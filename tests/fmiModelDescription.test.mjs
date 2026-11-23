/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelDescription, FmiModelDescriptionError } from '../src/fmiModelDescription.mjs';

function fmi2Xml({ coSimulation = true, variables = '', fmiVersion = '2.0', guid = 'guid-1' } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="${fmiVersion}" modelName="TestModel" guid="${guid}" generationTool="Test">
    ${coSimulation ? `<CoSimulation modelIdentifier="testModel" canHandleVariableCommunicationStepSize="true" canGetAndSetFMUstate="true" canSerializeFMUstate="true"/>` : ''}
    <ModelVariables>
        ${variables}
    </ModelVariables>
</fmiModelDescription>`;
}

test('parses a well-formed FMI 2.0 Co-Simulation modelDescription', () => {
    const xml = fmi2Xml({
        variables: `
            <ScalarVariable name="x" valueReference="0" causality="output" variability="continuous" initial="exact">
                <Real start="0"/>
            </ScalarVariable>
            <ScalarVariable name="k" valueReference="1" causality="input" variability="continuous">
                <Real start="0.5"/>
            </ScalarVariable>
            <ScalarVariable name="c" valueReference="2" causality="parameter" variability="tunable">
                <Real start="1.5"/>
            </ScalarVariable>
        `
    });
    const description = parseModelDescription(xml);
    assert.equal(description.fmiVersion, '2.0');
    assert.equal(description.guid, 'guid-1');
    assert.equal(description.modelIdentifier, 'testModel');
    assert.equal(description.canGetAndSetFMUState, true);
    assert.equal(description.variables.length, 3);
    assert.deepEqual(description.variables[0], { name: 'x', valueReference: 0, causality: 'output', type: 'Real', variability: 'continuous', start: 0 });
    assert.equal(description.variables[1].causality, 'input');
    assert.equal(description.variables[2].causality, 'parameter');
    assert.equal(description.variables[2].start, 1.5);
});

test('a single ScalarVariable is still returned as an array entry, not collapsed', () => {
    const xml = fmi2Xml({ variables: `<ScalarVariable name="x" valueReference="0" causality="output"><Real start="0"/></ScalarVariable>` });
    const description = parseModelDescription(xml);
    assert.equal(description.variables.length, 1);
});

test('rejects an FMU with no CoSimulation element (Model Exchange only)', () => {
    const xml = fmi2Xml({ coSimulation: false });
    assert.throws(() => parseModelDescription(xml), FmiModelDescriptionError);
    assert.throws(() => parseModelDescription(xml), /Co-Simulation/);
});

test('skips variables whose causality is not input/output/parameter, even non-Real ones', () => {
    const xml = fmi2Xml({
        variables: `
            <ScalarVariable name="t" valueReference="0" causality="independent"><Real start="0"/></ScalarVariable>
            <ScalarVariable name="internalFlag" valueReference="1" causality="local"><Boolean start="true"/></ScalarVariable>
            <ScalarVariable name="x" valueReference="2" causality="output"><Real start="0"/></ScalarVariable>
        `
    });
    const description = parseModelDescription(xml);
    assert.equal(description.variables.length, 1);
    assert.equal(description.variables[0].name, 'x');
});

test('Integer, Boolean and Enumeration variables are ports with their type; a String is listed as not exposed', () => {
    const xml = fmi2Xml({
        variables: `
            <ScalarVariable name="mode" valueReference="0" causality="input"><Integer start="2"/></ScalarVariable>
            <ScalarVariable name="on" valueReference="1" causality="output" variability="discrete"><Boolean/></ScalarVariable>
            <ScalarVariable name="option" valueReference="2" causality="parameter" variability="fixed"><Enumeration declaredType="Option" start="1"/></ScalarVariable>
            <ScalarVariable name="label" valueReference="3" causality="input"><String start="x"/></ScalarVariable>
        `
    });
    const description = parseModelDescription(xml);
    assert.deepEqual(description.variables.map(({ name, type, start }) => ({ name, type, start })), [
        { name: 'mode', type: 'Integer', start: 2 }, { name: 'on', type: 'Boolean', start: undefined }, { name: 'option', type: 'Enumeration', start: 1 }
    ]);
    assert.deepEqual(description.notExposed, [{ name: 'label', causality: 'input', type: 'String' }]);
});

test('an FMU offering only Model Exchange is refused saying so', () => {
    const xml = fmi2Xml({ coSimulation: false }).replace('<ModelVariables>', '<ModelExchange modelIdentifier="m"/><ModelVariables>');
    assert.throws(() => parseModelDescription(xml), /offers only Model Exchange\. Konjugate runs FMUs in Co-Simulation/);
});

test('rejects malformed XML with a clear error, not a garbled parse', () => {
    assert.throws(() => parseModelDescription('<fmiModelDescription><CoSimulation></fmiModelDescription>'), FmiModelDescriptionError);
});

test('rejects an FMU missing a guid', () => {
    const xml = fmi2Xml({ guid: '' });
    assert.throws(() => parseModelDescription(xml), /guid/);
});

test('a "3.x" fmiVersion dispatches to the FMI3 parser, not the FMI2 one', () => {
    const xml = fmi2Xml({ fmiVersion: '3.0' });
    // fmi2Xml's shape (guid attribute, <ScalarVariable><Real/></ScalarVariable>) is FMI2-only --
    // the point here is just that a "3.x" version string dispatches to the FMI3 parser rather
    // than being misread as FMI2, so it should fail on the FMI3-specific instantiationToken check.
    assert.throws(() => parseModelDescription(xml), /instantiationToken/);
});

test('rejects an unsupported/missing fmiVersion', () => {
    const xml = fmi2Xml({ fmiVersion: '1.0' });
    assert.throws(() => parseModelDescription(xml), /Unsupported fmiVersion/);
});

function fmi3Xml({ coSimulation = true, variables = '', instantiationToken = 'token-1' } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="3.0" modelName="TestModel3" instantiationToken="${instantiationToken}">
    ${coSimulation ? `<CoSimulation modelIdentifier="testModel3" canHandleVariableCommunicationStepSize="true" canGetAndSetFMUState="true" canSerializeFMUState="true"/>` : ''}
    <ModelVariables>
        ${variables}
    </ModelVariables>
</fmiModelDescription>`;
}

