/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exampleLabel } from '../src/exampleCatalog.mjs';
import { decodeProjectBundle } from '../src/projectFile.mjs';
import { calibrateTank, calibrateTankValues } from '../src/tutorials/calibrateTank.mjs';
import { firstModel, firstModelValues as tourModel } from '../src/tutorials/firstModel.mjs';
import { exampleTitle, groupTutorials, searchTutorials, tutorialAreas, tutorialById, tutorialDataFiles, tutorialForExample, tutorials, tutorialStartLabel } from '../src/tutorials/index.mjs';
import { brokenStepBefore as brokenStep, currentStepIndex as currentStep, edgeParameterChanged, edgeParameterValue, stepLabel as labelOf, stepText } from '../src/tutorials/steps.mjs';
import { tuneController, tuneControllerValues } from '../src/tutorials/tuneController.mjs';

// The first-model tour's tests below were written against its own step list; these bind the shared functions to it.
const tourSteps = firstModel.steps;
const currentStepIndex = (facts, reached = 0) => currentStep(facts, reached, tourSteps);
const brokenStepBefore = (facts, index) => brokenStep(facts, index, tourSteps);
const stepLabel = (index) => labelOf(index, tourSteps);

const node = (id) => ({ id, states: [{ id: id + 1, symbol: 'T' }] });
const edge = (from, to, equation = 'k * (sourceT - targetT)', role = 'target') => ({ id: 30, equation, equationModel: { output: { role } }, source: { nodeId: from }, target: { nodeId: to } });
const ui = (extra = {}) => ({
    nodeBuilderOpen: false, edgeBuilderOpen: false, edgeEditorFor: null, runDialogOpen: false, hasResult: false, runModel: null, timelineMoved: false,
    nodePlotVisible: false, plotsSeen: [], plotsSeenSinceRun: [], tuningOpen: false, tuningDataLoaded: false, tuningFitted: false,
    labelOf: () => null, relationshipRowOf: () => null, ...extra
});
const blockPlotShown = { plotsSeen: ['Block'] };
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
    assert.equal(step('plotBlock').done({ document: two, ui: ui(blockPlotShown) }), true);
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
    assert.equal(tourSteps[currentStepIndex(facts(built, { hasResult: true, ...blockPlotShown }), 1)].id, 'results');
    assert.equal(tourSteps[currentStepIndex(facts(built, { hasResult: true, ...blockPlotShown, timelineMoved: true }), 1)].id, 'finish');
    assert.equal(currentStepIndex(facts(built, { hasResult: true, ...blockPlotShown, timelineMoved: true }), 99), tourSteps.length - 1, 'It never runs past the last step.');
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

test('the numbered steps count up to their own total, and the welcome and the closing card are not among them', () => {
    const numbered = tourSteps.length - 2;
    assert.equal(stepLabel(0), '');
    assert.equal(stepLabel(1), `Step 1 of ${numbered}`);
    assert.equal(stepLabel(numbered), `Step ${numbered} of ${numbered}`);
    assert.equal(stepLabel(tourSteps.length - 1), 'Bonus step');
    assert.equal(stepLabel(99), '');
});

test('the card that follows the second node tells a person to drag the overlapping nodes apart', () => {
    // The builder puts every new node at the same position, so the nodes sit on top of each other until one is moved.
    assert.match(stepText(step('addEdge'), 'web'), /same spot.*drag one of them aside/);
});

// ---- Every tutorial (docs/proposals/tutorials.md)

const root = process.cwd();
const html = await readFile(join(root, 'src', 'renderer', 'index.html'), 'utf8');
const rendererSource = await readFile(join(root, 'src', 'renderer', 'renderer.mjs'), 'utf8');
const manifest = JSON.parse(await readFile(join(root, 'examples', 'manifest.json'), 'utf8'));
const exampleDocument = async (fileName) => JSON.parse((await decodeProjectBundle(await readFile(join(root, 'examples', fileName)))).content);

