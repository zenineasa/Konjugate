/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Fix an unstable model" (docs/proposals/tutorials.md), starting from the Spring Mass Damper example: a spring made a hundred times
// stiffer is too fast for the step the model is run at, the pre-run check warns before anything is run, its warning leads to the
// relationship it blames and says how many substeps the mass needs, and raising them clears the warning. The numbers come from the engine's
// own validator: at the default 0.01 s step, a stiffness of 400 N/m makes it ask for at least 11 substeps on the Suspended mass (it has 4),
// and names the relationship's Mass parameter as the main driver.

import { edgeParameterValue } from './steps.mjs';

export const fixInstabilityValues = Object.freeze({
    spring: 'Spring force',
    stiffness: { symbol: 'stiffness', parameterId: 9, from: 4, to: 400 },
    mass: { name: 'Suspended mass', id: 1, substepsFrom: 4, substepsTo: 11 },
    warning: 'numericsPotentiallyUnstable',
    runSeconds: 10
});
const values = fixInstabilityValues;

const substepsOf = (document) => Number((document?.nodes ?? []).find((node) => node.id === values.mass.id)?.numerics?.substepsPerGlobalStep ?? 1);
const fixed = (document) => substepsOf(document) >= values.mass.substepsTo;
const stiffened = (document) => edgeParameterValue(document, values.spring, values.stiffness.symbol) === values.stiffness.to;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Fix an unstable model',
        text: 'Konjugate moves a model forward in fixed steps. Something that changes much faster than the step can be followed makes the result grow without limit, however right the equations are. Here you will make this spring stiff enough to do that, let Konjugate warn you before anything runs, follow the warning to its cause and fix it.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'stiffen',
        title: 'Make the spring stiffer',
        text: `Click the "${values.spring}" relationship (its row in the label between the mass and the support, or the line itself) and change Spring stiffness from ${values.stiffness.from} to ${values.stiffness.to}, then press Enter or click elsewhere so the change is kept. The mass will want to bounce ten times faster.`,
        target: (ui) => (ui.edgeEditorFor === values.spring ? `#edgeEditorParameters [data-parameter-id="${values.stiffness.parameterId}"] input[data-field="value"]` : ui.relationshipRowOf(values.spring)),
        skip: 'setParameter', relationship: values.spring, parameterId: values.stiffness.parameterId, value: values.stiffness.to,
        done: ({ document }) => stiffened(document)
    },
    {
        id: 'seeWarning',
        title: 'A warning, before anything runs',
        text: 'Every change is checked straight away. The model is still valid, but the status at the top right now has a warning: open it to see the list.',
        target: '#validationSummary', skip: 'openValidationList',
        done: ({ document, ui }) => ui.validationPanelOpen || ui.followedIssue === values.warning || fixed(document)
    },
    {
        id: 'followWarning',
        title: 'Follow it',
        text: `The warning says the ${values.mass.name} may be unstable, which relationship's parameter drives it, and how many substeps it needs. Click the warning: it takes you to that parameter.`,
        target: '#validationIssues', skip: 'followStabilityWarning', warning: values.warning,
        done: ({ document, ui }) => ui.followedIssue === values.warning || fixed(document)
    },
    {
        id: 'raiseSubsteps',
        title: 'Give the mass more substeps',
        text: `The warning asked for at least ${values.mass.substepsTo} substeps on the ${values.mass.name}: it is stepped ${values.mass.substepsTo} times for every step of the whole model, so its fast bouncing can be followed while everything else keeps its own pace. Click the ${values.mass.name}, open its Numerics tab, and set "Substeps per global step" from ${values.mass.substepsFrom} to ${values.mass.substepsTo}. The warning goes away.`,
        target: (ui) => (ui.nodeEditorFor === values.mass.name ? (ui.numericsTabShown ? '#editNodeSubsteps' : '#nodeEditor [data-node-tab="numerics"]') : ui.labelOf(values.mass.name)),
        skip: 'setSubsteps', node: values.mass.name, substeps: values.mass.substepsTo,
        done: ({ document, ui }) => fixed(document) && !ui.validationCodes.includes(values.warning)
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => fixed(ui.runModel) && stiffened(ui.runModel)
    },
    {
        id: 'plot',
        title: 'A steady bounce',
        text: `Click the ${values.mass.name} to plot it: it bounces fast and dies away, as a stiff, damped spring should, instead of swinging wider every time.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.mass.name)), skip: 'plotNode', node: values.mass.name,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.mass.name)
    },
    {
        id: 'finish',
        title: 'You have fixed an unstable model',
        text: 'More substeps on the one fast node is the cheap fix: the rest of the model keeps its step. The warning sometimes says no number of substeps will help, when something like a controller pushes too hard: then the fix is the model, not the numerics. During a run, the Stability button beside the timeline lists anything that started to grow, and can check whether a node\'s result converged.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const fixInstability = Object.freeze({
    id: 'fixInstability',
    title: 'Fix an unstable model',
    summary: 'Make a spring too stiff for the step, follow the warning to its cause, and fix it with substeps.',
    minutes: 3,
    area: 'modelling',
    tags: ['stability', 'unstable', 'numerics', 'substeps', 'time step', 'warning', 'validation', 'diverge', 'blow up', 'stiff', 'spring', 'mechanical'],
    start: { from: 'example', example: 'springMassDamper.kjt' },
    editions: ['desktop', 'web'],
    steps
});
