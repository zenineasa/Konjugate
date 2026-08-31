/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { decodeProjectBundle, encodeProjectFile } from '../../src/projectFile.mjs';
import { normalizePacing, runWithEngine, startEngineRun, validateWithEngine } from '../../src/engineAdapter.mjs';
import { decodeResultFile, encodeEngineCommand, FramedEngineEventDecoder } from '../../src/engineProtocol.mjs';
import { openIndexedResult } from '../../src/indexedResultReader.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';

function run(executable, args, environment = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env: { ...process.env, ...environment }, stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
    });
}

function readProtocolEvents(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        const decoder = new FramedEngineEventDecoder();
        const events = [];
        child.stdout.on('data', (chunk) => events.push(...decoder.append(chunk)));
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve(events) : reject(new Error(`Engine exited with code ${code}.`)));
    });
}

function runWithCommandInput(executable, args, frames) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
        frames.forEach((frame) => child.stdin.write(frame));
        child.stdin.end();
    });
}

function doubleBits(value) {
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, value, false);
    return new DataView(bytes).getBigUint64(0, false);
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
// A third 'no-metis' argument relaxes the METIS-availability assertion below -- used by
// testEngineSanitized.mjs, which deliberately builds against the METIS-free
// development-no-metis preset (see engine/CMakePresets.json's "sanitize" preset) rather than
// mixing an uninstrumented vcpkg METIS binary into an ASan/UBSan build. Every other caller
// (testEngine.mjs, testPackagedEngine.mjs) omits it and keeps requiring METIS, unchanged.
const expectMetis = process.argv[3] !== 'no-metis';
// Mirrors resolveEnginePath() in src/engineAdapter.mjs in reverse: reconstructs whichever layout
// `executable` actually sits in (dev build under out/engine/, or packaged build under
// resources/engine/) instead of assuming dev -- this file is run against both, via
// scripts/testEngine.mjs and scripts/testPackagedEngine.mjs, and the latter doesn't build a dev
// engine first, so a hardcoded dev-relative applicationPath left the adapter unable to find it.
const engineDirectory = dirname(executable);
const engineParentDirectory = dirname(engineDirectory);
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };
const capabilityEvents = await readProtocolEvents(executable, ['capabilities', '--protobuf']);
assert.equal(capabilityEvents.length, 1);
assert.equal(capabilityEvents[0].capabilities.metisAvailable, expectMetis);
if (expectMetis) assert.match(capabilityEvents[0].capabilities.metisVersion, /^\d+\.\d+\.\d+$/);
const directory = await mkdtemp(join(tmpdir(), 'konjugateEngineTest-'));
const input = join(directory, 'model.kjt');
const report = join(directory, 'validation.bin');
const project = JSON.stringify({
    format: 'konjugate', version: 1, nodes: [{
        id: 1, name: 'Node', states: [{
            id: 2, name: 'State', symbol: 'state', initialValue: 0, unit: ''
        }], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#34727a' }
    }], edges: []
});
await writeFile(input, await encodeProjectFile(project));
assert.equal(await run(executable, ['validate', input, '--report', report]), 0);
const validation = decodeValidationReport(await readFile(report));
assert.equal(validation.valid, true);
assert.deepEqual(validation.summary, { nodes: 1, edges: 0 });

