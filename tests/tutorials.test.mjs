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
import { exampleTitle, groupTutorials, tutorialModelFiles, searchTutorials, tutorialAreas, tutorialById, tutorialDataFiles, tutorials, tutorialsForExample, tutorialStartLabel } from '../src/tutorials/index.mjs';
import { brokenStepBefore as brokenStep, currentStepIndex as currentStep, edgeParameterChanged, edgeParameterValue, offersNext, onlineRunTarget, stepLabel as labelOf, stepText } from '../src/tutorials/steps.mjs';
import { tuneController, tuneControllerValues } from '../src/tutorials/tuneController.mjs';
import { heatingRecordCsv } from '../scripts/generateHeatingRecord.mjs';
import { buildFromComponentsValues } from '../src/tutorials/buildFromComponents.mjs';
import { fixInstabilityValues } from '../src/tutorials/fixInstability.mjs';
import { optimiseObjectiveValues } from '../src/tutorials/optimiseObjective.mjs';
import { steerByHandValues } from '../src/tutorials/steerByHand.mjs';
import { whatIfBranchesValues } from '../src/tutorials/whatIfBranches.mjs';
import { parametersAndRunsValues } from '../src/tutorials/parametersAndRuns.mjs';
import { layoutModelValues } from '../src/tutorials/layoutModel.mjs';
import { equationsThatDoMoreValues } from '../src/tutorials/equationsThatDoMore.mjs';
import { programRelationshipValues } from '../src/tutorials/programRelationship.mjs';
import { replayLogValues } from '../src/tutorials/replayLog.mjs';
import { refitTwinValues } from '../src/tutorials/refitTwin.mjs';
import { readDataLog } from '../src/dataLog.mjs';
import { parsePlan } from '../src/inputForecast.mjs';
import { scheduleChangesValues } from '../src/tutorials/scheduleChanges.mjs';
import { organiseModelValues } from '../src/tutorials/organiseModel.mjs';
import { driveWithJoysticksValues } from '../src/tutorials/driveWithJoysticks.mjs';
import { excavator, excavatorParts, excavatorProject, startingPoses, startingTip } from '../scripts/generateExcavatorExample.mjs';
import { objectiveVocabulary } from '../src/renderer/tuningObjective.mjs';

// The first-model tour's tests below were written against its own step list; these bind the shared functions to it.
const tourSteps = firstModel.steps;
const currentStepIndex = (facts, reached = 0) => currentStep(facts, reached, tourSteps);
const brokenStepBefore = (facts, index) => brokenStep(facts, index, tourSteps);
const stepLabel = (index) => labelOf(index, tourSteps);

const node = (id, name = id === 1 ? 'Heater' : 'Block', initialValue = id === 1 ? 350 : 300) => ({ id, name, states: [{ id: id + 1, symbol: 'temperature', initialValue }] });
const edge = (from, to, equation = 'k * (sourceT - targetT)', role = 'target', mathJson = ['Multiply', 'k', ['Subtract', 'sourceT', 'targetT']]) => ({ id: 30, equation, equationModel: { output: { role }, mathJson }, source: { nodeId: from }, target: { nodeId: to } });
const ui = (extra = {}) => ({
    nodeEditorFor: null, endpointPick: null, edgeEditorFor: null, runDialogOpen: false, hasResult: false, runModel: null, timelineMoved: false,
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
    assert.equal(step('addNode').done({ document: { nodes: [node(1, 'New node', 0)], edges: [] }, ui: ui() }), true, 'A node made from the Add menu is the step done.');
    assert.equal(step('firstNode').done({ document: { nodes: [node(1, 'New node', 0)], edges: [] }, ui: ui() }), false, 'A node not yet defined is not the one asked for.');
    assert.equal(step('firstNode').done({ document: { nodes: [node(1)], edges: [] }, ui: ui() }), true);
    assert.equal(step('firstNode').done({ document: { nodes: [{ id: 1, name: 'Heater', states: [] }], edges: [] }, ui: ui() }), false, 'A node with no state is not the one asked for.');
    assert.equal(step('secondNode').done({ document: { nodes: [node(1)], edges: [] }, ui: ui() }), false);
    assert.equal(step('secondNode').done({ document: { nodes: [node(1), node(10)], edges: [] }, ui: ui() }), true);
    const two = { nodes: [node(1), node(10)], edges: [] };
    assert.equal(step('addEdge').done({ document: two, ui: ui({ endpointPick: 'target' }) }), false, 'Ends being picked are not yet a relationship.');
    assert.equal(step('addEdge').done({ document: { ...two, edges: [edge(1, 1)] }, ui: ui() }), false, 'An edge from a node to itself is not a connection.');
    assert.equal(step('addEdge').done({ document: { ...two, edges: [edge(1, 10, '')] }, ui: ui() }), true, 'A relationship made between the two, with its part still empty, is the step done.');
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10, '')] }, ui: ui() }), false);
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10)] }, ui: ui() }), true);
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10, '0')] }, ui: ui() }), false, 'The 0 a new relationship starts with is not the equation asked for.');
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10, undefined, 'source')] }, ui: ui() }), false, 'An equation that changes the heater is not the one asked for.');
    assert.equal(step('equation').done({ document: { ...two, edges: [edge(1, 10, undefined, 'target', null)] }, ui: ui() }), false, 'An equation whose k is not yet a parameter is not valid.');
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

