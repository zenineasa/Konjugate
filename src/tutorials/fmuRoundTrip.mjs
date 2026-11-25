/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Take a model out as an FMU and back" (docs/proposals/fmuImportWorkflow.md, stage 9), starting from the Spring Mass Damper example:
// the model run and its results kept to compare, exported as an FMI 3.0 FMU, tried as a node beside the model it came from (in the same
// window, as the tour lives in it), run again and compared with the original, identical; then two of the FMI standard's own example FMUs
// (examples/tutorialFmus/, the Reference FMUs Dahlquist and Feedthrough) put in the library, added, connected and run, where the
// connection is read a step late. Desktop only: the web edition runs no FMU.

export const fmuRoundTripValues = Object.freeze({
    runSeconds: 10,
    // What the exported FMU is called (its model's name, the example's file name) and its first output, by which the card finds it.
    exported: 'springMassDamper',
    source: { name: 'Dahlquist', output: 'x' },
    reader: { name: 'Feedthrough', input: 'float64ContinuousInput', inputName: 'Float64_continuous_input' },
    fmus: ['tutorialFmus/Dahlquist.fmu', 'tutorialFmus/Feedthrough.fmu']
});
const values = fmuRoundTripValues;

const fmuNode = (document, name) => (document.nodes ?? []).find((node) => node.name === name && node.implementation?.kind === 'fmi') ?? null;

// Feedthrough's continuous input reads Dahlquist's x.
export function fmusConnected(document) {
    const source = fmuNode(document ?? {}, values.source.name);
    const reader = fmuNode(document ?? {}, values.reader.name);
    const x = source?.states?.find((state) => state.symbol === values.source.output);
    const binding = reader?.implementation?.bindings?.find((item) => item.key === values.reader.input);
    return Boolean(x && binding?.kind === 'state' && binding.nodeId === source.id && binding.stateId === x.id);
}

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Take a model out as an FMU and back',
        text: 'An FMU is the standard package simulation tools trade models in. Here the Spring Mass Damper goes out as one and comes back as a node of a model, its run compared with the original\'s, number by number; then two FMUs from the FMI standard\'s own examples are connected, one feeding the other.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'run',
        title: 'Run the model',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start: this is the run the FMU will be compared with.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.resultEnd >= values.runSeconds - 1e-9 || ui.keptForComparison
    },
    {
        id: 'keep',
        title: 'Keep the results to compare',
        text: 'Press "Close and edit", then "Keep them to compare": the model unlocks for the export, and this window keeps the run.',
        target: (ui) => (ui.closeResultsAsking ? '#keepCloseResults' : '#closeResults'), skip: 'keepResults',
        done: ({ ui }) => ui.keptForComparison
    },
    {
        id: 'export',
        title: 'Export it as an FMU',
        text: 'Press "Export simulation code" (the ‹/› button in the title bar), set the format to "FMU (FMI 3.0 Co-Simulation)", read what a tool running it gets, press Export and choose where to save it.',
        target: (ui) => (ui.exportDialogOpen ? '#exportCodeFormat' : '#exportCodeButton'), skip: 'exportFmu3',
        done: ({ ui }) => ui.exportedKinds.includes('fmu3')
    },
    {
        id: 'try',
        title: 'Try it as a node',
        text: 'Press "Try it as a node" on the notice: the FMU you just saved joins this model as a node of its own, its four outputs as its states. Outside a tutorial it opens in a new window.',
        target: (ui) => (ui.exportNoticeOpen ? '#exportFmuTry' : '#exportCodeButton'), skip: 'tryFmuHere',
        done: ({ document }) => Boolean(fmuNode(document, values.exported))
    },
    {
        id: 'compare',
        title: 'Run it and compare',
        text: `Run again to ${values.runSeconds} s. The FMU runs beside the model it came from, and "Compare with original" sets its run against the one you kept: identical, to the last digit.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.comparedWithOriginal
    },
    {
        id: 'library',
        title: 'Add two FMUs',
        text: `Two FMUs from the FMI standard's own examples: ${values.source.name}, a value that decays, and ${values.reader.name}, which passes its inputs to its outputs. Press "Close and edit", then "Put them in my library", then Add (+): under FMU… add each.`,
        target: (ui) => (ui.resultsOpen ? '#closeResults' : '#addButton'), fill: 'putExampleFmus', fillLabel: 'Put them in my library', skip: 'addExampleFmus',
        done: ({ document }) => Boolean(fmuNode(document, values.source.name) && fmuNode(document, values.reader.name))
    },
    {
        id: 'connect',
        title: 'Connect them',
        text: `Click ${values.reader.name}. On its card, set ${values.reader.inputName} to read ${values.source.name}.${values.source.output}: an arrow joins them, and the row says when it is read.`,
        target: (ui) => ui.labelOf(values.reader.name) ?? '#addButton', skip: 'connectExampleFmus',
        done: ({ document }) => fmusConnected(document)
    },
    {
        id: 'runConnected',
        title: 'Run them',
        text: `Run to ${values.runSeconds} s again.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => fmusConnected(ui.runModel)
    },
    {
        id: 'finish',
        title: 'Your model went out as an FMU and came back',
        text: `${values.reader.name}'s output follows ${values.source.name}'s x a step behind: every node reads the others as they were at the start of each step, so no loop between FMUs ever needs solving. An FMU also arrives from Add › FMU…, a .fmu dropped on the canvas, or Extensions; a saved project keeps its FMUs in its file, so it runs on another computer.`,
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const fmuRoundTrip = Object.freeze({
    id: 'fmuRoundTrip',
    title: 'Take a model out as an FMU and back',
    summary: 'Export a model as an FMU, bring it back as a node and compare it with the original run, then connect two FMUs.',
    minutes: 6,
    area: 'results',
    tags: ['FMU', 'FMI', 'co-simulation', 'export', 'import', 'compare', 'round trip', 'connect', 'Reference FMUs'],
    start: { from: 'example', example: 'springMassDamper.kjt' },
    editions: ['desktop'],
    fmus: values.fmus,
    steps
});
