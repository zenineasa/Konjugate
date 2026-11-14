/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Organise a larger model" (docs/proposals/tutorials.md), from an empty canvas: one thermal mass from the library, copied and pasted into
// three, one of them warmed, all three joined by one edge group (one shared relationship, meshed between every pair of members, both ways),
// and the three put into a subsystem that is entered, run and left. With a coefficient of 0.1 per kelvin on each of a mass's two incoming
// relationships, three masses starting at 400, 293.15 and 293.15 K settle together at about 329 K within the 20 s run.

export const organiseModelValues = Object.freeze({
    mass: { template: 'thermalMass', name: 'Thermal mass', symbol: 'temperature', from: 293.15, warm: 400 },
    count: 3,
    groupLatex: String.raw`0.1\cdot(\mathrm{sourceTemperature}-\mathrm{targetTemperature})`,
    subsystem: 'Bodies',
    runSeconds: 20
});
const values = organiseModelValues;

const masses = (document) => (document?.nodes ?? []).filter((node) => (node.states ?? []).some((state) => state.symbol === values.mass.symbol));
const warmed = (document) => masses(document).some((node) => node.states.some((state) => state.symbol === values.mass.symbol && Number(state.initialValue) === values.mass.warm));
const group = (document) => (document?.edgeGroups ?? []).find((candidate) => (candidate.memberNodeIds ?? []).length >= values.count) ?? null;
const groupWritten = (document) => {
    const definition = group(document)?.definition;
    return Boolean(definition && String(definition.equation ?? '').trim() && definition.output?.symbol === values.mass.symbol);
};
// A subsystem holding all three: membership is kept on each node, as its subsystem's id.
const nested = (document) => (document?.subsystems ?? []).some((subsystem) => (document.nodes ?? []).filter((node) => node.subsystemId === subsystem.id).length >= values.count);

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Organise a larger model',
        text: 'Models grow: many parts alike, joined the same way, too many to see at once. You will make three bodies that share heat, by copying one; join every pair of them with one shared relationship instead of six; and fold the three into a subsystem you can step into and out of.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'placeMass',
        title: 'Place one body',
        text: 'Open the component library from the toolbar and click "Thermal mass": a body with a temperature, starting at 293.15 K.',
        target: (ui) => (ui.libraryOpen ? `[data-template-id="${values.mass.template}"]` : '#componentLibraryButton'),
        skip: 'placeTemplates', templates: [{ template: values.mass.template, name: values.mass.name }],
        done: ({ document }) => masses(document).length >= 1
    },
    {
        id: 'copyPaste',
        title: 'Copy it into three',
        text: 'Click the Thermal mass on the canvas to select it, press Copy in the toolbar (or ⌘C, Ctrl+C on Windows and Linux), then Paste twice. Each copy lands a little to the side, with everything the first had.',
        target: (ui) => (ui.canPaste ? '#pasteSelection' : ui.selectedCount ? '#copySelection' : ui.labelOf(values.mass.name)),
        skip: 'copyPasteNode', node: values.mass.name, copies: values.count - 1,
        done: ({ document }) => masses(document).length >= values.count
    },
    {
        id: 'warmOne',
        title: 'Warm one of them',
        text: `Click the first "${values.mass.name}" (the one without "copy" in its name) and change its Temperature from ${values.mass.from} to ${values.mass.warm} K in its editor, then press Enter.`,
        target: (ui) => (ui.nodeEditorFor === values.mass.name ? '#nodeEditorStates input[data-field="value"]' : ui.labelOf(values.mass.name)),
        skip: 'setStateValue', node: values.mass.name, symbol: values.mass.symbol, value: values.mass.warm,
        done: ({ document }) => warmed(document)
    },
    {
        id: 'selectAll',
        title: 'Select all three',
        text: 'Press ⌘A (Ctrl+A on Windows and Linux) with the canvas in use, or choose Select all from the Add menu. The rectangle tool and the multi-select tool in the toolbar select a few of many.',
        target: '#addButton', skip: 'selectAllNodes',
        done: ({ document, ui }) => ui.selectedCount >= values.count || group(document) !== null
    },
    {
        id: 'makeGroup',
        title: 'Join them with an edge group',
        text: 'Press "Create edge group" in the toolbar. It joins every pair of the selected nodes both ways, six relationships for three nodes, all sharing one definition: change it once and all six change.',
        target: '#createEdgeGroup', skip: 'createGroup',
        done: ({ document }) => group(document) !== null
    },
    {
        id: 'groupEquation',
        title: 'Write the shared equation',
        text: 'In the group\'s editor, set Updates to temperature and enter 0.1·(sourceTemperature − targetTemperature), with the reference buttons for the names: each body warms by a tenth of a degree a second for every degree its neighbour is hotter.',
        target: '#groupMathField', skip: 'writeGroupEquation', latex: values.groupLatex, output: values.mass.symbol,
        done: ({ document }) => groupWritten(document)
    },
    {
        id: 'makeSubsystem',
        title: 'Fold them into a subsystem',
        text: `Select all three again if they are not, press "Create subsystem" in the toolbar, name it "${values.subsystem}" and press Create subsystem. The three become one box on the canvas.`,
        target: (ui) => (ui.subsystemDialogOpen ? '#subsystemName' : '#createSubsystem'), skip: 'createSubsystem', name: values.subsystem,
        done: ({ document }) => nested(document)
    },
    {
        id: 'enter',
        title: 'Step inside',
        text: `Click the "${values.subsystem}" box to step inside it. The path at the top of the canvas says where you are.`,
        target: (ui) => (ui.insideSubsystem ? '#subsystemBreadcrumb' : ui.subsystemLabelOf(values.subsystem)), skip: 'enterSubsystem', name: values.subsystem,
        done: ({ ui }) => ui.enteredSubsystem
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start. A subsystem changes how the model is shown, not how it runs.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => groupWritten(ui.runModel)
    },
    {
        id: 'plot',
        title: 'Heat spreads',
        text: `Click the warm ${values.mass.name} to plot it: it cools from ${values.mass.warm} K as its two neighbours warm, and the three settle together at about 329 K.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.mass.name)), skip: 'plotNode', node: values.mass.name,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.mass.name)
    },
    {
        id: 'leave',
        title: 'Step back out',
        text: 'Click "Model" in the path at the top of the canvas to step back out to the whole model.',
        target: '#subsystemBreadcrumb', skip: 'leaveSubsystem',
        done: ({ ui }) => ui.enteredSubsystem && !ui.insideSubsystem
    },
    {
        id: 'finish',
        title: 'You have organised a model',
        text: 'Subsystems can hold subsystems. A node selected on the canvas can join a group from its editor, and a member can be detached to give it values of its own. Selected nodes can also be saved as your own component, with "Save to my library", to place again in any model.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const organiseModel = Object.freeze({
    id: 'organiseModel',
    title: 'Organise a larger model',
    summary: 'Copy one part into three, join them all with one shared relationship, and fold them into a subsystem.',
    minutes: 6,
    area: 'modelling',
    tags: ['subsystem', 'edge group', 'group', 'mesh', 'copy', 'paste', 'select all', 'rectangle select', 'multi-select', 'organise', 'organize', 'hierarchy', 'my library', 'thermal'],
    start: { from: 'empty', fileName: 'Three bodies.kjt' },
    editions: ['desktop', 'web'],
    steps
});
