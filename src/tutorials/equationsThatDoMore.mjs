/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Equations that do more" (docs/proposals/tutorials.md), starting from the Thermal Equilibrium example: its one relationship acting both
// ways (one equation, applied equal and opposite to both bodies); a node's own equation, a source term, letting the hot body leak heat to
// a 290 K room; and a state that is an Update rather than a Rate, a Celsius reading of the hot body whose term is its value, worked out
// afresh after each step instead of integrated (docs/proposals/ratesAndUpdates.md). Without the leak the pair meets at 320 K (the example's own result); with it, both drift down towards 290 K.

import { latch } from './latches.mjs';

export const equationsThatDoMoreValues = Object.freeze({
    relationship: 'Conduction',
    hot: 'Hot body',
    lossLatex: String.raw`-0.01\cdot(\mathrm{temperature}-290)`,
    celsius: { name: 'Temperature (°C)', symbol: 'temperatureCelsius', unit: '°C', latex: String.raw`\mathrm{temperature}-273.15` },
    runSeconds: 60
});
const values = equationsThatDoMoreValues;

const hot = (document) => (document?.nodes ?? []).find((node) => node.name === values.hot);
// The hot body's own parts on a state, by its symbol, whose equation has `mark` in it and reads as an equation (its MathJSON is there
// only then): a part typed half-way, which the model reports as an error and which stops a run, is not the step done.
const termsFor = (document, symbol, mark) => (hot(document)?.sourceTerms ?? []).filter((term) => {
    const state = hot(document).states.find((candidate) => candidate.id === term.expressionModel?.output?.stateId || candidate.symbol === term.state);
    return state?.symbol === symbol && String(term.expression ?? term.expressionModel?.latex ?? '').includes(mark) && term.expressionModel?.mathJson != null;
});
const leaking = (document) => termsFor(document, 'temperature', '290').some((term) => !term.setsValue);
const hasCelsius = (document) => (hot(document)?.states ?? []).some((state) => state.symbol === values.celsius.symbol);
// The Celsius reading is an Update: its state says so, or, in a file that says no kinds, its term sets its value.
const celsiusIsUpdate = (document) => (hot(document)?.states ?? []).some((state) => state.symbol === values.celsius.symbol && state.kind === 'update');
const setsCelsius = (document) => termsFor(document, values.celsius.symbol, '273.15').some((term) => term.setsValue === true || celsiusIsUpdate(document));
const card = (symbol) => `#nodeEditorStates .stateCard[data-symbol="${symbol}"]`;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Equations that do more',
        text: 'A relationship between two nodes is only one kind of equation. Here, on two bodies sharing heat, you will see a relationship that acts on both of its ends, give one body an equation of its own, and add a value that is worked out directly from another instead of moved forward in time.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'bothWays',
        // Its card opens on the Equations tab, where Direction is: it waits for Next, so the card is read before the step moves on.
        waitForNext: true,
        title: 'A relationship that acts both ways',
        text: `Click "${values.relationship}" in the label between the two bodies. At the top of its Equations tab, its direction is "Both ways": one equation, worked out once, adds to the cold body exactly what it takes from the hot one, so no heat is lost or made, and the row for its other end below shows the same term negated. "One way" changes only the node it runs to, and that row goes. Right-clicking a relationship offers the same choice.`,
        target: (ui) => (ui.edgeEditorFor === values.relationship ? (ui.edgeEditorTab === 'equations' ? '#editEdgeDirection' : '#edgeEditor [data-editor-tab="equations"]') : ui.relationshipRowOf(values.relationship)),
        skip: 'openRelationship', relationship: values.relationship, tab: 'equations',
        // Kept once Direction has been on screen: the next step opens the Hot body, which closes this card.
        done: latch(({ document, ui }) => (ui.edgeEditorFor === values.relationship && ui.edgeEditorTab === 'equations') || leaking(document))
    },
    {
        id: 'sourceTerm',
        title: 'Give a body its own equation',
        text: `Click the ${values.hot}. Its Equations tab shows each state's equation, built from every part reaching it: temperature's has the ${values.relationship} relationship's part, in blue. Type the body's own part into the field beside it, a part with nothing on the other end: −0.01·(temperature − 290), choosing temperature from the references under it. The body leaks heat to a room at 290 K.`,
        target: (ui) => (ui.nodeEditorFor === values.hot ? `${card('temperature')} .ownPart` : ui.labelOf(values.hot)),
        skip: 'addSourceTerm', node: values.hot, state: 'temperature', latex: values.lossLatex, setsValue: false,
        done: ({ document }) => leaking(document)
    },
    {
        id: 'addState',
        title: 'Add a state for degrees Celsius',
        text: `In the ${values.hot}'s editor, press + State and name the new one "${values.celsius.name}", with symbol ${values.celsius.symbol} and unit ${values.celsius.unit}.`,
        target: (ui) => (ui.nodeEditorFor === values.hot ? '#editAddState' : ui.labelOf(values.hot)),
        skip: 'addState', node: values.hot, name: values.celsius.name, symbol: values.celsius.symbol, unit: values.celsius.unit,
        done: ({ document }) => hasCelsius(document)
    },
    {
        id: 'setValue',
        title: 'Make it an update',
        text: `Its equation is under its line, empty: nothing changes ${values.celsius.symbol} yet. Click its left side, d${values.celsius.symbol}/dt =, and choose ${values.celsius.symbol} =: its parts add up to its value, not to how fast it changes. Then type temperature − 273.15 in its field. It is not moved forward in time: it is worked out afresh after every step from the temperature the step reached, so it can never drift from it.`,
        target: (ui) => (ui.nodeEditorFor === values.hot ? `${card(values.celsius.symbol)} .ownPart, #nodeEditorStates .stateFold[data-symbols~="${values.celsius.symbol}"] .stateSummary` : ui.labelOf(values.hot)),
        skip: 'addSourceTerm', node: values.hot, state: values.celsius.symbol, latex: values.celsius.latex, setsValue: true,
        done: ({ document }) => setsCelsius(document)
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => leaking(ui.runModel) && setsCelsius(ui.runModel)
    },
    {
        id: 'plot',
        // Its text says what the plot shows: it waits for Next once the plot is on screen.
        waitForNext: true,
        title: 'Read the result',
        text: `Click the ${values.hot} to plot it. Without the leak the two bodies meet at 320 K; with it, they meet lower and keep falling towards the room's 290 K. The Celsius line follows the temperature exactly, 273.15 below it.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.hot)), skip: 'plotNode', node: values.hot,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.hot)
    },
    {
        id: 'finish',
        title: 'You have written equations that do more',
        text: 'A relationship into an update adds to its value, as a node\'s own equation does, and one with several equations sets several values at once. A value that settles much faster than everything around it is often better an update than stepped. A node\'s own equation can have parameters of its own, and both a node\'s own part and a relationship can be written as a program instead of an equation.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const equationsThatDoMore = Object.freeze({
    id: 'equationsThatDoMore',
    title: 'Equations that do more',
    summary: 'A relationship that acts both ways, a node\'s own equation, and a value set directly instead of stepped.',
    minutes: 4,
    area: 'modelling',
    tags: ['own equation', 'source term', 'both ways', 'one way', 'bidirectional', 'directed', 'direction', 'directionality', 'sets value', 'algebraic', 'equation', 'state', 'node equation', 'thermal', 'conduction'],
    start: { from: 'example', example: 'thermalEquilibrium.kjt' },
    editions: ['desktop', 'web'],
    steps
});
