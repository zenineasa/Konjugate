/* Copyright © 2026 Zenin Easa Panthakkalakath */

// These tests cover what a JS unit test can meaningfully check: structural shape and
// embedded-data correctness of the generated source. Actual numerical fidelity against the real
// engine (Explicit Euler, snapshot semantics, provider embedding) was verified by compiling and
// running the generated C++/Python output against hand-computed expected trajectories -- not
// reproduced here, since that would mean re-implementing a C++ compiler and a Python interpreter
// in JS. See docs/codeExport.md.

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateStandaloneProgram } from '../src/codeExport.mjs';

let nextId;
function id() { return nextId++; }

function baseDocument() {
    nextId = 1;
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'Test project' },
        runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.1 }],
        activeRunConfigurationId: 900,
        exportDefaultTargetTime: 5,
        nodes: [], edges: []
    };
}

function balanced(source, openers, closers) {
    const opens = (source.match(openers) ?? []).length;
    const closes = (source.match(closers) ?? []).length;
    assert.equal(opens, closes, 'generated source has unbalanced delimiters.');
}

function singleNodeSourceTermModel() {
    const document = baseDocument();
    const nodeId = id();
    const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Tank',
        states: [{ id: stateId, name: 'Pressure', symbol: 'pressure', initialValue: 100, unit: 'Pa' }],
        sourceTerms: [{
            id: id(), state: 'pressure', expression: '',
            expressionModel: {
                latex: '-0.1 p', bindings: [{ kind: 'state', nodeId, stateId, symbol: 'p' }],
                output: { stateId }, mathJson: ['Multiply', '-0.1', 'p']
            }
        }]
    });
    return document;
}

test('single-node equation model emits the expression, the Euler update and the CSV header', () => {
    for (const kind of ['cpp', 'python']) {
        const source = generateStandaloneProgram(singleNodeSourceTermModel(), kind);
        assert.match(source, /-0\.1/);
        assert.match(source, /derivative\[0\] \+= contribution/);
        assert.match(source, /time \(s\),Tank — Pressure \(Pa\)/);
    }
});

test('C++ output compiles-shaped constructs: constexpr timestep, isfinite guard, snapshot seeding', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp');
    assert.match(source, /constexpr double globalTimeStep = 0\.1;/);
    assert.match(source, /std::isfinite\(contributionValue\)/);
    assert.match(source, /double state\[1\] = \{ snapshot\[0\] \};/);
    balanced(source, /[{[]/g, /[}\]]/g);
    balanced(source, /\(/g, /\)/g);
});

test('Python output uses math.isfinite and seeds each node from the frozen snapshot', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'python');
    assert.match(source, /math\.isfinite\(contribution_value\)/);
    assert.match(source, /state = \[snapshot\[0\]\]/);
    balanced(source, /[{[(]/g, /[}\])]/g);
});

