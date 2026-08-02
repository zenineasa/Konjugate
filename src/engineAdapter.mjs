/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, open as openFile, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectFile } from './projectFile.mjs';

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

function runEngine(executable, args, environment = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            env: { ...process.env, ...environment },
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics: diagnostics.trim() }));
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
        const execution = await runEngine(executable, ['validate', inputPath, '--report', reportPath]);
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
        '--pacing-control', pacingControlPath
    ], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostics = '';
    let lastSnapshotKey = '';
    let polling = false;
    let streamOffset = 0;
    let streamRemainder = '';
    let accumulatedSamples = [];
    let accumulatedCheckpoints = [];
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });

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
        child.once('error', reject);
        child.once('exit', async (code) => {
            clearInterval(pollTimer);
            while (polling) await new Promise((resolvePolling) => setTimeout(resolvePolling, 5));
            const result = await readSnapshot();
            try {
                if (code !== 0) throw new Error(diagnostics.trim() || `The simulation engine exited with code ${code}.`);
                if (!result) throw new Error('The simulation engine did not produce a result.');
                resolve(result);
            } catch (error) {
                reject(error);
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        });
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
        cancel: () => child.kill()
    };
}
