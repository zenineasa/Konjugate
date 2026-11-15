/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Reuse a part of a model" (docs/proposals/subsystemComponents.md#tutorials): the Thermal Equilibrium example's two bodies folded into a
// subsystem, which is a component; a state of it made a port and its conductance exposed; a second instance placed beside it, with a
// conductance of its own; the two connected; run; and the component saved to My library, which works in both editions and needs no file
// picker.

export const reuseComponentValues = Object.freeze({
    subsystem: 'Pair',
    port: { node: 'Cold body', symbol: 'temperature', name: 'Outlet' },
    parameter: { symbol: 'conductance', name: 'Conductance', secondValue: 10 },
    link: { from: 'Cold body', to: 'Hot body', name: 'Link' },
    runSeconds: 60
});
const values = reuseComponentValues;

const instances = (document) => (document?.subsystems ?? []).filter((subsystem) => subsystem.definitionId != null && subsystem.parentSubsystemId == null);
const definitionOf = (document, subsystem) => (document?.subsystemDefinitions ?? []).find((definition) => definition.id === subsystem?.definitionId) ?? null;
const pair = (document) => instances(document).find((subsystem) => subsystem.name === values.subsystem) ?? instances(document)[0] ?? null;
const pairDefinition = (document) => definitionOf(document, pair(document))?.document ?? null;
const folded = (document) => instances(document).some((subsystem) => (document.nodes ?? []).filter((node) => node.subsystemId === subsystem.id).length >= 2);
const portNamed = (document) => (pairDefinition(document)?.component?.ports ?? []).some((port) => port.name === values.port.name);
const exposed = (document) => (pairDefinition(document)?.sharedParameters ?? []).some((shared) => shared.exposed && shared.symbol === values.parameter.symbol);
const twoInstances = (document) => {
    const first = pair(document);
    return Boolean(first) && instances(document).filter((subsystem) => subsystem.definitionId === first.definitionId).length >= 2;
};
// Each instance's copy has a symbol of its own in the project ("conductance", "conductance2"), so it is found by its start.
const ownValue = (document) => (document?.sharedParameters ?? []).some((shared) => String(shared.symbol).startsWith(values.parameter.symbol) && shared.subsystemId != null && Number(shared.value) === values.parameter.secondValue);
// A relationship from a node of one instance to a node of the other.
const connected = (document) => {
    const owner = new Map((document?.nodes ?? []).map((node) => [node.id, node.subsystemId ?? null]));
    const ids = new Set(instances(document).map((subsystem) => subsystem.id));
    return (document?.edges ?? []).some((edge) => {
        const from = owner.get(edge.source?.nodeId);
        const to = owner.get(edge.target?.nodeId);
        return ids.has(from) && ids.has(to) && from !== to;
    });
};

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Reuse a part of a model',
        text: 'A subsystem is a component: a part with a boundary that can be placed more than once, each copy kept identical, each with values of its own where you choose. You will make the two bodies of this example into a component, give it a port and a parameter, place it twice, connect the two, run them, and keep the component in your library for other models.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'fold',
        title: 'Fold the two bodies into a subsystem',
        text: `Select both bodies (⌘A, Ctrl+A on Windows and Linux), press "Create subsystem" in the toolbar, name it "${values.subsystem}" and press Create subsystem.`,
        target: (ui) => (ui.subsystemDialogOpen ? '#subsystemName' : '#createSubsystem'), skip: 'createSubsystem', name: values.subsystem,
        done: ({ document }) => folded(document)
    },
    {
        id: 'openCard',
        title: 'Open its card',
        text: `Click the "${values.subsystem}" box once. Its card shows what it holds, what crosses its boundary, and, under Component, its ports and parameters.`,
        target: (ui) => ui.subsystemLabelOf(values.subsystem), skip: 'openSubsystemCard', name: values.subsystem,
        done: ({ document, ui }) => ui.subsystemCardFor === values.subsystem || twoInstances(document)
    },
    {
        id: 'port',
        title: 'Give it a port',
        text: `Under Ports, choose "${values.port.node} · ${values.port.symbol}" in "Make a state a port", then name the port "${values.port.name}". A port is what the component offers outside: other models connect to it.`,
        target: (ui) => (ui.subsystemCardFor ? '#subsystemAddPort' : ui.subsystemLabelOf(values.subsystem)), skip: 'declarePort', subsystem: values.subsystem, ...values.port,
        done: ({ document }) => portNamed(document)
    },
    {
        id: 'expose',
        title: 'Expose its conductance',
        text: `Under Parameters, choose "${values.parameter.name} (${values.parameter.symbol})" in "Expose a parameter". Each placement of the component can then have a conductance of its own.`,
        target: (ui) => (ui.subsystemCardFor ? '#subsystemExposeParameter' : ui.subsystemLabelOf(values.subsystem)), skip: 'exposeParameter', subsystem: values.subsystem, symbol: values.parameter.symbol,
        done: ({ document }) => exposed(document)
    },
    {
        id: 'another',
        title: 'Place it again',
        text: 'Press "Place another instance" in the card. The second box is the same component: change something inside either, and the other follows.',
        target: (ui) => (ui.subsystemCardFor ? '#subsystemPlaceAnother' : ui.subsystemLabelOf(values.subsystem)), skip: 'placeAnotherInstance', subsystem: values.subsystem,
        done: ({ document }) => twoInstances(document)
    },
    {
        id: 'ownValue',
        title: 'Give the second its own conductance',
        text: `In the second box's card, set ${values.parameter.name} to ${values.parameter.secondValue} W/K. The first keeps 50: what is exposed is each instance's own.`,
        target: (ui) => (ui.subsystemCardFor ? '#subsystemEditorParameterList [data-parameter-value]' : '#canvas'), skip: 'setInstanceParameter', symbol: values.parameter.symbol, value: values.parameter.secondValue,
        done: ({ document }) => ownValue(document)
    },
    {
        id: 'connect',
        title: 'Connect the two',
        text: `Open Add edge (the + button, then Edge). From and To list the nodes inside the boxes by where they are: choose the first box's ${values.link.from} and the second box's ${values.link.to}, write an equation, and press Create edge. Heat now flows from one component to the other.`,
        target: (ui) => (ui.edgeBuilderOpen ? '#edgeSource' : '#addButton'), skip: 'connectInstances', ...values.link,
        done: ({ document }) => connected(document)
    },
    {
        id: 'run',
        title: 'Run them',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start. The engine runs both copies, and the link between them, as one model.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => connected(ui.runModel)
    },
    {
        id: 'library',
        title: 'Keep it in your library',
        text: `Close the results, click a "${values.subsystem}" box to select it, and press "Save to my library" (⊞) in the toolbar, then Save. It is kept as a component, with its port and parameter, to place in any model.`,
        target: (ui) => (ui.templateDialogOpen ? '#templateSubmit' : '#saveTemplateButton'), skip: 'saveSubsystemToLibrary', subsystem: values.subsystem,
        done: ({ ui }) => ui.libraryComponents.includes(values.subsystem)
    },
    {
        id: 'finish',
        title: 'You have reused a part',
        text: 'In another model, open the component library and place "Pair" from My library; it stays linked, so changing it in the library updates every model that uses it. A subsystem can also be saved as a file of its own, with "Save as component file…", and placed from one with Add, then Component from file. "Make this one separate" gives one instance its own copy to change.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const reuseComponent = Object.freeze({
    id: 'reuseComponent',
    title: 'Reuse a part of a model',
    summary: 'Make a subsystem a component with a port and a parameter, place it twice, connect the two, and keep it in your library.',
    minutes: 6,
    area: 'modelling',
    tags: ['component', 'subsystem', 'reuse', 'instance', 'port', 'expose', 'parameter', 'my library', 'link', 'place another', 'thermal'],
    start: { from: 'example', example: 'thermalEquilibrium.kjt' },
    editions: ['desktop', 'web'],
    steps
});
