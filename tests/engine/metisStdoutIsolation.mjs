/* Copyright © 2026 Zenin Easa Panthakkalakath */

// METIS prints some of its failures (e.g. "***Cannot bisect a graph with 0 vertices!") with printf to stdout, which also
// carries the engine's framed binary event stream. Those bytes reached the reader as a frame length, so a run failed with
// "The engine protocol frame is too large" even though the engine itself had fallen back to the greedy partitioner and could
// finish. The Four Bar Linkage example with 8 substeps on one node, run as the app runs it (automatic backend, 8 workers,
// 8 requested partitions), makes METIS fail on its 4-node graph; stdout must still be nothing but well-formed frames.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/metisStdoutIsolation.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FramedEngineEventDecoder } from '../../src/engineProtocol.mjs';
import { decodeProjectFile, encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const model = JSON.parse(await decodeProjectFile(await readFile(join(root, 'examples', 'fourBarLinkage.kjt'))));
model.nodes.find((node) => node.name === 'Coupler-rocker pin C').numerics = { substepsPerGlobalStep: 8 };

const directory = await mkdtemp(join(tmpdir(), 'konjugateMetisStdout-'));
try {
    const input = join(directory, 'input.kjt');
    const configuration = join(directory, 'runConfiguration.json');
    await writeFile(input, await encodeProjectFile(JSON.stringify(model)));
    await writeFile(configuration, JSON.stringify({
        targetTime: 1, globalTimeStep: 0.02, outputInterval: 0.02,
        execution: { backend: 'automatic', partitionAlgorithm: 'automatic', workerThreads: 8, partitionCount: 8 }
    }));
    const child = spawn(executable, ['run', input, '--configuration', configuration, '--output', join(directory, 'result.bin'), '--control-stream', 'protobuf', '--event-stream', 'protobuf'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new FramedEngineEventDecoder();
    const events = [];
    let failure = null;
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
        try {
            events.push(...decoder.append(chunk));
        } catch (error) {
            failure ??= error;
        }
    });
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    const code = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(failure, null, `stdout was not a clean frame stream: ${failure?.message}`);
    assert.equal(code, 0, `The engine exited with ${code}: ${diagnostics}`);
    assert.ok(events.some((event) => event.stateTable) && events.some((event) => event.sampleBatch), 'The stream carried no state table or samples.');
    console.log(`METIS stdout isolation: ${events.length} well-formed events with METIS ${/Cannot bisect|too many parts/.test(diagnostics) ? 'failing (message on stderr)' : 'not failing in this build'}.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
