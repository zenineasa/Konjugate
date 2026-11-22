/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Optimise towards a goal" (docs/proposals/tutorials.md), starting from the Tank Calibration example: Parameter tuning searching for the
// parameter values that maximise a number from the run (the water's final temperature) instead of matching data, then the same search
// held to a limit (the water may never pass 340 K). Left alone, the search would drive both parameters to their lower bounds, since a
// smaller thermal mass warms faster and a smaller loss coefficient leaks less heat; but the example's guessed values already take the
// water to about 355 K, past the limit, so the search raises both (a larger heat capacity, a larger heat loss) until the hottest the water
// gets is the limit, and ends inside it: with this example and these settings, 362,649 J/K and 14.93 W/K, the water at 339.97 K.

export const optimiseObjectiveValues = Object.freeze({
    state: 'Water tank · Water temperature',
    // The name the objective editor gives that state (src/renderer/tuningObjective.mjs: node name and state symbol, camel-cased).
    stateName: 'waterTankTankTemperature',
    runSeconds: 28800,
    timeStep: 600,
    limit: 340
});
const values = optimiseObjectiveValues;

// Once a search has run on an objective, the steps that set it up are done, whatever the card shows after (it resets when closed).
const searched = (ui) => ui.objectiveSearched;
const objectiveIsFinal = (ui) => ui.objectiveValid && ui.objectiveLatex.includes('lim') && ui.objectiveLatex.includes(values.stateName);
const limitHeld = (ui) => ui.objectiveLimits.some((limit) => limit.latex.includes('max') && limit.latex.includes(values.stateName)
    && limit.relation === '<=' && Number(limit.limit) === values.limit);

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Optimise towards a goal',
        text: 'Parameter tuning can do more than match measurements: it can search for the parameter values that make a number from the run as large or as small as possible. On this water tank you will ask for the warmest water after eight hours, see where the search goes, then hold it to a limit. The About this example button (?) in the toolbar explains the model, whenever you want the details.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openTuning',
        title: 'Open Parameter tuning',
        text: 'Open Parameter tuning from the toolbar. The tank\'s two uncertain numbers, its heat capacity and its heat loss, are already marked tunable, each with the range it may take.',
        target: '#parameterTuningButton', skip: 'openTuning',
        done: ({ ui }) => ui.tuningOpen || searched(ui)
    },
    {
        id: 'chooseObjective',
        title: 'Choose a goal instead of data',
        text: 'Press "Optimise an objective" at the top of the card. An objective is one number worked out from each simulation the search tries.',
        target: '#parameterTuningGoalObjective', skip: 'chooseObjective',
        done: ({ ui }) => ui.tuningGoal === 'objective' || searched(ui)
    },
    {
        id: 'writeObjective',
        title: 'Write the objective',
        text: `The objective is written like a relationship's equation, with buttons for what it can use. Click "final" under Summaries, then "${values.state}" under States, so it reads as the water temperature at the end of the run. The line under it says whether it reads.`,
        target: '#parameterTuningSummaryButtons', skip: 'writeFinalObjective', state: values.state,
        done: ({ ui }) => objectiveIsFinal(ui) || searched(ui)
    },
    {
        id: 'setGoal',
        title: 'Maximise it, over eight hours',
        text: `Set Goal to Maximise. Each simulation the search tries must run long enough for the answer to mean something: set "Runs for" to ${values.runSeconds} s, eight hours, and "Time step" to ${values.timeStep} s.`,
        target: '#parameterTuningDirection', skip: 'setObjectiveGoal', direction: 'maximise', runSeconds: values.runSeconds, timeStep: values.timeStep,
        done: ({ ui }) => (ui.objectiveDirection === 'maximise' && ui.objectiveRunTime === values.runSeconds && ui.objectiveTimeStep === values.timeStep) || searched(ui)
    },
    {
        id: 'addLimit',
        title: 'Add a limit',
        text: `Left alone, the search heats the water as much as it can. Real goals come with limits: press the ＋ beside Limits, click "max" under Summaries and then "${values.state}", keep "stays at most", and enter ${values.limit}. The water may then never pass ${values.limit} K.`,
        target: '#addParameterTuningConstraint', skip: 'addObjectiveLimit', state: values.state, limit: values.limit,
        done: ({ ui }) => limitHeld(ui) || searched(ui)
    },
    {
        id: 'runSearch',
        title: 'Run the search',
        text: 'Press Run fit. The search tries simulation after simulation, keeping the best that holds to the limit.',
        target: '#runParameterTuning', skip: 'runFit',
        done: ({ ui }) => searched(ui)
    },
    {
        id: 'review',
        title: 'Where it went',
        text: `The search raised both numbers: the heat capacity from 300,000 to 362,649 J/K, so the water warms more slowly, and the heat loss from 10 to 14.93 W/K, so it keeps less of the heat. With the guessed values the water ends at about 355 K, past the limit; with these, the hottest it gets is 339.97 K, just under ${values.limit} K: the warmest water the limit allows. Without the limit it would have gone the other way, both to the bottom of their ranges. The card gives the limit with its tolerance, says it holds, and what the water came to; the plot compares its temperature before and after.`,
        advance: 'next', done: () => true
    },
    {
        id: 'finish',
        title: 'You have optimised a model',
        text: 'Apply a result only if you want to keep it: these values make the hottest tank the limit allows, not the real one. The objective can also be a Python or C++ program, for goals that are not a formula, such as how long the water takes to settle; the example guide shows how.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const optimiseObjective = Object.freeze({
    id: 'optimiseObjective',
    title: 'Optimise towards a goal',
    summary: 'Have Parameter tuning search for the values that maximise a number from the run, held to a limit.',
    minutes: 4,
    area: 'tuning',
    tags: ['objective', 'optimise', 'optimize', 'optimisation', 'maximise', 'minimise', 'goal', 'limit', 'constraint', 'design', 'parameter tuning', 'search', 'thermal', 'tank'],
    start: { from: 'example', example: 'tankCalibration.kjt' },
    editions: ['desktop', 'web'],
    steps
});
