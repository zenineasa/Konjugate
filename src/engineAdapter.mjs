/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectFile } from './projectFile.mjs';
import { decodeResultFile, encodeEngineCommand, FramedEngineEventDecoder } from './engineProtocol.mjs';

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
    const jobId = randomUUID();
    const initialPacing = normalizePacing(configuration.pacing);
    await writeFile(inputPath, await encodeProjectFile(content));
    await writeFile(configurationPath, JSON.stringify({ ...configuration, pacing: initialPacing }));
    const liveParameterIds = new Set(JSON.parse(content).edges.flatMap((edge) =>
        (edge.parameters ?? []).filter((parameter) => parameter.mode === 'live').map((parameter) => parameter.id)));
    const child = spawn(executable, [
        'run', inputPath,
        '--configuration', configurationPath,
        '--output', outputPath,
        '--control-stream', 'protobuf',
        '--event-stream', 'protobuf'
    ], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '';
    let lastSnapshotKey = '';
    let polling = false;
    let accumulatedSamples = [];
    let protocolStateIds = [];
    let childExited = false;
    let shutdownPromise = null;
    let commandSequence = 0;
    let commandWrite = Promise.resolve();
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

    const readSnapshot = async () => {
        if (polling) return null;
        polling = true;
        try {
            let snapshot = decodeResultFile(await readFile(outputPath));
            if (snapshot.snapshotMode === 'live') {
                snapshot = { ...snapshot, samples: accumulatedSamples };
            } else {
                accumulatedSamples = snapshot.samples ?? [];
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
            child.stdin.destroy();
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

    const sendCommand = (command) => {
        const frame = encodeEngineCommand(++commandSequence, command);
        commandWrite = commandWrite.then(() => new Promise((resolve, reject) => {
            if (childExited || child.stdin.destroyed) {
                reject(new Error('The simulation engine is no longer accepting commands.'));
                return;
            }
            child.stdin.write(frame, (error) => error ? reject(error) : resolve());
        }));
        commandWrite.catch(() => {});
        return commandWrite;
    };

    const closeCommandStream = async () => {
        await commandWrite.catch(() => {});
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
            await new Promise((resolve) => child.stdin.end(resolve));
        }
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
                await sendCommand({ type: 'setRunState', state: 'stopped' }).catch(() => {});
                await closeCommandStream().catch(() => {});
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
            if (!childExited) {
                child.stdin.destroy();
                child.kill('SIGTERM');
            }
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
            await sendCommand({ type: 'setPacing', pacing: normalized });
            return normalized;
        },
        setExecutionState: async (executionState) => {
            if (!['running', 'paused', 'stopped'].includes(executionState)) throw new Error('Unsupported execution state.');
            await sendCommand({ type: 'setRunState', state: executionState });
            if (executionState === 'stopped') await closeCommandStream();
            return executionState;
        },
        setParameterValue: async (parameterId, parameterValue) => {
            const value = Number(parameterValue);
            if (!liveParameterIds.has(parameterId)) throw new Error('That parameter is not available for live control.');
            if (!Number.isFinite(value)) throw new Error('A live parameter value must be finite.');
            await sendCommand({ type: 'setParameterValue', parameterId, value });
            return { parameterId, value };
        },
        shutdown,
        cancel
    };
}
