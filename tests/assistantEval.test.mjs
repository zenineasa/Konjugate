/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAIProviderRegistry } from '../src/aiProviderRegistry.mjs';
import { checkOutcome, runEvalCase, summarizeEvalResults, untouchedChanges } from '../src/assistantEval.mjs';
import { loadEvalBase, loadEvalCases, loadReferenceProvider } from '../src/assistantEvalFiles.mjs';
import { checkGeneratedRequests, evalDomainModels, evalFamilies, evalStyles, heldOutModels, reviewGeneratedRequests } from '../src/assistantEvalRequests.mjs';

const model = () => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [
        { id: 1, name: 'Battery module', states: [{ id: 2, name: 'Temperature', symbol: 'temperature', initialValue: 300, unit: 'K' }], sourceTerms: [] },
        { id: 3, name: 'Enclosed air', states: [{ id: 4, name: 'Temperature', symbol: 'temperature', initialValue: 293.15, unit: 'K' }], sourceTerms: [] }
    ],
    edges: []
});

// A provider that answers every request with a fixed reply (or a sequence of replies, one per call).
const scripted = (...replies) => createAIProviderRegistry([{
    id: 'scripted', name: 'Scripted',
    async generateProposal() {
        const reply = replies.length > 1 ? replies.shift() : replies[0];
        if (reply instanceof Error) throw reply;
        return structuredClone(reply);
    }
}]);
const setTemperature = (stateRef, initialValue) => ({
    responseKind: 'proposal', proposalVersion: 1, operations: [{ kind: 'updateState', stateRef, initialValue }]
});
const run = (evalCase, registry, base = model()) => runEvalCase(evalCase, { base, registry, configuration: { provider: 'scripted' } });
const batteryCase = { id: 'battery', family: 'updateValue', request: 'Set the battery to 320 K.', expect: { touches: ['Battery module'], assertions: [{ op: 'state', node: 'Battery module', symbol: 'temperature', initialValue: 320 }] } };

test('a proposal that applies and meets the outcome passes', async () => {
    const result = await run(batteryCase, scripted(setTemperature(2, 320)));
    assert.equal(result.passed, true);
    assert.equal(result.stage, 'pass');
    assert.equal(result.attempts, 1);
});

test('the right operation on the wrong entity fails the outcome, not the host', async () => {
    const result = await run(batteryCase, scripted(setTemperature(4, 320)));
    assert.equal(result.stage, 'outcome');
    assert.match(result.messages.join(' '), /Battery module/);
});

test('changing something the case did not name is a failure', async () => {
    const both = { responseKind: 'proposal', proposalVersion: 1, operations: [
        { kind: 'updateState', stateRef: 2, initialValue: 320 }, { kind: 'updateState', stateRef: 4, initialValue: 310 }
    ] };
    const result = await run(batteryCase, scripted(both));
    assert.equal(result.stage, 'outcome');
    assert.match(result.messages.join(' '), /Enclosed air.*changed/);
});

test('each failure is attributed to the stage it belongs to', async () => {
    assert.equal((await run(batteryCase, scripted(setTemperature(99, 320)))).stage, 'apply');
    assert.equal((await run(batteryCase, scripted(new Error('boom')))).stage, 'generate');
    const asked = { responseKind: 'clarification', question: 'Which node?', suggestions: ['Battery module'] };
    assert.equal((await run(batteryCase, scripted(asked))).stage, 'kind');
});

test('a clarification case passes on a question that offers the expected suggestions', async () => {
    const clarificationCase = { id: 'ask', family: 'clarification', request: 'Set the temperature.', expect: { kind: 'clarification', suggestionsInclude: ['battery module'] } };
    const good = { responseKind: 'clarification', question: 'Which node?', suggestions: ['Battery module', 'Enclosed air'] };
    assert.equal((await run(clarificationCase, scripted(good))).passed, true);
    const missing = { responseKind: 'clarification', question: 'Which node?', suggestions: ['Enclosed air'] };
    assert.equal((await run(clarificationCase, scripted(missing))).stage, 'outcome');
    assert.equal((await run(clarificationCase, scripted(setTemperature(2, 320)))).stage, 'kind');
});

test('native validation blames a proposal only for errors it introduced', async () => {
    const withErrors = (errors) => ({ base: model(), registry: scripted(setTemperature(2, 320)), configuration: { provider: 'scripted' }, baselineErrors: ['no run configuration'], validateNative: async () => ({ available: true, errors }) });
    const inherited = await runEvalCase(batteryCase, withErrors(['no run configuration']));
    assert.equal(inherited.passed, true);
    assert.equal(inherited.native, 'passed');
    const introduced = await runEvalCase(batteryCase, withErrors(['no run configuration', 'state out of range']));
    assert.equal(introduced.stage, 'native');
    assert.deepEqual(introduced.messages, ['state out of range']);
});

