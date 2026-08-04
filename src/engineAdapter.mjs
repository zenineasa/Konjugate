/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, open as openFile, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectFile } from './projectFile.mjs';
import { FramedEngineEventDecoder } from './engineProtocol.mjs';

function engineFileName() {
    return process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine';
}

export async function resolveEnginePath({ applicationPath, resourcesPath, packaged }) {
    const candidates = [
        process.env.KONJUGATE_ENGINE_PATH,
        packaged ? join(resourcesPath, 'engine', engineFileName()) : join(applicationPath, 'out', 'engine', engineFileName()),
        packaged ? join(resourcesPath, 'engine', 'Release', engineFileName()) : null
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the next supported location.
        }
    }
    return null;
}

function runEngine(executable, args, environment = {}, signal = null) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            env: { ...process.env, ...environment },
            stdio: ['ignore', 'ignore', 'pipe'],
            ...(signal ? { signal } : {})
        });
        let diagnostics = '';
        let processError = null;
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', (error) => { processError = error; });
        child.once('close', (code) => {
            if (processError) reject(processError);
            else resolve({ code, diagnostics: diagnostics.trim() });
        });
    });
}

export async function validateWithEngine(content, options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateValidation-'));
    const inputPath = join(directory, 'input.kjt');
    const reportPath = join(directory, 'validation.json');
    try {
        await writeFile(inputPath, await encodeProjectFile(content));
        const execution = await runEngine(executable, ['validate', inputPath, '--report', reportPath], {}, options.signal);
        if (execution.code !== 0 && execution.code !== 2) {
            throw new Error(execution.diagnostics || `The validation engine exited with code ${execution.code}.`);
        }
        return { available: true, report: JSON.parse(await readFile(reportPath, 'utf8')) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function runWithEngine(content, configuration, options) {
    const execution = await startEngineRun(content, configuration, options);
    if (!execution.available) return execution;
    return { available: true, result: await execution.completion };
}

export function normalizePacing(pacing = {}) {
    const mode = pacing.mode ?? 'fastest';
    const ratio = mode === 'realTime' ? 1 : Number(pacing.simulationSecondsPerWallSecond ?? 1);
    if (!['fastest', 'realTime', 'limitedRatio'].includes(mode)) throw new Error('Unsupported simulation pacing mode.');
    if (mode === 'limitedRatio' && (!(ratio > 0) || !Number.isFinite(ratio))) {
        throw new Error('Limited simulation pacing requires a finite positive ratio.');
    }
    return { mode, simulationSecondsPerWallSecond: ratio };
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function startEngineRun(content, configuration, options, { onUpdate } = {}) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateRun-'));
    const inputPath = join(directory, 'input.kjt');
    const configurationPath = join(directory, 'runConfiguration.json');
    const outputPath = join(directory, 'simulationResults.kjr');
    const streamPath = `${outputPath}.stream`;
    const pacingControlPath = join(directory, 'pacingControl.json');
    const jobId = randomUUID();
    const initialPacing = normalizePacing(configuration.pacing);
    await writeFile(inputPath, await encodeProjectFile(content));
    await writeFile(configurationPath, JSON.stringify({ ...configuration, pacing: initialPacing }));
    const liveParameterIds = new Set(JSON.parse(content).edges.flatMap((edge) =>
        (edge.parameters ?? []).filter((parameter) => parameter.mode === 'live').map((parameter) => parameter.id)));
    let control = { executionState: 'running', pacing: initialPacing, parameterValues: {} };
    let controlWrite = Promise.resolve();
    await writeFile(pacingControlPath, JSON.stringify(control));

    const child = spawn(executable, [
        'run', inputPath,
        '--configuration', configurationPath,
        '--output', outputPath,
        '--pacing-control', pacingControlPath,
        '--event-stream', 'protobuf'
    ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    let lastSnapshotKey = '';
    let polling = false;
    let streamOffset = 0;
    let streamRemainder = '';
    let accumulatedSamples = [];
    let accumulatedCheckpoints = [];
    let protocolStateIds = [];
    let childExited = false;
    let shutdownPromise = null;
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    const eventDecoder = new FramedEngineEventDecoder();
    child.stdout.on('data', (chunk) => {
        try {
            for (const event of eventDecoder.append(chunk)) {
                if (event.stateTable) protocolStateIds = event.stateTable;
                if (event.sampleBatch) {
                    const { times, stateCount, values } = event.sampleBatch;
                    if (stateCount !== protocolStateIds.length || values.length !== times.length * stateCount) {
                        throw new Error('The engine returned an inconsistent Protobuf sample batch.');
                    }
                    for (let sampleIndex = 0; sampleIndex < times.length; ++sampleIndex) {
                        accumulatedSamples.push({
                            time: times[sampleIndex],
                            states: protocolStateIds.map((stateId, stateIndex) => ({
                                stateId,
                                value: values[sampleIndex * stateCount + stateIndex]
                            }))
                        });
                    }
                }
            }
        } catch (error) {
            diagnostics += `\nENGINE_PROTOCOL_FAILURE: ${error.message}`;
            child.kill('SIGTERM');
        }
    });

    const readStream = async () => {
        const handle = await openFile(streamPath, 'r');
        try {
            const { size } = await handle.stat();
            if (size < streamOffset) {
                streamOffset = 0;
                streamRemainder = '';
                accumulatedSamples = [];
                accumulatedCheckpoints = [];
            }
            if (size === streamOffset) return;
            const bytes = Buffer.alloc(size - streamOffset);
            await handle.read(bytes, 0, bytes.length, streamOffset);
            streamOffset = size;
            const lines = `${streamRemainder}${bytes.toString('utf8')}`.split('\n');
            streamRemainder = lines.pop() ?? '';
            for (const line of lines) {
                if (!line) continue;
                const record = JSON.parse(line);
                if (record.type === 'sample') accumulatedSamples.push({ time: record.time, states: record.states });
                else if (record.type === 'checkpoint') accumulatedCheckpoints.push({
                    uuid: record.uuid, time: record.time, solver: record.solver, states: record.states
                });
            }
        } finally {
            await handle.close();
        }
    };

    const readSnapshot = async () => {
        if (polling) return null;
        polling = true;
        try {
            let snapshot = JSON.parse(await readFile(outputPath, 'utf8'));
            if (snapshot.snapshotMode === 'live') {
                await readStream();
                snapshot = { ...snapshot, samples: accumulatedSamples, checkpoints: accumulatedCheckpoints };
            } else {
                accumulatedSamples = snapshot.samples ?? [];
                accumulatedCheckpoints = snapshot.checkpoints ?? [];
            }
            const key = `${snapshot.lifecycle}:${snapshot.samples?.length}:${snapshot.pacing?.mode}:${snapshot.pacing?.simulationSecondsPerWallSecond}`;
            if (key !== lastSnapshotKey) {
                lastSnapshotKey = key;
                onUpdate?.(structuredClone(snapshot));
            }
            return snapshot;
        } catch {
            return null;
        } finally {
            polling = false;
        }
    };
    const pollTimer = setInterval(readSnapshot, 100);

    const completion = new Promise((resolve, reject) => {
        let finalized = false;
        const finalize = async (code, processError = null) => {
            if (finalized) return;
            finalized = true;
            childExited = true;
            clearInterval(pollTimer);
            while (polling) await new Promise((resolvePolling) => setTimeout(resolvePolling, 5));
            const result = await readSnapshot();
            let failure = processError;
            try {
                if (failure) throw failure;
                if (code !== 0) throw new Error(diagnostics.trim() || `The simulation engine exited with code ${code}.`);
                if (!result) throw new Error('The simulation engine did not produce a result.');
            } catch (error) {
                failure = error;
            }
            try {
                await rm(directory, { recursive: true, force: true });
            } catch (error) {
                failure ??= error;
            }
            if (failure) reject(failure);
            else resolve(result);
        };
        child.once('error', (error) => { void finalize(null, error); });
        child.once('exit', (code) => { void finalize(code); });
    });

    const persistControl = () => {
        const snapshot = structuredClone(control);
        controlWrite = controlWrite.then(async () => {
            const temporaryPath = `${pacingControlPath}.${randomUUID()}.tmp`;
            await writeFile(temporaryPath, JSON.stringify(snapshot));
            try { await rename(temporaryPath, pacingControlPath); } catch {
                await unlink(pacingControlPath).catch(() => {});
                await rename(temporaryPath, pacingControlPath);
            }
        });
        return controlWrite;
    };

    const awaitExit = async (timeoutMilliseconds) => {
        if (childExited) {
            await completion.catch(() => {});
            return true;
        }
        return Promise.race([
            completion.then(() => true, () => true),
            delay(timeoutMilliseconds).then(() => false)
        ]);
    };

    const shutdown = ({ gracefulTimeoutMilliseconds = 1500, terminationTimeoutMilliseconds = 1000 } = {}) => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            if (!childExited) {
                control = { ...control, executionState: 'stopped' };
                await persistControl().catch(() => {});
            }
            if (await awaitExit(gracefulTimeoutMilliseconds)) return;
            child.kill('SIGTERM');
            if (await awaitExit(terminationTimeoutMilliseconds)) return;
            if (!child.kill('SIGKILL') && !childExited) throw new Error('The simulation engine could not be terminated.');
            await completion.catch(() => {});
        })();
        return shutdownPromise;
    };

    const cancel = () => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            if (!childExited) child.kill('SIGTERM');
            if (await awaitExit(1000)) return;
            if (!child.kill('SIGKILL') && !childExited) throw new Error('The simulation engine could not be cancelled.');
            await completion.catch(() => {});
        })();
        return shutdownPromise;
    };

    return {
        available: true,
        jobId,
        completion,
        setPacing: async (pacing) => {
            const normalized = normalizePacing(pacing);
            control = { ...control, pacing: normalized };
            await persistControl();
            return normalized;
        },
        setExecutionState: async (executionState) => {
            if (!['running', 'paused', 'stopped'].includes(executionState)) throw new Error('Unsupported execution state.');
            control = { ...control, executionState };
            await persistControl();
            return executionState;
        },
        setParameterValue: async (parameterId, parameterValue) => {
            const value = Number(parameterValue);
            if (!liveParameterIds.has(parameterId)) throw new Error('That parameter is not available for live control.');
            if (!Number.isFinite(value)) throw new Error('A live parameter value must be finite.');
            control = { ...control, parameterValues: { ...control.parameterValues, [parameterId]: value } };
            await persistControl();
            return { parameterId, value };
        },
        shutdown,
        cancel
    };
}
