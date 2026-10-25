/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The guided first-model tour as data (docs/proposals/guidedTour.md): what each step says, what it points at, and how to tell the
// person has done it. The renderer's tour controller reads this and nothing else, in both the desktop and the web edition, so the
// wording and the checks live in one place and cannot drift between them.
//
// A step is done when `done({ document, ui })` is true. `document` is the project as it would be saved, so a check about the model
// asks the model; `ui` holds the few facts only the interface knows (a builder is open, a run has finished, the timeline moved).
// Every check stays true once it has become true (the model only grows over the tour), which is what lets the controller tell, from
// the checks alone, that a person has undone an earlier step and offer to go back.

export const tourModel = Object.freeze({
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
export const tourSteps = Object.freeze([
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
        target: '#addButton',
        done: ({ document, ui }) => ui.nodeBuilderOpen || nodesWithState(document).length >= 1
    },
    {
        id: 'firstNode',
        title: `Define the ${tourModel.source.name.toLowerCase()}`,
        text: `Name it "${tourModel.source.name}" and give it one state: ${tourModel.state.name} (symbol ${tourModel.state.symbol}), starting at ${tourModel.source.temperature} ${tourModel.state.unit}. A state is a number the simulation moves forward in time. Then press Create node.`,
        target: '#nodeBuilder', fill: 'sourceNode',
        done: ({ document }) => nodesWithState(document).length >= 1
    },
    {
        id: 'secondNode',
        title: 'Add a second node',
        text: `Add another the same way: "${tourModel.target.name}", with ${tourModel.state.name} starting at ${tourModel.target.temperature} ${tourModel.state.unit}. This is what the heater will warm.`,
        target: (ui) => (ui.nodeBuilderOpen ? '#nodeBuilder' : '#addButton'), fill: 'targetNode',
        done: ({ document }) => nodesWithState(document).length >= 2
    },
    {
        id: 'addEdge',
        title: 'Connect them',
        text: `An edge is a relationship: an equation that says how one node changes another. Open the Add menu, choose Edge, and make it go from ${tourModel.source.name} to ${tourModel.target.name}.`,
        target: (ui) => (ui.edgeBuilderOpen ? '#edgeBuilder' : '#addButton'), fill: 'edgeEndpoints',
        done: ({ document, ui }) => (ui.edgeBuilderOpen && ui.edgeSourceNodeId && ui.edgeTargetNodeId && ui.edgeSourceNodeId !== ui.edgeTargetNodeId) || edgesBetweenNodes(document).length >= 1
    },
    {
        id: 'equation',
        title: 'Write the equation',
        text: `Enter k·(sourceTemperature − targetTemperature): the block warms at a rate proportional to how much hotter the heater is. k is the "Coefficient" parameter the edge builder adds for you under Custom parameters, set to 1; change its value to make the heat flow faster or slower. Choose the reference buttons under the equation instead of typing the names. Check that "Updates" says target.${tourModel.state.symbol}, so the equation changes the block and not the heater, and press Create edge.`,
        target: '#edgeBuilder', fill: 'edgeEquation',
        done: ({ document }) => edgesBetweenNodes(document).some((edge) => String(edge.equation ?? '').trim() !== '' && edge.equationModel?.output?.role === 'target')
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${tourModel.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), fill: 'runTime',
        done: ({ ui }) => ui.hasResult
    },
    {
        id: 'plotBlock',
        title: 'Plot the temperature',
        text: `The run is done and its results are on the canvas. Click the "${tourModel.target.name}" to open its editor, which plots how its ${tourModel.state.name.toLowerCase()} changed over the run.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(tourModel.target.name)),
        done: ({ ui }) => ui.blockPlotShown
    },
    {
        id: 'results',
        title: 'Watch it happen',
        text: `Drag the timeline: the marker moves along the plot, and ${tourModel.target.name} warms from ${tourModel.target.temperature} ${tourModel.state.unit} towards the heater's ${tourModel.source.temperature} ${tourModel.state.unit}.`,
        target: '#resultTimeline',
        done: ({ ui }) => ui.timelineMoved
    },
    {
        id: 'finish',
        title: 'You have built and run a model',
        text: 'Save it from the toolbar if you want to keep it. The Examples menu has finished models to open and study. Edges can also run C++ or Python programs, and results can be charted further.',
        desktopText: ' Add-ons and plugins in the desktop app\'s Extensions dialog chart results, drive runs and add new kinds of nodes and edges: have a look there next.',
        webText: ' The desktop app adds add-ons and plugins that chart results, drive runs and add new kinds of nodes and edges.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

// The text a step shows in an edition (the finish step ends with a sentence on the desktop app's extras).
export const stepText = (step, edition) => `${step.text}${edition === 'desktop' ? step.desktopText ?? '' : step.webText ?? ''}`;

// The step a person is on, given what they have done: the first one that is not done, never beyond a step that waits for Next, and
// `restoreFrom` (the step the tour has reached) is the floor, so a step that is done by a person's own action stays done.
export function currentStepIndex(facts, reached = 0, steps = tourSteps) {
    let index = Math.min(steps.length - 1, Math.max(0, reached));
    while (index < steps.length - 1 && steps[index].advance !== 'next' && steps[index].done(facts)) index += 1;
    return index;
}

// The earliest step before `index` whose check no longer holds (a node was deleted, say), or null when everything done so far still is.
export function brokenStepBefore(facts, index, steps = tourSteps) {
    for (let candidate = 1; candidate < index; candidate += 1) if (!steps[candidate].done(facts)) return candidate;
    return null;
}