test('the attempt count comes from the registry, so repaired output is not counted as a first-attempt pass', async () => {
    const bad = { responseKind: 'proposal', proposalVersion: 1, operations: [{ kind: 'nonsense' }] };
    const result = await run(batteryCase, scripted(bad, setTemperature(2, 320)));
    assert.equal(result.passed, true);
    assert.equal(result.attempts, 2);
    const summary = summarizeEvalResults([result]);
    assert.equal(summary.overall.passRate, 1);
    assert.equal(summary.overall.firstAttemptPassRate, 0);
});

test('assertions cover edges, enabled flags, removal and fields', () => {
    const base = model();
    base.edges.push({ id: 5, name: 'Heat', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed', equation: '', parameters: [] });
    const result = structuredClone(base);
    result.edges[0].directionality = 'bidirectional';
    result.edges[0].equationModel = { latex: '\\mathrm{sourceTemperature}-\\mathrm{targetTemperature}' };
    result.edges[0].parameters = [{ symbol: 'conductance', value: 5, unit: 'W/K' }];
    result.nodes[1].enabled = false;
    result.nodes[1].appearance = { shape: 'sphere' };
    assert.deepEqual(checkOutcome(base, result, { touches: ['Battery module', 'Enclosed air', 'Heat'], assertions: [
        { op: 'hasEdge', from: 'Battery', to: 'Enclosed', directionality: 'bidirectional' },
        { op: 'edgeEquation', from: 'Battery', to: 'Enclosed', uses: ['source', 'target'] },
        { op: 'edgeParameter', from: 'Battery', to: 'Enclosed', symbol: 'conductance', value: 5, unit: 'W/K' },
        { op: 'enabled', node: 'Enclosed air', value: false },
        { op: 'field', node: 'Enclosed air', path: 'appearance.shape', value: 'sphere' }
    ] }), []);
    const withoutBattery = { ...result, nodes: result.nodes.slice(1), edges: [] };
    assert.deepEqual(checkOutcome(base, withoutBattery, { touches: ['Battery module'], assertions: [{ op: 'removed', node: 'Battery module' }] }).filter((failure) => /Enclosed air/.test(failure)), [
        'node “Enclosed air” was changed'
    ]);
    assert.throws(() => checkOutcome(base, result, { assertions: [{ op: 'nonsense' }] }), /Unknown assertion/);
});

test('untouched entities are compared by id, and a touched node covers its relationships', () => {
    const base = model();
    base.edges.push({ id: 5, name: 'Heat', source: { nodeId: 1, stateId: 2 }, target: { nodeId: 3, stateId: 4 }, directionality: 'directed' });
    const result = structuredClone(base);
    result.edges[0].directionality = 'bidirectional';
    assert.equal(untouchedChanges(base, result, []).length, 1);
    assert.deepEqual(untouchedChanges(base, result, ['Battery module']), []);
});

test('every bundled case is tagged from the shared vocabulary and starts from a model of its domain', async () => {
    const cases = await loadEvalCases();
    assert.ok(cases.length >= 150);
    const ids = new Set();
    for (const evalCase of cases) {
        assert.ok(!ids.has(evalCase.id), `duplicate case id ${evalCase.id}`);
        ids.add(evalCase.id);
        assert.ok(evalFamilies.includes(evalCase.family), `${evalCase.id}: family ${evalCase.family}`);
        assert.ok(evalStyles.includes(evalCase.style), `${evalCase.id}: style ${evalCase.style}`);
        assert.ok(evalDomainModels[evalCase.domain]?.includes(evalCase.model), `${evalCase.id}: ${evalCase.model} is not a ${evalCase.domain} model`);
        assert.equal(evalCase.split, 'test', evalCase.id);
        assert.ok(evalCase.request?.trim(), evalCase.id);
        assert.equal(evalCase.family === 'history', Boolean(evalCase.history), `${evalCase.id}: history and the history family go together`);
    }
    // The spread is the point of the set: every domain and every phrasing style has to carry real weight.
    const count = (key) => Object.entries(cases.reduce((totals, item) => ({ ...totals, [item[key]]: (totals[item[key]] ?? 0) + 1 }), {}));
    for (const [domain, total] of count('domain')) assert.ok(total >= 8, `${domain} has only ${total} cases`);
    for (const [style, total] of count('style')) assert.ok(total >= 8, `${style} has only ${total} cases`);
    assert.equal(new Set(cases.map((item) => item.domain)).size, Object.keys(evalDomainModels).length);
});

test('no two cases share a request, and no case is already satisfied by the model it starts from', async () => {
    const cases = await loadEvalCases();
    const requests = new Set();
    for (const evalCase of cases) {
        const key = JSON.stringify([evalCase.request, evalCase.history ?? null]);
        assert.ok(!requests.has(key), `${evalCase.id}: repeats another case's request`);
        requests.add(key);
        if (evalCase.expect.kind === 'clarification') continue;
        const base = await loadEvalBase(evalCase.model);
        // Passing without doing anything would make the case measure nothing.
        assert.ok(checkOutcome(base, structuredClone(base), { assertions: evalCase.expect.assertions }).length > 0, `${evalCase.id}: the unchanged model already satisfies it`);
    }
});

test('every case can be passed: the recorded reference answers replay to a pass', async () => {
    const cases = await loadEvalCases();
    const { provider, caseIds } = await loadReferenceProvider(cases);
    assert.deepEqual(cases.filter((evalCase) => !caseIds.has(evalCase.id)).map((evalCase) => evalCase.id), [], 'a case without a reference answer');
    const registry = createAIProviderRegistry([provider]);
    for (const evalCase of cases) {
        const result = await runEvalCase(evalCase, { base: await loadEvalBase(evalCase.model), registry, configuration: { provider: 'reference' } });
        assert.equal(result.passed, true, `${evalCase.id} [${result.stage}]: ${result.messages.join(' ')}`);
    }
});

test('the intake check keeps a request pool clear of the test set', async () => {
    const testCases = await loadEvalCases();
    const good = { domain: 'thermal', model: 'heatedWaterTank', family: 'updateValue', style: 'plain', request: 'Start the tank at 311 K.', expectedOutcome: 'Water tank temperature is 311 K.' };
    const { accepted, rejected } = checkGeneratedRequests([
        good,
        { ...good, request: 'start the tank at 311 K' },
        { ...good, request: testCases[0].request, model: 'blank', domain: 'general' },
        { ...good, request: 'Set the battery module temperature to 321 K.', model: 'thermalManagement' },
        { ...good, request: 'Move the living room to 300 K.', model: 'twoRoomBuilding' },
        { ...good, model: 'springMassDamper' },
        { ...good, style: 'shouting' },
        { ...good, request: 'Another request.', expectedOutcome: '' },
        { ...good, family: 'history', request: 'Zone 3' }
    ], { testCases, purpose: 'train' });
    assert.deepEqual(accepted, [good]);
    const reasons = rejected.map((entry) => entry.reasons.join(' '));
    assert.match(reasons[0], /duplicates an earlier request/);
    assert.match(reasons[1], /is a test request/);
    assert.match(reasons[2], /nearly identical to the test request/);
    assert.match(reasons[3], /reserved for the test/);
    assert.match(reasons[4], /not one of the thermal models/);
    assert.match(reasons[5], /unknown style/);
    assert.match(reasons[6], /expectedOutcome is required/);
    assert.match(reasons[7], /history must be/);
    // A test pool may use the reserved models.
    assert.equal(checkGeneratedRequests([{ ...good, request: 'Move the living room to 300 K.', model: 'twoRoomBuilding' }], { testCases, purpose: 'test' }).accepted.length, 1);
    assert.ok(heldOutModels.every((model) => Object.values(evalDomainModels).some((models) => models.includes(model))));
});

test('the review warns about an expected outcome the model cannot satisfy, and about quoting catalog names', async () => {
    const documents = { pumpSuctionHydraulics: await loadEvalBase('pumpSuctionHydraulics') };
    const item = (request, expectedOutcome, family = 'updateValue') => ({ model: 'pumpSuctionHydraulics', family, request, expectedOutcome });
    const { warnings } = reviewGeneratedRequests([
        item('Would you adjust the liquid level in the storage tank to 8.2 feet?', 'The Tank liquid level becomes 2.49936 m. Nothing else changes.'),
        item('Set the tank pressure to 98 kPa.', 'The Tank Surface pressure becomes 98000 Pa. Nothing else changes.'),
        item('5.8 m', 'The Pump NPSH margin (design, with safety allowance) becomes 5.8 m.'),
        item('Lower the pump suction pressure.', 'The Pump suction pressure becomes 90000 Pa.'),
        item('Lower junction pressure.', 'The Tank liquid level becomes nothing.', 'clarification')
    ], documents);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /gives “Tank” a “liquid level”.*Surface pressure/);

    const quoting = [1, 2, 3, 4].map((n) => item(`Disable Suction Line ${n} charges Suction Manifold Junction please.`, 'x'));
    const review = reviewGeneratedRequests(quoting, documents);
    assert.equal(review.verbatimShare, 1);
    assert.match(review.warnings.at(-1).message, /quote a long catalog name word for word/);
    assert.equal(reviewGeneratedRequests([item('Turn off the first suction line charging the manifold.', 'x')], documents).warnings.length, 0);
    assert.deepEqual(reviewGeneratedRequests([{ model: 'blank', family: 'addNode', request: 'Add a tank.', expectedOutcome: 'x' }], documents).warnings, []);
    // A relationship that starts with a node's name is not a state of that node, and a removal lists what goes with it.
    const quiet = reviewGeneratedRequests([
        item('Make the tank feed bidirectional.', 'The relationship Tank drives Suction Line 1 becomes bidirectional. Nothing else changes.'),
        item('Delete line 2.', 'The node Suction Line 2 and the relationships attached to it are removed.')
    ], documents);
    assert.deepEqual(quiet.warnings, []);
});
