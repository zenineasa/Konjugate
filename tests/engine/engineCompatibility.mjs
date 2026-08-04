/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { normalizePacing, runWithEngine, startEngineRun, validateWithEngine } from '../../src/engineAdapter.mjs';

function run(executable, args, environment = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env: { ...process.env, ...environment }, stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
    });
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateEngineTest-'));
const input = join(directory, 'model.kjt');
const report = join(directory, 'validation.json');
const project = JSON.stringify({
    format: 'konjugate', version: 1, nodes: [{
        id: '11111111-1111-4111-8111-111111111111', name: 'Node', states: [{
            id: '22222222-2222-4222-8222-222222222222', name: 'State', symbol: 'state', initialValue: 0, unit: ''
        }], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#34727a' }
    }], edges: []
});
await writeFile(input, await encodeProjectFile(project));
assert.equal(await run(executable, ['validate', input, '--report', report]), 0);
const validation = JSON.parse(await readFile(report, 'utf8'));
assert.equal(validation.valid, true);
assert.deepEqual(validation.summary, { nodes: 1, edges: 0 });

const sourceProject = JSON.parse(project);
sourceProject.nodes[0].states[0].initialValue = 1;
sourceProject.nodes[0].numerics = { substepsPerGlobalStep: 2 };
sourceProject.nodes[0].sourceTerms.push({
    id: '33333333-3333-4333-8333-333333333333', state: 'state', expression: 'state',
    expressionModel: {
        latex: 'state', bindings: [{
            kind: 'state', nodeId: '11111111-1111-4111-8111-111111111111',
            stateId: '22222222-2222-4222-8222-222222222222', symbol: 'state'
        }], output: { stateId: '22222222-2222-4222-8222-222222222222' }, mathJson: 'state'
    }
});
await writeFile(input, await encodeProjectFile(JSON.stringify(sourceProject)));
await writeFile(join(directory, 'sourceRun.json'), JSON.stringify({ name: 'Subcycling', targetTime: 0.1, globalTimeStep: 0.1, outputInterval: 0.1 }));
assert.equal(await run(executable, ['run', input, '--configuration', join(directory, 'sourceRun.json'), '--output', join(directory, 'sourceResults.kjr')]), 0);
const sourceResult = JSON.parse(await readFile(join(directory, 'sourceResults.kjr'), 'utf8'));
assert.ok(Math.abs(sourceResult.states[0].value - 1.1025) < 1e-12);
assert.deepEqual(sourceResult.nodeTimesteps[0], {
    nodeId: '11111111-1111-4111-8111-111111111111', substepsPerGlobalStep: 2, effectiveTimeStep: 0.05
});
assert.equal(sourceResult.execution.planVersion, 1);
assert.equal(sourceResult.execution.nodeMetrics[0].invocations, 1);
assert.equal(sourceResult.execution.nodeMetrics[0].executedSubsteps, 2);
assert.equal(sourceResult.execution.nodeMetrics[0].evaluatedContributions, 2);
assert.deepEqual(sourceResult.samples.map((sample) => sample.time), [0, 0.1]);
assert.deepEqual(sourceResult.checkpoints.map((checkpoint) => checkpoint.time), [0, 0.1]);
assert.ok(sourceResult.checkpoints.every((checkpoint) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(checkpoint.uuid)));
assert.ok(sourceResult.checkpoints.every((checkpoint) => checkpoint.solver.kind === 'explicitEuler' && checkpoint.states.length === 1));

