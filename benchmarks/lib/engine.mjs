/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs the native engine headless, exactly as the app and the command line do: `konjugateEngine run model.kjt --configuration run.json
// --output result.bin` (docs/engineCli.md), then decodes the result with the app's own decoder.
//
// A benchmark model is a committed .kjt. A run may apply a variant to it first, and only these, recorded with every result:
//   integration  every node's numerics.integration ("explicit" or "semiImplicit")
//   substeps     every node's numerics.substepsPerGlobalStep
//   method       the run's method ("rungeKutta4"; docs/proposals/integrators.md), and its stepsPerGlobalStep, set on the run
//                configuration the engine is given rather than on the model
//
// A run executes on the serial backend unless `execution` (docs/parallelExecution.md) chooses another, as the scaling benchmarks do.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { decodeProjectFile, encodeProjectFile } from '../../src/projectFile.mjs';

export const repositoryRoot = join(import.meta.dirname, '..', '..');

export function resolveEngineExecutable(explicit) {
    const candidate = explicit ?? process.env.KONJUGATE_ENGINE ?? join(repositoryRoot, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
    if (!existsSync(candidate)) throw new Error(`No engine at ${candidate}. Build it with npm run build:engine, or pass --engine <path>.`);
    return candidate;
}

function execute(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

export async function loadModel(path) {
    const content = await decodeProjectFile(await readFile(path));
    return JSON.parse(typeof content === 'string' ? content : JSON.stringify(content));
}

export function applyVariant(document, { integration, substeps } = {}) {
    const copy = structuredClone(document);
    for (const node of copy.nodes) {
        node.numerics = { ...(node.numerics ?? {}) };
        if (integration) node.numerics.integration = integration;
        if (substeps) node.numerics.substepsPerGlobalStep = substeps;
    }
    return copy;
}

// The peak resident memory of a finished child, from the platform's own time(1), where there is one that reports it.
function memoryWrapper() {
    if (process.platform === 'darwin' && existsSync('/usr/bin/time')) return { command: '/usr/bin/time', args: ['-l'], pattern: /(\d+)\s+maximum resident set size/, bytesPerUnit: 1 };
    if (process.platform === 'linux' && existsSync('/usr/bin/time')) return { command: '/usr/bin/time', args: ['-v'], pattern: /Maximum resident set size \(kbytes\):\s*(\d+)/, bytesPerUnit: 1024 };
    return null;
}

export function createEngine(executable, workDirectory) {
    const modelFiles = new Map();
    let runIndex = 0;

    async function modelFile(modelPath, variant) {
        const key = JSON.stringify([modelPath, variant ?? {}]);
        if (!modelFiles.has(key)) {
            const path = join(workDirectory, `model${modelFiles.size}.kjt`);
            await writeFile(path, await encodeProjectFile(`${JSON.stringify(applyVariant(await loadModel(modelPath), variant), null, 4)}\n`));
            modelFiles.set(key, path);
        }
        return modelFiles.get(key);
    }

    return {
        executable,
        async validate(modelPath) {
            const reportPath = join(workDirectory, 'validation.bin');
            const { code, diagnostics } = await execute(executable, ['validate', modelPath, '--report', reportPath]);
            if (code !== 0) throw new Error(`${modelPath} did not validate (exit ${code}). ${diagnostics}`);
        },
        // run: { globalTimeStep, targetTime, outputInterval }. Returns the sampled times, each state's samples by state ID, and the work the
        // engine reports: global steps, node substeps executed and contributions evaluated, summed over nodes. execution: the run
        // configuration's execution settings (backend, workerThreads, partitionCount, ...), serial when absent. modelAsIs: run the file
        // as it is, without reading and rewriting it, for a generated model too large to be decoded and encoded again for nothing (only
        // the run's method may then be varied).
        async run(modelPath, variant, run, { measure = false, execution = null, modelAsIs = false } = {}) {
            const index = runIndex++;
            const configurationPath = join(workDirectory, `run${index}.json`);
            const outputPath = join(workDirectory, `run${index}.bin`);
            const method = variant?.method ? { method: variant.method, ...(variant.stepsPerGlobalStep ? { stepsPerGlobalStep: variant.stepsPerGlobalStep } : {}) } : {};
            await writeFile(configurationPath, JSON.stringify({ name: 'Benchmark', ...run, ...method, execution: { backend: 'serial', ...(execution ?? {}) } }));
            const engineArgs = ['run', modelAsIs ? modelPath : await modelFile(modelPath, variant), '--configuration', configurationPath, '--output', outputPath];
            const wrapper = measure ? memoryWrapper() : null;
            const startedAt = performance.now();
            const { code, diagnostics } = wrapper ? await execute(wrapper.command, [...wrapper.args, executable, ...engineArgs]) : await execute(executable, engineArgs);
            const wallMilliseconds = performance.now() - startedAt;
            if (code !== 0) throw Object.assign(new Error(`The engine failed on ${modelPath} (exit ${code}). ${diagnostics.trim()}`), { engineExitCode: code, diverged: /non-finite/.test(diagnostics) });
            const result = decodeResultFile(await readFile(outputPath));
            await rm(outputPath, { force: true });
            const times = result.samples.map((sample) => sample.time);
            const values = new Map();
            for (const sample of result.samples) {
                for (const { stateId, value } of sample.states) {
                    if (!values.has(stateId)) values.set(stateId, []);
                    values.get(stateId).push(value);
                }
            }
            const metrics = result.execution.nodeMetrics;
            const memoryMatch = wrapper?.pattern.exec(diagnostics);
            return {
                times, values,
                work: {
                    globalSteps: result.globalSteps,
                    substeps: metrics.reduce((sum, node) => sum + Number(node.executedSubsteps), 0),
                    evaluations: metrics.reduce((sum, node) => sum + Number(node.evaluatedContributions), 0)
                },
                timing: measure ? {
                    wallMilliseconds,
                    engineComputeMilliseconds: Number(result.execution.synchronizationComputeNanoseconds) / 1e6,
                    planningMilliseconds: Number(result.execution.planningNanoseconds) / 1e6,
                    peakResidentBytes: memoryMatch ? Number(memoryMatch[1]) * wrapper.bytesPerUnit : null
                } : null,
                execution: {
                    backend: result.execution.backend, workerThreads: result.execution.workerThreads, selectionReason: result.execution.selectionReason,
                    communicationCutFraction: result.execution.communicationCutFraction, estimatedOperationsPerSynchronization: Number(result.execution.estimatedOperationsPerSynchronization)
                },
                engineVersion: result.engineVersion
            };
        }
    };
}

// Samples of chosen states, as [[s1, s2, ...] per sample time].
export function trajectory(run, stateIds) {
    return run.times.map((_time, sample) => stateIds.map((stateId) => run.values.get(stateId)[sample]));
}

export function sampleTimes(targetTime, outputInterval) {
    const count = Math.round(targetTime / outputInterval);
    return Array.from({ length: count + 1 }, (_unused, index) => index * outputInterval);
}
