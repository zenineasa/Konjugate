/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { brokenStepBefore, currentStepIndex, stepText, tourModel, tourSteps } from '../src/tour/tourSteps.mjs';

const node = (id) => ({ id, states: [{ id: id + 1, symbol: 'T' }] });
const edge = (from, to, equation = 'k * (sourceT - targetT)', role = 'target') => ({ id: 30, equation, equationModel: { output: { role } }, source: { nodeId: from }, target: { nodeId: to } });
const ui = (extra = {}) => ({ nodeBuilderOpen: false, edgeBuilderOpen: false, runDialogOpen: false, hasResult: false, timelineMoved: false, blockPlotShown: false, nodePlotVisible: false, labelOf: () => null, ...extra });
const step = (id) => tourSteps.find((candidate) => candidate.id === id);

test('every step has the pieces the controller needs, and ids are unique', () => {
    assert.equal(new Set(tourSteps.map((candidate) => candidate.id)).size, tourSteps.length);
    for (const candidate of tourSteps) {
        assert.ok(candidate.title && candidate.text, `${candidate.id} needs a title and text`);
        assert.equal(typeof candidate.done, 'function');
        if (candidate.advance !== 'next') assert.ok(candidate.target, `${candidate.id} points at nothing`);
    }
    assert.equal(tourSteps[0].advance, 'next');
    assert.equal(tourSteps.at(-1).advance, 'next');
});

test('steps are done by what the model holds, and by the interface where only it knows', () => {
    const empty = { nodes: [], edges: [] };
    assert.equal(step('addNode').done({ document: empty, ui: ui() }), false);
    assert.equal(step('addNode').done({ document: empty, ui: ui({ nodeBuilderOpen: true }) }), true);
    assert.equal(step('firstNode').done({ document: { nodes: [node(1)], edges: [] }, ui: ui() }), true);
    assert.equal(step('firstNode').done({ document: { nodes: [{ id: 1, states: [] }], edges: [] }, ui: ui() }), false, 'A node with no state is not the one asked for.');
    assert.equal(step('secondNode').done({ document: { nodes: [node(1)], edges: [] }, ui: ui() }), false);
    assert.equal(step('secondNode').done({ document: { nodes: [node(1), node(10)], edges: [] }, ui: ui() }), true);
    const two = { nodes: [node(1), node(10)], edges: [] };
    assert.equal(step('addEdge').done({ document: two, ui: ui({ edgeBuilderOpen: true, edgeSourceNodeId: '1', edgeTargetNodeId: '1' }) }), false, 'An edge from a node to itself is not a connection.');
    assert.equal(step('addEdge').done({ document: two, ui: ui({ edgeBuilderOpen: true, edgeSourceNodeId: '1', edgeTargetNodeId: '10' }) }), true);
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10, '')] }, ui: ui() }), false);
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10)] }, ui: ui() }), true);
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10, undefined, 'source')] }, ui: ui() }), false, 'An equation that changes the heater is not the one asked for.');
    assert.equal(step('run').done({ document: two, ui: ui({ hasResult: true }) }), true);
    assert.equal(step('plotBlock').done({ document: two, ui: ui() }), false);
    assert.equal(step('plotBlock').done({ document: two, ui: ui({ blockPlotShown: true }) }), true);
    assert.equal(step('results').done({ document: two, ui: ui({ timelineMoved: true }) }), true);
});

test('the step a person is on follows what they have done, and waits at a Next step', () => {
    const facts = (document, extra) => ({ document, ui: ui(extra) });
    assert.equal(currentStepIndex(facts({ nodes: [], edges: [] })), 0, 'The welcome waits for Start.');
    assert.equal(currentStepIndex(facts({ nodes: [], edges: [] }), 1), 1);
    assert.equal(currentStepIndex(facts({ nodes: [node(1)], edges: [] }), 1), 3);
    const built = { nodes: [node(1), node(10)], edges: [edge(1, 10)] };
    assert.equal(tourSteps[currentStepIndex(facts(built), 1)].id, 'run');
    assert.equal(tourSteps[currentStepIndex(facts(built, { hasResult: true }), 1)].id, 'plotBlock');
    assert.equal(tourSteps[currentStepIndex(facts(built, { hasResult: true, blockPlotShown: true }), 1)].id, 'results');
    assert.equal(tourSteps[currentStepIndex(facts(built, { hasResult: true, blockPlotShown: true, timelineMoved: true }), 1)].id, 'finish');
    assert.equal(currentStepIndex(facts(built, { hasResult: true, blockPlotShown: true, timelineMoved: true }), 99), tourSteps.length - 1, 'It never runs past the last step.');
});

test('a step undone later is found, so the tour can offer to go back', () => {
    const facts = (nodes, edges = []) => ({ document: { nodes, edges }, ui: ui() });
    const runIndex = tourSteps.findIndex((candidate) => candidate.id === 'run');
    assert.equal(brokenStepBefore(facts([node(1), node(10)], [edge(1, 10)]), runIndex), null);
    assert.equal(tourSteps[brokenStepBefore(facts([node(1)]), runIndex)].id, 'secondNode', 'With a node deleted, the earliest step to repeat is the second node.');
    assert.equal(tourSteps[brokenStepBefore(facts([node(1), node(10)]), runIndex)].id, 'addEdge');
});

test('the finish step ends with a sentence about the desktop app\'s extras, said for the edition reading it', () => {
    const finish = tourSteps.at(-1);
    assert.match(stepText(finish, 'desktop'), /Extensions dialog/);
    assert.match(stepText(finish, 'web'), /desktop app adds add-ons and plugins/);
    assert.doesNotMatch(stepText(finish, 'web'), /Extensions dialog/);
    assert.equal(stepText(tourSteps[1], 'web'), tourSteps[1].text);
});

test('the model the tour builds is the one its steps describe', () => {
    assert.ok(tourModel.source.temperature > tourModel.target.temperature, 'Heat must flow from the heater to the block.');
    for (const candidate of tourSteps.filter((item) => item.id === 'firstNode' || item.id === 'secondNode')) assert.match(candidate.text, /Temperature/);
});
