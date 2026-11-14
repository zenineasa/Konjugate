/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Equations that do more" (docs/proposals/tutorials.md), starting from the Thermal Equilibrium example: its one relationship acting both
// ways (one equation, applied equal and opposite to both bodies); a node's own equation, a source term, letting the hot body leak heat to
// a 290 K room; and an equation that sets a value directly rather than its rate, a Celsius reading of the hot body worked out afresh each
// step instead of integrated. Without the leak the pair meets at 320 K (the example's own result); with it, both drift down towards 290 K.

export const equationsThatDoMoreValues = Object.freeze({
    relationship: 'Conduction',
    hot: 'Hot body',
    lossLatex: String.raw`-0.01\cdot(\mathrm{temperature}-290)`,
    celsius: { name: 'Temperature (°C)', symbol: 'temperatureCelsius', unit: '°C', latex: String.raw`\mathrm{temperature}-273.15` },
    runSeconds: 60
});
const values = equationsThatDoMoreValues;

const hot = (document) => (document?.nodes ?? []).find((node) => node.name === values.hot);
// The hot body's source terms that update a state, by its symbol, whose equation has `mark` in it (a new term starts as 0).
const termsFor = (document, symbol, mark) => (hot(document)?.sourceTerms ?? []).filter((term) => {
    const state = hot(document).states.find((candidate) => candidate.id === term.expressionModel?.output?.stateId || candidate.symbol === term.state);
    return state?.symbol === symbol && String(term.expression ?? term.expressionModel?.latex ?? '').includes(mark);
});
const leaking = (document) => termsFor(document, 'temperature', '290').some((term) => !term.setsValue);
const hasCelsius = (document) => (hot(document)?.states ?? []).some((state) => state.symbol === values.celsius.symbol);
const setsCelsius = (document) => termsFor(document, values.celsius.symbol, '273.15').some((term) => term.setsValue === true);

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Equations that do more',
        text: 'A relationship between two nodes is only one kind of equation. Here, on two bodies sharing heat, you will see a relationship that acts on both of its ends, give one body an equation of its own, and add a value that is worked out directly from another instead of moved forward in time.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'bothWays',
        title: 'A relationship that acts both ways',
        text: `Click the "${values.relationship}" relationship between the two bodies. Its Directionality is Bidirectional: one equation, worked out once, adds to the cold body exactly what it takes from the hot one, so no heat is lost or made. A directed relationship changes only its target.`,
        target: (ui) => (ui.edgeEditorFor === values.relationship ? '#editEdgeDirectionality' : ui.relationshipRowOf(values.relationship)),
        skip: 'openRelationship', relationship: values.relationship,
        done: ({ document, ui }) => ui.edgeEditorFor === values.relationship || leaking(document)
    },
    {
        id: 'sourceTerm',
        title: 'Give a body its own equation',
        text: `Click the ${values.hot}, press + beside Source terms, and open the new term. A source term is a node's own equation, with nothing on the other end. Keep Updates at temperature and enter −0.01·(temperature − 290), choosing temperature from the buttons below: the body leaks heat to a room at 290 K.`,
        target: (ui) => (ui.sourceTermEditorOpen ? '#termMathField' : ui.nodeEditorFor === values.hot ? '#editAddSourceTerm' : ui.labelOf(values.hot)),
        skip: 'addSourceTerm', node: values.hot, state: 'temperature', latex: values.lossLatex, setsValue: false,
        done: ({ document }) => leaking(document)
    },
    {
        id: 'addState',
        title: 'Add a state for degrees Celsius',
        text: `In the ${values.hot}'s editor, press + beside States and name the new one "${values.celsius.name}", with symbol ${values.celsius.symbol} and unit ${values.celsius.unit}.`,
        target: (ui) => (ui.nodeEditorFor === values.hot ? '#editAddState' : ui.labelOf(values.hot)),
        skip: 'addState', node: values.hot, name: values.celsius.name, symbol: values.celsius.symbol, unit: values.celsius.unit,
        done: ({ document }) => hasCelsius(document)
    },
    {
        id: 'setValue',
        title: 'Set it directly',
        text: `Add another source term, set Updates to ${values.celsius.symbol} and Sets to "The value directly", and enter temperature − 273.15. This state is not moved forward in time: it is worked out afresh at every step from the temperature, so it can never drift from it.`,
        target: (ui) => (ui.sourceTermEditorOpen ? '#termSetsValue' : ui.nodeEditorFor === values.hot ? '#editAddSourceTerm' : ui.labelOf(values.hot)),
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
        title: 'Read the result',
        text: `Click the ${values.hot} to plot it. Without the leak the two bodies meet at 320 K; with it, they meet lower and keep falling towards the room's 290 K. The Celsius line follows the temperature exactly, 273.15 below it.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.hot)), skip: 'plotNode', node: values.hot,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.hot)
    },
    {
        id: 'finish',
        title: 'You have written equations that do more',
        text: 'A relationship can set values directly too ("Equations that set values" under its Implementation), and a value that settles much faster than everything around it is often better set directly than stepped. A source term can have parameters of its own, and both kinds can be written as a program instead of an equation.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const equationsThatDoMore = Object.freeze({
    id: 'equationsThatDoMore',
    title: 'Equations that do more',
    summary: 'A relationship that acts both ways, a node\'s own equation, and a value set directly instead of stepped.',
    minutes: 4,
    area: 'modelling',
    tags: ['source term', 'bidirectional', 'directed', 'directionality', 'sets value', 'algebraic', 'equation', 'state', 'node equation', 'thermal', 'conduction'],
    start: { from: 'example', example: 'thermalEquilibrium.kjt' },
    editions: ['desktop', 'web'],
    steps
});