test('parses a well-formed FMI 3.0 Co-Simulation modelDescription', () => {
    const xml = fmi3Xml({
        variables: `
            <Float64 name="x" valueReference="0" causality="output" variability="continuous" start="0"/>
            <Float64 name="k" valueReference="1" causality="input" variability="continuous" start="0.5"/>
            <Float64 name="c" valueReference="2" causality="parameter" variability="tunable" start="1.5"/>
        `
    });
    const description = parseModelDescription(xml);
    assert.equal(description.fmiVersion, '3.0');
    assert.equal(description.guid, 'token-1');
    assert.equal(description.modelIdentifier, 'testModel3');
    assert.equal(description.canGetAndSetFMUState, true);
    assert.equal(description.variables.length, 3);
    assert.deepEqual(description.variables[0], { name: 'x', valueReference: 0, causality: 'output', type: 'Float64', variability: 'continuous', start: 0 });
});

test('a single FMI3 Float64 variable is still returned as an array entry, not collapsed', () => {
    const xml = fmi3Xml({ variables: `<Float64 name="x" valueReference="0" causality="output" start="0"/>` });
    assert.equal(parseModelDescription(xml).variables.length, 1);
});

test('FMI3: rejects an FMU with no CoSimulation element', () => {
    const xml = fmi3Xml({ coSimulation: false });
    assert.throws(() => parseModelDescription(xml), /Co-Simulation/);
});

test('FMI3: skips variables whose causality is not input/output/parameter, even non-Float64 ones', () => {
    const xml = fmi3Xml({
        variables: `
            <Float64 name="t" valueReference="0" causality="independent"/>
            <Boolean name="internalFlag" valueReference="1" causality="local"/>
            <Float64 name="x" valueReference="2" causality="output"/>
        `
    });
    const description = parseModelDescription(xml);
    assert.equal(description.variables.length, 1);
    assert.equal(description.variables[0].name, 'x');
});

test('FMI3: integer, Float32 and Boolean variables are ports with their type, discrete unless they say otherwise', () => {
    const xml = fmi3Xml({ variables: `<Int32 name="mode" valueReference="0" causality="input"/><Float32 name="f" valueReference="1" causality="output"/><Boolean name="b" valueReference="2" causality="output"/>` });
    assert.deepEqual(parseModelDescription(xml).variables.map(({ name, type, variability }) => ({ name, type, variability })), [
        { name: 'f', type: 'Float32', variability: 'continuous' }, { name: 'mode', type: 'Int32', variability: 'discrete' }, { name: 'b', type: 'Boolean', variability: 'discrete' }
    ]);
});

test('FMI3: an array, a String, a Binary or a Clock is not a port, and is listed as not exposed', () => {
    const xml = fmi3Xml({ variables: `
        <Float64 name="vector" valueReference="0" causality="input"><Dimension start="3"/></Float64>
        <String name="label" valueReference="1" causality="input"/>
        <Binary name="blob" valueReference="2" causality="output"/>
        <Float64 name="x" valueReference="3" causality="output"/>` });
    const description = parseModelDescription(xml);
    assert.deepEqual(description.variables.map((variable) => variable.name), ['x']);
    assert.deepEqual(description.notExposed, [
        { name: 'vector', causality: 'input', type: 'Float64 array' }, { name: 'label', causality: 'input', type: 'String' }, { name: 'blob', causality: 'output', type: 'Binary' }
    ]);
});

test('FMI3: rejects an FMU missing an instantiationToken', () => {
    const xml = fmi3Xml({ instantiationToken: '' });
    assert.throws(() => parseModelDescription(xml), /instantiationToken/);
});
