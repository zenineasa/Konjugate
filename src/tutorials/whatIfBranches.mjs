/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Ask what if, with branches" (docs/proposals/tutorials.md), starting from the Position Controlled Joint example: a run, then a fork from
// 4 s of it in which the joint's target angle is changed, run on from the state the first run had reached there, and the two compared on one
// plot. Forking reads the engine's checkpoints, which the web edition's engine does not keep, so this tutorial is for the desktop app.

export const whatIfBranchesValues = Object.freeze({
    joint: 'Joint link',
    setpoint: { name: 'Setpoint angle', parameterId: 21, from: 1.2, to: -0.5 },
    forkSeconds: 4,
    runSeconds: 10
});
const values = whatIfBranchesValues;

// A fork that has run, with the target angle changed in it.
const forked = (ui) => ui.forks.some((fork) => fork.finished && fork.values.includes(values.setpoint.to));

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Ask what if, with branches',
        text: 'A result is not the end of a run. You can go back to any moment in it, change something, and run on from exactly the state the model was in, while the first run stays as it was. Here the joint will be on its way to its target when you ask: what if the target had moved at that moment?',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start. This first run is the baseline: the joint turns to its ${values.setpoint.from} rad target.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.hasResult || ui.runModel !== null
    },
    {
        id: 'scrub',
        title: `Go back to ${values.forkSeconds} s`,
        text: `Drag the timeline back to ${values.forkSeconds} s. The values on the canvas follow it: this is the moment you will fork from.`,
        target: '#resultTimeline', skip: 'moveTimelineTo', seconds: values.forkSeconds,
        done: ({ ui }) => Math.abs(ui.timelineTime - values.forkSeconds) <= 0.25 || ui.forkPanelOpen || ui.forks.length > 0
    },
    {
        id: 'fork',
        title: 'Fork here',
        text: `Press "Baseline" beside the timeline to open the branches, then "Fork at ${values.forkSeconds} s".`,
        target: (ui) => (ui.branchesPanelOpen ? '#forkHereButton' : '#branchesButton'), skip: 'openFork',
        done: ({ ui }) => ui.forkPanelOpen || ui.runDialogOpen || ui.forks.length > 0
    },
    {
        id: 'changeTarget',
        title: 'Change the target, and run the fork',
        text: `The fork can start with different values for the model's live parameters. Set "${values.setpoint.name}" to ${values.setpoint.to}, press Continue, keep "Run until" at ${values.runSeconds} s and press Start. The fork runs from ${values.forkSeconds} s on, from the joint's angle and speed at that moment.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : ui.forkPanelOpen ? '#forkParameterRows' : '#branchesButton'),
        skip: 'runFork', parameterName: values.setpoint.name, value: values.setpoint.to, runSeconds: values.runSeconds, seconds: values.forkSeconds,
        done: ({ ui }) => forked(ui)
    },
    {
        id: 'plot',
        title: 'Plot the fork',
        text: `Click the ${values.joint} to plot this branch: up to ${values.forkSeconds} s it is the baseline, then it turns back towards ${values.setpoint.to} rad.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.joint)), skip: 'plotNode', node: values.joint,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.joint) || ui.comparing
    },
    {
        id: 'compare',
        title: 'Compare the two',
        text: 'Open the branches again (the button beside the timeline now names the fork) and tick the box beside Baseline. Its curves join the fork\'s on the plot, so the two futures sit side by side.',
        target: (ui) => (ui.branchesPanelOpen ? '#branchTree' : '#branchesButton'), skip: 'compareBaseline',
        done: ({ ui }) => ui.comparing
    },
    {
        id: 'finish',
        title: 'You have asked what if',
        text: 'Forks can be forked again, into a tree of what-ifs, and clicking a branch shows it. A fork can also run with its own time step, to check a result holds up with a finer one. Saving the project with its results keeps every branch.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const whatIfBranches = Object.freeze({
    id: 'whatIfBranches',
    title: 'Ask what if, with branches',
    summary: 'Go back to a moment in a run, fork it with a different target, and compare the two futures on one plot.',
    minutes: 4,
    area: 'results',
    tags: ['branches', 'branch', 'fork', 'what if', 'scenario', 'compare', 'timeline', 'checkpoint', 'results', 'controller', 'setpoint', 'live parameter'],
    start: { from: 'example', example: 'positionControlledJoint.kjt' },
    editions: ['desktop'],
    steps
});
