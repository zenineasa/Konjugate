/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Tune a controller" (docs/proposals/tutorials.md), starting from the Position Controlled Joint example: run it, make the controller's
// gain larger, run it again and compare. The values were chosen by running the example: with the shipped gain of 5 the angle reaches 95 %
// of its 1.2 rad target after about 5.7 s without overshoot; with 10 it gets there in about 1.3 s, overshoots to about 1.28 rad and has
// settled by about 7 s; at 15 it overshoots to about 1.58 rad and takes most of 20 s to settle; at 20 the loop is unstable.

import { edgeParameterChanged } from './steps.mjs';

export const tuneControllerValues = Object.freeze({
    joint: 'Joint link',
    controller: 'Position control',
    gain: { symbol: 'gain', parameterId: 19, from: 5, to: 10 },
    runSeconds: 10
});
const values = tuneControllerValues;

const gainChanged = (document, start) => edgeParameterChanged(document, start, values.controller, values.gain.symbol);
const gainInput = `#edgeEditorParameters [data-parameter-id="${values.gain.parameterId}"] input[data-field="value"]`;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Tune a controller',
        text: `This joint follows a target angle of 1.2 rad. A controller, the "${values.controller}" relationship, compares the joint's angle with the target and sets the voltage that drives its motor. You will run it, make the controller push harder, run it again and see what changes. The Example guide button in the toolbar explains the model, whenever you want the details.`,
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'run',
        title: 'Run it as it is',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.hasResult || ui.runModel !== null
    },
    {
        id: 'plotAngle',
        title: 'Look at the angle',
        text: `Click the "${values.joint}" to open its editor, which plots its angle over the run. It rises smoothly to 1.2 rad without overshooting, but slowly: it takes about 6 seconds to get close.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.joint)), skip: 'plotNode', node: values.joint,
        done: ({ ui }) => ui.plotsSeen.includes(values.joint)
    },
    {
        id: 'closeResults',
        title: 'Back to editing',
        text: `While results are on screen the model is locked, so nothing can change under them. First close the ${values.joint}'s editor with the × at its top right, since it covers the end of the timeline. Then press "Close and edit" beside the timeline, and "Close and remove results". Keep the curve you just saw in mind: you will compare against it.`,
        target: (ui) => (ui.closeResultsDialogOpen ? '#confirmCloseResults' : ui.openEditorClose ?? '#closeResults'), skip: 'closeResults',
        done: ({ document, start, ui }) => !ui.hasResult || gainChanged(document, start)
    },
    {
        id: 'openController',
        title: 'Open the controller',
        text: `The controller is the "${values.controller}" relationship, from the ${values.joint} to the Voltage source. Click its row in the relationship label between them, or the line itself, to open its editor.`,
        target: (ui) => ui.relationshipRowOf(values.controller), skip: 'openRelationship', relationship: values.controller,
        done: ({ document, start, ui }) => ui.edgeEditorFor === values.controller || gainChanged(document, start)
    },
    {
        id: 'changeGain',
        title: 'Turn up the gain',
        text: `"Gain" says how hard the controller pushes for each radian the joint is away from its target. Change its initial value from ${values.gain.from} to ${values.gain.to}, then press Enter or click elsewhere so the change is kept.`,
        target: (ui) => (ui.edgeEditorFor === values.controller ? gainInput : ui.relationshipRowOf(values.controller)), skip: 'setParameter', relationship: values.controller, parameterId: values.gain.parameterId, value: values.gain.to,
        done: ({ document, start }) => gainChanged(document, start)
    },
    {
        id: 'rerun',
        title: 'Run it again',
        text: `Run it again with the new gain: press Run, keep "Run until" at ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ start, ui }) => gainChanged(ui.runModel, start)
    },
    {
        id: 'compare',
        title: 'Compare',
        text: `Click the "${values.joint}" again. With twice the gain the angle gets close to 1.2 rad in about a second instead of six, but it now overshoots, to about 1.28 rad, before it settles back.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.joint)), skip: 'plotNode', node: values.joint,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.joint)
    },
    {
        id: 'finish',
        title: 'You have tuned a controller',
        text: `That is the trade every controller makes: more gain answers faster and overshoots more. Try 15, and then 20: at 15 it swings well past the target and takes most of 20 seconds to settle, and at 20 it never settles, because the controller has become unstable. "Rate gain" damps the swing; try raising it too. Parameter tuning can also search for the best values for you, against a goal you write.`,
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const tuneController = Object.freeze({
    id: 'tuneController',
    title: 'Tune a controller',
    summary: 'Change a controller\'s gain, run again, and see the trade between a fast answer and overshoot.',
    minutes: 4,
    area: 'control',
    tags: ['controller', 'control', 'gain', 'PID', 'feedback', 'setpoint', 'overshoot', 'stability', 'parameter', 'relationship editor', 'robotics', 'motor'],
    start: { from: 'example', example: 'positionControlledJoint.kjt' },
    editions: ['desktop', 'web'],
    steps
});
