/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Parameters and run settings" (docs/proposals/tutorials.md), starting from the Spring Mass Damper example, whose two relationships each
// carry their own copy of the mass (1 kg): the Parameters table that lists every parameter in the model, the two copies made one shared
// parameter, its value changed once in the table, and a run whose settings and execution summary are read. A mass of 2 kg against the same
// spring bounces √2 times slower: a period of about 4.4 s instead of 3.1 s.

export const parametersAndRunsValues = Object.freeze({
    spring: { relationship: 'Spring force', parameterId: 10 },
    damper: { relationship: 'Damper force', parameterId: 13 },
    mass: { name: 'Mass', symbol: 'mass', from: 1, to: 2 },
    node: 'Suspended mass',
    runSeconds: 20
});
const values = parametersAndRunsValues;

const sharedMass = (document) => (document?.sharedParameters ?? []).find((shared) => shared.symbol === values.mass.symbol) ?? null;
const linked = (document, relationship) => {
    const shared = sharedMass(document);
    const edge = (document?.edges ?? []).find((candidate) => candidate.name === relationship);
    return Boolean(shared && (edge?.parameters ?? []).some((parameter) => parameter.symbol === values.mass.symbol && parameter.sharedParameterId === shared.id));
};
const bothLinked = (document) => linked(document, values.spring.relationship) && linked(document, values.damper.relationship);
const heavier = (document) => bothLinked(document) && Number(sharedMass(document).value) === values.mass.to;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Parameters and run settings',
        text: 'Every number in a model\'s equations is a parameter, and a model soon has many. Here you will see them all in one table, turn two copies of the same number into one shared parameter so they can never disagree, and look at how a run is set up and how it was carried out.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openTable',
        title: 'Open the Parameters table',
        text: 'Press Parameters in the toolbar. Every parameter of every relationship and node is here, with what it belongs to; the filter shows only the shared, live, constant or tunable ones. Notice Mass, twice: the spring and the damper each have their own.',
        target: '#parametersButton', skip: 'openParameters',
        done: ({ document, ui }) => ui.parametersOpen || sharedMass(document) !== null
    },
    {
        id: 'share',
        title: 'Make the mass a shared parameter',
        text: `Click "${values.spring.relationship}" in the table's "Belongs to" column to open it. In its Mass row, set Shared to "New shared parameter from this row…". The mass is now one parameter the relationship uses.`,
        target: (ui) => (ui.edgeEditorFor === values.spring.relationship ? `#edgeEditorParameters [data-parameter-id="${values.spring.parameterId}"] [data-shared-select]` : '#parametersPanel'),
        skip: 'shareParameter', relationship: values.spring.relationship, parameterId: values.spring.parameterId, choice: 'new',
        done: ({ document }) => linked(document, values.spring.relationship)
    },
    {
        id: 'linkSecond',
        title: 'Use it in the damper too',
        text: `Open "${values.damper.relationship}" and set its Mass row's Shared to the new "Mass (mass)". Both relationships now read the same mass.`,
        target: (ui) => (ui.edgeEditorFor === values.damper.relationship ? `#edgeEditorParameters [data-parameter-id="${values.damper.parameterId}"] [data-shared-select]` : ui.relationshipRowOf(values.damper.relationship)),
        skip: 'shareParameter', relationship: values.damper.relationship, parameterId: values.damper.parameterId, choice: 'mass',
        done: ({ document }) => bothLinked(document)
    },
    {
        id: 'changeOnce',
        title: 'Change it once',
        text: `In the Parameters table, the shared Mass is one row now. Change its value from ${values.mass.from} to ${values.mass.to} and press Enter: both relationships follow.`,
        target: (ui) => (ui.parametersOpen ? '#parametersBody tr.sharedRow input[data-field="value"]' : '#parametersButton'),
        skip: 'setSharedValue', symbol: values.mass.symbol, value: values.mass.to,
        done: ({ document }) => heavier(document)
    },
    {
        id: 'run',
        title: 'Run it, and read its settings',
        text: `Press Run. The dialog holds the run's settings, kept with the model: the time step every node is moved by, how often results are kept, and under Execution, whether the model runs in one thread or is split across several. Set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => heavier(ui.runModel)
    },
    {
        id: 'summary',
        title: 'How it was run',
        text: 'Press the ⌁ button beside the timeline for the execution summary: how the run was carried out, and why. A model this small runs in one thread; a large one is split into parts that run side by side, and the summary says how.',
        target: '#executionSummaryButton', skip: 'openExecutionSummary',
        done: ({ ui }) => ui.executionSummaryShown
    },
    {
        id: 'plot',
        title: 'A heavier bounce',
        text: `Click the ${values.node} to plot it: twice the mass on the same spring bounces √2 times slower, about every 4.4 s instead of 3.1 s, and dies away more slowly too.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.node)), skip: 'plotNode', node: values.node,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.node)
    },
    {
        id: 'finish',
        title: 'You have organised your parameters',
        text: 'A shared parameter can also follow a schedule over a run, set from its row in the table, and be made live, to be moved while the model runs. "Save settings" in the Run dialog keeps a run\'s settings with the model without running it.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const parametersAndRuns = Object.freeze({
    id: 'parametersAndRuns',
    title: 'Parameters and run settings',
    summary: 'See every parameter in one table, make two copies one shared parameter, and read how a run was carried out.',
    minutes: 4,
    area: 'modelling',
    tags: ['parameters', 'parameters table', 'shared parameter', 'share', 'link', 'run settings', 'time step', 'output interval', 'execution', 'parallel', 'threads', 'execution summary', 'mechanical'],
    start: { from: 'example', example: 'springMassDamper.kjt' },
    editions: ['desktop', 'web'],
    steps
});