test('a cross-node edge reads the snapshot array, not the owning node\'s local array', () => {
    const document = baseDocument();
    const nodeAId = id(); const stateAId = id();
    const nodeBId = id(); const stateBId = id();
    document.nodes.push(
        { id: nodeAId, name: 'A', states: [{ id: stateAId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: nodeBId, name: 'B', states: [{ id: stateBId, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'A to B', source: { nodeId: nodeAId, stateId: stateAId }, target: { nodeId: nodeBId, stateId: stateBId },
        directionality: 'directed',
        equationModel: {
            latex: 'x', bindings: [{ kind: 'state', role: 'source', nodeId: nodeAId, stateId: stateAId, symbol: 'x' }],
            output: { role: 'target', stateId: stateBId }, mathJson: 'x'
        },
        parameters: []
    });
    const source = generateStandaloneProgram(document, 'cpp');
    assert.match(source, /double contributionValue = snapshot\[0\];/);
});

test('a bidirectional edge negates the contribution on its other endpoint', () => {
    const document = baseDocument();
    const nodeAId = id(); const stateAId = id();
    const nodeBId = id(); const stateBId = id();
    document.nodes.push(
        { id: nodeAId, name: 'A', states: [{ id: stateAId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: nodeBId, name: 'B', states: [{ id: stateBId, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'Coupling', source: { nodeId: nodeAId, stateId: stateAId }, target: { nodeId: nodeBId, stateId: stateBId },
        directionality: 'bidirectional',
        equationModel: {
            latex: 'x', bindings: [{ kind: 'state', role: 'source', nodeId: nodeAId, stateId: stateAId, symbol: 'x' }],
            output: { role: 'target', stateId: stateBId }, mathJson: 'x'
        },
        parameters: []
    });
    const source = generateStandaloneProgram(document, 'python');
    const negations = (source.match(/contribution_value = -contribution_value/g) ?? []).length;
    assert.equal(negations, 1, 'exactly one endpoint of a bidirectional edge should negate its contribution.');
});

test('a disabled node contributes no states and an edge touching it is excluded', () => {
    const document = baseDocument();
    const enabledId = id(); const enabledStateId = id();
    const disabledId = id(); const disabledStateId = id();
    document.nodes.push(
        { id: enabledId, name: 'Kept', states: [{ id: enabledStateId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: disabledId, name: 'Dropped', enabled: false, states: [{ id: disabledStateId, name: 'Y', symbol: 'y', initialValue: 1, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'Into disabled', source: { nodeId: enabledId, stateId: enabledStateId }, target: { nodeId: disabledId, stateId: disabledStateId },
        directionality: 'directed',
        equationModel: {
            latex: 'x', bindings: [{ kind: 'state', role: 'source', nodeId: enabledId, stateId: enabledStateId, symbol: 'x' }],
            output: { role: 'target', stateId: disabledStateId }, mathJson: 'x'
        },
        parameters: []
    });
    const source = generateStandaloneProgram(document, 'cpp');
    assert.doesNotMatch(source, /Dropped/);
    assert.match(source, /globalState = \{ 1 \};/);
});

test('a live parameter is emitted as a plain constant, not a runtime override', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id(); const parameterId = id();
    document.nodes.push({
        id: nodeId, name: 'Node', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            expressionModel: {
                latex: 'k', bindings: [{ kind: 'parameter', parameterId, symbol: 'k' }],
                output: { stateId }, mathJson: 'k'
            },
            parameters: [{ id: parameterId, name: 'Gain', symbol: 'k', value: 7.5, mode: 'live', control: { minimum: 0, maximum: 10, step: 0.1 } }]
        }]
    });
    const source = generateStandaloneProgram(document, 'cpp');
    assert.match(source, /double contributionValue = 7\.5;/);
});

test('a same-language relationship provider is embedded and callable', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Node', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: {
                kind: 'python', providerApiVersion: 1,
                source: 'from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort\n\n\nclass DoubleIt(RelationshipProvider):\n    def describe(self):\n        return RelationshipDescription("d", "D", [ScalarPort("input", "Input", "")], ScalarPort("output", "Output", ""))\n\n    def evaluate(self, context, inputs, outputs):\n        outputs.add_gradient(2.0 * inputs["input"])\n',
                bindings: [{ key: 'input', kind: 'state', nodeId, stateId }],
                output: { key: 'output', stateId }
            }
        }]
    });
    const source = generateStandaloneProgram(document, 'python');
    assert.match(source, /class DoubleItProvider0\(RelationshipProvider\):/);
    assert.doesNotMatch(source, /from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort\n\n\nclass DoubleItProvider0/);
    assert.match(source, /doubleItProvider0\.evaluate\(/);
    assert.match(source, /outputs\.add_gradient\(2\.0 \* inputs\["input"\]\)/);
});

test('a cross-language provider blocks export with a descriptive, node-naming error', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Controller', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: {
                kind: 'cpp', providerApiVersion: 1,
                source: '#include <konjugate/relationshipProvider.hpp>\n',
                bindings: [], output: { key: 'output', stateId }
            }
        }]
    });
    assert.throws(() => generateStandaloneProgram(document, 'python'), /"Controller"[\s\S]*C\+\+[\s\S]*Python/);
});

test('a plugin-referenced provider always blocks export', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Plugged', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: { kind: 'plugin', pluginId: 'example', pluginVersion: 1, providerId: 'p', bindings: [], output: { key: 'output', stateId } }
        }]
    });
    assert.throws(() => generateStandaloneProgram(document, 'cpp'), /"Plugged"[\s\S]*plugin/);
    assert.throws(() => generateStandaloneProgram(document, 'python'), /"Plugged"[\s\S]*plugin/);
});

test('a node-level computational provider always blocks C++ export', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Controlled', states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }],
        sourceTerms: [],
        implementation: {
            kind: 'python', providerApiVersion: 1,
            source: 'from konjugate import NodeOutputCollector, NodeProvider, NodeProviderDescription, ScalarPort\n\n\nclass Controller(NodeProvider):\n    def describe(self):\n        return NodeProviderDescription("c", "C", [ScalarPort("level", "Level", "")], [ScalarPort("rate", "Rate", "")])\n\n    def evaluate(self, context, inputs, outputs):\n        outputs.add_gradient("rate", 1.0)\n\n    def checkpoint(self):\n        return b""\n\n    def restore(self, payload):\n        pass\n',
            bindings: [{ key: 'level', kind: 'state', stateId }],
            outputs: [{ key: 'rate', stateId }]
        }
    });
    assert.throws(() => generateStandaloneProgram(document, 'cpp'), /"Controlled"[\s\S]*no C\+\+ equivalent/);
    const python = generateStandaloneProgram(document, 'python');
    assert.match(python, /class ControllerProvider0\(NodeProvider\):/);
    assert.match(python, /node_outputs\.gradients\.get\("rate", 0\.0\)/);
});