const exampleInput = join(directory, 'thermalManagement.kjt');
const exampleReport = join(directory, 'thermalValidation.json');
const example = await readFile(new URL('../../examples/thermalManagement.konjugate.json', import.meta.url), 'utf8');
await writeFile(exampleInput, await encodeProjectFile(example));
assert.equal(await run(executable, ['validate', exampleInput, '--report', exampleReport]), 0);
assert.equal(JSON.parse(await readFile(exampleReport, 'utf8')).valid, true);
const runConfiguration = join(directory, 'runConfiguration.json');
const simulationOutput = join(directory, 'simulationResults.kjr');
await writeFile(runConfiguration, JSON.stringify({
    name: 'Compatibility', targetTime: 1, globalTimeStep: 0.01, outputInterval: 0.1,
    execution: { partitionCount: 2 }
}));
assert.equal(await run(executable, ['run', exampleInput, '--configuration', runConfiguration, '--output', simulationOutput]), 0);
const simulation = JSON.parse(await readFile(simulationOutput, 'utf8'));
assert.equal(simulation.resultVersion, 1);
assert.equal(simulation.execution.requestedBackend, 'automatic');
assert.equal(simulation.execution.backend, 'serial');
assert.equal(simulation.execution.workerThreads, 1);
assert.equal(simulation.execution.selectionReason, 'belowParallelWorkThreshold');
assert.ok(simulation.execution.communicationCutFraction >= 0 && simulation.execution.communicationCutFraction <= 1);
assert.equal(simulation.execution.nodeMetrics.length, 3);
assert.ok(simulation.execution.nodeMetrics.every((metrics) => metrics.invocations === simulation.globalSteps));
assert.ok(simulation.execution.nodeMetrics.every((metrics) => metrics.computeNanoseconds >= 0));
assert.equal(simulation.dependencyGraph.version, 1);
assert.equal(simulation.dependencyGraph.componentCount, 1);
assert.equal(simulation.dependencyGraph.nodes.length, 3);
assert.equal(simulation.dependencyGraph.dependencies.length, 3);
assert.ok(simulation.dependencyGraph.dependencies.every((dependency) => dependency.communicationWeight >= 1));
const exampleNodeNames = new Map(JSON.parse(example).nodes.map((node) => [node.id, node.name]));
const dependencyDirections = simulation.dependencyGraph.dependencies.map((dependency) =>
    `${exampleNodeNames.get(dependency.sourceNodeId)} -> ${exampleNodeNames.get(dependency.targetNodeId)}`);
assert.deepEqual(dependencyDirections.toSorted(), [
    'Battery module -> Enclosed air',
    'Electrical losses -> Battery module',
    'Enclosed air -> Battery module'
]);
assert.ok(['metisKway', 'communicationAwareGreedy'].includes(simulation.partitionPlan.algorithm));
assert.match(simulation.partitionPlan.algorithmVersion, /^\d+(?:\.\d+){0,2}$/);
assert.equal(simulation.partitionPlan.requestedAlgorithm, 'automatic');
if (simulation.partitionPlan.algorithm === 'metisKway') assert.equal(simulation.partitionPlan.metisAvailable, true);
assert.equal(simulation.partitionPlan.requestedPartitions, 2);
assert.equal(simulation.partitionPlan.effectivePartitions, 2);
assert.equal(simulation.partitionPlan.assignments.length, 3);
assert.equal(simulation.partitionPlan.partitions.reduce((total, partition) => total + partition.nodeCount, 0), 3);
assert.ok(simulation.partitionPlan.selected.computeImbalance >= 1);
assert.equal(simulation.targetTime, 1);
assert.equal(simulation.globalSteps, 100);
assert.equal(simulation.samples.length, 11);
assert.equal(simulation.states.length, 4);
assert.ok(simulation.states.every((state) => Number.isFinite(state.value)));
const exampleStates = new Map(simulation.states.map((state) => [state.stateId, state.value]));
const batteryTemperature = exampleStates.get('bdf343a3-54a2-4ab0-a1eb-1dd68507c130');
const airTemperature = exampleStates.get('a9a1552b-dd1a-4860-889b-300d1888a2cb');
assert.ok(batteryTemperature < 353.2 && batteryTemperature > airTemperature);
assert.ok(airTemperature > 293.15 && airTemperature < batteryTemperature);
assert.ok(Math.abs(1000 * (batteryTemperature - 353.2) + 5025 * (airTemperature - 293.15) - 420) < 1e-8);

const serialConfiguration = join(directory, 'serialRunConfiguration.json');
const serialOutput = join(directory, 'serialSimulationResults.kjr');
await writeFile(serialConfiguration, JSON.stringify({
    name: 'Serial compatibility', targetTime: 1, globalTimeStep: 0.01, outputInterval: 0.1,
    execution: { backend: 'serial', workerThreads: 1 }
}));
assert.equal(await run(executable, ['run', exampleInput, '--configuration', serialConfiguration, '--output', serialOutput]), 0);
const serialSimulation = JSON.parse(await readFile(serialOutput, 'utf8'));
assert.equal(serialSimulation.execution.backend, 'serial');
assert.equal(serialSimulation.execution.workerThreads, 1);
assert.deepEqual(serialSimulation.states, simulation.states);
assert.deepEqual(serialSimulation.samples, simulation.samples);

