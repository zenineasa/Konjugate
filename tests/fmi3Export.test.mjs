/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The FMI 3.0 export's pure-JS parts (src/fmiExport.mjs): its modelDescription.xml and the source it compiles, against the FMI 2.0
// export of the same model -- the same model, variables, value references and refusals, with FMI 3.0's own shape (typed <Float64>
// variables, an instantiationToken, an independent "time", declared units, <Output> by value reference). Building, running and
// validating a real FMI 3.0 FMU needs the engine and FMPy: tests/engine/fmiExportFidelity.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { zipSync, unzipSync } from 'fflate';
import { describeFmu, fmiVersions, mergeFmuPackages, platformDirectory } from '../src/fmiExport.mjs';
import { parseModelDescription } from '../src/fmiModelDescription.mjs';
import { document as fixtureDocument } from './engine/fixtures/fmuFidelityFixture.mjs';
import { exportDocument, fmiExamples } from '../scripts/fmiExamples.mjs';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: (name) => ['Float64', 'Unit', 'Output', 'InitialUnknown'].includes(name) });

function withMethod(document, method) {
    return { ...document, runConfigurations: [{ id: 900, name: 'x', globalTimeStep: 0.1, outputInterval: 0.2, method }], activeRunConfigurationId: 900 };
}

test('FMI 2.0 stays the default and FMI 3.0 is offered beside it', () => {
    assert.deepEqual(fmiVersions, ['2.0', '3.0']);
    assert.equal(describeFmu(fixtureDocument, 'fixture').fmiVersion, '2.0');
    assert.equal(describeFmu(fixtureDocument, 'fixture').xml, describeFmu(fixtureDocument, 'fixture', { fmiVersion: '2.0' }).xml);
    assert.throws(() => describeFmu(fixtureDocument, 'fixture', { fmiVersion: '1.0' }), /FMI 2\.0 or FMI 3\.0/);
});

test('an FMI 3.0 export has the FMI 2.0 export\'s variables, value references, starts and rollback', () => {
    const fmi2 = parseModelDescription(describeFmu(fixtureDocument, 'fixture').xml);
    const fmi3 = parseModelDescription(describeFmu(fixtureDocument, 'fixture', { fmiVersion: '3.0' }).xml);
    assert.equal(fmi3.fmiVersion, '3.0');
    assert.equal(fmi3.modelIdentifier, fmi2.modelIdentifier);
    assert.equal(fmi3.canGetAndSetFMUState, fmi2.canGetAndSetFMUState);
    const shape = (variables) => variables.map(({ name, valueReference, causality, variability, start }) => ({ name, valueReference, causality, variability, start }))
        .sort((a, b) => a.valueReference - b.valueReference);
    assert.deepEqual(shape(fmi3.variables), shape(fmi2.variables));
    assert.ok(fmi3.variables.every((variable) => variable.type === 'Float64'));
    assert.ok(fmi3.variables.some((variable) => variable.causality === 'input'), 'The fixture\'s live parameter is an input.');
    assert.ok(fmi3.variables.some((variable) => variable.causality === 'parameter' && variable.variability === 'tunable'));
});

