/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { componentTemplateHasCppProgram, validateComponentTemplate } from '../src/componentTemplate.mjs';

const bundle = () => ({
    id: 'loadedMotor', kind: 'bundle', name: 'Loaded motor', domains: ['electrical'],
    endpoints: [{ id: 'supply', label: 'Supply' }, { id: 'motor', label: 'Motor' }],
    sharedParameters: [{ key: 'resistance', name: 'Winding resistance', symbol: 'resistance', value: 2, unit: 'Ω' }],
    edges: [{
        name: 'Drive', from: 'supply', to: 'motor', ports: { source: 'voltage', target: ['current', 'speed'] },
        output: { role: 'target', state: 'current' }, latex: '\\mathrm{sourceVoltage} / \\mathrm{resistance}',
        parameters: [{ name: 'Winding resistance', symbol: 'resistance', shared: 'resistance' }]
    }]
});

test('every bundled component template validates, bundles and assemblies included', async () => {
    const directory = new URL('../assets/componentLibrary/', import.meta.url).pathname;
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json') && name !== 'webManifest.json');
    const kinds = new Set();
    for (const name of names) kinds.add(validateComponentTemplate(JSON.parse(await readFile(join(directory, name), 'utf8'))).kind);
    assert.deepEqual([...kinds].sort(), ['bundle', 'edge', 'fragment', 'node']);
});

test('a well-formed bundle validates and is cloned', () => {
    const template = bundle();
    const validated = validateComponentTemplate(template);
    assert.deepEqual(validated, template);
    assert.notEqual(validated, template);
});

test('a bundle rejects malformed endpoints, edges and shared parameters', () => {
    const rejects = (mutate, pattern) => {
        const template = bundle();
        mutate(template);
        assert.throws(() => validateComponentTemplate(template), pattern);
    };
    rejects((t) => { t.endpoints = [t.endpoints[0]]; }, /at least two endpoints/);
    rejects((t) => { t.endpoints[1].id = 'supply'; }, /duplicated/);
    rejects((t) => { t.edges = []; }, /at least one edge/);
    rejects((t) => { t.edges[0].to = 'nowhere'; }, /between two different declared endpoints/);
    rejects((t) => { t.edges[0].to = 'supply'; }, /between two different declared endpoints/);
    rejects((t) => { delete t.edges[0].latex; }, /needs a latex/);
    rejects((t) => { t.edges[0].output.role = 'middle'; }, /needs an output/);
    rejects((t) => { t.edges[0].parameters[0].shared = 'missing'; }, /undeclared shared parameter/);
    rejects((t) => { t.sharedParameters.push({ ...t.sharedParameters[0] }); }, /unique key/);
    rejects((t) => { t.sharedParameters[0].value = 'two'; }, /finite value/);
    rejects((t) => { t.sharedParameters[0].scope = 'galaxy'; }, /scope/);
    rejects((t) => { t.sharedParameters[0].mode = 'live'; }, /slider control/);
});

const nodeWithTerms = () => ({
    id: 'stockpile', kind: 'node', name: 'Stockpile', domains: ['logistics'],
    states: [{ symbol: 'stock', label: 'Stock', initialValue: 10 }, { symbol: 'orderRate', label: 'Order rate', initialValue: 0 }],
    sharedParameters: [
        { key: 'cover', name: 'Cover', symbol: 'coverDays', value: 3, scope: 'project' },
        { key: 'drain', name: 'Drain time', symbol: 'drainDays', value: 2 }
    ],
    sourceTerms: [
        { state: 'stock', expression: '-\\frac{\\mathrm{stock}}{\\mathrm{drainDays}}', parameters: [{ name: 'Drain time', symbol: 'drainDays', shared: 'drain' }] },
        {
            state: 'orderRate', setsValue: true, expression: '\\mathrm{gain} \\cdot (\\mathrm{coverDays} - \\mathrm{stock})',
            parameters: [{ name: 'Gain', symbol: 'gain', value: 0.5 }, { name: 'Cover', symbol: 'coverDays', shared: 'cover' }]
        }
    ]
});

test('a node template can give its source terms parameters, shared parameters and algebraic outputs', () => {
    const template = nodeWithTerms();
    assert.deepEqual(validateComponentTemplate(template), template);
});

test('a node template rejects malformed source-term parameters and shared parameters', () => {
    const rejects = (mutate, pattern) => {
        const template = nodeWithTerms();
        mutate(template);
        assert.throws(() => validateComponentTemplate(template), pattern);
    };
    rejects((t) => { t.sourceTerms[0].parameters[0].shared = 'missing'; }, /undeclared shared parameter/);
    rejects((t) => { t.sourceTerms[1].parameters[0].value = 'half'; }, /finite value/);
    rejects((t) => { t.sourceTerms[1].parameters.push({ name: 'Gain again', symbol: 'gain', value: 1 }); }, /reuses the symbol "gain"/);
    rejects((t) => { t.sourceTerms[1].parameters[0].symbol = 'stock'; }, /reuses the symbol "stock"/);
    rejects((t) => { delete t.sourceTerms[1].parameters[0].name; }, /without a name and symbol/);
    rejects((t) => { t.sourceTerms[1].setsValue = 'yes'; }, /not a boolean/);
    rejects((t) => { t.sharedParameters[1].key = 'cover'; }, /node template shared parameter needs a unique key/);
    rejects((t) => { t.sharedParameters[0].scope = 'galaxy'; }, /node template shared parameter scope/);
});