const parallelResults = [];
for (const backend of ['threadPool', 'partitioned']) {
    const configurationPath = join(directory, `${backend}RunConfiguration.json`);
    const outputPath = join(directory, `${backend}SimulationResults.kjr`);
    await writeFile(configurationPath, JSON.stringify({
        name: `${backend} compatibility`, targetTime: 1, globalTimeStep: 0.01, outputInterval: 0.1,
        execution: { backend, workerThreads: 2, partitionCount: backend === 'partitioned' ? 3 : 2 }
    }));
    assert.equal(await run(executable, ['run', exampleInput, '--configuration', configurationPath, '--output', outputPath]), 0);
    const result = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(result.execution.backend, backend);
    assert.equal(result.execution.workerThreads, 2);
    if (backend === 'partitioned') {
        assert.equal(result.partitionPlan.requestedPartitions, 3);
        assert.equal(result.partitionPlan.effectivePartitions, 2);
        assert.equal(result.execution.schedulingPolicy, 'partitionAffinity');
        assert.equal(result.execution.partitionCommunication.transport, 'inMemory');
        assert.equal(result.execution.partitionCommunication.messageVersion, 1);
        assert.equal(result.execution.partitionCommunication.boundaryMessages, result.globalSteps * 2);
        assert.ok(result.execution.partitionCommunication.boundaryPayloadBytes > 0);
        assert.ok(result.execution.partitionCommunication.messagePreparationNanoseconds > 0);
        assert.ok(result.execution.partitionCommunication.transportPublishNanoseconds > 0);
        assert.ok(result.execution.partitionCommunication.boundaryWaitNanoseconds >= 0);
        assert.equal(result.execution.partitionCommunication.serializationNanoseconds, 0);
    }
    assert.deepEqual(result.states, serialSimulation.states);
    assert.deepEqual(result.samples, serialSimulation.samples);
    parallelResults.push(result);
}
assert.deepEqual(parallelResults[0].states, parallelResults[1].states);

const damaged = JSON.parse(project);
damaged.nodes[0].states[0].symbol = 'Not camel case';
await writeFile(input, await encodeProjectFile(JSON.stringify(damaged)));
assert.equal(await run(executable, ['validate', input, '--report', report]), 2);
const invalid = JSON.parse(await readFile(report, 'utf8'));
assert.equal(invalid.valid, false);
assert.ok(invalid.issues.some((issue) => issue.code === 'stateSymbolInvalid'));

const invalidEquation = JSON.parse(example);
invalidEquation.edges[0].equation = 'randomCharacters';
invalidEquation.edges[0].equationModel = {
    ...invalidEquation.edges[0].equationModel,
    latex: 'randomCharacters'
};
await writeFile(input, await encodeProjectFile(JSON.stringify(invalidEquation)));
assert.equal(await run(executable, ['validate', input, '--report', report]), 2);
const invalidEquationReport = JSON.parse(await readFile(report, 'utf8'));
assert.ok(invalidEquationReport.issues.some((issue) => (
    issue.code === 'edgeEquationInvalid' && issue.message.includes('randomCharacters')
)));

const encryptedInput = join(directory, 'encrypted.kjt');
await writeFile(encryptedInput, await encodeProjectFile(project, { password: 'engine compatibility password', scryptCost: 2 ** 14 }));
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report]), 4);
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report], { KONJUGATE_PASSWORD: 'wrong password' }), 4);
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report], { KONJUGATE_PASSWORD: 'engine compatibility password' }), 0);
const adapted = await validateWithEngine(project, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '',
    packaged: false
});
assert.equal(adapted.available, true);
assert.equal(adapted.report.valid, true);
const adaptedRun = await runWithEngine(example, { name: 'Adapter', targetTime: 0.1, globalTimeStep: 0.01, outputInterval: 0.1 }, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '',
    packaged: false
});
assert.equal(adaptedRun.available, true);
assert.equal(adaptedRun.result.globalSteps, 10);
assert.deepEqual(normalizePacing({ mode: 'realTime', simulationSecondsPerWallSecond: 9 }), {
    mode: 'realTime', simulationSecondsPerWallSecond: 1
});
assert.throws(() => normalizePacing({ mode: 'limitedRatio', simulationSecondsPerWallSecond: 0 }));
const liveUpdates = [];
const liveStartedAt = performance.now();
const liveRun = await startEngineRun(example, {
    name: 'Live adapter', targetTime: 0.5, globalTimeStep: 0.01, outputInterval: 0.05,
    pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }
}, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '',
    packaged: false
}, { onUpdate: (result) => liveUpdates.push(result) });
const liveResult = await liveRun.completion;
assert.ok(performance.now() - liveStartedAt >= 450);
assert.ok(liveUpdates.some((result) => result.lifecycle === 'running' && result.samples.length > 1));
assert.equal(liveResult.lifecycle, 'completed');
assert.equal(liveResult.availableResultTime, 0.5);
assert.ok(liveResult.samples.length > liveResult.checkpoints.length);
assert.deepEqual(liveResult.checkpoints.map((checkpoint) => checkpoint.time), [0, 0.5]);

