/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The guided first-model tour (docs/proposals/guidedTour.md), the first of the tutorials (docs/proposals/tutorials.md): from an empty
// canvas to a first run. Its checks ask whether things exist, since the model it starts from is empty and only grows over the tour.
// The rules every tutorial's steps follow are in ./steps.mjs.

export const firstModelValues = Object.freeze({
    source: { name: 'Heater', temperature: 350 },
    target: { name: 'Block', temperature: 300 },
    state: { name: 'Temperature', symbol: 'temperature', unit: 'K' },
    // The relationship's own coefficient, `k`, is added by the edge builder, so the equation is the only thing to enter.
    equationLatex: String.raw`k\cdot(\mathrm{sourceTemperature}-\mathrm{targetTemperature})`,
    runSeconds: 10
});

const nodesWithState = (document) => (document?.nodes ?? []).filter((node) => (node.states ?? []).length > 0);
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
        text: 'A node is a thing in your model that has numbers which change over time. Open the Add menu and choose Node.',
        target: '#addButton', skip: 'openNodeBuilder',
        done: ({ document, ui }) => ui.nodeBuilderOpen || nodesWithState(document).length >= 1
    },
    {
        id: 'firstNode',
        title: `Define the ${firstModelValues.source.name.toLowerCase()}`,
        text: `Name it "${firstModelValues.source.name}" and give it one state: ${firstModelValues.state.name} (symbol ${firstModelValues.state.symbol}), starting at ${firstModelValues.source.temperature} ${firstModelValues.state.unit}. A state is a number the simulation moves forward in time. Then press Create node.`,
        target: '#nodeBuilder', fill: 'sourceNode', skip: 'createSourceNode',
        done: ({ document }) => nodesWithState(document).length >= 1
    },
    {
        id: 'secondNode',
        title: 'Add a second node',
        text: `Add another the same way: "${firstModelValues.target.name}", with ${firstModelValues.state.name} starting at ${firstModelValues.target.temperature} ${firstModelValues.state.unit}. This is what the heater will warm.`,
        target: (ui) => (ui.nodeBuilderOpen ? '#nodeBuilder' : '#addButton'), fill: 'targetNode', skip: 'createTargetNode',
        done: ({ document }) => nodesWithState(document).length >= 2
    },
    {
        id: 'addEdge',
        title: 'Connect them',
        text: `Both nodes start in the same spot, so one hides the other: drag one of them aside on the canvas first. An edge is a relationship: an equation that says how one node changes another. Open the Add menu, choose Edge, and make it go from ${firstModelValues.source.name} to ${firstModelValues.target.name}.`,
        target: (ui) => (ui.edgeBuilderOpen ? '#edgeBuilder' : '#addButton'), fill: 'edgeEndpoints', skip: 'chooseEdgeEndpoints',
        done: ({ document, ui }) => (ui.edgeBuilderOpen && ui.edgeSourceNodeId && ui.edgeTargetNodeId && ui.edgeSourceNodeId !== ui.edgeTargetNodeId) || edgesBetweenNodes(document).length >= 1
    },
    {
        id: 'equation',
        title: 'Write the equation',
        text: `Enter k·(sourceTemperature − targetTemperature): the block warms at a rate proportional to how much hotter the heater is. k is the "Coefficient" parameter the edge builder adds for you under Custom parameters, set to 1; change its value to make the heat flow faster or slower. Choose the reference buttons under the equation instead of typing the names. Check that "Updates" says target.${firstModelValues.state.symbol}, so the equation changes the block and not the heater, and press Create edge.`,
        target: '#edgeBuilder', fill: 'edgeEquation', skip: 'createEdge',
        done: ({ document }) => edgesBetweenNodes(document).some((edge) => String(edge.equation ?? '').trim() !== '' && edge.equationModel?.output?.role === 'target')
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
