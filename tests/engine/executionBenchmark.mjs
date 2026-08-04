/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const executable = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const nodeCount = Number(process.env.KONJUGATE_BENCHMARK_NODES ?? 64);
const expressionDepth = Number(process.env.KONJUGATE_BENCHMARK_DEPTH ?? 80);
const globalSteps = Number(process.env.KONJUGATE_BENCHMARK_STEPS ?? 1000);
const trials = Number(process.env.KONJUGATE_BENCHMARK_TRIALS ?? 3);
const topology = process.env.KONJUGATE_BENCHMARK_TOPOLOGY ?? 'independent';
if (!['independent', 'ring'].includes(topology)) throw new Error('KONJUGATE_BENCHMARK_TOPOLOGY must be independent or ring.');

function expression(baseSymbol = 'state') {
    let result = baseSymbol;
    for (let index = 0; index < expressionDepth; ++index) {
        result = ['Add', ['Multiply', result, '0.999999'], ['Multiply', baseSymbol, '0.000001']];
    }
    return result;
}

function benchmarkDocument() {
    const nodes = Array.from({ length: nodeCount }, (_unused, index) => {
        const nodeId = randomUUID();
        const stateId = randomUUID();
        return {
            id: nodeId,
            name: `Benchmark node ${index + 1}`,
            states: [{ id: stateId, name: 'State', symbol: 'state', initialValue: 1, unit: '' }],
            sourceTerms: [{
                id: randomUUID(),
                state: 'state',
                expression: 'Synthetic arithmetic workload',
                expressionModel: {
                    latex: 'state',
                    bindings: [{ kind: 'state', nodeId, stateId, symbol: 'state' }],
                    output: { stateId },
                    mathJson: expression()
                }
            }],
            appearance: { type: 'primitive', shape: 'box', color: '#34727a' }
        };
    });
    const edges = topology === 'ring' ? nodes.map((sourceNode, index) => {
        const targetNode = nodes[(index + 1) % nodes.length];
        const sourceState = sourceNode.states[0];
        const targetState = targetNode.states[0];
        return {
            id: randomUUID(),
            name: `Ring dependency ${index + 1}`,
            source: { nodeId: sourceNode.id, stateId: sourceState.id },
            target: { nodeId: targetNode.id, stateId: targetState.id },
            directionality: 'directed',
            equation: 'Synthetic remote workload',
            equationModel: {
                latex: 'remoteState',
                bindings: [{
                    kind: 'state', role: 'source', nodeId: sourceNode.id,
                    stateId: sourceState.id, symbol: 'remoteState'
                }],
                output: { role: 'target', stateId: targetState.id },
                mathJson: ['Multiply', expression('remoteState'), '0.000000001']
            },
            parameters: [],
            appearance: { color: '#70cfc7', offset: 0 }
        };
    }) : [];
    return {
        format: 'konjugate',
        version: 1,
        nodes,
        edges
    };
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

const directory = await mkdtemp(join(tmpdir(), 'konjugateExecutionBenchmark-'));
try {
    const inputPath = join(directory, 'benchmark.kjt');
    await writeFile(inputPath, await encodeProjectFile(`${JSON.stringify(benchmarkDocument(), null, 4)}\n`));
    const measurements = {};
    for (const backend of ['serial', 'threadPool', 'partitioned', 'automatic']) {
        const durations = [];
        let result;
        for (let trial = 0; trial < trials; ++trial) {
            const configurationPath = join(directory, `${backend}Configuration.json`);
            const outputPath = join(directory, `${backend}Result.kjr`);
            await writeFile(configurationPath, `${JSON.stringify({
                name: `${backend} benchmark`,
                targetTime: globalSteps,
                globalTimeStep: 1,
                outputInterval: globalSteps,
                execution: { backend }
            }, null, 4)}\n`);
            const startedAt = performance.now();
            await runEngine(['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
            durations.push(performance.now() - startedAt);
            result = JSON.parse(await readFile(outputPath, 'utf8'));
        }
        measurements[backend] = {
            medianMilliseconds: Number(median(durations).toFixed(3)),
            trialsMilliseconds: durations.map((duration) => Number(duration.toFixed(3))),
            effectiveBackend: result.execution.backend,
            selectionReason: result.execution.selectionReason,
            communicationCutFraction: Number(result.execution.communicationCutFraction.toFixed(3)),
            workerThreads: result.execution.workerThreads,
            synchronizationComputeMilliseconds: Number((result.execution.synchronizationComputeNanoseconds / 1e6).toFixed(3)),
            partitionPlan: {
                algorithm: result.partitionPlan.algorithm,
                partitions: result.partitionPlan.effectivePartitions,
                computeImbalance: Number(result.partitionPlan.selected.computeImbalance.toFixed(3)),
                communicationCutWeight: result.partitionPlan.selected.communicationCutWeight
            },
            partitionCommunication: result.execution.partitionCommunication
        };
    }
    const threadPoolSpeedup = measurements.serial.medianMilliseconds / measurements.threadPool.medianMilliseconds;
    const partitionedSpeedup = measurements.serial.medianMilliseconds / measurements.partitioned.medianMilliseconds;
    console.log(JSON.stringify({
        topology, nodeCount, expressionDepth, globalSteps, trials, measurements,
        threadPoolSpeedup: Number(threadPoolSpeedup.toFixed(3)),
        partitionedSpeedup: Number(partitionedSpeedup.toFixed(3))
    }, null, 4));
} finally {
    await rm(directory, { recursive: true, force: true });
}