const controlledUpdates = [];
const liveParameterProject = JSON.parse(example);
const liveParameter = liveParameterProject.edges[0].parameters[0];
liveParameter.mode = 'live';
const controlledRun = await startEngineRun(JSON.stringify(liveParameterProject), {
    name: 'Controlled adapter', targetTime: 0.4, globalTimeStep: 0.01, outputInterval: 0.05,
    pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }
}, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '', packaged: false
}, { onUpdate: (result) => controlledUpdates.push(result) });
await new Promise((resolve) => setTimeout(resolve, 90));
await controlledRun.setExecutionState('paused');
for (let attempt = 0; attempt < 50 && !controlledUpdates.some((result) => result.lifecycle === 'paused'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(controlledUpdates.some((result) => result.lifecycle === 'paused'));
assert.deepEqual(await controlledRun.setParameterValue(liveParameter.id, Number(liveParameter.value) * 2), {
    parameterId: liveParameter.id,
    value: Number(liveParameter.value) * 2
});
await assert.rejects(() => controlledRun.setParameterValue('not-live', 1), /not available for live control/);
await Promise.all([
    controlledRun.setPacing({ mode: 'realTime' }),
    controlledRun.setPacing({ mode: 'limitedRatio', simulationSecondsPerWallSecond: 2 }),
    controlledRun.setPacing({ mode: 'fastest' })
]);
await controlledRun.setExecutionState('running');
const controlledResult = await controlledRun.completion;
assert.equal(controlledResult.lifecycle, 'completed');
assert.equal(controlledResult.pacing.mode, 'fastest');

let resolveStoppedProgress;
const stoppedProgress = new Promise((resolve) => { resolveStoppedProgress = resolve; });
const stoppedRun = await startEngineRun(example, {
    name: 'Stopped adapter', targetTime: 2, globalTimeStep: 0.01, outputInterval: 0.05,
    pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }
}, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '', packaged: false
}, { onUpdate: (result) => {
    if (result.lifecycle === 'running' && result.availableResultTime > 0) resolveStoppedProgress();
} });
await stoppedProgress;
await stoppedRun.setExecutionState('stopped');
const stoppedResult = await stoppedRun.completion;
assert.equal(stoppedResult.lifecycle, 'stopped');
assert.ok(stoppedResult.availableResultTime > 0 && stoppedResult.availableResultTime < stoppedResult.targetTime);
assert.equal(stoppedResult.checkpoints.at(-1).time, stoppedResult.availableResultTime);

let resolveShutdownProgress;
const shutdownProgress = new Promise((resolve) => { resolveShutdownProgress = resolve; });
const shutdownRun = await startEngineRun(example, {
    name: 'Application shutdown', targetTime: 10, globalTimeStep: 0.01, outputInterval: 0.05,
    pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }
}, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '', packaged: false
}, { onUpdate: (result) => {
    if (result.lifecycle === 'running' && result.availableResultTime > 0) resolveShutdownProgress();
} });
await shutdownProgress;
const firstShutdown = shutdownRun.shutdown();
assert.equal(shutdownRun.shutdown(), firstShutdown, 'Engine shutdown must be idempotent.');
await firstShutdown;
const shutdownResult = await shutdownRun.completion;
assert.equal(shutdownResult.lifecycle, 'stopped');
assert.ok(shutdownResult.availableResultTime > 0 && shutdownResult.availableResultTime < shutdownResult.targetTime);

await writeFile(join(directory, 'restartRun.json'), JSON.stringify({
    name: 'Restart', targetTime: 0.2, globalTimeStep: 0.1, outputInterval: 0.1,
    startCheckpoint: sourceResult.checkpoints.at(-1)
}));
await writeFile(input, await encodeProjectFile(JSON.stringify(sourceProject)));
assert.equal(await run(executable, ['run', input, '--configuration', join(directory, 'restartRun.json'), '--output', join(directory, 'restartResults.kjr')]), 0);
const restartResult = JSON.parse(await readFile(join(directory, 'restartResults.kjr'), 'utf8'));
assert.deepEqual(restartResult.samples.map((sample) => sample.time), [0.1, 0.2]);

const unsupportedInput = join(directory, 'project.unsupported');
await writeFile(unsupportedInput, await encodeProjectFile(project));
assert.equal(await run(executable, ['validate', unsupportedInput, '--report', report]), 3);
console.log('C++/Electron container compatibility passed.');