test('a step that waits for Next once done (a plot to read) stays on screen, offering Next, even when the steps after it are done', () => {
    const steps = [
        { id: 'welcome', advance: 'next', done: () => true },
        { id: 'run', done: ({ ui }) => ui.ran },
        { id: 'plot', waitForNext: true, done: ({ ui }) => ui.plotted },
        { id: 'timeline', done: ({ ui }) => ui.moved },
        { id: 'finish', advance: 'next', done: () => false }
    ];
    const at = (ui, reached = 1) => steps[currentStep({ ui }, reached, steps)].id;
    assert.equal(at({ ran: true, plotted: false, moved: true }), 'plot', 'Not done yet, it is the step on screen.');
    assert.equal(offersNext(steps[2], { ui: { plotted: false } }), false, 'Until it is done it offers no Next, only its skip.');
    assert.equal(at({ ran: true, plotted: true, moved: true }), 'plot', 'Done, it is not walked past, though the step after it is done too.');
    assert.equal(offersNext(steps[2], { ui: { plotted: true } }), true, 'Done, it offers Next.');
    assert.equal(at({ ran: true, plotted: true, moved: true }, 3), 'finish', 'Next pressed (the tutorial reached the step after), the done steps after it are passed.');
    assert.equal(at({ ran: true, plotted: true, moved: false }, 3), 'timeline');
    assert.equal(brokenStep({ ui: { ran: true, plotted: false, moved: true } }, 3, steps), 2, 'Undone later, it is offered to go back to, as any step is.');
    assert.equal(offersNext(steps[0], { ui: {} }), true, 'A step with nothing to do always offers Next.');
    assert.equal(offersNext(steps[1], { ui: { ran: true } }), false, 'A step without the flag never does.');
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
            // A step whose work is in another window (the live twin's) points at nothing here, and says where it is instead.
            if (step.advance !== 'next') assert.ok(step.target || step.elsewhere === 'twin', `${tutorial.id}/${step.id} points at nothing`);
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
            // An example in the Examples dialog, or a model beside them (examples/dataSources/) that the loader opens for tutorials alone.
            assert.ok(manifest.examples.some((entry) => `${entry.id}.kjt` === example) || (example.startsWith('dataSources/') && tutorialModelFiles.includes(example)), `${tutorial.id}'s example is not in examples/manifest.json`);
            assert.ok(tutorialsForExample(example).includes(tutorial));
        } else {
            assert.equal(tutorial.start.from, 'empty');
        }
        for (const fileName of tutorial.data ?? []) assert.ok(existsSync(join(root, 'examples', fileName)), `${tutorial.id} reads ${fileName}, which is not shipped`);
    }
    assert.deepEqual([...tutorialDataFiles].sort(), ['dataSources/labVesselLog.csv', 'heatingRecord.csv', 'tankCalibrationMeasured.csv']);
    assert.equal(tutorialById('nope'), null);
    assert.deepEqual(tutorialsForExample('twoLinkArm.kjt'), []);
    assert.deepEqual(tutorialsForExample('tankCalibration.kjt').map((tutorial) => tutorial.id), ['calibrateTank', 'optimiseObjective'], 'An example can have several tutorials.');
});