test('every tutorial has what the list and the controller need, starts with a welcome and ends with a closing card', () => {
    assert.equal(new Set(tutorials.map((tutorial) => tutorial.id)).size, tutorials.length, 'Tutorial ids are unique.');
    const areas = new Set(tutorialAreas.map((area) => area.id));
    for (const tutorial of tutorials) {
        assert.ok(tutorial.title && tutorial.summary, `${tutorial.id} needs a title and a sentence`);
        assert.ok(Number.isInteger(tutorial.minutes) && tutorial.minutes > 0, `${tutorial.id} says how long it takes`);
        assert.ok(areas.has(tutorial.area), `${tutorial.id} is in a known area`);
        assert.ok(tutorial.tags.length > 0);
        assert.ok(tutorial.editions.length > 0 && tutorial.editions.every((edition) => edition === 'desktop' || edition === 'web'));
        const { steps } = tutorial;
        assert.equal(new Set(steps.map((step) => step.id)).size, steps.length, `${tutorial.id}'s step ids are unique`);
        assert.equal(steps[0].id, 'welcome');
        assert.equal(steps[0].advance, 'next');
        assert.equal(steps.at(-1).id, 'finish');
        assert.equal(steps.at(-1).advance, 'next');
        assert.ok(steps.some((step) => step.advance !== 'next'), `${tutorial.id} asks the person to do something`);
        for (const step of steps) {
            assert.ok(step.title && step.text, `${tutorial.id}/${step.id} needs a title and text`);
            assert.equal(typeof step.done, 'function');
            if (step.advance !== 'next') assert.ok(step.target, `${tutorial.id}/${step.id} points at nothing`);
        }
    }
});

