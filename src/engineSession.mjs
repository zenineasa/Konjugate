/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A long-lived engine session (docs/proposals/liveEngineSession.md), from Node: starts `konjugateEngine session`, sends it commands
// as framed protobuf on its stdin and reads the answers on its stdout. The model is set up once and the process stays running, so a
// cycle of the comparison window costs no start-up. Commands sent together go as one batch, written at once without waiting for each
// answer (the engine carries them out in order, and once one fails the rest of its batch is not carried out); the answers are matched
// to them by sequence number.
//
// What a command answers with:
//   advanceTo(time, { takeCheckpoints })   { time, samples: [{ time, values }], checkpointsTaken } with `values` in the order of
//                                     `reportedStateIds`; checkpoints are kept on the way only when asked for
//   restoreCheckpoint(time, overrides) and restoreState(...)   { time, values, providerStates } with `values` in the order of `stateIds`
//   appendInputs, retainFrom          { time }
// Every answer also carries `computeNanoseconds`, how long the engine took to carry the command out.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProvidersConfiguration, resolveEnginePath } from './engineAdapter.mjs';
import { encodeEngineCommand, FramedEngineEventDecoder } from './engineProtocol.mjs';
import { encodeProjectFile } from './projectFile.mjs';
import { resolveInstalledFmus } from './fmiResolver.mjs';
import { resolveInstalledPlugins } from './pluginResolver.mjs';

export class EngineSessionError extends Error {
    constructor(message, reply = null) {
        super(message);
        this.name = 'EngineSessionError';
        this.reply = reply;
    }
}

export class EngineSession {
    #child;
    #directory;
    #decoder = new FramedEngineEventDecoder();
    #sequence = 0;
    #batch = 0;
    #pending = new Map(); // sequence -> { resolve, reject, wantsSamples }
    #samples = [];
    #diagnostics = '';
    #stateTable = null;
    #algebraicStateIds = [];
    #ready;
    #exited;
    #ended = false;

    // `configuration`: { globalTimeStep, outputInterval, checkpointInterval?, reportedStateIds?, execution?, providers? }.
    static async start(content, configuration, options) {
        const executable = await resolveEnginePath(options);
        if (!executable) throw new EngineSessionError('The native simulation engine is unavailable.');
        const directory = await mkdtemp(join(tmpdir(), 'konjugateSession-'));
        const resolvedContent = await resolveInstalledFmus(await resolveInstalledPlugins(content, options), options);
        const inputPath = join(directory, 'input.kjt');
        const configurationPath = join(directory, 'session.json');
        await writeFile(inputPath, await encodeProjectFile(resolvedContent));
        await writeFile(configurationPath, JSON.stringify({
            ...configuration,
            providers: buildProvidersConfiguration(configuration, options, JSON.parse(resolvedContent))
        }));
        const session = new EngineSession(spawn(executable, ['session', inputPath, '--configuration', configurationPath], { stdio: ['pipe', 'pipe', 'pipe'] }), directory, configuration);
        await session.#ready;
        return session;
    }

