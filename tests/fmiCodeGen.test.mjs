/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Structural unit tests for src/fmiCodeGen.mjs, mirroring tests/codeExport.test.mjs's style and
// scope: what a JS test can meaningfully check is shape and embedded-data correctness, not that
// the emitted C++ actually compiles and runs correctly against the real FMI 2.0 C API -- that is
// covered end-to-end by tests/engine/fmiExportFidelity.mjs (compiles the real shared library,
// drives it through fmiGlue.cpp, and via FMPy, comparing against the real engine).

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFmiModel } from '../src/fmiCodeGen.mjs';

let nextId;
function id() { return nextId++; }

function baseDocument() {
    nextId = 1;
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'Test project' },
        runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.1 }],
        activeRunConfigurationId: 900,
        nodes: [], edges: []
    };
}

function balanced(source) {
    const opens = (source.match(/[{[(]/g) ?? []).length;
    const closes = (source.match(/[}\])]/g) ?? []).length;
    assert.equal(opens, closes, 'generated FMI model source has unbalanced delimiters.');
}

test('a state becomes an output valueReference and a live parameter becomes an input valueReference', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id(); const parameterId = id();
    document.nodes.push({
        id: nodeId, name: 'Tank',
        states: [{ id: stateId, name: 'Pressure', symbol: 'pressure', initialValue: 100, unit: 'Pa' }],
        sourceTerms: [{
            id: id(), state: 'pressure', expression: '',
            expressionModel: {
                latex: '-k p', bindings: [
                    { kind: 'state', nodeId, stateId, symbol: 'p' },
                    { kind: 'parameter', parameterId, symbol: 'k' }
                ],
                output: { stateId }, mathJson: ['Multiply', ['Negate', 'k'], 'p']
            },
            parameters: [{ id: parameterId, name: 'Decay', symbol: 'k', value: 0.5, mode: 'live', control: { minimum: 0, maximum: 1, step: 0.01 } }]
        }]
    });
    const { source, stateVariables, inputVariables } = generateFmiModel(document);
    assert.deepEqual(stateVariables, [{ valueReference: 0, causality: 'output', name: 'Tank.Pressure', unit: 'Pa', start: 100 }]);
    assert.deepEqual(inputVariables, [{ valueReference: 1, causality: 'input', name: 'k', unit: '', start: 0.5 }]);
    // 0.5 legitimately appears once, as liveInput_1's own default member value (used before any
    // fmi2SetReal call) -- the point of this assertion is that the *contribution expression*
    // itself references the input, not a baked literal, unlike the plain export's behavior.
    assert.match(source, /double liveInput_1 = 0\.5;/);
    assert.match(source, /double contributionValue = \(\(-liveInput_1\) \* state\[0\]\);/);
    balanced(source);
});

test('a constant parameter is still baked as a literal, unlike a live one', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id(); const parameterId = id();
    document.nodes.push({
        id: nodeId, name: 'Node', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId, symbol: 'k' }], output: { stateId }, mathJson: 'k' },
            parameters: [{ id: parameterId, name: 'Gain', symbol: 'k', value: 7.5, mode: 'constant' }]
        }]
    });
    const { source, inputVariables } = generateFmiModel(document);
    assert.equal(inputVariables.length, 0, 'A constant parameter must not become an FMI input.');
    assert.match(source, /double contributionValue = 7\.5;/);
});

test('setInput and getOutput switch on the assigned valueReferences', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id(); const parameterId = id();
    document.nodes.push({
        id: nodeId, name: 'Node', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            expressionModel: { latex: 'k', bindings: [{ kind: 'parameter', parameterId, symbol: 'k' }], output: { stateId }, mathJson: 'k' },
            parameters: [{ id: parameterId, name: 'Gain', symbol: 'k', value: 1, mode: 'live', control: { minimum: 0, maximum: 10, step: 1 } }]
        }]
    });
    const { source } = generateFmiModel(document);
    assert.match(source, /case 1: liveInput_1 = value; break;/);
    assert.match(source, /case 0: return state_\[0\];/);
    assert.match(source, /class GeneratedModel final : public konjugate::sdk::v1::SimulationModel/);
    assert.match(source, /std::unique_ptr<konjugate::sdk::v1::SimulationModel> konjugate::sdk::v1::createSimulationModel\(\)/);
});

test('globalTimeStep is read from the active run configuration', () => {
    const document = baseDocument();
    document.runConfigurations = [{ id: 900, globalTimeStep: 0.02, outputInterval: 0.02 }];
    const { source } = generateFmiModel(document);
    assert.match(source, /double globalTimeStep\(\) const override \{ return 0\.02; \}/);
});

test('a same-language (C++) relationship provider is embedded and callable', () => {
    const document = baseDocument();
    const nodeAId = id(); const stateAId = id();
    const nodeBId = id(); const stateBId = id();
    document.nodes.push(
        { id: nodeAId, name: 'A', states: [{ id: stateAId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: nodeBId, name: 'B', states: [{ id: stateBId, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'Coupling', source: { nodeId: nodeAId, stateId: stateAId }, target: { nodeId: nodeBId, stateId: stateBId },
        directionality: 'directed',
        implementation: {
            kind: 'cpp', providerApiVersion: 1,
            source: '#include <konjugate/relationshipProvider.hpp>\n\nnamespace {\nclass Doubler final : public konjugate::sdk::v1::RelationshipProvider {\npublic:\n    konjugate::sdk::v1::RelationshipDescription describe() const override {\n        return {"d", "D", {konjugate::sdk::v1::ScalarPort{"input", "input", ""}}, konjugate::sdk::v1::ScalarPort{"output", "output", ""}};\n    }\n    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::OutputCollector& output) override {\n        output.addGradient(2.0 * context.inputs.at("input"));\n    }\n};\n}\n\nstd::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {\n    return std::make_unique<Doubler>();\n}\n',
            bindings: [{ key: 'input', kind: 'state', nodeId: nodeAId, stateId: stateAId }],
            output: { key: 'output', role: 'target', stateId: stateBId }
        },
        parameters: []
    });
    const { source } = generateFmiModel(document);
    assert.match(source, /namespace provider0 \{/);
    assert.match(source, /class Doubler final/);
    assert.match(source, /provider0Instance->evaluate\(/);
    balanced(source);
});

test('a Python provider blocks FMU export -- an FMU is a compiled binary, C++ only', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Controller', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: { kind: 'python', providerApiVersion: 1, source: 'from konjugate import RelationshipProvider\n', bindings: [], output: { key: 'output', stateId } }
        }]
    });
    assert.throws(() => generateFmiModel(document), /"Controller"[\s\S]*Python[\s\S]*C\+\+/);
});

test('a node-level computational provider always blocks FMU export', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Controlled', states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }],
        sourceTerms: [],
        implementation: {
            kind: 'python', providerApiVersion: 1,
            source: 'from konjugate import NodeProvider\n', bindings: [{ key: 'level', kind: 'state', stateId }], outputs: [{ key: 'rate', stateId }]
        }
    });
    assert.throws(() => generateFmiModel(document), /"Controlled"[\s\S]*no C\+\+ equivalent/);
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
    const { source } = generateFmiModel(document);
    const negations = (source.match(/contributionValue = -contributionValue/g) ?? []).length;
    assert.equal(negations, 1);
});