test('what a tutorial points at, fills in and starts from exists', () => {
    for (const tutorial of tutorials) {
        for (const step of tutorial.steps) {
            // A fixed target is a selector; its first id must be in the page (the rest may be built at run time, like a parameter's row).
            if (typeof step.target === 'string') {
                const id = step.target.match(/^#([\w-]+)/)?.[1];
                assert.ok(id && html.includes(`id="${id}"`), `${tutorial.id}/${step.id} points at ${step.target}, which is not in the page`);
            }
            // Every step with something to do can be skipped, and the renderer supplies what each step's fill, skip and link do.
            if (step.advance !== 'next') assert.ok(step.skip, `${tutorial.id}/${step.id} cannot be skipped`);
            for (const [kind, name] of [['fill', step.fill], ['skip', step.skip], ['link', step.link?.action]]) {
                if (name) assert.match(rendererSource, new RegExp(`\\n {8}${name}: async`), `${tutorial.id}/${step.id}'s "${name}" ${kind} is not supplied by the renderer`);
            }
            if (step.link) assert.ok(step.link.label, `${tutorial.id}/${step.id}'s link says nothing`);
            if (step.fill === 'runTime' || step.skip === 'runModel') assert.ok(step.runSeconds > 0, `${tutorial.id}/${step.id} says how long to run`);
            if (step.skip === 'plotNode') assert.ok(step.node, `${tutorial.id}/${step.id} says which node to plot`);
            if (step.skip === 'setParameter') assert.ok(step.relationship && step.parameterId && step.value !== undefined, `${tutorial.id}/${step.id} says which parameter to set, and to what`);
        }
        if (tutorial.start.from === 'example') {
            const { example } = tutorial.start;
            assert.ok(existsSync(join(root, 'examples', example)), `${tutorial.id} starts from ${example}, which is not shipped`);
            assert.ok(manifest.examples.some((entry) => `${entry.id}.kjt` === example), `${tutorial.id}'s example is not in examples/manifest.json`);
            assert.equal(tutorialForExample(example), tutorial);
        } else {
            assert.equal(tutorial.start.from, 'empty');
        }
        for (const fileName of tutorial.data ?? []) assert.ok(existsSync(join(root, 'examples', fileName)), `${tutorial.id} reads ${fileName}, which is not shipped`);
    }
    assert.deepEqual(tutorialDataFiles, ['tankCalibrationMeasured.csv']);
    assert.equal(tutorialById('nope'), null);
    assert.equal(tutorialForExample('heatedWaterTank.kjt'), null);
});

test('an example is named in the list as the Examples dialog names it', () => {
    for (const tutorial of tutorials.filter((candidate) => candidate.start.from === 'example')) assert.equal(exampleTitle(tutorial.start.example), exampleLabel(tutorial.start.example));
    assert.equal(tutorialStartLabel(calibrateTank), 'Starts from the Tank Calibration example');
    assert.equal(tutorialStartLabel(firstModel), 'From an empty canvas');
});

test('the list is searched by title, tags, sentence and starting example, every word counting, best match first', () => {
    const ids = (query) => searchTutorials(query).map((tutorial) => tutorial.id);
    assert.deepEqual(ids(''), tutorials.map((tutorial) => tutorial.id), 'Nothing typed lists everything, in order.');
    assert.equal(ids('calibrate')[0], 'calibrateTank');
    assert.equal(ids('PID')[0], 'tuneController', 'Case does not matter.');
    assert.equal(ids('measured data')[0], 'calibrateTank');
    assert.equal(ids('Tank Calibration')[0], 'calibrateTank', 'The starting example\'s name finds it.');
    assert.equal(ids('position controlled joint')[0], 'tuneController');
    assert.equal(ids('first')[0], 'firstModel');
    assert.deepEqual(ids('controller calibrate'), [], 'Every word must match.');
    assert.deepEqual(ids('zzzz'), []);
    // A title match ranks above a match elsewhere: "run" is in the first-model tutorial's title and only in the others' sentences.
    assert.equal(ids('run')[0], 'firstModel');
});

test('with nothing typed the list is grouped by area, in the areas\' order, and empty areas are left out', () => {
    const groups = groupTutorials();
    assert.equal(groups[0].id, 'start');
    assert.equal(groups[0].title, 'Start here');
    assert.deepEqual(groups[0].tutorials, [firstModel]);
    const order = tutorialAreas.map((area) => area.id);
    assert.deepEqual(groups.map((group) => group.id), [...groups.map((group) => group.id)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    assert.ok(groups.every((group) => group.tutorials.length > 0));
    assert.equal(groups.flatMap((group) => group.tutorials).length, tutorials.length);
});

test('a parameter\'s value is read through its relationship, following a link to a shared parameter', async () => {
    const tank = await exampleDocument('tankCalibration.kjt');
    assert.equal(edgeParameterValue(tank, 'Heater input', 'waterThermalCapacitance'), 300000);
    assert.equal(edgeParameterValue(tank, 'Ambient heat loss', 'heatLossCoefficient'), 10);
    assert.equal(edgeParameterValue(tank, 'Nope', 'heatLossCoefficient'), undefined);
    const changed = structuredClone(tank);
    changed.sharedParameters[0].value = 209000;
    assert.equal(edgeParameterChanged(changed, tank, 'Heater input', 'waterThermalCapacitance'), true, 'A linked parameter changes with its shared one.');
    assert.equal(edgeParameterChanged(tank, tank, 'Heater input', 'waterThermalCapacitance'), false);
    assert.equal(edgeParameterChanged(null, tank, 'Heater input', 'waterThermalCapacitance'), false, 'No model (no run yet) is no change.');
});

// Plays a tutorial's checks over a sequence of situations, as the controller would, and returns the step it is on after each.
const play = (tutorial, start, situations) => {
    let reached = 1;
    return situations.map(({ document = start, ui: extra = {} }) => {
        reached = Math.max(reached, currentStep({ document, start, ui: ui(extra) }, reached, tutorial.steps));
        return tutorial.steps[reached].id;
    });
};

test('the calibration tutorial follows Parameter tuning from opening it to a run with the fitted values', async () => {
    const start = await exampleDocument('tankCalibration.kjt');
    assert.ok(start.nodes.some((node) => node.name === calibrateTankValues.tank), 'The tank the steps name is in the example.');
    const fitted = structuredClone(start);
    fitted.sharedParameters[0].value = 209000;
    fitted.edges.find((edge) => edge.name === 'Ambient heat loss').parameters.find((parameter) => parameter.symbol === 'heatLossCoefficient').value = 20;
    const halfFitted = structuredClone(start);
    halfFitted.sharedParameters[0].value = 209000;
    assert.deepEqual(play(calibrateTank, start, [
        {},
        { ui: { tuningOpen: true } },
        { ui: { tuningOpen: true, tuningDataLoaded: true } },
        { ui: { tuningOpen: true, tuningDataLoaded: true, tuningFitted: true } },
        { document: halfFitted, ui: { tuningOpen: true, tuningDataLoaded: true, tuningFitted: true } },
        { document: fitted },
        { document: fitted, ui: { hasResult: true, runModel: start } },
        { document: fitted, ui: { runModel: fitted } },
        { document: fitted, ui: { hasResult: true, runModel: fitted, plotsSeen: ['Water tank'], plotsSeenSinceRun: ['Water tank'] } }
    ]), ['openTuning', 'addData', 'runFit', 'apply', 'apply', 'run', 'run', 'plotTank', 'finish'],
    'Applying only one of the two values is not keeping the fit, and a run from before the fit is not a run of the calibrated model.');
    // Closing the card after the fit undoes nothing: the fitted values in the model are what count.
    const runIndex = calibrateTank.steps.findIndex((step) => step.id === 'run');
    assert.equal(brokenStep({ document: fitted, start, ui: ui() }, runIndex, calibrateTank.steps), null);
    assert.equal(calibrateTank.steps[brokenStep({ document: start, start, ui: ui() }, runIndex, calibrateTank.steps)].id, 'openTuning', 'Undoing the fit sends the person back.');
});

test('the controller tutorial asks for a run, a changed gain and a run with that gain, and its numbers are the example\'s', async () => {
    const start = await exampleDocument(tuneController.start.example);
    const controller = start.edges.find((edge) => edge.name === tuneControllerValues.controller);
    assert.ok(controller, 'The controller the steps name is in the example.');
    const gain = controller.parameters.find((parameter) => parameter.symbol === tuneControllerValues.gain.symbol);
    assert.equal(gain.id, tuneControllerValues.gain.parameterId, 'The fill finds the gain by this id.');
    assert.equal(gain.value, tuneControllerValues.gain.from, 'The card says the gain starts at this value.');
    assert.ok(start.nodes.some((node) => node.name === tuneControllerValues.joint));
    const changed = structuredClone(start);
    changed.edges.find((edge) => edge.name === tuneControllerValues.controller).parameters.find((parameter) => parameter.symbol === 'gain').value = tuneControllerValues.gain.to;
    assert.deepEqual(play(tuneController, start, [
        {},
        { ui: { hasResult: true, runModel: start } },
        { ui: { hasResult: true, runModel: start, plotsSeen: ['Joint link'], plotsSeenSinceRun: ['Joint link'] } },
        { ui: { hasResult: true, runModel: start, plotsSeen: ['Joint link'], edgeEditorFor: 'Position control' } },
        { ui: { runModel: start, plotsSeen: ['Joint link'] } },
        { ui: { runModel: start, plotsSeen: ['Joint link'], edgeEditorFor: 'Position control' } },
        { document: changed, ui: { runModel: start, plotsSeen: ['Joint link'], edgeEditorFor: 'Position control' } },
        { document: changed, ui: { hasResult: true, runModel: changed, plotsSeen: ['Joint link'] } },
        { document: changed, ui: { hasResult: true, runModel: changed, plotsSeen: ['Joint link'], plotsSeenSinceRun: ['Joint link'] } }
    ]), ['run', 'plotAngle', 'closeResults', 'closeResults', 'openController', 'changeGain', 'rerun', 'compare', 'finish'],
    'Opening the controller with results on screen is not enough (it cannot be edited then), and the plot from before the second run does not count as comparing.');
    // Closing the results, and the editor after changing the gain, undo nothing; putting the gain back does.
    const rerunIndex = tuneController.steps.findIndex((step) => step.id === 'rerun');
    const facts = (document) => ({ document, start, ui: ui({ runModel: start, plotsSeen: ['Joint link'] }) });
    assert.equal(brokenStep(facts(changed), rerunIndex, tuneController.steps), null);
    assert.equal(tuneController.steps[brokenStep(facts(start), rerunIndex, tuneController.steps)].id, 'openController');
});

test('only the closing card of the first-model tour is a bonus step; the others\' closing cards are not numbered', () => {
    for (const tutorial of [calibrateTank, tuneController]) {
        assert.equal(labelOf(0, tutorial.steps), '');
        assert.equal(labelOf(1, tutorial.steps), `Step 1 of ${tutorial.steps.length - 2}`);
        assert.equal(labelOf(tutorial.steps.length - 1, tutorial.steps), '');
    }
});

test('a skipped step is not reported as undone: "Skip this step" did it, and the person is not sent back to it', () => {
    const facts = { document: { nodes: [], edges: [] }, start: null, ui: ui() };
    const runIndex = tourSteps.findIndex((step) => step.id === 'run');
    assert.equal(brokenStep(facts, runIndex, tourSteps), 1, 'Undone and not skipped: the first step to repeat.');
    assert.equal(brokenStep(facts, runIndex, tourSteps, new Set([1, 2, 3, 4, 5])), null);
    assert.equal(brokenStep(facts, runIndex, tourSteps, new Set([1, 2])), 3);
});