    constructor(child, directory, configuration) {
        this.#child = child;
        this.#directory = directory;
        this.configuration = configuration;
        let readyResolve;
        let readyReject;
        this.#ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        child.stderr.on('data', (chunk) => { this.#diagnostics += chunk; });
        child.stdout.on('data', (chunk) => {
            try {
                for (const event of this.#decoder.append(chunk)) {
                    if (event.stateTable && !this.#stateTable) {
                        this.#stateTable = event.stateTable;
                    } else if (event.sessionInfo) {
                        // Sent once, after the state table: the session is ready.
                        this.#algebraicStateIds = event.sessionInfo.algebraicStateIds;
                        readyResolve();
                    } else if (event.sampleBatch) {
                        const { times, stateCount, values } = event.sampleBatch;
                        times.forEach((time, index) => this.#samples.push({ time, values: values.slice(index * stateCount, (index + 1) * stateCount) }));
                    } else if (event.sessionReply) {
                        this.#answer(event.sessionReply);
                    }
                }
            } catch (error) {
                this.#fail(new EngineSessionError(`The engine session sent something unreadable: ${error.message}`));
                child.kill('SIGKILL');
            }
        });
        // stdin may be closed under a write when the process dies; that is reported through the exit below.
        child.stdin.on('error', () => {});
        this.#exited = new Promise((resolve) => child.once('exit', (code, signal) => {
            this.#ended = true;
            const error = new EngineSessionError(`The engine session stopped${signal ? ` (${signal})` : ` with code ${code}`}. ${this.#diagnostics.trim()}`.trim());
            readyReject(error);
            this.#fail(error);
            resolve({ code, signal });
        }));
    }

    // Every state of the model, in the order full state vectors are given and taken in.
    get stateIds() { return this.#stateTable; }
    get reportedStateIds() { return this.configuration.reportedStateIds ?? this.#stateTable; }
    get alive() { return !this.#ended; }
    // The states the model computes from others: they can be compared with a measurement, never set to one.
    get algebraicStateIds() { return this.#algebraicStateIds; }
    // The engine process's id, to watch its memory or tell it apart in a process list.
    get pid() { return this.#child.pid; }

    #answer(reply) {
        const waiting = this.#pending.get(reply.sequence);
        if (!waiting) return;
        this.#pending.delete(reply.sequence);
        const samples = waiting.wantsSamples ? this.#samples : [];
        if (waiting.wantsSamples) this.#samples = [];
        waiting.resolve({ ...reply, samples });
    }

    #fail(error) {
        for (const waiting of this.#pending.values()) waiting.reject(error);
        this.#pending.clear();
    }

    // Sends commands as one batch and resolves to their answers, in order, failed ones included (`ok` false and a `message`).
    send(commands) {
        if (this.#ended) return Promise.reject(new EngineSessionError('The engine session has stopped.'));
        const batch = commands.length > 1 ? ++this.#batch : 0;
        const answers = commands.map((command) => {
            const sequence = ++this.#sequence;
            const answered = new Promise((resolve, reject) => this.#pending.set(sequence, { resolve, reject, wantsSamples: command.type === 'advanceTo' }));
            this.#child.stdin.write(encodeEngineCommand(sequence, { ...command, batch }));
            return answered;
        });
        return Promise.all(answers);
    }

    // As send(), but rejects with the first failure's reason.
    async run(commands) {
        const replies = await this.send(commands);
        const failed = replies.find((reply) => !reply.ok);
        if (failed) throw new EngineSessionError(failed.message, failed);
        return replies;
    }

    advanceTo(time, { takeCheckpoints = false } = {}) { return this.run([{ type: 'advanceTo', time, takeCheckpoints }]).then(([reply]) => reply); }
    restoreCheckpoint(time, overrides = []) { return this.run([{ type: 'restoreCheckpoint', time, overrides }]).then(([reply]) => reply); }
    restoreState(time, values, providerStates = []) { return this.run([{ type: 'restoreState', time, values, providerStates }]).then(([reply]) => reply); }
    appendInputs(parameterId, samples, replaceFrom) { return this.run([{ type: 'appendInputSamples', parameterId, samples, replaceFrom }]).then(([reply]) => reply); }
    retainFrom(time) { return this.run([{ type: 'retainCheckpointsFrom', time }]).then(([reply]) => reply); }

    // Ends the process at once, as a crash would (for tests of recovery, and as a last resort).
    kill() {
        this.#child.kill('SIGKILL');
        return this.#exited;
    }

    async close() {
        if (!this.#ended) {
            this.#child.stdin.end();
            const timer = setTimeout(() => this.#child.kill('SIGKILL'), 5000);
            await this.#exited;
            clearTimeout(timer);
        }
        await rm(this.#directory, { recursive: true, force: true });
    }
}