test('an example is named in the list as the Examples dialog names it', () => {
    for (const tutorial of tutorials.filter((candidate) => candidate.start.from === 'example')) assert.equal(exampleTitle(tutorial.start.example), exampleLabel(tutorial.start.example.split('/').at(-1)));
    assert.equal(tutorialStartLabel(calibrateTank), 'Starts from the Tank Calibration example');
    assert.equal(tutorialStartLabel(firstModel), 'From an empty canvas');
    // A model beside the examples, which the Examples dialog does not list, is not called an example.
    assert.equal(tutorialStartLabel(tutorialById('replayLog')), 'Starts from the Lab Vessel model');
});

test('the list is searched by title, tags, sentence and starting example, every word counting, best match first', () => {
    const ids = (query) => searchTutorials(query).map((tutorial) => tutorial.id);
    assert.deepEqual(ids(''), tutorials.map((tutorial) => tutorial.id), 'Nothing typed lists everything, in order.');
    assert.equal(ids('calibrate')[0], 'calibrateTank');
    assert.equal(ids('PID')[0], 'tuneController', 'Case does not matter.');
    assert.equal(ids('measured data')[0], 'calibrateTank');
    assert.equal(ids('Tank Calibration')[0], 'calibrateTank', 'The starting example\'s name finds it.');
    assert.deepEqual(ids('position controlled joint').sort(), tutorialsForExample('positionControlledJoint.kjt').map((tutorial) => tutorial.id).sort(), 'An example\'s name finds every tutorial on it.');
    assert.equal(ids('first')[0], 'firstModel');
    assert.equal(ids('fork')[0], 'whatIfBranches');
    assert.equal(ids('what if')[0], 'whatIfBranches');
    assert.equal(ids('stability')[0], 'fixInstability');
    assert.equal(ids('substeps')[0], 'fixInstability');
    assert.equal(ids('digital twin')[0], 'liveTwin');
    assert.equal(ids('keyboard')[0], 'steerByHand');
    assert.equal(ids('gamepad')[0], 'steerByHand');
    assert.equal(ids('component library')[0], 'buildFromComponents');
    assert.equal(ids('causal')[0], 'discoverEquations');
    assert.equal(ids('maximise')[0], 'optimiseObjective');
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

// Plays a tutorial's checks over a sequence of situations, as the controller would, and returns the step it is on after each. A step
// that waits for Next once done (a plot to read) is read and moved on from, as a person does.
const play = (tutorial, start, situations) => {
    let reached = 1;
    return situations.map(({ document = start, ui: extra = {} }) => {
        const facts = { document, start, ui: ui(extra) };
        reached = Math.max(reached, currentStep(facts, reached, tutorial.steps));
        while (tutorial.steps[reached].waitForNext && tutorial.steps[reached].done(facts)) reached = currentStep(facts, reached + 1, tutorial.steps);
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

test('the heating record the inference tutorial downloads is the one its generator writes', async () => {
    assert.equal(await readFile(join(root, 'examples', 'heatingRecord.csv'), 'utf8'), heatingRecordCsv(),
        'examples/heatingRecord.csv has drifted from scripts/generateHeatingRecord.mjs: run the script again.');
});

test('the names, ids and starting values the newer tutorials\' cards and skips rely on are the examples\' own', async () => {
    const joint = await exampleDocument('positionControlledJoint.kjt');
    const setpoint = joint.edges.find((edge) => edge.name === 'Position control').parameters.find((parameter) => parameter.symbol === 'setpointAngle');
    assert.equal(setpoint.id, whatIfBranchesValues.setpoint.parameterId);
    assert.equal(setpoint.value, whatIfBranchesValues.setpoint.from);
    assert.equal(setpoint.mode, 'live', 'A fork can only start with other values for live parameters.');
    assert.ok(whatIfBranchesValues.setpoint.to >= setpoint.control.minimum && whatIfBranchesValues.setpoint.to <= setpoint.control.maximum);
    assert.equal(setpoint.id, steerByHandValues.setpoint.parameterId);
    assert.equal(setpoint.symbol, steerByHandValues.setpoint.symbol);
    assert.equal(setpoint.name, steerByHandValues.setpoint.name);

    const spring = await exampleDocument('springMassDamper.kjt');
    const stiffness = spring.edges.find((edge) => edge.name === fixInstabilityValues.spring).parameters.find((parameter) => parameter.symbol === 'stiffness');
    assert.equal(stiffness.id, fixInstabilityValues.stiffness.parameterId);
    assert.equal(stiffness.value, fixInstabilityValues.stiffness.from);
    const mass = spring.nodes.find((node) => node.id === fixInstabilityValues.mass.id);
    assert.equal(mass.name, fixInstabilityValues.mass.name);
    assert.equal(mass.numerics.substepsPerGlobalStep, fixInstabilityValues.mass.substepsFrom);

    const tank = await exampleDocument('tankCalibration.kjt');
    const state = objectiveVocabulary(tank).states.find((candidate) => candidate.label === optimiseObjectiveValues.state);
    assert.equal(state?.name, optimiseObjectiveValues.stateName, 'The objective editor names the tank\'s temperature as the card expects.');

    for (const id of [...buildFromComponentsValues.parts.map((part) => part.template), buildFromComponentsValues.armature.template, buildFromComponentsValues.shaft.template]) {
        const template = JSON.parse(await readFile(join(root, 'assets', 'componentLibrary', `${id}.json`), 'utf8'));
        const part = buildFromComponentsValues.parts.find((candidate) => candidate.template === id);
        if (part) assert.equal(template.name, part.name, `The ${id} template places a node called ${part.name}.`);
    }
});

test('the third wave\'s names, ids and starting values are the shipped models\' own', async () => {
    const spring = await exampleDocument('springMassDamper.kjt');
    for (const { relationship, parameterId } of [parametersAndRunsValues.spring, parametersAndRunsValues.damper]) {
        const parameter = spring.edges.find((edge) => edge.name === relationship).parameters.find((candidate) => candidate.id === parameterId);
        assert.equal(parameter.symbol, parametersAndRunsValues.mass.symbol);
        assert.equal(parameter.value, parametersAndRunsValues.mass.from);
    }
    const tank = await exampleDocument('heatedWaterTank.kjt');
    assert.ok(tank.nodes.some((node) => node.name === layoutModelValues.heater) && tank.nodes.some((node) => node.name === layoutModelValues.tank));
    const shapes = JSON.parse(await readFile(join(root, 'assets', 'shapes', 'manifest.json'), 'utf8'));
    assert.ok((shapes.shapes ?? shapes).some((shape) => shape.id === layoutModelValues.shape.id && shape.name === layoutModelValues.shape.name));
    const thermal = await exampleDocument('thermalEquilibrium.kjt');
    assert.ok(thermal.nodes.some((node) => node.name === equationsThatDoMoreValues.hot));
    assert.equal(thermal.edges[0].name, programRelationshipValues.relationship);
    assert.equal(thermal.edges[0].directionality, 'bidirectional');
    const conductance = thermal.edges[0].parameters.find((parameter) => parameter.symbol === 'conductance').value;
    const capacitance = thermal.edges[0].parameters.find((parameter) => parameter.symbol === 'thermalCapacitance').value;
    assert.ok(programRelationshipValues.line.includes(String(conductance / capacitance)), 'The program uses the relationship\'s own conductance over capacitance.');
    const vessel = await exampleDocument(replayLogValues.capacitance && 'dataSources/labVessel.kjt');
    for (const { id, from } of [replayLogValues.capacitance, replayLogValues.heatLoss]) assert.equal(vessel.sharedParameters.find((parameter) => parameter.id === id).value, from);
    const log = await readFile(join(root, 'examples', replayLogValues.log), 'utf8');
    for (const { column } of replayLogValues.columns) assert.ok(log.split(/\r?\n/)[0].split(';').includes(column), `The log has a ${column} column.`);
    const rig = await exampleDocument('dataSources/simulatedTankRig.kjt');
    assert.equal(rig.edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === refitTwinValues.heatLoss.parameterId).value, refitTwinValues.heatLoss.from);
    // The operator's plan the tutorial has the person type is the drifting rig's own: each time its heater changes in the recording is a
    // time of the plan, by the recording's clock in the plan's time zone, with the value it changed to.
    assert.equal(rig.sharedParameters.find((parameter) => parameter.symbol === refitTwinValues.heater.input).name, refitTwinValues.heater.name);
    const drifting = readDataLog(await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRigDrifting.csv'), 'utf8'));
    const { points } = parsePlan(refitTwinValues.heater.plan);
    const heaterReadings = drifting.observations.filter((observation) => observation.signal === refitTwinValues.heater.input);
    const changes = heaterReadings.filter((reading, index) => index === 0 || reading.value !== heaterReadings[index - 1].value);
    assert.equal(changes.length, points.length);
    for (const change of changes) {
        const clock = new Date(drifting.header.epoch + change.time * 1000);
        assert.equal(refitTwinValues.heater.timeZone, 'UTC');
        const at = clock.getUTCHours() * 3600 + clock.getUTCMinutes() * 60 + clock.getUTCSeconds();
        assert.ok(points.some((point) => point.at === at && point.value === change.value), `The heater's change to ${change.value} W at ${clock.toISOString()} is in the plan.`);
    }
    const joint = await exampleDocument('positionControlledJoint.kjt');
    assert.equal(joint.edges.flatMap((edge) => edge.parameters).find((parameter) => parameter.id === scheduleChangesValues.setpoint.parameterId).mode, 'live');
    const mass = JSON.parse(await readFile(join(root, 'assets', 'componentLibrary', `${organiseModelValues.mass.template}.json`), 'utf8'));
    assert.equal(mass.name, organiseModelValues.mass.name);
    assert.equal(mass.states[0].initialValue, organiseModelValues.mass.from);
});

test('the excavator the joystick tutorial drives is the one its generator writes, with a live command for each of the four axes', async () => {
    const shipped = await exampleDocument('excavator.kjt');
    assert.deepEqual(shipped, JSON.parse(JSON.stringify(excavatorProject())), 'examples/excavator.kjt has drifted from scripts/generateExcavatorExample.mjs: run the script again.');
    const live = shipped.nodes.flatMap((node) => node.sourceTerms.flatMap((term) => term.parameters)).filter((parameter) => parameter.mode === 'live');
    // In the model's order: Settings › Controllers lists them so, Bind goes on through them so, and the card names them so.
    assert.deepEqual(live.map((parameter) => parameter.symbol), driveWithJoysticksValues.commands.map((command) => command.symbol));
    for (const parameter of live) assert.deepEqual([parameter.control.minimum, parameter.control.maximum, parameter.value], [-1, 1, 0], `${parameter.name} is centred, from −1 to 1.`);
    // Each joystick drives two commands, on two different axes; the keys stand in for all four, each pair distinct.
    for (const joystick of [0, 1]) assert.deepEqual(driveWithJoysticksValues.commands.filter((command) => command.joystick === joystick).map((command) => command.axis).sort(), [0, 1]);
    const keys = driveWithJoysticksValues.commands.flatMap((command) => [command.keys.up, command.keys.down]);
    assert.equal(new Set(keys).size, keys.length);
    // The tip starts above the ground and below the lift height, so the dig asks for both.
    const tip = startingTip();
    assert.ok(tip.height > driveWithJoysticksValues.ground && tip.height < driveWithJoysticksValues.lift);
    assert.ok(shipped.nodes.some((node) => node.name === driveWithJoysticksValues.tip));
    // The Pose Visualizer finds four bodies on Machine pose, each by its prefix to its own six names, and draws each with its part.
    const poseNode = shipped.nodes.find((node) => node.name === 'Machine pose');
    const symbols = poseNode.states.map((entry) => entry.symbol);
    for (const { prefix } of excavatorParts) {
        for (const role of ['X', 'Y', 'Z', 'Roll', 'Pitch', 'Yaw']) assert.ok(symbols.includes(`${prefix}${role}`), `Machine pose has no ${prefix}${role}.`);
        const part = poseNode.appearance.parts.find((candidate) => candidate.prefix === prefix);
        assert.ok(part && part.mesh.position.length === 72 && part.mesh.index.length === 36, `The ${prefix}'s part is not a box.`);
    }
    // Each part held at the end of the one before: the bucket's far end is the tip, where the model's own reckoning puts it.
    const poses = startingPoses();
    const end = poses.bucket;
    const length = excavator.lengths.bucket;
    assert.ok(Math.abs(end.z - length * Math.sin(end.pitch) - tip.height) < 1e-9, 'The bucket\'s far end is not at the tip\'s height.');
    assert.ok(Math.abs(Math.hypot(end.x + length * Math.cos(end.pitch) * Math.cos(end.yaw), end.y + length * Math.cos(end.pitch) * Math.sin(end.yaw)) - tip.reach) < 1e-9, 'The bucket\'s far end is not at the tip\'s reach.');
    for (const { prefix } of excavatorParts) for (const role of ['x', 'y', 'z', 'pitch', 'yaw']) {
        assert.ok(Math.abs(poseNode.states.find((entry) => entry.symbol === `${prefix}${role[0].toUpperCase()}${role.slice(1)}`).initialValue - poses[prefix][role]) < 1e-6);
    }
    assert.match(driveWithJoysticksValues.poseVisualizer.since, /^1\.0\.7$/);
});

test('a step asking for an online run points at what is left to set, one thing after another, and at Start last', () => {
    const at = (ui) => onlineRunTarget({ settingsOpen: false, runDialogOpen: true, ...ui }, 60);
    assert.equal(at({ settingsOpen: true }), '#settingsClose');
    assert.equal(at({ runDialogOpen: false }), '#runButton');
    assert.equal(at({ runDialog: { online: false, pacing: 'realTime', targetTime: '1' } }), '#runOnlineMode');
    assert.equal(at({ runDialog: { online: true, pacing: 'limitedRatio', targetTime: '1' } }), '#runPacingMode');
    assert.equal(at({ runDialog: { online: true, pacing: 'realTime', targetTime: '1' } }), '#runTargetTime');
    assert.equal(at({ runDialog: { online: true, pacing: 'realTime', targetTime: '60' } }), '#startRun');
});

test('a twin tutorial\'s "Open the live twin" is done by the window brought up for it, and the plan step by the forecast turning with a plan in UTC', () => {
    for (const id of ['liveTwin', 'matchSignals', 'refitTwin']) {
        const open = tutorialById(id).steps.find((step) => step.id === 'openTwin');
        // A twin window left open from before (minimized, or behind the project window) is not one the person has in front of them.
        assert.equal(Boolean(open.done({ document: { nodes: [] }, ui: { twinWindowOpen: true, twinWindowShown: false, twinSawRunning: true } })), false, `${id}: a window from before is not it.`);
        assert.equal(open.done({ document: { nodes: [] }, ui: { twinWindowShown: true } }), true, `${id}: the window brought up is.`);
    }
    const plan = tutorialById('refitTwin').steps.find((step) => step.id === 'plan');
    const inZone = (timeZone) => ({ [refitTwinValues.heater.input]: { forecast: 'plan', plan: { repeat: 'daily', timeZone, points: [] } } });
    assert.equal(plan.done({ ui: { twinInputs: inZone('UTC'), twinSawPlanTurn: false } }), false, 'Kept, but not yet seen turning.');
    assert.equal(plan.done({ ui: { twinInputs: inZone('Asia/Calcutta'), twinSawPlanTurn: true } }), false, 'The computer\'s own zone is not the rig\'s clock.');
    assert.equal(plan.done({ ui: { twinInputs: inZone('UTC'), twinSawPlanTurn: true } }), true);
    assert.equal(plan.done({ ui: { twinInputs: inZone('Etc/UTC'), twinSawPlanTurn: true } }), true);
    assert.equal(plan.status({ twinInputs: {} }), '');
    assert.match(plan.status({ twinInputs: inZone('Asia/Calcutta') }), /in Asia\/Calcutta: the rig's clock is UTC/);
    assert.match(plan.status({ twinInputs: inZone('UTC') }), /^The plan is kept/);
});

test('a step that asks to look at something stays done for the rest of that play once seen, and a new play judges it afresh', async () => {
    const { latch } = await import('../src/tutorials/latches.mjs');
    let open = true;
    const seen = latch(() => open);
    const play = {};
    assert.equal(seen({ start: play }), true);
    open = false;
    assert.equal(seen({ start: play }), true, 'Closing what was looked at does not undo the step.');
    assert.equal(seen({ start: {} }), false, 'Another play of the tutorial starts afresh.');
    // The relationship tutorial's first step: Direction seen at the top of the card's Equations tab, then the next step opens the Hot body.
    const bothWays = tutorialById('equationsThatDoMore').steps.find((step) => step.id === 'bothWays');
    const start = {};
    const facts = (ui) => ({ document: { nodes: [] }, start, ui: { edgeEditorFor: null, edgeEditorTab: null, ...ui } });
    assert.equal(bothWays.waitForNext, true, 'The card opens on Direction: the step waits for Next so it is read.');
    assert.equal(bothWays.tab, 'equations', 'Its skip opens the card where Direction is.');
    assert.equal(bothWays.target({ edgeEditorFor: 'Conduction', edgeEditorTab: 'equations' }), '#editEdgeDirection');
    assert.equal(bothWays.target({ edgeEditorFor: 'Conduction', edgeEditorTab: 'parameters' }), '#edgeEditor [data-editor-tab="equations"]');
    assert.equal(bothWays.done(facts({ edgeEditorFor: 'Conduction', edgeEditorTab: 'parameters' })), false, 'A tab without Direction is not seeing it.');
    assert.equal(bothWays.done(facts({ edgeEditorFor: 'Conduction', edgeEditorTab: 'equations' })), true);
    assert.equal(bothWays.done(facts({ nodeEditorFor: 'Hot body' })), true, 'Going on to the Hot body is not undoing it.');
});

test('the first-model tour\'s equation is the one its card asks for, however it is written', () => {
    const equation = firstModel.steps.find((step) => step.id === 'equation');
    const documentWith = (mathJson) => ({ nodes: [{ id: 1 }, { id: 2 }], edges: [{ source: { nodeId: 1 }, target: { nodeId: 2 }, equation: 'k*(sourceTemperature-targetTemperature)', equationModel: { output: { role: 'target' }, mathJson } }] });
    assert.equal(equation.done({ document: documentWith(['Multiply', 'k', ['Subtract', 'sourceTemperature', 'targetTemperature']]) }), true);
    assert.equal(equation.done({ document: documentWith(['Multiply', 'k', ['Delimiter', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]]]) }), true);
    assert.equal(equation.done({ document: documentWith(['Subtract', ['Multiply', 'k', 'sourceTemperature'], 'targetTemperature']) }), false, 'k·T_H − T_B reads both ends but is not the heat flow asked for.');
});

test('a program relationship is written only when it declares the keys it reads, and an own part only when it reads as an equation', () => {
    const write = tutorialById('programRelationship').steps.find((step) => step.id === 'write');
    const line = programRelationshipValues.line;
    const programWith = (source) => ({ edges: [{ name: 'Conduction', implementation: { kind: 'python', source } }] });
    const declared = '            [\n                ScalarPort("hot", "hot", ""),\n                ScalarPort("cold", "cold", ""),\n            ],';
    assert.equal(write.done({ document: programWith(`${declared}\n${line}`) }), true);
    assert.equal(write.done({ document: programWith(`            [\n                # No bindings declared yet\n            ],\n${line}`) }), false, 'A template from before the bindings reads keys it does not declare, and fails when run.');
    const leak = tutorialById('equationsThatDoMore').steps.find((step) => step.id === 'sourceTerm');
    const hotWith = (expressionModel) => ({ nodes: [{ name: 'Hot body', states: [{ id: 2, symbol: 'temperature' }], sourceTerms: [{ state: 'temperature', expression: expressionModel.latex, expressionModel }] }] });
    assert.equal(leak.done({ document: hotWith({ latex: '-0.01\\cdot(\\mathrm{temperature}-290)', mathJson: ['Multiply', -0.01, ['Subtract', 'temperature', 290]], output: { stateId: 2 } }) }), true);
    assert.equal(leak.done({ document: hotWith({ latex: '-0.01\\cdot(-290', mathJson: null, output: { stateId: 2 } }) }), false, 'A part that does not read is not the leak.');
});

test('the record of changes is read once the run has ended, though it opens by itself when the wave starts', () => {
    const changes = tutorialById('scheduleChanges').steps.find((step) => step.id === 'changes');
    assert.equal(changes.done({ ui: { changesShown: true, simulationRunning: true, repeated: false } }), false);
    assert.equal(changes.done({ ui: { changesShown: true, simulationRunning: false, repeated: false } }), true);
    assert.match(changes.status({ simulationRunning: true }), /still going/);
});