const sourceProject = JSON.parse(project);
sourceProject.nodes[0].states[0].initialValue = 1;
sourceProject.nodes[0].numerics = { substepsPerGlobalStep: 2 };
sourceProject.nodes[0].sourceTerms.push({
    id: 3, state: 'state', expression: 'gain * state',
    parameters: [{ id: 4, name: 'Gain', symbol: 'gain', value: 2, unit: '1/s', mode: 'constant' }],
    expressionModel: {
        latex: 'gain * state', bindings: [{
            kind: 'state', nodeId: 1,
            stateId: 2, symbol: 'state'
        }, { kind: 'parameter', parameterId: 4, symbol: 'gain' }],
        output: { stateId: 2 }, mathJson: ['Multiply', 'gain', 'state']
    }
});
await writeFile(input, await encodeProjectFile(JSON.stringify(sourceProject)));
await writeFile(join(directory, 'sourceRun.json'), JSON.stringify({ name: 'Subcycling', targetTime: 0.1, globalTimeStep: 0.1, outputInterval: 0.1 }));
assert.equal(await run(executable, ['run', input, '--configuration', join(directory, 'sourceRun.json'), '--output', join(directory, 'sourceResult.bin')]), 0);
const sourceResult = decodeResultFile(await readFile(join(directory, 'sourceResult.bin')));
assert.ok(Math.abs(sourceResult.states[0].value - 1.21) < 1e-12);
assert.deepEqual(sourceResult.nodeTimesteps[0], {
    nodeId: 1, substepsPerGlobalStep: 2, effectiveTimeStep: 0.05
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
const exampleReport = join(directory, 'thermalValidation.bin');
const exampleBytes = await readFile(new URL('../../examples/thermalManagement.kjt', import.meta.url));
const example = (await decodeProjectBundle(exampleBytes)).content;
await writeFile(exampleInput, exampleBytes);
assert.equal(await run(executable, ['validate', exampleInput, '--report', exampleReport]), 0);
assert.equal(decodeValidationReport(await readFile(exampleReport)).valid, true);
const invalidControlConfiguration = join(directory, 'invalidControlConfiguration.json');
await writeFile(invalidControlConfiguration, JSON.stringify({
    name: 'Invalid command ordering', targetTime: 10, globalTimeStep: 0.01, outputInterval: 1,
    pacing: { mode: 'limitedRatio', simulationSecondsPerWallSecond: 1 }
}));
const invalidControl = await runWithCommandInput(executable, [
    'run', exampleInput, '--configuration', invalidControlConfiguration,
    '--output', join(directory, 'invalidControlResult.bin'), '--control-stream', 'protobuf'
], [
    encodeEngineCommand(1, { type: 'setRunState', state: 'running' }),
    encodeEngineCommand(1, { type: 'setRunState', state: 'paused' })
]);
assert.equal(invalidControl.code, 5);
assert.match(invalidControl.diagnostics, /out-of-order command/);
const runConfiguration = join(directory, 'runConfiguration.json');
const simulationOutput = join(directory, 'simulationResult.bin');
await writeFile(runConfiguration, JSON.stringify({
    name: 'Compatibility', targetTime: 1, globalTimeStep: 0.01, outputInterval: 0.1,
    execution: { partitionCount: 2 }
}));
const batchedEvents = await readProtocolEvents(executable, [
    'run', exampleInput, '--configuration', runConfiguration,
    '--output', join(directory, 'batchedSimulationResult.bin'), '--event-stream', 'protobuf'
]);
assert.ok(batchedEvents.some((event) => event.sampleBatch?.times.length > 1),
    'The engine must aggregate multiple available samples into one live Protobuf batch.');
assert.equal(await run(executable, ['run', exampleInput, '--configuration', runConfiguration, '--output', simulationOutput]), 0);
const simulationBytes = await readFile(simulationOutput);
assert.equal(simulationBytes.subarray(0, 4).toString('hex'), '4b4a5202');
assert.equal(simulationBytes.subarray(-4).toString('utf8'), 'KJIX');
const projectWithResults = await encodeProjectFile(example, { result: simulationBytes });
const projectWithResultsPath = join(directory, 'thermalManagementWithResults.kjt');
await writeFile(projectWithResultsPath, projectWithResults);
assert.equal(await run(executable, ['validate', projectWithResultsPath, '--report', exampleReport]), 0);
assert.deepEqual((await decodeProjectBundle(projectWithResults)).result, simulationBytes);
const damagedIndexFooter = Buffer.from(simulationBytes);
damagedIndexFooter[damagedIndexFooter.length - 1] ^= 0xff;
assert.throws(() => decodeResultFile(damagedIndexFooter), /index footer/);
const simulation = decodeResultFile(simulationBytes);
const indexedSimulation = await openIndexedResult(simulationOutput);
assert.equal(indexedSimulation.metadata.sampleCount, simulation.samples.length);
const indexedRange = await indexedSimulation.readSamples({ startTime: 0.2, endTime: 0.4 });
assert.equal(indexedRange.length, 3);
assert.ok(indexedRange.every((sample, index) => Math.abs(sample.time - (index + 2) * 0.1) < 1e-12));
assert.ok(Math.abs((await indexedSimulation.readNearestSample(0.36)).time - 0.4) < 1e-12);
const boundedIndexedRange = await indexedSimulation.readSamples({ startTime: 0, endTime: 1, maximumSamples: 3 });
assert.equal(boundedIndexedRange.length, 3);
assert.ok(boundedIndexedRange.every((sample, index) => Math.abs(sample.time - index * 0.5) < 1e-12));
const readsBeforeRepeatedPlayback = indexedSimulation.diagnostics().batchReads;
await indexedSimulation.readNearestSample(0.37);
await indexedSimulation.readNearestSample(0.38);
assert.equal(indexedSimulation.diagnostics().batchReads, readsBeforeRepeatedPlayback);
assert.ok(indexedSimulation.diagnostics().cacheHits >= 2);
await indexedSimulation.close();
assert.equal(simulation.resultVersion, 2);
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
const batteryTemperature = exampleStates.get(2);
const airTemperature = exampleStates.get(5);
assert.ok(batteryTemperature < 353.2 && batteryTemperature > airTemperature);
assert.ok(airTemperature > 293.15 && airTemperature < batteryTemperature);
assert.ok(Math.abs(1000 * (batteryTemperature - 353.2) + 5025 * (airTemperature - 293.15) - 420) < 1e-8);

const serialConfiguration = join(directory, 'serialRunConfiguration.json');
const serialOutput = join(directory, 'serialSimulationResult.bin');
await writeFile(serialConfiguration, JSON.stringify({
    name: 'Serial compatibility', targetTime: 1, globalTimeStep: 0.01, outputInterval: 0.1,
    execution: { backend: 'serial', workerThreads: 1 }
}));
assert.equal(await run(executable, ['run', exampleInput, '--configuration', serialConfiguration, '--output', serialOutput]), 0);
const serialSimulation = decodeResultFile(await readFile(serialOutput));
assert.equal(serialSimulation.execution.backend, 'serial');
assert.equal(serialSimulation.execution.workerThreads, 1);
assert.deepEqual(serialSimulation.states, simulation.states);
assert.deepEqual(serialSimulation.samples, simulation.samples);

const parallelResults = [];
for (const backend of ['threadPool', 'partitioned']) {
    const configurationPath = join(directory, `${backend}RunConfiguration.json`);
    const outputPath = join(directory, `${backend}SimulationResult.bin`);
    await writeFile(configurationPath, JSON.stringify({
        name: `${backend} compatibility`, targetTime: 1, globalTimeStep: 0.01, outputInterval: 0.1,
        execution: { backend, workerThreads: 2, partitionCount: backend === 'partitioned' ? 3 : 2 }
    }));
    assert.equal(await run(executable, ['run', exampleInput, '--configuration', configurationPath, '--output', outputPath]), 0);
    const result = decodeResultFile(await readFile(outputPath));
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
const invalid = decodeValidationReport(await readFile(report));
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
const invalidEquationReport = decodeValidationReport(await readFile(report));
assert.ok(invalidEquationReport.issues.some((issue) => (
    issue.code === 'edgeEquationInvalid' && issue.message.includes('randomCharacters')
)));

const encryptedInput = join(directory, 'encrypted.kjt');
await writeFile(encryptedInput, await encodeProjectFile(project, {
    password: 'engine compatibility password',
    scryptCost: 2 ** 14,
    result: simulationBytes
}));
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report]), 4);
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report], { KONJUGATE_PASSWORD: 'wrong password' }), 4);
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report], { KONJUGATE_PASSWORD: 'engine compatibility password' }), 0);
const adapted = await validateWithEngine(project, engineOptions);
assert.equal(adapted.available, true);
assert.equal(adapted.report.valid, true);
const adaptedRun = await runWithEngine(example, { name: 'Adapter', targetTime: 0.1, globalTimeStep: 0.01, outputInterval: 0.1 }, engineOptions);
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
    ...engineOptions
}, { onUpdate: (result) => liveUpdates.push(result) });
const liveResult = await liveRun.completion;
assert.ok(performance.now() - liveStartedAt >= 450);
assert.ok(liveUpdates.some((result) => result.lifecycle === 'running' && result.samples.length > 1));
assert.equal(liveResult.lifecycle, 'completed');
assert.equal(liveResult.availableResultTime, 0.5);
assert.ok(liveResult.samples.length > liveResult.checkpoints.length);
assert.deepEqual(liveResult.checkpoints.map((checkpoint) => checkpoint.time), [0, 0.5]);
const mostCompleteLiveUpdate = liveUpdates.filter((result) => result.lifecycle === 'running')
    .toSorted((left, right) => right.samples.length - left.samples.length)[0];
