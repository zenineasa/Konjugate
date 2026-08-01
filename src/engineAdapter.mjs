/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateRun-'));
    const inputPath = join(directory, 'input.kjt');
    const configurationPath = join(directory, 'runConfiguration.json');
    const outputPath = join(directory, 'simulationResults.kjr');
    try {
        await writeFile(inputPath, await encodeProjectFile(content));
        await writeFile(configurationPath, JSON.stringify(configuration));
        const execution = await runEngine(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
        if (execution.code !== 0) throw new Error(execution.diagnostics || `The simulation engine exited with code ${execution.code}.`);
        return { available: true, result: JSON.parse(await readFile(outputPath, 'utf8')) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
