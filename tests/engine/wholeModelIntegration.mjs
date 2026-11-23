/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for a whole-model method (docs/proposals/integrators.md), Runge–Kutta 4:
//   - a run configuration that says method "nodeByNode" gives the bits of one that says nothing;
//   - the serial, thread-pool and partitioned backends give the same bits;
//   - three nodes coupled through relationships give the one-node model's numbers (benchmarks/coupling/graphSplit);
//   - stepsPerGlobalStep 2 at a step H gives the bits of one step per global step at H / 2, for a model that does not read time;
//   - a run to T equals, to the bit, a run to T / 2 continued from its checkpoint, which records the method as its solver;
//   - a term written as a program (C++ and Python, the starter templates' included) is held: evaluated once per global step, at its
//     start, and read through the stages, and the result names it (a version 1 program cannot be known to be pure,
//     docs/proposals/programSdkV2.md);
//   - a node that is a program of its own is stepped on its own, as is one whose program sets its states' values (as an imported FMU),
//     and the result names it;
//   - an unknown method, a bad stepsPerGlobalStep and an unknown `requires` entry are refused by name;
// and for Adaptive (Dormand–Prince 5(4) with error control): the same bits on every backend and worker count (its error norm summed
// in node order), the split model as the one-node model, a run continued from a checkpoint (which keeps the controller's memory) to the
// bit, the error following the tolerance, steps landing on a schedule's jumps, the stiffness finding, held programs, and its refusals;
// and for Stiff (Rodas4): the same bits on every backend, the split model as the one-node model, a checkpoint continued to the bit, the
// Jacobian's structure and work in the summary, a stiff model in few steps, a schedule's jumps landed on, held programs, and no warning
// for a stiff model.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { decodeProjectFile, encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';
import { defaultNodeProviderSource, defaultProviderSource } from '../../src/providerTemplate.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const root = join(import.meta.dirname, '..', '..');
const providers = {
    cpp: { sdkPath: join(root, 'engine') },
    python: { sdkPath: join(root, 'engine', 'sdk', 'python') }
};

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateWholeModel-'));
let runs = 0;

async function modelPath(name, document) {
    const path = join(directory, `${name}.kjt`);
    await writeFile(path, await encodeProjectFile(JSON.stringify(document)));
    return path;
}

async function attempt(model, configuration) {
    const index = runs++;
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, providers, ...configuration }));
    const outcome = await execute(['run', model, '--configuration', configurationPath, '--output', outputPath]);
    return { ...outcome, result: outcome.code === 0 ? decodeResultFile(await readFile(outputPath)) : null };
}

async function run(model, configuration) {
    const { code, diagnostics, result } = await attempt(model, configuration);
    assert.equal(code, 0, `The run must succeed: ${diagnostics}`);
    return result;
}

const valuesOf = (result) => result.samples.flatMap((sample) => sample.states.map((state) => state.value));
const sameBits = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
const valueOf = (sample, stateId) => sample.states.find((state) => state.stateId === stateId).value;

