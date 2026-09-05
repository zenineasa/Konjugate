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
    const { source, stateVariables, parameterVariables } = generateFmiModel(document);
    assert.deepEqual(stateVariables, [{ valueReference: 0, causality: 'output', variability: 'continuous', name: 'Tank.Pressure', unit: 'Pa', start: 100 }]);
    assert.deepEqual(parameterVariables, [{ valueReference: 1, causality: 'input', variability: 'continuous', name: 'k', unit: '', start: 0.5 }]);
    // 0.5 legitimately appears once, as parameterValue_1's own default member value (used before
    // any fmi2SetReal call) -- the point of this assertion is that the *contribution expression*
    // itself references the parameter member, not a baked literal, unlike the plain export's
    // behavior.
    assert.match(source, /double parameterValue_1 = 0\.5;/);
    assert.match(source, /double contributionValue = \(\(-parameterValue_1\) \* state\[0\]\);/);
    balanced(source);
});

test('a constant parameter also becomes a real FMI variable, but tunable rather than a continuous input', () => {
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
    const { source, parameterVariables } = generateFmiModel(document);
    assert.deepEqual(parameterVariables, [{ valueReference: 1, causality: 'parameter', variability: 'tunable', name: 'k', unit: '', start: 7.5 }]);
    // Unlike the plain export (which always bakes a constant parameter as a literal, since a
    // standalone program has no runtime control stream), the FMU export makes every parameter --
    // live or not -- a real, settable member, so a host can tune it via fmi2SetReal.
    assert.match(source, /double contributionValue = parameterValue_1;/);
    assert.doesNotMatch(source, /double contributionValue = 7\.5;/);
});

test('setInput and getOutput switch on the assigned valueReferences, including a parameter\'s own readback', () => {
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
    assert.match(source, /case 1: parameterValue_1 = value; break;/);
    assert.match(source, /case 0: return state_\[0\];/);
    // getOutput must also answer a parameter's own value reference (fmi2GetReal on an
    // input/parameter causality variable, e.g. reading back what fmi2SetReal just set) -- not
    // fall through to the hardcoded 0.0 default.
    assert.match(source, /case 1: return parameterValue_1;/);
    assert.match(source, /class GeneratedModel final : public konjugate::sdk::v1::SimulationModel/);
    assert.match(source, /std::unique_ptr<konjugate::sdk::v1::SimulationModel> konjugate::sdk::v1::createSimulationModel\(\)/);
});

test('a providerless model supports state capture (rollback); one with a provider does not', () => {
    const withoutProvider = baseDocument();
    const nodeId1 = id(); const stateId1 = id();
    withoutProvider.nodes.push({ id: nodeId1, name: 'Node', states: [{ id: stateId1, name: 'X', symbol: 'x', initialValue: 0, unit: '' }], sourceTerms: [] });
    const { source: sourceWithoutProvider, supportsStateCapture: withoutProviderSupport } = generateFmiModel(withoutProvider);
    assert.equal(withoutProviderSupport, true);
    assert.match(sourceWithoutProvider, /bool supportsStateCapture\(\) const override \{ return true; \}/);
    assert.match(sourceWithoutProvider, /std::vector<double> captureState\(\) const override \{/);
    assert.match(sourceWithoutProvider, /void restoreState\(const std::vector<double>& snapshot\) override \{/);
    balanced(sourceWithoutProvider);

    const withProvider = baseDocument();
    const nodeId2 = id(); const stateId2 = id();
    withProvider.nodes.push({
        id: nodeId2, name: 'Node', states: [{ id: stateId2, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: {
                kind: 'cpp', providerApiVersion: 1,
                source: '#include <konjugate/relationshipProvider.hpp>\n\nnamespace {\nclass P final : public konjugate::sdk::v1::RelationshipProvider {\npublic:\n    konjugate::sdk::v1::RelationshipDescription describe() const override { return {"p", "P", {}, konjugate::sdk::v1::ScalarPort{"output", "output", ""}}; }\n    void evaluate(const konjugate::sdk::v1::EvaluationContext&, konjugate::sdk::v1::OutputCollector& output) override { output.addGradient(1.0); }\n};\n}\n\nstd::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() { return std::make_unique<P>(); }\n',
                bindings: [], output: { key: 'output', stateId: stateId2 }
            }
        }]
    });
    const { source: sourceWithProvider, supportsStateCapture: withProviderSupport } = generateFmiModel(withProvider);
    assert.equal(withProviderSupport, false);
    assert.doesNotMatch(sourceWithProvider, /supportsStateCapture/, 'A model with a provider should not override supportsStateCapture -- it inherits the base class default (false).');
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
