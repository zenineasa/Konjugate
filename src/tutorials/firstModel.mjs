/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The guided first-model tour (docs/proposals/guidedTour.md), the first of the tutorials (docs/proposals/tutorials.md): from an empty
// canvas to a first run. Its checks ask whether things exist, since the model it starts from is empty and only grows over the tour.
// The rules every tutorial's steps follow are in ./steps.mjs.

export const firstModelValues = Object.freeze({
    source: { name: 'Heater', temperature: 350 },
    target: { name: 'Block', temperature: 300 },
    state: { name: 'Temperature', symbol: 'temperature', unit: 'K' },
    // A new relationship comes with a coefficient, `k`, so its part is the only thing to type. Its card writes each end's
    // state with that node's short name (Heater → H, Block → B), and what is typed in those names is stored in its own.
    typedEquation: String.raw`k\cdot(\mathrm{temperature}_{\mathrm{H}}-\mathrm{temperature}_{\mathrm{B}})`,
    runSeconds: 10
});

const nodesWithState = (document) => (document?.nodes ?? []).filter((node) => (node.states ?? []).length > 0);
// A node defined as asked: its name, and a state with the asked symbol starting at the asked value.
const defined = (document, { name, temperature }) => (document?.nodes ?? []).some((node) => node.name?.trim().toLowerCase() === name.toLowerCase()
    && (node.states ?? []).some((state) => state.symbol === firstModelValues.state.symbol && Number(state.initialValue) === temperature));
const edgesBetweenNodes = (document) => {
    const ids = new Set((document?.nodes ?? []).map((node) => node.id));
    return (document?.edges ?? []).filter((edge) => edge.source?.nodeId !== edge.target?.nodeId && ids.has(edge.source?.nodeId) && ids.has(edge.target?.nodeId));
};

// `target` is the selector the step points at (or a function of the interface facts, for a step whose target moves); `fill` names
// the action the "Fill this in for me" button performs, which the renderer supplies.
const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Build and run your first model',
        text: 'In about three minutes you will make two blocks, connect them with an equation that moves heat from one to the other, run it and watch the result. Everything you build here is a normal model you can keep.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'addNode',
        title: 'Add a node',
        text: 'A node is a thing in your model that has numbers which change over time. Open the Add menu and choose Node: it is made with one state, and its card opens.',
        target: '#addButton', skip: 'newNode',
        done: ({ document }) => nodesWithState(document).length >= 1
    },
    {
        id: 'firstNode',
        title: `Define the ${firstModelValues.source.name.toLowerCase()}`,
        text: `On the card's Details tab, name it "${firstModelValues.source.name}". Back on Equations, its state's line is open: name the state ${firstModelValues.state.name}, symbol ${firstModelValues.state.symbol}, starting at ${firstModelValues.source.temperature}, unit ${firstModelValues.state.unit}. A state is a number the simulation moves forward in time.`,
        target: '#nodeEditor', fill: 'sourceNode', skip: 'sourceNode',
        done: ({ document }) => defined(document, firstModelValues.source)
    },
    {
        id: 'secondNode',
        title: 'Add a second node',
        text: `Add another the same way: "${firstModelValues.target.name}", with ${firstModelValues.state.name} (${firstModelValues.state.symbol}) starting at ${firstModelValues.target.temperature} ${firstModelValues.state.unit}. This is what the heater will warm.`,
        target: (ui) => (ui.nodeEditorFor && ui.nodeEditorFor !== firstModelValues.source.name ? '#nodeEditor' : '#addButton'), fill: 'targetNode', skip: 'targetNode',
        done: ({ document }) => defined(document, firstModelValues.target)
    },
    {
        id: 'addEdge',
        title: 'Connect them',
        text: `Both nodes start in the same spot, so one hides the other: drag one of them aside on the canvas first. An edge is a relationship: an equation that says how one node changes another. Open the Add menu, choose Edge, then click ${firstModelValues.source.name} and then ${firstModelValues.target.name}.`,
        target: (ui) => {
            if (ui.endpointPick === 'source') return ui.labelOf(firstModelValues.source.name);
            if (ui.endpointPick === 'target') return ui.labelOf(firstModelValues.target.name);
            return '#addButton';
        },
        fill: 'connectNodes', skip: 'connectNodes',
        done: ({ document }) => edgesBetweenNodes(document).length >= 1
    },
    {
        id: 'equation',
        title: 'Write the equation',
        text: `Its card shows ${firstModelValues.target.name}'s ${firstModelValues.state.name.toLowerCase()} and, in the field, what this relationship adds to it, empty: until it is written, the relationship adds 0. Enter k·(${firstModelValues.state.symbol}_H − ${firstModelValues.state.symbol}_B): the block warms at a rate proportional to how much hotter the heater is. ${firstModelValues.state.symbol}_H is the heater's ${firstModelValues.state.name.toLowerCase()} and ${firstModelValues.state.symbol}_B the block's: choose them from the buttons under the field instead of typing them. k is the Coefficient on the Parameters tab, set to 1; change it to make the heat flow faster or slower.`,
        target: '#edgeEditor', fill: 'edgeEquation', skip: 'edgeEquation',
        // Its part reads both ends (a new relationship starts as k times its source's state alone) and lands on the block.
        done: ({ document }) => edgesBetweenNodes(document).some((edge) => /source/.test(edge.equation ?? '') && /target/.test(edge.equation ?? '') && edge.equationModel?.output?.role === 'target')
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${firstModelValues.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), fill: 'runTime', skip: 'runModel', runSeconds: firstModelValues.runSeconds,
        done: ({ ui }) => ui.hasResult || ui.runModel !== null
    },
    {
        id: 'plotBlock',
        title: 'Plot the temperature',
        text: `The run is done and its results are on the canvas. Click the "${firstModelValues.target.name}" to open its editor, which plots how its ${firstModelValues.state.name.toLowerCase()} changed over the run.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(firstModelValues.target.name)), skip: 'plotNode', node: firstModelValues.target.name,
        done: ({ ui }) => ui.plotsSeen.includes(firstModelValues.target.name)
    },
    {
        id: 'results',
        title: 'Watch it happen',
        text: `Drag the timeline: the marker moves along the plot, and ${firstModelValues.target.name} warms from ${firstModelValues.target.temperature} ${firstModelValues.state.unit} towards the heater's ${firstModelValues.source.temperature} ${firstModelValues.state.unit}.`,
        target: '#resultTimeline', skip: 'moveTimeline',
        done: ({ ui }) => ui.timelineMoved
    },
    {
        id: 'finish',
        title: 'You have built and run a model',
        text: 'Save it from the toolbar if you want to keep it. The Examples menu has finished models to open and study. Edges can also run C++ or Python programs, and results can be charted further.',
        desktopText: ' Add-ons and plugins in the desktop app\'s Extensions dialog chart results, drive runs and add new kinds of nodes and edges: have a look there next.',
        webText: ' The desktop app adds add-ons and plugins that chart results, drive runs and add new kinds of nodes and edges.',
        advance: 'next', nextLabel: 'Finish', bonus: true, done: () => false
    }
]);

export const firstModel = Object.freeze({
    id: 'firstModel',
    title: 'Build and run your first model',
    summary: 'Make two nodes, connect them with an equation that moves heat, run it and watch the result.',
    minutes: 3,
    area: 'start',
    tags: ['tour', 'node', 'edge', 'relationship', 'equation', 'run', 'timeline', 'plot', 'beginner', 'first'],
    start: { from: 'empty', fileName: 'First model.kjt' },
    editions: ['desktop', 'web'],
    steps
});
