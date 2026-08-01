/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
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
    const pacingControlPath = join(directory, 'pacingControl.json');
    const jobId = randomUUID();
    const initialPacing = normalizePacing(configuration.pacing);
    await writeFile(inputPath, await encodeProjectFile(content));
    await writeFile(configurationPath, JSON.stringify({ ...configuration, pacing: initialPacing }));
    let control = { executionState: 'running', pacing: initialPacing };
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
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });

    const readSnapshot = async () => {
        if (polling) return null;
        polling = true;
        try {
            const snapshot = JSON.parse(await readFile(outputPath, 'utf8'));
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
    const pollTimer = setInterval(readSnapshot, 40);

    const completion = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', async (code) => {
            clearInterval(pollTimer);
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
        cancel: () => child.kill()
    };
}
