/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Integrated counterpart to engine/tests/providerBatchingBenchmark.cpp: that tool measures raw
// per-call cost by hand-constructing ExecutionPlan objects and calling ProviderRuntime directly,
// in-process, bypassing the project-file/CLI/JSON-configuration layer entirely. This script
// instead drives the real konjugateEngine executable exactly the way the app does -- encoding a
// project file, writing a run configuration, spawning the engine, decoding its result -- so the
// comparison includes everything a real run pays: process startup, JSON parsing, project
// decoding, and (for provider modes) the one-time inline-source compile. It answers "how does a
// real simulation compare across equation vs. each ProviderExecutionMode", not "how fast is one
// evaluateBatch call".
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/providerExecutionBenchmark.mjs
// Optional env vars: KONJUGATE_BENCHMARK_NODES, KONJUGATE_BENCHMARK_STEPS, KONJUGATE_BENCHMARK_TRIALS.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

const executable = process.argv[2] ??
    join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
// buildCppProvider() expects this to be the engine/ root (see cppProviderSdkPath() in
// engineAdapter.mjs for the same convention in the app itself).
const cppSdkPath = join(import.meta.dirname, '..', '..', 'engine');
const nodeCount = Number(process.env.KONJUGATE_BENCHMARK_NODES ?? 32);
const globalSteps = Number(process.env.KONJUGATE_BENCHMARK_STEPS ?? 2000);
const trials = Number(process.env.KONJUGATE_BENCHMARK_TRIALS ?? 3);

// All provider-mode nodes share this identical inline source, so ProviderRuntime resolves them
// to one shared worker/library (mirrors the common real-world case: many instances reusing one
// relationship type) and only the very first run of a given execution mode pays to compile it.
const inlineConductanceProviderSource = `
#include <konjugate/relationshipProvider.hpp>
#include <memory>

namespace {

class ConductanceProvider final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"benchmark.conductance", "Conductance",
            {{"delta", "Level", "K"}},
            {"gradient", "Rate", "K/s"}};
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::OutputCollector& output) override {
        output.addGradient(context.inputs.at("delta") * 3);
    }
};

}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<ConductanceProvider>();
}
`;

// Every node has two states -- level (untouched, holds steady) and rate (driven by a source
// term computing level * 3) -- so equation and provider variants do the identical trivial
// amount of arithmetic and differ only in how that one multiply gets dispatched.
function benchmarkDocument(kind) {
    let nextEntityId = 1;
    const allocateEntityId = () => nextEntityId++;
    const nodes = Array.from({ length: nodeCount }, (_unused, index) => {
        const nodeId = allocateEntityId();
        const levelStateId = allocateEntityId();
        const rateStateId = allocateEntityId();
        const sourceTerm = kind === 'equation' ? {
            id: allocateEntityId(),
            state: 'rate',
            expression: 'level * 3',
            expressionModel: {
                latex: 'level \\times 3',
                bindings: [{ kind: 'state', nodeId, stateId: levelStateId, symbol: 'level' }],
                output: { stateId: rateStateId },
                mathJson: ['Multiply', 'level', '3']
            }
        } : {
            id: allocateEntityId(),
            state: 'rate',
            expression: '',
            implementation: {
                kind: 'cpp',
                providerApiVersion: 1,
                source: inlineConductanceProviderSource,
                bindings: [{ key: 'delta', kind: 'state', nodeId, stateId: levelStateId }],
                output: { key: 'gradient', stateId: rateStateId }
            }
        };
        return {
            id: nodeId,
            name: `Benchmark node ${index + 1}`,
            states: [
                { id: levelStateId, name: 'Level', symbol: 'level', initialValue: 300, unit: '' },
                { id: rateStateId, name: 'Rate', symbol: 'rate', initialValue: 0, unit: '' }
            ],
            sourceTerms: [sourceTerm],
            appearance: { type: 'primitive', shape: 'box', color: '#34727a' }
        };
    });
    return { format: 'konjugate', version: 1, nodes, edges: [] };
}

function runEngine(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(diagnostics || `Engine exited with code ${code}.`)));
    });
}

function median(values) {
    const sorted = values.toSorted((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function safeFileNamePart(label) {
    return label.replace(/[^a-zA-Z0-9]/g, '');
}

const modes = [
    { label: 'equation', executionMode: null },
    { label: 'cppProvider-pipeWorker', executionMode: 'pipeWorker' },
    { label: 'cppProvider-sharedMemoryWorker', executionMode: 'sharedMemoryWorker' },
    { label: 'cppProvider-inProcess', executionMode: 'inProcess' }
];

const directory = await mkdtemp(join(tmpdir(), 'konjugateProviderBenchmark-'));
try {
    const measurements = {};
    for (const { label, executionMode } of modes) {
        const kind = executionMode ? 'provider' : 'equation';
        const inputPath = join(directory, `${safeFileNamePart(label)}.kjt`);
        await writeFile(inputPath, await encodeProjectFile(`${JSON.stringify(benchmarkDocument(kind), null, 4)}\n`));

        const configurationPath = join(directory, `${safeFileNamePart(label)}Configuration.json`);
        const outputPath = join(directory, `${safeFileNamePart(label)}Result.bin`);
        await writeFile(configurationPath, `${JSON.stringify({
            name: `${label} benchmark`,
            targetTime: globalSteps,
            globalTimeStep: 1,
            outputInterval: globalSteps,
            execution: { backend: 'serial' },
            ...(executionMode ? { providers: { executionMode, cpp: { sdkPath: cppSdkPath } } } : {})
        }, null, 4)}\n`);

        // Warm-up, untimed: for provider modes this pays the one-time inline-source compile
        // outside the measured trials (every node shares one source, so this is the only
        // compile the whole run needs, same as buildCppProvider()'s hash-keyed on-disk cache).
        await runEngine(['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);

        const durations = [];
        for (let trial = 0; trial < trials; ++trial) {
            const startedAt = performance.now();
            await runEngine(['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
            durations.push(performance.now() - startedAt);
        }

        const result = decodeResultFile(await readFile(outputPath));
        const finalSample = result.samples.at(-1);
        const firstNodeRateStateId = 3; // node 1: id=1, level=2, rate=3 (allocation order above)
        const finalRate = finalSample?.states.find((state) => state.stateId === firstNodeRateStateId)?.value;

        measurements[label] = {
            medianMilliseconds: Number(median(durations).toFixed(3)),
            trialsMilliseconds: durations.map((duration) => Number(duration.toFixed(3))),
            finalRateSample: finalRate ?? null
        };
    }

    const baselineMilliseconds = measurements.equation.medianMilliseconds;
    for (const entry of Object.values(measurements)) {
        entry.vsEquation = Number((entry.medianMilliseconds / baselineMilliseconds).toFixed(3));
    }

    // "rate" is a state, so its source term drives rate's *derivative* (level * 3, a constant
    // here since nothing else touches level), not rate's value directly -- rate accumulates
    // that constant slope over the whole run, i.e. level * 3 * globalTimeStep * globalSteps.
    const expectedFinalRate = 300 * 3 * 1 * globalSteps;
    for (const [label, entry] of Object.entries(measurements)) {
        if (!Number.isFinite(entry.finalRateSample) || Math.abs(entry.finalRateSample - expectedFinalRate) > 1e-6 * expectedFinalRate) {
            throw new Error(`${label}: expected the rate state to reach ${expectedFinalRate}, got ${entry.finalRateSample}.`);
        }
    }

    console.log(JSON.stringify({ nodeCount, globalSteps, trials, measurements }, null, 4));
} finally {
    await rm(directory, { recursive: true, force: true });
}