// A fragment template: a node with its own C++ program, reading the two shared parameters it carries.
const fragmentTemplate = () => ({
    id: 'limitedGain', kind: 'fragment', name: 'Limited gain', domains: ['control'], description: 'Scales an input and clamps it.',
    fragment: {
        format: 'konjugateGraphFragment', version: 1,
        nodes: [{
            id: 1, name: 'Limited gain', description: 'Holds the clamped output.', position: [0, 0, 0],
            states: [{ id: 2, name: 'Output', symbol: 'output', initialValue: 0, unit: '' }], sourceTerms: [],
            implementation: {
                kind: 'cpp', providerApiVersion: 1, source: 'struct Gain {};',
                bindings: [{ key: 'gain', kind: 'parameter', sharedParameterId: 3 }, { key: 'limit', kind: 'parameter', sharedParameterId: 4 }],
                outputs: [{ key: 'output', stateId: 2, setsValue: true }]
            }
        }],
        edges: [],
        sharedParameters: [
            { id: 3, name: 'Gain', symbol: 'gain', value: 2, unit: '', mode: 'live', control: { minimum: 0, maximum: 10, step: 0.1 } },
            { id: 4, name: 'Limit', symbol: 'limit', value: 5, unit: '', scope: 'instance' }
        ]
    }
});

test('a well-formed fragment template validates and is cloned', () => {
    const template = fragmentTemplate();
    const validated = validateComponentTemplate(template);
    assert.deepEqual(validated, template);
    assert.notEqual(validated.fragment, template.fragment);
});

test('a fragment template that links to a shared parameter it does not carry is refused', () => {
    const template = fragmentTemplate();
    template.fragment.sharedParameters.pop();
    assert.throws(() => validateComponentTemplate(template), /does not carry/);
});

test('a fragment template\'s live shared parameter needs a usable slider range', () => {
    const template = fragmentTemplate();
    template.fragment.sharedParameters[0].control.maximum = -1;
    assert.throws(() => validateComponentTemplate(template), /slider control/);
});

test('a fragment template may carry only inline programs', () => {
    for (const implementation of [{ kind: 'fmi', fmuId: 'x', bindings: [], outputs: [] }, { kind: 'plugin', pluginId: 'p' }, { kind: 'cpp', source: '   ', bindings: [] }]) {
        const template = fragmentTemplate();
        template.fragment.nodes[0].implementation = implementation;
        assert.throws(() => validateComponentTemplate(template), /inline cpp or python source/, JSON.stringify(implementation));
    }
});

test('a fragment template needs a graph that is valid as the canvas copies it', () => {
    const empty = fragmentTemplate();
    empty.fragment.nodes = [];
    assert.throws(() => validateComponentTemplate(empty), /valid graph fragment/);
    const repeated = fragmentTemplate();
    repeated.fragment.sharedParameters[1].id = 2;
    assert.throws(() => validateComponentTemplate(repeated), /valid graph fragment/);
    const unnamed = fragmentTemplate();
    unnamed.fragment.nodes[0].name = '';
    assert.throws(() => validateComponentTemplate(unnamed), /needs a name/);
});

test('a template that puts a C++ program in the model is recognised wherever the program sits', () => {
    assert.equal(componentTemplateHasCppProgram(fragmentTemplate()), true);
    const onSourceTerm = fragmentTemplate();
    const program = onSourceTerm.fragment.nodes[0].implementation;
    delete onSourceTerm.fragment.nodes[0].implementation;
    onSourceTerm.fragment.nodes[0].sourceTerms = [{ id: 9, state: 'output', expression: '', implementation: program }];
    assert.equal(componentTemplateHasCppProgram(onSourceTerm), true);
    const python = fragmentTemplate();
    python.fragment.nodes[0].implementation.kind = 'python';
    assert.equal(componentTemplateHasCppProgram(python), false);
    assert.equal(componentTemplateHasCppProgram(validateComponentTemplate(bundle())), false);
});

test('the bundled PID assemblies carry a C++ program, so the web library leaves them out', async () => {
    const directory = new URL('../assets/componentLibrary/', import.meta.url).pathname;
    for (const id of ['pidParallel', 'pidIsa']) {
        assert.equal(componentTemplateHasCppProgram(validateComponentTemplate(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')))), true, id);
    }
});
