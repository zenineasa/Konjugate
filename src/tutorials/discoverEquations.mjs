/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Discover equations from data" (docs/proposals/tutorials.md), from an empty canvas: causal inference reads a recording of a heated room
// (examples/heatingRecord.csv, written by scripts/generateHeatingRecord.mjs: the temperature outside, the heater's power and the room's
// temperature, every 10 minutes for two days), finds which columns drive which, and turns what it finds into nodes and relationships with
// fitted equations. In that recording the room follows both the weather and the heater a reading later, and the two causes are unrelated:
// the engine finds exactly outdoorTemperature -> roomTemperature and heaterPower -> roomTemperature, both lagged, and nothing else.

export const discoverEquationsValues = Object.freeze({
    recording: 'heatingRecord.csv',
    columns: ['outdoorTemperature', 'heaterPower', 'roomTemperature']
});
const values = discoverEquationsValues;

// The recording's columns are in the model as nodes, joined by relationships: what Import selected leaves.
const imported = (document) => (document?.nodes ?? []).length >= values.columns.length && (document?.edges ?? []).length >= 2;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Discover equations from data',
        text: 'Sometimes there is a recording but no model: you know what was measured, not how the measurements drive each other. Causal inference reads a recording, works out which columns predict which others a moment later, and writes those as relationships with fitted equations. Here it will read two days of a heated room.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openInference',
        title: 'Open causal inference',
        text: 'Open Causal inference from the toolbar.',
        target: '#causalInferenceButton', skip: 'openInference',
        done: ({ document, ui }) => ui.inferenceOpen || imported(document)
    },
    {
        id: 'addData',
        title: 'Add the recording',
        text: 'The recording has the temperature outside, the heater\'s power and the room\'s temperature, every ten minutes for two days, in a CSV file that comes with this tutorial. Download it with the link below: it goes to your Downloads folder. Then press "Choose CSV file" in Causal inference and pick it from there. A recording needs a time column first, evenly spaced, then one column per measurement.',
        link: { label: `Download the recording (${values.recording})`, action: 'downloadTutorialData' },
        target: '#causalInferenceFileChooser', skip: 'loadInferenceData',
        done: ({ document, ui }) => ui.inferenceLoaded || ui.inferenceCandidates || imported(document)
    },
    {
        id: 'runInference',
        title: 'Run it',
        text: 'Each column is matched to a node\'s state by name. This model is empty, so each will become a new node. Press Run inference.',
        target: '#runCausalInference', skip: 'runInference',
        done: ({ document, ui }) => ui.inferenceCandidates || imported(document)
    },
    {
        id: 'import',
        title: 'What it found',
        text: 'Two relationships: outdoorTemperature → roomTemperature and heaterPower → roomTemperature, both marked lagged, because each column\'s earlier value predicts the room\'s next one. It found nothing between the weather and the heater, rightly: they have nothing to do with each other. Below them, each column\'s own decay. Press Import selected.',
        target: '#commitCausalInference', skip: 'importInference',
        done: ({ document }) => imported(document)
    },
    {
        id: 'readEquation',
        title: 'Read an equation',
        text: 'The recording is now a model: three nodes, two relationships. Click one of the relationships to open it and read the equation that was fitted to the data, with its coefficient as a parameter you can change.',
        target: (ui) => ui.anyRelationshipRow, skip: 'openAnyRelationship',
        done: ({ ui }) => ui.edgeEditorFor !== null
    },
    {
        id: 'finish',
        title: 'You have discovered a model from data',
        text: 'Inference proposes; you decide. A column that someone sets, like the heater\'s power, can be marked as an input, so the model replays what was recorded instead of explaining it. Curvature and interaction effects can be allowed when straight lines are not enough. And Parameter tuning can refine the fitted values against the same recording.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const discoverEquations = Object.freeze({
    id: 'discoverEquations',
    title: 'Discover equations from data',
    summary: 'Let causal inference read a recording of a heated room and write what drives what as relationships.',
    minutes: 3,
    area: 'data',
    tags: ['causal inference', 'inference', 'discover', 'equations', 'data', 'recording', 'CSV', 'time series', 'regression', 'system identification', 'lagged', 'thermal'],
    start: { from: 'empty', fileName: 'Heated room.kjt' },
    data: [values.recording],
    editions: ['desktop', 'web'],
    steps
});