assert.ok(mostCompleteLiveUpdate.samples.length > 1, 'The live Protobuf stream must deliver multiple samples.');
const durableSamplesByTime = new Map(liveResult.samples.map((sample) => [sample.time, new Map(
    sample.states.map((state) => [state.stateId, state.value])
)]));
for (const liveSample of mostCompleteLiveUpdate.samples) {
    const durableStates = durableSamplesByTime.get(liveSample.time);
    assert.ok(durableStates, `The durable result is missing the ${liveSample.time} s Protobuf sample.`);
    for (const state of liveSample.states) {
        assert.equal(doubleBits(state.value), doubleBits(durableStates.get(state.stateId)),
            `Protobuf changed the IEEE-754 value for state ${state.stateId} at ${liveSample.time} s.`);
    }
}

const controlledUpdates = [];
const liveParameterProject = JSON.parse(example);
const liveParameter = liveParameterProject.edges[0].parameters[0];
liveParameter.mode = 'live';
const controlledRun = await startEngineRun(JSON.stringify(liveParameterProject), {
    name: 'Controlled adapter', targetTime: 0.4, globalTimeStep: 0.01, outputInterval: 0.05,
    pacing: { mode: 'realTime', simulationSecondsPerWallSecond: 1 }
}, {
    ...engineOptions
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
    ...engineOptions
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
    ...engineOptions
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
assert.equal(await run(executable, ['run', input, '--configuration', join(directory, 'restartRun.json'), '--output', join(directory, 'restartResult.bin')]), 0);
const restartResult = decodeResultFile(await readFile(join(directory, 'restartResult.bin')));
assert.deepEqual(restartResult.samples.map((sample) => sample.time), [0.1, 0.2]);

const unsupportedInput = join(directory, 'project.unsupported');
await writeFile(unsupportedInput, await encodeProjectFile(project));
assert.equal(await run(executable, ['validate', unsupportedInput, '--report', report]), 3);

// A computational-node provider's opaque checkpoint()/restore() state (here, a controller's
// integral term) has no analog in the ordinary state vector, so a pause/resume-style restart must
// reproduce an uninterrupted run bit-for-bit, and a restart missing that state must be rejected
// rather than silently resetting it -- see docs/pluginDevelopment.md's computational-node-provider
// section.
const pythonSdkPath = join(engineOptions.packaged ? engineOptions.resourcesPath : engineOptions.applicationPath, 'engine', 'sdk', 'python');
const nodeProviderProject = JSON.parse(await readFile(
    new URL('../../examples/providers/piControlledTankProject.json', import.meta.url), 'utf8'));
const nodeProviderInput = join(directory, 'nodeProvider.kjt');
await writeFile(nodeProviderInput, await encodeProjectFile(JSON.stringify(nodeProviderProject)));
assert.equal(await run(executable, ['validate', nodeProviderInput, '--report', report]), 0);
assert.equal(decodeValidationReport(await readFile(report)).valid, true);

const nodeProviderRunConfiguration = (overrides) => JSON.stringify({
    name: 'PI controller', globalTimeStep: 0.1, outputInterval: 0.5,
    providers: { python: { sdkPath: pythonSdkPath } }, ...overrides
});
await writeFile(join(directory, 'nodeProviderFull.json'), nodeProviderRunConfiguration({ targetTime: 3 }));
assert.equal(await run(executable, [
    'run', nodeProviderInput, '--configuration', join(directory, 'nodeProviderFull.json'),
    '--output', join(directory, 'nodeProviderFull.bin')
]), 0);
const nodeProviderFullResult = decodeResultFile(await readFile(join(directory, 'nodeProviderFull.bin')));
assert.equal(nodeProviderFullResult.checkpoints.at(-1).providerStates.length, 1);
assert.equal(nodeProviderFullResult.checkpoints.at(-1).providerStates[0].nodeId, 1);

await writeFile(join(directory, 'nodeProviderPartial.json'), nodeProviderRunConfiguration({ targetTime: 1.5 }));
assert.equal(await run(executable, [
    'run', nodeProviderInput, '--configuration', join(directory, 'nodeProviderPartial.json'),
    '--output', join(directory, 'nodeProviderPartial.bin')
]), 0);
const nodeProviderPartialResult = decodeResultFile(await readFile(join(directory, 'nodeProviderPartial.bin')));
const nodeProviderCheckpoint = nodeProviderPartialResult.checkpoints.at(-1);

await writeFile(join(directory, 'nodeProviderRestart.json'),
    nodeProviderRunConfiguration({ targetTime: 3, startCheckpoint: nodeProviderCheckpoint }));
assert.equal(await run(executable, [
    'run', nodeProviderInput, '--configuration', join(directory, 'nodeProviderRestart.json'),
    '--output', join(directory, 'nodeProviderRestart.bin')
]), 0);
const nodeProviderRestartResult = decodeResultFile(await readFile(join(directory, 'nodeProviderRestart.bin')));
assert.deepEqual(nodeProviderRestartResult.samples.at(-1).states, nodeProviderFullResult.samples.at(-1).states);

await writeFile(join(directory, 'nodeProviderRestartMissingProviderState.json'), nodeProviderRunConfiguration({
    targetTime: 3, startCheckpoint: { time: nodeProviderCheckpoint.time, states: nodeProviderCheckpoint.states }
}));
assert.notEqual(await run(executable, [
    'run', nodeProviderInput, '--configuration', join(directory, 'nodeProviderRestartMissingProviderState.json'),
    '--output', join(directory, 'nodeProviderRestartMissingProviderState.bin')
]), 0);

console.log('C++/Electron container compatibility passed.');