test('an FMI 3.0 modelDescription.xml has the elements and attributes FMI 3.0 asks for', () => {
    const { xml, source } = describeFmu(fixtureDocument, 'fixture', { fmiVersion: '3.0' });
    const root = parser.parse(xml).fmiModelDescription;
    assert.equal(root.fmiVersion, '3.0');
    assert.match(root.instantiationToken, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
    assert.equal(root.ModelExchange, undefined, 'Co-Simulation only.');
    const coSimulation = root.CoSimulation;
    for (const attribute of ['hasEventMode', 'mightReturnEarlyFromDoStep', 'canReturnEarlyAfterIntermediateUpdate', 'providesIntermediateUpdate', 'providesDirectionalDerivatives']) {
        assert.equal(coSimulation[attribute], 'false', attribute);
    }
    assert.equal(coSimulation.canHandleVariableCommunicationStepSize, 'true');
    assert.equal(Number(coSimulation.fixedInternalStepSize), fixtureDocument.runConfigurations?.[0]?.globalTimeStep ?? 0.01);

    const variables = root.ModelVariables.Float64;
    const independent = variables.filter((variable) => variable.causality === 'independent');
    assert.equal(independent.length, 1, 'Exactly one independent variable (FMI 3.0 section 2.4.7.4).');
    assert.equal(independent[0].name, 'time');
    assert.equal(Number(independent[0].valueReference), variables.length - 1, 'time comes after every other value reference.');
    assert.equal(new Set(variables.map((variable) => variable.valueReference)).size, variables.length);

    const declared = new Set(root.UnitDefinitions.Unit.map((unit) => unit.name));
    for (const variable of variables) if (variable.unit) assert.ok(declared.has(variable.unit), `${variable.name}'s unit ${variable.unit} is declared.`);

    const outputs = variables.filter((variable) => variable.causality === 'output');
    assert.deepEqual(root.ModelStructure.Output.map((output) => output.valueReference), outputs.map((output) => output.valueReference));
    assert.ok(outputs.every((output) => output.initial === 'exact' && output.start !== undefined));
    assert.equal(root.ModelStructure.InitialUnknown, undefined, 'Outputs with initial="exact" are not initial unknowns (FMI 3.0 section 2.4.8).');

    // The source is the FMI 2.0 export's model (before its own identity, FMI review M1), with the constants engine/src/fmi3Glue.cpp reads
    // appended.
    const fmi2Source = describeFmu(fixtureDocument, 'fixture').modelSource;
    assert.ok(source.startsWith(fmi2Source));
    const identity = source.slice(fmi2Source.length);
    assert.match(identity, new RegExp(`fmi3InstantiationToken = "${root.instantiationToken.replace(/[{}]/g, '\\$&')}";`));
    assert.match(identity, new RegExp(`fmi3TimeValueReference = ${independent[0].valueReference};`));
    assert.match(identity, new RegExp(`fmi3OutputCount = ${outputs.length};`));
});

test('the instantiationToken is deterministic, and never the FMI 2.0 export\'s guid', () => {
    const first = describeFmu(fixtureDocument, 'fixture', { fmiVersion: '3.0' }).xml;
    assert.equal(describeFmu(structuredClone(fixtureDocument), 'fixture', { fmiVersion: '3.0' }).xml, first);
    const token = parseModelDescription(first).guid;
    const guid = parseModelDescription(describeFmu(fixtureDocument, 'fixture').xml).guid;
    assert.notEqual(token.replace(/[{}]/g, ''), guid);
    const other = describeFmu(fixtureDocument, 'otherName', { fmiVersion: '3.0' }).xml;
    assert.notEqual(parseModelDescription(other).guid, token);
});

test('an FMI 3.0 export refuses what the FMI 2.0 export refuses, by the same words', () => {
    for (const method of ['rk4', 'adaptive']) {
        const document = withMethod(fixtureDocument, method);
        let fmi2Message;
        assert.throws(() => describeFmu(document, 'fixture'), (error) => { fmi2Message = error.message; return true; });
        assert.throws(() => describeFmu(document, 'fixture', { fmiVersion: '3.0' }), (error) => error.message === fmi2Message);
    }
    for (const method of ['nodeByNode', 'rodas4', 'bdf']) {
        const document = withMethod(fixtureDocument, method);
        const fmi2 = describeFmu(document, 'fixture');
        const fmi3 = describeFmu(document, 'fixture', { fmiVersion: '3.0' });
        assert.ok(fmi3.source.startsWith(fmi2.modelSource), method);
        assert.ok(fmi2.source.startsWith(fmi2.modelSource) && /extern const char\* const fmi2Guid = "/.test(fmi2.source.slice(fmi2.modelSource.length)), method);
        assert.equal(parseModelDescription(fmi3.xml).canGetAndSetFMUState, parseModelDescription(fmi2.xml).canGetAndSetFMUState, method);
    }
});

test('the example FMUs\' models export as FMI 3.0 with their ownership and units', async () => {
    for (const example of fmiExamples) {
        const document = await exportDocument(example);
        const root = parser.parse(describeFmu(document, example.name, { fmiVersion: '3.0' }).xml).fmiModelDescription;
        assert.ok(root.author, `${example.name} names its author.`);
        assert.equal(root.CoSimulation.modelIdentifier, example.name);
        assert.equal(Number(root.CoSimulation.fixedInternalStepSize), example.run.globalTimeStep);
        assert.ok(root.UnitDefinitions.Unit.length > 1, `${example.name} declares its units.`);
    }
});

test('FMI 3.0 binaries go in the platform tuple directory', () => {
    assert.match(platformDirectory('3.0'), /^(aarch64|x86_64|x86)-(darwin|linux|windows)$/);
    assert.match(platformDirectory(), /^(darwin|linux|win)(32|64)$/);
    assert.equal(platformDirectory('2.0'), platformDirectory());
});

function fmuBytes(attributes, binaries) {
    const entries = { 'modelDescription.xml': new TextEncoder().encode(`<fmiModelDescription ${attributes}></fmiModelDescription>`) };
    for (const [path, text] of Object.entries(binaries)) entries[path] = new TextEncoder().encode(text);
    return zipSync(entries, { level: 0 });
}

test('mergeFmuPackages merges FMI 3.0 exports by their instantiationToken, and never mixes FMI versions', () => {
    const mac = fmuBytes('fmiVersion="3.0" instantiationToken="{t-1}"', { 'binaries/aarch64-darwin/model.dylib': 'mac' });
    const linux = fmuBytes('fmiVersion="3.0" instantiationToken="{t-1}"', { 'binaries/x86_64-linux/model.so': 'linux' });
    const merged = unzipSync(mergeFmuPackages([{ name: 'mac.fmu', data: mac }, { name: 'linux.fmu', data: linux }]));
    assert.deepEqual(Object.keys(merged).sort(), ['binaries/aarch64-darwin/model.dylib', 'binaries/x86_64-linux/model.so', 'modelDescription.xml']);

    const other = fmuBytes('fmiVersion="3.0" instantiationToken="{t-2}"', { 'binaries/x86_64-linux/model.so': 'linux' });
    assert.throws(() => mergeFmuPackages([{ name: 'mac.fmu', data: mac }, { name: 'other.fmu', data: other }]), /same model/);
    const fmi2 = fmuBytes('fmiVersion="2.0" guid="{t-1}"', { 'binaries/linux64/model.so': 'linux' });
    assert.throws(() => mergeFmuPackages([{ name: 'mac.fmu', data: mac }, { name: 'fmi2.fmu', data: fmi2 }]), /same model/);
});

// The run a host starts with (docs/proposals/fmuImportWorkflow.md, stage 7): <DefaultExperiment> from 0, to the run's end when the
// export knows it, in steps of the model's output interval; where each FMI version's schema puts it, and nothing else changed.
test('both FMI versions say the run a host starts with, from 0 in steps of the output interval, to the run\'s end when known', () => {
    const configured = { ...fixtureDocument, runConfigurations: [{ id: 1, globalTimeStep: 0.01, outputInterval: 0.05 }], activeRunConfigurationId: 1 };
    for (const fmiVersion of fmiVersions) {
        const known = describeFmu(configured, 'fixture', { fmiVersion, stopTime: 12.5 }).xml;
        const unknown = describeFmu(configured, 'fixture', { fmiVersion }).xml;
        // FMI 2.0 puts its vendor annotations (Konjugate's fixed step, FMI review #4) between them, as its schema orders them.
        const next = fmiVersion === '3.0' ? '<ModelVariables>' : '<VendorAnnotations>';
        assert.ok(known.includes(`    <DefaultExperiment startTime="0" stopTime="12.5" stepSize="0.05"/>\n    ${next}`), `FMI ${fmiVersion}: just before the ${fmiVersion === '3.0' ? 'variables' : 'vendor annotations'}.`);
        if (fmiVersion === '2.0') assert.ok(known.includes('    </VendorAnnotations>\n    <ModelVariables>'), 'FMI 2.0: its vendor annotations just before the variables.');
        assert.ok(unknown.includes('    <DefaultExperiment startTime="0" stepSize="0.05"/>\n'), `FMI ${fmiVersion}: no stop time when the run's end is not known.`);
        assert.ok(describeFmu(fixtureDocument, 'fixture', { fmiVersion }).xml.includes('    <DefaultExperiment startTime="0" stepSize="0.01"/>\n'), 'With no run configuration, the global step it is exported with.');
        const without = (xml) => xml.split('\n').filter((line) => !line.includes('<DefaultExperiment')).join('\n');
        assert.equal(without(known), without(unknown), 'Only that line differs.');
        if (fmiVersion === '3.0') assert.ok(known.includes('    </LogCategories>\n    <DefaultExperiment'), 'FMI 3.0 puts it after the log categories.');
        else assert.ok(/providesDirectionalDerivative="false"\/>\n    <DefaultExperiment/.test(known), 'FMI 2.0 puts it after <CoSimulation>.');
        // The identity is a hash of the source, not of the description: the same either way.
        const identity = (xml) => /(?:guid|instantiationToken)="([^"]+)"/.exec(xml)[1];
        assert.equal(identity(known), identity(unknown));
    }
});
