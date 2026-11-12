/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Build from components" (docs/proposals/tutorials.md), from an empty canvas: the Single Joint Actuator example built again from the
// component library, three part templates (a voltage source, a motor, a load) joined by two relationship templates whose equations bind
// themselves to the parts' states by name. The run's numbers are the example's: the motor's current jumps to about 10 A, and its speed
// climbs to 44 rad/s in about two seconds, where the motor's torque balances friction and the load.

export const buildFromComponentsValues = Object.freeze({
    parts: [
        { template: 'voltageSource', name: 'Voltage source' },
        { template: 'motor', name: 'Motor' },
        { template: 'torqueLoad', name: 'Torque load' }
    ],
    armature: { template: 'armatureDynamics', name: 'Armature dynamics', from: 'Voltage source', to: 'Motor' },
    shaft: { template: 'shaftDynamics', name: 'Shaft dynamics', from: 'Torque load', to: 'Motor' },
    runSeconds: 5
});
const values = buildFromComponentsValues;

const nodeId = (document, name) => (document?.nodes ?? []).find((node) => node.name === name)?.id;
const partsPlaced = (document) => values.parts.every((part) => nodeId(document, part.name) !== undefined);
const connected = (document, { name, from, to }) => (document?.edges ?? []).some((edge) => edge.name === name
    && edge.source?.nodeId === nodeId(document, from) && edge.target?.nodeId === nodeId(document, to));

// Where a step that applies a relationship template points: the template, then each end in turn, then the builder's Create button.
const connectTarget = (connection) => (ui) => {
    if (ui.endpointPick === 'source') return ui.labelOf(connection.from);
    if (ui.endpointPick === 'target') return ui.labelOf(connection.to);
    if (ui.edgeBuilderOpen) return '#createEdge';
    return ui.libraryOpen ? `[data-template-id="${connection.template}"]` : '#componentLibraryButton';
};

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Build from components',
        text: 'The component library holds ready-made parts (a motor, a battery, a thermal mass) and the relationships that join them, with their equations and typical values filled in. You will build a motor driving a load from three parts and two relationships, without writing an equation, and run it.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openLibrary',
        title: 'Open the library',
        text: 'Open the component library from the toolbar. Its parts are grouped by domain: electrical, mechanical, thermal and more.',
        target: '#componentLibraryButton', skip: 'openLibrary',
        done: ({ document, ui }) => ui.libraryOpen || partsPlaced(document)
    },
    {
        id: 'placeParts',
        title: 'Place three parts',
        text: 'Click "Voltage source", "Motor" and "Torque load" in the library. Each click puts that part on the canvas, with its states and their units: the supply\'s 24 V, the motor\'s current and speed, the load\'s 0.1 N·m.',
        target: (ui) => (ui.libraryOpen ? '#componentLibraryPanel' : '#componentLibraryButton'), skip: 'placeTemplates', templates: values.parts,
        done: ({ document }) => partsPlaced(document)
    },
    {
        id: 'armature',
        title: 'Connect the supply to the motor',
        text: `Click "${values.armature.name}" in the library, then click the ${values.armature.from} on the canvas and then the ${values.armature.to}: from the part that drives to the part that is driven. Its equation binds itself to the two parts' states by their names; check the builder's equation reads, and press Create edge.`,
        target: connectTarget(values.armature), skip: 'connectTemplate', connection: values.armature,
        done: ({ document }) => connected(document, values.armature)
    },
    {
        id: 'shaft',
        title: 'Connect the load to the motor',
        text: `The same with "${values.shaft.name}": click it, then the ${values.shaft.from}, then the ${values.shaft.to}, and press Create edge. This is the mechanical side: the motor's torque against the load and friction.`,
        target: connectTarget(values.shaft), skip: 'connectTemplate', connection: values.shaft,
        done: ({ document }) => connected(document, values.shaft)
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => connected(ui.runModel, values.armature) && connected(ui.runModel, values.shaft)
    },
    {
        id: 'plot',
        title: 'Watch it spin up',
        text: 'Click the Motor to plot it. Its current jumps to about 10 A as the supply is switched on, then its speed climbs to 44 rad/s in about two seconds, where its torque balances friction and the load.',
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf('Motor')), skip: 'plotNode', node: 'Motor',
        done: ({ ui }) => ui.plotsSeenSinceRun.includes('Motor')
    },
    {
        id: 'finish',
        title: 'You have built a model from components',
        text: 'Every value a part brings is a starting point: open a part or a relationship to change it. The library\'s search and domain buttons narrow it down, and its assemblies place several parts already joined. The Single Joint Actuator example is this same model, and the robot arms in the Examples menu are built from it.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const buildFromComponents = Object.freeze({
    id: 'buildFromComponents',
    title: 'Build from components',
    summary: 'Build a motor driving a load from library parts and relationships, without writing an equation, and run it.',
    minutes: 4,
    area: 'modelling',
    tags: ['component library', 'components', 'templates', 'parts', 'library', 'motor', 'electrical', 'mechanical', 'ports', 'assemble', 'build'],
    start: { from: 'empty', fileName: 'Motor and load.kjt' },
    editions: ['desktop', 'web'],
    steps
});
