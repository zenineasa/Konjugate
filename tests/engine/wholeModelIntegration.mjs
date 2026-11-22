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
//   - an unknown method, a bad stepsPerGlobalStep and an unknown `requires` entry are refused by name.

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
        [{ ...timing, method: 'dormandPrince54' }, /method "dormandPrince54" is not one this version of Konjugate knows/],
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
    const unknownMethod = issues(await validate('unknownMethod', { method: 'dormandPrince54', globalTimeStep: 0.125, outputInterval: 0.125 }));
    assert.ok(unknownMethod.some((issue) => issue.code === 'runConfigurationMethodInvalid' && /dormandPrince54/.test(issue.message)), 'An unknown method must be an error naming it.');

    console.log('✓ whole-model integration: Runge–Kutta 4 gives the same bits on every backend and from a checkpoint, makes three nodes the one-node model, '
        + 'holds programs through the stages, steps a node that is a program of its own, and refuses what it does not know.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