try {
    const committed = async (name) => modelPath(name, JSON.parse(await decodeProjectFile(await readFile(join(root, 'benchmarks', 'coupling', 'graphSplit', `${name}.kjt`)))));
    const split = await committed('split');
    const monolithic = await committed('monolithic');
    const timing = { targetTime: 8, globalTimeStep: 0.0625, outputInterval: 0.125 };
    const rungeKutta4 = { ...timing, method: 'rungeKutta4' };

    // The default, named or not.
    assert.ok(sameBits(valuesOf(await run(split, timing)), valuesOf(await run(split, { ...timing, method: 'nodeByNode' }))),
        'method "nodeByNode" must give the bits of a configuration that names no method.');

    // Backends.
    const serial = await run(split, { ...rungeKutta4, execution: { backend: 'serial' } });
    const pool = await run(split, { ...rungeKutta4, execution: { backend: 'threadPool', workerThreads: 3 } });
    const partitioned = await run(split, { ...rungeKutta4, execution: { backend: 'partitioned', partitionCount: 3, workerThreads: 3 } });
    assert.equal(partitioned.execution.backend, 'partitioned');
    assert.ok(sameBits(valuesOf(serial), valuesOf(pool)), 'The thread pool must give the serial backend\'s bits.');
    assert.ok(sameBits(valuesOf(serial), valuesOf(partitioned)), 'The partitioned backend must give the serial backend\'s bits.');
    assert.equal(partitioned.execution.partitionCommunication.boundaryMessages, 3 * 4 * Math.round(timing.targetTime / timing.globalTimeStep),
        'Partitions must exchange one boundary message a stage.');
    assert.deepEqual(serial.integration, { method: 'rungeKutta4', stepsPerGlobalStep: 1, steppedNodeIds: [], heldTerms: [] });
    assert.equal(serial.checkpoints.at(-1).solver.kind, 'rungeKutta4');
    assert.equal(serial.checkpoints.at(-1).solver.version, 1);

    // The split model is the one-node model.
    const whole = valuesOf(await run(monolithic, { ...rungeKutta4, execution: { backend: 'serial' } }));
    const parts = valuesOf(serial);
    const largest = Math.max(...whole.map(Math.abs));
    assert.ok(parts.every((value, index) => Math.abs(value - whole[index]) <= 1e-12 * largest), 'Three nodes must give the one-node model\'s numbers.');

    // Steps per global step.
    const twice = await run(split, { ...rungeKutta4, stepsPerGlobalStep: 2 });
    const halved = await run(split, { ...rungeKutta4, globalTimeStep: timing.globalTimeStep / 2 });
    assert.ok(sameBits(valuesOf(twice), valuesOf(halved)), 'Two steps per global step must give the bits of a halved global step.');
    assert.equal(twice.integration.stepsPerGlobalStep, 2);

    // Restart.
    const checkpoint = serial.checkpoints.find((candidate) => candidate.time === timing.targetTime / 2);
    assert.ok(checkpoint, 'The run must checkpoint half way.');
    const resumed = await run(split, { ...rungeKutta4, startCheckpoint: checkpoint });
    assert.ok(sameBits(resumed.samples.at(-1).states.map((state) => state.value), serial.samples.at(-1).states.map((state) => state.value)),
        'A run continued from its checkpoint must end on the uninterrupted run\'s bits.');

    // Refusals.
    for (const [configuration, message] of [
        [{ ...timing, method: 'bdf15' }, /method "bdf15" is not one this version of Konjugate knows/],
        [{ ...rungeKutta4, stepsPerGlobalStep: 0 }, /stepsPerGlobalStep must be an integer from 1 through 10000/],
        [{ ...rungeKutta4, stepsPerGlobalStep: 2.5 }, /stepsPerGlobalStep must be an integer from 1 through 10000/]
    ]) {
        const { code, diagnostics } = await attempt(split, configuration);
        assert.notEqual(code, 0);
        assert.match(diagnostics, message);
    }
    const requiring = await modelPath('requiring', { ...JSON.parse(await decodeProjectFile(await readFile(split))), requires: ['extrapolatedCoupling'] });
    const refused = await attempt(requiring, timing);
    assert.notEqual(refused.code, 0);
    assert.match(refused.diagnostics, /requires "extrapolatedCoupling", which this version of Konjugate does not know/);

    // Programs: y' = -y on one node; z' = y on another, the coupling written as an equation or as a program.
    const decay = (couplingImplementation) => ({
        format: 'konjugate', version: 1, metadata: { units: 'SI' },
        nodes: [
            {
                id: 1, name: 'Source', position: [0, 0, 0],
                states: [{ id: 11, name: 'Y', symbol: 'y', initialValue: 1, unit: '' }],
                sourceTerms: [{ id: 101, state: 'y', expression: '-y', expressionModel: { latex: '-y', bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }], output: { stateId: 11 }, mathJson: ['Negate', 'y'] } }],
                appearance: { type: 'primitive', shape: 'box', color: '#2f6970' }
            },
            {
                id: 2, name: 'Sink', position: [2, 0, 0],
                states: [{ id: 21, name: 'Z', symbol: 'z', initialValue: 0, unit: '' }],
                sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' }
            }
        ],
        edges: [{
            id: 31, name: 'Feed', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', parameters: [],
            ...(couplingImplementation
                ? { equation: '', implementation: { ...couplingImplementation, providerApiVersion: 1, bindings: [{ key: 'y', kind: 'state', nodeId: 1, stateId: 11 }], output: { role: 'target', key: 'rate', stateId: 21 } } }
                : { equation: 'y', equationModel: { latex: 'y', bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }], output: { role: 'target', stateId: 21 }, mathJson: 'y' } })
        }]
    });
    const pythonFeed = () => `from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort


class Feed(RelationshipProvider):
    def describe(self):
        return RelationshipDescription("test.feed", "Feed", [ScalarPort("y", "Y", "")], ScalarPort("rate", "Rate", ""))

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient(inputs["y"])
`;
    const cppFeed = () => `#include <konjugate/relationshipProvider.hpp>
#include <memory>

class Feed final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"test.feed", "Feed", {{"y", "Y", ""}}, {"rate", "Rate", ""}};
    }
    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::OutputCollector& output) override {
        static_cast<void>(context);
        output.addGradient(context.inputs.at("y"));
    }
};

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<Feed>();
}
`;
    const programTiming = { targetTime: 2, globalTimeStep: 0.25, outputInterval: 0.25, method: 'rungeKutta4' };
    const equation = valuesOf(await run(await modelPath('equationFeed', decay(null)), programTiming));
    const equationResult = await run(await modelPath('equationFeedAgain', decay(null)), programTiming);
    for (const [kind, source] of [['python', pythonFeed], ['cpp', cppFeed]]) {
        const held = await run(await modelPath(`${kind}HeldFeed`, decay({ kind, source: source() })), programTiming);
        assert.deepEqual(held.integration.heldTerms, [{ sourceId: 31, stateId: 21 }], `A ${kind} program must be named as held.`);
        // Held: z' is y at the global step's start through all four stages.
        const step = programTiming.globalTimeStep;
        for (let index = 1; index < held.samples.length; ++index) {
            const rate = valueOf(held.samples[index - 1], 11);
            const expected = valueOf(held.samples[index - 1], 21) + step * (rate + 2.0 * rate + 2.0 * rate + rate) / 6.0;
            assert.ok(Object.is(valueOf(held.samples[index], 21), expected), `A held ${kind} program must be read at the step's start through its stages.`);
        }
        assert.ok(sameBits(held.samples.map((sample) => valueOf(sample, 11)), equationResult.samples.map((sample) => valueOf(sample, 11))),
            'Holding a program must not change the states it does not reach.');
    }

    // The starter templates are version 1 programs: a relationship's is held and a node's stepped on its own, in both languages.
    for (const kind of ['python', 'cpp']) {
        const templated = decay({ kind, source: defaultProviderSource(kind, [{ key: 'y' }], 'rate', 'Feed') });
        templated.nodes.push({
            id: 3, name: 'Programmed', position: [4, 0, 0],
            states: [{ id: 41, name: 'Level', symbol: 'level', initialValue: 1, unit: '' }],
            implementation: {
                kind, providerApiVersion: 1, source: defaultNodeProviderSource(kind, [{ key: 'level' }], [{ key: 'levelRate' }], 'Programmed'),
                bindings: [{ key: 'level', kind: 'state', stateId: 41 }], outputs: [{ key: 'levelRate', stateId: 41 }]
            },
            sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' }
        });
        // A C++ node provider runs in the engine's own process, as does, here, the C++ relationship's.
        const fromTemplates = await run(await modelPath(`${kind}Templates`, templated),
            { ...programTiming, ...(kind === 'cpp' ? { providers: { ...providers, executionMode: 'inProcess' } } : {}) });
        assert.deepEqual(fromTemplates.integration.heldTerms, [{ sourceId: 31, stateId: 21 }], `The ${kind} relationship template must be held.`);
        assert.deepEqual(fromTemplates.integration.steppedNodeIds, [3], `The ${kind} node template must be stepped on its own.`);
    }

    // A provider that sets its states' values, as an imported FMU: stepped on its own.
    const stepped = decay(null);
    stepped.nodes.push({
        id: 3, name: 'Co-simulated', position: [4, 0, 0],
        states: [{ id: 41, name: 'Reading', symbol: 'reading', initialValue: 0, unit: '' }],
        implementation: {
            kind: 'python', providerApiVersion: 1, bindings: [{ key: 'y', kind: 'state', nodeId: 1, stateId: 11 }],
            outputs: [{ key: 'reading', stateId: 41, setsValue: true }],
            source: `from konjugate import NodeProvider, NodeProviderDescription, ScalarPort


class Reading(NodeProvider):
    def describe(self):
        return NodeProviderDescription("test.reading", "Reading", [ScalarPort("y", "Y", "")], [ScalarPort("reading", "Reading", "")])

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient("reading", 2.0 * inputs["y"])

    def checkpoint(self):
        return b""

    def restore(self, payload):
        pass
`
        },
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' }
    });
    const steppedResult = await run(await modelPath('stepped', stepped), programTiming);
    assert.deepEqual(steppedResult.integration.steppedNodeIds, [3], 'A provider that sets its states\' values must be stepped on its own.');
    for (let index = 1; index < steppedResult.samples.length; ++index) {
        assert.ok(Object.is(valueOf(steppedResult.samples[index], 41), 2.0 * valueOf(steppedResult.samples[index - 1], 11)),
            'A stepped node must read the others as they were at the step\'s start.');
    }
    assert.ok(sameBits(steppedResult.samples.map((sample) => valueOf(sample, 11)), equation.filter((_value, index) => index % 2 === 0)),
        'A stepped node must not change the states it does not reach.');

    // Validation judges a whole-model method by the whole model's Jacobian and the method's stability function: the split masses at a
    // global step outside Runge–Kutta 4's region are flagged on the run settings, with the steps per global step that fix it, and the same
    // model at a step inside it is not; an unknown method is an error naming it.
    const validate = async (name, configuration) => {
        const document = JSON.parse(await decodeProjectFile(await readFile(split)));
        document.runConfigurations = [{ id: 900, name: 'Run', globalTimeStep: 1, outputInterval: 1, ...configuration }];
        document.activeRunConfigurationId = 900;
        const reportPath = join(directory, `${name}.report`);
        await execute(['validate', await modelPath(name, document), '--report', reportPath]);
        return decodeValidationReport(await readFile(reportPath));
    };
    const issues = (report) => [...(report.errors ?? []), ...(report.warnings ?? []), ...(report.issues ?? [])];
    const unstable = issues(await validate('unstable', { method: 'rungeKutta4', globalTimeStep: 2, outputInterval: 2 }));
    const finding = unstable.find((issue) => issue.code === 'numericsPotentiallyUnstable');
    assert.ok(finding, `A step outside the method's region must be flagged: ${JSON.stringify(unstable)}`);
    assert.match(finding.message, /unstable with Runge–Kutta 4 .* take at least \d+ steps per global step \(Run settings, Steps per global step\)/);
    assert.equal(finding.location?.kind ?? finding.entityKind, 'runConfiguration');
    const stable = issues(await validate('stable', { method: 'rungeKutta4', globalTimeStep: 0.125, outputInterval: 0.125 }));
    assert.ok(!stable.some((issue) => issue.code === 'numericsPotentiallyUnstable'), 'A step inside the region must not be flagged.');
    const unknownMethod = issues(await validate('unknownMethod', { method: 'bdf15', globalTimeStep: 0.125, outputInterval: 0.125 }));
    assert.ok(unknownMethod.some((issue) => issue.code === 'runConfigurationMethodInvalid' && /bdf15/.test(issue.message)), 'An unknown method must be an error naming it.');

    // --- Adaptive: Dormand–Prince 5(4) with error control ---
    const adaptive = { ...timing, method: 'dormandPrince54' };
    const adaptiveSerial = await run(split, { ...adaptive, execution: { backend: 'serial' } });
    for (const execution of [{ backend: 'threadPool', workerThreads: 2 }, { backend: 'threadPool', workerThreads: 3 },
        { backend: 'partitioned', partitionCount: 2, workerThreads: 2 }, { backend: 'partitioned', partitionCount: 3, workerThreads: 3 }]) {
        assert.ok(sameBits(valuesOf(adaptiveSerial), valuesOf(await run(split, { ...adaptive, execution }))),
            `Adaptive must give the serial backend's bits on ${execution.backend} with ${execution.workerThreads} workers: its error norm is summed in node order.`);
    }
    const summary = adaptiveSerial.integration;
    assert.equal(summary.method, 'dormandPrince54');
    assert.deepEqual(summary.tolerance, { relative: 1e-6, absolute: 1e-9 });
    assert.equal(summary.stepsPerGlobalStep, undefined, 'Adaptive chooses its own steps.');
    assert.ok(summary.steps >= timing.targetTime / timing.globalTimeStep, 'Adaptive lands on every global step, so takes at least one step a global step.');
    assert.ok(Number.isInteger(summary.rejectedSteps) && summary.evaluations >= 6 * summary.steps, `The summary must count the work: ${JSON.stringify(summary)}`);
    assert.ok(summary.largestStep <= timing.globalTimeStep * (1 + 1e-12), 'The global step is the largest step Adaptive takes.');
    // The split model is the one-node model under Adaptive too.
    const adaptiveWhole = valuesOf(await run(monolithic, { ...adaptive, execution: { backend: 'serial' } }));
    const adaptiveParts = valuesOf(adaptiveSerial);
    const adaptiveLargest = Math.max(...adaptiveWhole.map(Math.abs));
    assert.ok(adaptiveParts.every((value, index) => Math.abs(value - adaptiveWhole[index]) <= 1e-12 * adaptiveLargest), 'Three nodes must give the one-node model\'s numbers under Adaptive.');
    // Restart: the checkpoint keeps the controller's memory, so a run continued from it takes the uninterrupted run's steps, to the bit.
    const adaptiveCheckpoint = adaptiveSerial.checkpoints.find((candidate) => candidate.time === timing.targetTime / 2);
    assert.equal(adaptiveCheckpoint.solver.kind, 'dormandPrince54');
    assert.ok(typeof adaptiveCheckpoint.solver.state === 'string' && adaptiveCheckpoint.solver.state.length > 0, 'An Adaptive checkpoint keeps the controller\'s memory as base64.');
    const adaptiveResumed = await run(split, { ...adaptive, startCheckpoint: adaptiveCheckpoint });
    assert.ok(sameBits(adaptiveResumed.samples.at(-1).states.map((state) => state.value), adaptiveSerial.samples.at(-1).states.map((state) => state.value)),
        'An Adaptive run continued from its checkpoint must end on the uninterrupted run\'s bits.');
    // Without the controller's memory (a checkpoint made by another method) the run starts the controller afresh and still agrees closely.
    const afresh = await run(split, { ...adaptive, startCheckpoint: { ...adaptiveCheckpoint, solver: { kind: 'rungeKutta4', version: 1 } } });
    const afreshEnd = afresh.samples.at(-1).states.map((state) => state.value);
    assert.ok(afreshEnd.every((value, index) => Math.abs(value - adaptiveSerial.samples.at(-1).states[index].value) <= 1e-4), 'A controller started afresh must still keep to the tolerance.');
    // Euler and Runge–Kutta 4 checkpoints keep no hidden state.
    assert.equal(serial.checkpoints.at(-1).solver.state, undefined);

    // The tolerance sets the error: y' = -y over 8 s against e^-t, each tighter tolerance closer, with more steps.
    const decayDocument = decay(null);
    const decayModel = await modelPath('adaptiveDecay', decayDocument);
    let previous = null;
    for (const relative of [1e-4, 1e-6, 1e-8, 1e-10]) {
        const result = await run(decayModel, { targetTime: 8, globalTimeStep: 1, outputInterval: 1, method: 'dormandPrince54', tolerance: { relative, absolute: relative * 1e-3 } });
        const error = Math.max(...result.samples.map((sample) => Math.abs(valueOf(sample, 11) - Math.exp(-sample.time))));
        assert.ok(error <= 50 * relative, `At relative tolerance ${relative} the error must stay near it: ${error}.`);
        if (previous) assert.ok(error < previous.error && result.integration.steps > previous.steps, 'A tighter tolerance must give a smaller error for more steps.');
        previous = { error, steps: result.integration.steps };
    }

    // Samples stay on global steps under Adaptive too: an output interval finer than the global step is refused, as for every method.
    const { code: finerCode, diagnostics: finerDiagnostics } = await attempt(decayModel, { targetTime: 4, globalTimeStep: 1, outputInterval: 0.25, method: 'dormandPrince54' });
    assert.notEqual(finerCode, 0);
    assert.match(finerDiagnostics, /outputInterval must be an integer multiple of globalTimeStep\./);

    // Steps land on where a schedule jumps inside a global step: y' = -k y, k held at 0.5, then 3 from 0.73 s, then 1 from 1.31 s.
    const scheduled = decay(null);
    scheduled.sharedParameters = [{ id: 90, name: 'Rate', symbol: 'rate', value: 1, unit: '', mode: 'constant', schedule: { interpolation: 'hold', samples: [[0, 0.5], [0.73, 3], [1.31, 1]] } }];
    scheduled.nodes[0].sourceTerms = [{ id: 101, state: 'y', expression: '-k y', parameters: [{ id: 501, name: 'Rate', symbol: 'k', value: 1, unit: '', mode: 'constant', sharedParameterId: 90 }],
        expressionModel: { latex: '', bindings: [{ kind: 'parameter', parameterId: 501, symbol: 'k' }, { kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }], output: { stateId: 11 }, mathJson: ['Negate', ['Multiply', 'k', 'y']] } }];
    const scheduledResult = await run(await modelPath('adaptiveScheduled', scheduled), { targetTime: 2, globalTimeStep: 0.5, outputInterval: 0.5, method: 'dormandPrince54', tolerance: { relative: 1e-9, absolute: 1e-12 } });
    const exactAtTwo = Math.exp(-(0.5 * 0.73 + 3 * (1.31 - 0.73) + 1 * (2 - 1.31)));
    assert.ok(Math.abs(valueOf(scheduledResult.samples.at(-1), 11) - exactAtTwo) <= 1e-8, 'Landing on a schedule\'s jumps, the step keeps the tolerance\'s accuracy.');
    assert.ok(scheduledResult.integration.rejectedSteps <= 4, `Landing on the jumps, the steps must not be rejected again and again at them: ${JSON.stringify(scheduledResult.integration)}`);

    // A stiff model: Hairer's test says so, once, as a finding about the whole model; and validation says what stability will hold it to.
    const stiff = decay(null);
    // y' = -1000 (y - cos t): y follows cos t, and its fast mode limits the steps.
    stiff.nodes[0].sourceTerms[0] = { id: 101, state: 'y', expression: '-1000 (y - cos t)', expressionModel: { latex: '', bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }, { kind: 'time', symbol: 't' }],
        output: { stateId: 11 }, mathJson: ['Multiply', '-1000', ['Add', 'y', ['Negate', ['Cos', 't']]]] } };
    const stiffResult = await run(await modelPath('adaptiveStiff', stiff), { targetTime: 4, globalTimeStep: 1, outputInterval: 1, method: 'dormandPrince54', tolerance: { relative: 1e-3, absolute: 1e-6 } });
    const stiffFindings = stiffResult.stabilityFindings.filter((finding) => finding.code === 'adaptiveStepsLimitedByStiffness');
    assert.equal(stiffFindings.length, 1, `The stiffness test must fire once: ${JSON.stringify(stiffResult.stabilityFindings)}`);
    assert.match(stiffFindings[0].message, /looks stiff: Adaptive is taking steps limited by stability, not accuracy/);
    assert.equal(stiffFindings[0].nodeId, 0);
    assert.ok(Number.isFinite(stiffResult.integration.stiffnessDetectedAt));
    const nonStiffFindings = adaptiveSerial.stabilityFindings?.filter((finding) => finding.code === 'adaptiveStepsLimitedByStiffness') ?? [];
    assert.equal(nonStiffFindings.length, 0, 'The masses on springs are not stiff.');

    // A program is held under Adaptive: evaluated once a global step, at its start.
    const heldAdaptive = await run(await modelPath('pythonHeldAdaptive', decay({ kind: 'python', source: pythonFeed() })), { ...programTiming, method: 'dormandPrince54' });
    assert.deepEqual(heldAdaptive.integration.heldTerms, [{ sourceId: 31, stateId: 21 }]);
    for (let index = 1; index < heldAdaptive.samples.length; ++index) {
        const expected = valueOf(heldAdaptive.samples[index - 1], 21) + programTiming.globalTimeStep * valueOf(heldAdaptive.samples[index - 1], 11);
        assert.ok(Math.abs(valueOf(heldAdaptive.samples[index], 21) - expected) <= 1e-12, 'A held program must be read at the global step\'s start through every step.');
    }

    // Refusals by name: tolerances out of range, and a state's own absolute tolerance that is not a positive number.
    for (const [configuration, message] of [
        [{ ...adaptive, tolerance: { relative: 0 } }, /relative tolerance must be a number greater than 0 and less than 1/],
        [{ ...adaptive, tolerance: { relative: 1 } }, /relative tolerance must be a number greater than 0 and less than 1/],
        [{ ...adaptive, tolerance: { absolute: -1 } }, /absolute tolerance must be a finite number greater than 0/]
    ]) {
        const { code, diagnostics } = await attempt(split, configuration);
        assert.notEqual(code, 0);
        assert.match(diagnostics, message);
    }
    const badTolerance = decay(null);
    badTolerance.nodes[0].states[0].numerics = { absoluteTolerance: 0 };
    const badToleranceDocument = { ...badTolerance, runConfigurations: [{ id: 900, name: 'Run', globalTimeStep: 0.25, outputInterval: 0.25, method: 'dormandPrince54' }], activeRunConfigurationId: 900 };
    const badReportPath = join(directory, 'badTolerance.report');
    await execute(['validate', await modelPath('badTolerance', badToleranceDocument), '--report', badReportPath]);
    assert.ok(issues(decodeValidationReport(await readFile(badReportPath))).some((issue) => issue.code === 'stateAbsoluteToleranceInvalid'), 'A state\'s tolerance must be checked.');
    // A state's own absolute tolerance is used: loose ones on y and z let Adaptive take fewer steps than the run's would.
    const loose = decay(null);
    loose.nodes[0].states[0].numerics = { absoluteTolerance: 1e-2 };
    loose.nodes[1].states[0].numerics = { absoluteTolerance: 1e-2 };
    const looseSteps = (await run(await modelPath('looseTolerance', loose), { targetTime: 8, globalTimeStep: 8, outputInterval: 8, method: 'dormandPrince54', tolerance: { relative: 1e-12 } })).integration.steps;
    const tightSteps = (await run(decayModel, { targetTime: 8, globalTimeStep: 8, outputInterval: 8, method: 'dormandPrince54', tolerance: { relative: 1e-12 } })).integration.steps;
    assert.ok(looseSteps < tightSteps, `A state's own looser absolute tolerance must take fewer steps (${looseSteps} vs ${tightSteps}).`);

    // Validation under Adaptive: a stiff model is said to be held to small steps by stability; no step is called unstable.
    const stiffValidation = { ...stiff, runConfigurations: [{ id: 900, name: 'Run', globalTimeStep: 1, outputInterval: 1, method: 'dormandPrince54' }], activeRunConfigurationId: 900 };
    stiffValidation.nodes[0].sourceTerms.push({ id: 102, state: 'y', expression: '0.001 y', expressionModel: { latex: '', bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }], output: { stateId: 11 }, mathJson: ['Multiply', '0.001', 'y'] } });
    stiffValidation.nodes[1].sourceTerms = [{ id: 201, state: 'z', expression: '-0.01 z', expressionModel: { latex: '', bindings: [{ kind: 'state', nodeId: 2, stateId: 21, symbol: 'z' }], output: { stateId: 21 }, mathJson: ['Multiply', '-0.01', 'z'] } }];
    const stiffReportPath = join(directory, 'stiffValidation.report');
    await execute(['validate', await modelPath('stiffValidation', stiffValidation), '--report', stiffReportPath]);
    const stiffIssues = issues(decodeValidationReport(await readFile(stiffReportPath)));
    assert.ok(!stiffIssues.some((issue) => issue.code === 'numericsPotentiallyUnstable'), 'Adaptive keeps itself stable: no step is called unstable.');
    assert.ok(stiffIssues.some((issue) => issue.code === 'numericsStiffModel' && /Adaptive stays stable only with steps of at most about/.test(issue.message)),
        `A stiff model must be named under Adaptive: ${JSON.stringify(stiffIssues)}`);

    // --- Stiff: Rodas4, with its Jacobian's structure from the graph, coloured finite differences and Konjugate's own LU ---
    const stiffMethod = { ...timing, method: 'rodas4' };
    const stiffSerial = await run(split, { ...stiffMethod, execution: { backend: 'serial' } });
    for (const execution of [{ backend: 'threadPool', workerThreads: 2 }, { backend: 'threadPool', workerThreads: 3 },
        { backend: 'partitioned', partitionCount: 2, workerThreads: 2 }, { backend: 'partitioned', partitionCount: 3, workerThreads: 3 }]) {
        assert.ok(sameBits(valuesOf(stiffSerial), valuesOf(await run(split, { ...stiffMethod, execution }))),
            `Stiff must give the serial backend's bits on ${execution.backend} with ${execution.workerThreads} workers.`);
    }
    const stiffSummary = stiffSerial.integration;
    assert.equal(stiffSummary.method, 'rodas4');
    assert.deepEqual(stiffSummary.tolerance, { relative: 1e-6, absolute: 1e-9 });
    assert.equal(stiffSummary.stepsPerGlobalStep, undefined, 'Stiff chooses its own steps.');
    assert.ok(stiffSummary.steps >= timing.targetTime / timing.globalTimeStep, 'Stiff lands on every global step.');
    assert.equal(stiffSummary.jacobians, stiffSummary.steps, 'One Jacobian a step: a rejected step reuses its start\'s.');
    assert.equal(stiffSummary.factorisations, stiffSummary.steps + stiffSummary.rejectedSteps, 'One factorisation a step tried.');
    assert.equal(stiffSummary.linearSystemSize, 6, 'Three masses: six integrated states.');
    assert.equal(stiffSummary.sparse, false, 'Six states are solved by the dense LU.');
    // The masses on springs: each mass reads its own position and velocity and its neighbours' positions, so a few colours cover them.
    assert.ok(stiffSummary.jacobianColours >= 2 && stiffSummary.jacobianColours < 6, `The Jacobian's colours come from the graph's structure: ${JSON.stringify(stiffSummary)}`);
    assert.ok(stiffSummary.largestStep <= timing.globalTimeStep * (1 + 1e-12), 'The global step is the largest step Stiff takes.');
    // The split model is the one-node model: to the bit at fixed steps (the same equations, the same Jacobian whatever its colouring, the
    // same solves); under error control the error norm is summed node by node, so in the one-node model in one group, and a rounding
    // difference may tip a step's acceptance (an equally valid step sequence, docs/proposals/integrators.md, Determinism): within the
    // tolerance.
    const stiffFixed = { ...timing, method: 'rodas4', stepsPerGlobalStep: 1, execution: { backend: 'serial' } };
    assert.ok(sameBits(valuesOf(await run(split, stiffFixed)), valuesOf(await run(monolithic, stiffFixed))), 'Three nodes must give the one-node model\'s bits under Rodas4 at fixed steps.');
    const stiffWhole = valuesOf(await run(monolithic, { ...stiffMethod, execution: { backend: 'serial' } }));
    const stiffLargest = Math.max(...stiffWhole.map(Math.abs));
    assert.ok(valuesOf(stiffSerial).every((value, index) => Math.abs(value - stiffWhole[index]) <= 1e-6 * stiffLargest), 'Three nodes must agree with the one node within the tolerance under Stiff.');
    const stiffCheckpoint = stiffSerial.checkpoints.find((candidate) => candidate.time === timing.targetTime / 2);
    assert.equal(stiffCheckpoint.solver.kind, 'rodas4');
    assert.ok(typeof stiffCheckpoint.solver.state === 'string' && stiffCheckpoint.solver.state.length > 0, 'A Stiff checkpoint keeps the controller\'s memory.');
    const stiffResumed = await run(split, { ...stiffMethod, startCheckpoint: stiffCheckpoint });
    assert.ok(sameBits(stiffResumed.samples.at(-1).states.map((state) => state.value), stiffSerial.samples.at(-1).states.map((state) => state.value)),
        'A Stiff run continued from its checkpoint must end on the uninterrupted run\'s bits.');
    const stiffAfresh = await run(split, { ...stiffMethod, startCheckpoint: { ...stiffCheckpoint, solver: { kind: 'dormandPrince54', version: 1, state: adaptiveCheckpoint.solver.state } } });
    assert.ok(stiffAfresh.samples.at(-1).states.every((state, index) => Math.abs(state.value - stiffSerial.samples.at(-1).states[index].value) <= 1e-4),
        'Another method\'s memory is not read: the controller starts afresh and still keeps to the tolerance.');

    // The stiff model Adaptive struggled with: y' = -1000 (y - cos t), which reads the time, in few steps, without the stiffness finding.
    const stiffModel = await modelPath('stiffStiff', stiff);
    const stiffRun = await run(stiffModel, { targetTime: 4, globalTimeStep: 1, outputInterval: 1, method: 'rodas4', tolerance: { relative: 1e-6, absolute: 1e-9 } });
    // The exact solution from y(0) = 1: y = (1000^2 cos t + 1000 sin t) / (1000^2 + 1) + (1 - 1000^2 / (1000^2 + 1)) e^(-1000 t).
    const exactStiff = (time) => (1e6 * Math.cos(time) + 1e3 * Math.sin(time)) / (1e6 + 1) + (1 - 1e6 / (1e6 + 1)) * Math.exp(-1e3 * time);
    for (const sample of stiffRun.samples) {
        assert.ok(Math.abs(valueOf(sample, 11) - exactStiff(sample.time)) <= 1e-5, `Stiff must follow y' = -1000 (y - cos t) at ${sample.time} s: ${valueOf(sample, 11)} against ${exactStiff(sample.time)}.`);
    }
    // At Adaptive's tolerance above, Stiff's steps are set by accuracy, not stability: far fewer.
    const stiffLoose = await run(stiffModel, { targetTime: 4, globalTimeStep: 1, outputInterval: 1, method: 'rodas4', tolerance: { relative: 1e-3, absolute: 1e-6 } });
    assert.ok(stiffLoose.integration.steps * 10 < stiffResult.integration.steps,
        `Stiff must take far fewer steps than Adaptive on a stiff model at the same tolerance: ${stiffLoose.integration.steps} against ${stiffResult.integration.steps}.`);
    assert.equal((stiffRun.stabilityFindings ?? []).filter((finding) => finding.code === 'adaptiveStepsLimitedByStiffness').length, 0);

    // Steps land on a schedule's jumps under Stiff too.
    const stiffScheduled = await run(await modelPath('stiffScheduled', scheduled), { targetTime: 2, globalTimeStep: 0.5, outputInterval: 0.5, method: 'rodas4', tolerance: { relative: 1e-9, absolute: 1e-12 } });
    assert.ok(Math.abs(valueOf(stiffScheduled.samples.at(-1), 11) - exactAtTwo) <= 1e-8, 'Landing on a schedule\'s jumps, Stiff keeps the tolerance\'s accuracy.');
    assert.ok(stiffScheduled.integration.rejectedSteps <= 4, `Landing on the jumps, Stiff's steps must not be rejected again and again: ${JSON.stringify(stiffScheduled.integration)}`);

    // Late in a long run a step may stop a rounding short of the global step's end (t / H large): Stiff lands rather than leave a
    // remainder too small for the time to resolve.
    const longStiff = await run(decayModel, { targetTime: 600, globalTimeStep: 0.1, outputInterval: 10, method: 'rodas4' });
    assert.equal(longStiff.samples.at(-1).time, 600, 'Stiff must finish a long run with a short global step.');

    // The tolerance sets the error under Stiff too.
    let previousStiff = null;
    for (const relative of [1e-4, 1e-6, 1e-8]) {
        const result = await run(decayModel, { targetTime: 8, globalTimeStep: 1, outputInterval: 1, method: 'rodas4', tolerance: { relative, absolute: relative * 1e-3 } });
        const error = Math.max(...result.samples.map((sample) => Math.abs(valueOf(sample, 11) - Math.exp(-sample.time))));
        assert.ok(error <= 50 * relative, `Under Stiff at relative tolerance ${relative} the error must stay near it: ${error}.`);
        if (previousStiff) assert.ok(error < previousStiff.error && result.integration.steps > previousStiff.steps, 'A tighter tolerance must give a smaller error for more steps.');
        previousStiff = { error, steps: result.integration.steps };
    }

    // A program is held under Stiff: evaluated once a global step, at its start, and not differentiated.
    const heldStiff = await run(await modelPath('pythonHeldStiff', decay({ kind: 'python', source: pythonFeed() })), { ...programTiming, method: 'rodas4' });
    assert.deepEqual(heldStiff.integration.heldTerms, [{ sourceId: 31, stateId: 21 }]);
    for (let index = 1; index < heldStiff.samples.length; ++index) {
        const expected = valueOf(heldStiff.samples[index - 1], 21) + programTiming.globalTimeStep * valueOf(heldStiff.samples[index - 1], 11);
        assert.ok(Math.abs(valueOf(heldStiff.samples[index], 21) - expected) <= 1e-12, 'A held program must be read at the global step\'s start under Stiff.');
    }

    // Validation under Stiff: it is L-stable, so a stiff model is neither unstable nor worth a warning.
    const stiffMethodValidation = { ...stiffValidation, runConfigurations: [{ id: 900, name: 'Run', globalTimeStep: 1, outputInterval: 1, method: 'rodas4' }] };
    const stiffMethodReportPath = join(directory, 'stiffMethodValidation.report');
    await execute(['validate', await modelPath('stiffMethodValidation', stiffMethodValidation), '--report', stiffMethodReportPath]);
    const stiffMethodIssues = issues(decodeValidationReport(await readFile(stiffMethodReportPath)));
    assert.ok(!stiffMethodIssues.some((issue) => issue.code === 'numericsPotentiallyUnstable' || issue.code === 'numericsStiffModel'),
        `Stiff is made for a stiff model: ${JSON.stringify(stiffMethodIssues)}`);

    console.log('✓ whole-model integration: Runge–Kutta 4, Adaptive and Stiff give the same bits on every backend and from a checkpoint, make three nodes the '
        + 'one-node model, hold programs through the stages and step a node that is a program of its own; Adaptive and Stiff keep to their tolerance and land '
        + 'on a schedule\'s jumps, Adaptive says when a model is stiff and Stiff takes it in few steps; and what is not known is refused.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
