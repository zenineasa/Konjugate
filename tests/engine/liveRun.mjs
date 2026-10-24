/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs the engine over its control stream for the tests that make changes while a run is going. The changes that are to arrive
// mid-run are sent when the run has *reached* a simulation time (read from the result file the engine keeps writing), not after a
// fixed number of milliseconds, so how long the engine took to start, or how busy the machine is, cannot change what is tested.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { decodeResultFile, encodeEngineCommand } from '../../src/engineProtocol.mjs';

// `commands` are written at once. Each of `later` ({ after, command }, in order) is written once the run has reached `after`
// simulation seconds. Resolves when the engine exits cleanly; rejects if it does not, or exits before every command was sent.
export function runWithLiveCommands({ executable, input, settings, output, commands = [], later = [] }) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', input, '--configuration', settings, '--output', output, '--control-stream', 'protobuf'], { stdio: ['pipe', 'ignore', 'pipe'] });
        const waiting = [...later];
        let diagnostics = '';
        let sequence = 0;
        let exited = false;
        const send = (command) => child.stdin.write(encodeEngineCommand(++sequence, command));
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        commands.forEach(send);
        if (!waiting.length) child.stdin.end();
        const poll = setInterval(async () => {
            if (exited || !waiting.length) return;
            let reached = 0;
            try {
                // How far the run has got is in the result's own metadata: while it is going the samples are not in the file.
                const snapshot = decodeResultFile(await readFile(output));
                reached = Math.max(Number(snapshot.availableResultTime ?? 0), snapshot.samples.at(-1)?.time ?? 0);
            } catch {
                return; // not written yet, or being replaced
            }
            while (waiting.length && reached >= waiting[0].after && !exited) send(waiting.shift().command);
            if (!waiting.length && !exited) child.stdin.end();
        }, 15);
        child.once('exit', (code) => {
            exited = true;
            clearInterval(poll);
            if (code !== 0) reject(new Error(diagnostics || `The engine exited with code ${code}.`));
            else if (waiting.length) reject(new Error(`The run was over before ${waiting.length} of its mid-run commands could be sent.`));
            else resolve();
        });
    });
}
