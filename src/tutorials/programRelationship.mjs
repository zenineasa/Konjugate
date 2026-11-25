/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Write a relationship as a program" (docs/proposals/tutorials.md), starting from the Thermal Equilibrium example: its Conduction
// relationship written again as a Python program that declares the two temperatures it reads, bound to them in the code editor's Ports,
// its contribution added in code.
// With 0.05 (the example's conductance of 50 W/K over its capacitance of 1000 J/K) the program gives exactly the equation's result, the
// two bodies at 320.07 and 319.93 K after 60 s, acting both ways as the equation did. A program runs in a process of its own, with Python
// (or a C++ compiler, for C++) on the computer, so this tutorial is for the desktop app.

export const programRelationshipValues = Object.freeze({
    relationship: 'Conduction',
    cold: 'Cold body',
    bindings: [{ key: 'hot', reference: 'source.temperature' }, { key: 'cold', reference: 'target.temperature' }],
    line: '        return 0.05 * (x.hot - x.cold)',
    runSeconds: 60
});
const values = programRelationshipValues;

const conduction = (document) => (document?.edges ?? []).find((edge) => edge.name === values.relationship);
const isPython = (document) => conduction(document)?.implementation?.kind === 'python';
const bound = (document) => {
    const bindings = conduction(document)?.implementation?.bindings ?? [];
    return values.bindings.every(({ key, reference }) => bindings.some((binding) => binding.key === key && binding.kind === 'state' && binding.role === reference.split('.')[0]));
};
// The program declares both keys as inputs (hot = Input()), and returns something computed from both (a comment that mentions them is
// not enough): one that reads a key it does not declare fails when it is run.
const written = (document) => {
    const lines = String(conduction(document)?.implementation?.source ?? '').split('\n').filter((line) => !line.trim().startsWith('#'));
    const declares = (key) => lines.some((line) => new RegExp(`^\\s*${key}\\s*=\\s*Input\\(`).test(line));
    return values.bindings.every(({ key }) => declares(key))
        && lines.some((line) => /^\s*return\b/.test(line) && line.includes('x.hot') && line.includes('x.cold'));
};

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Write a relationship as a program',
        text: 'Some relationships are not one formula: a lookup table, a controller with memory, a calculation from another library. Any relationship can be a C++ or Python program instead of an equation. Here you will write the heat flow between these two bodies as a short Python program, and see it give exactly the equation\'s result.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'open',
        title: 'Open the relationship',
        text: `Click "${values.relationship}" in the label between the two bodies to open it.`,
        target: (ui) => ui.relationshipRowOf(values.relationship), skip: 'openRelationship', relationship: values.relationship,
        done: ({ document, ui }) => ui.edgeEditorFor === values.relationship || isPython(document)
    },
    {
        id: 'switch',
        title: 'Make it a Python program',
        text: 'Press "{ } Program" at the top of its equation, with Python chosen beside it. The equation gives way to the program\'s summary and Edit program: the program declares the inputs it reads, each bound in the code editor\'s Ports to a state or parameter, and adds its result to its output.',
        target: '#editEdgeWrittenAs', skip: 'setImplementation', relationship: values.relationship, kind: 'python',
        done: ({ document }) => isPython(document)
    },
    {
        id: 'write',
        title: 'Write the program',
        text: 'Press Edit program. The program reads the two temperatures as inputs, so declare them: replace the line "No inputs declared yet" with hot = Input() and, on the next line, cold = Input(). Then, in its evaluate method, replace return 0.0 with return 0.05 * (x.hot - x.cold): the conductance over the capacitance, times the difference. The editor checks it as you type; Apply puts it in the model.',
        target: () => '#editOpenProviderEditor', skip: 'writeProgram', relationship: values.relationship, line: values.line,
        done: ({ document }) => written(document)
    },
    {
        id: 'bind',
        title: 'Bind the two temperatures',
        text: `In the editor's Ports, beside the code, hot and cold say "not bound". Click hot's, and choose ${values.bindings[0].reference}; then cold's, and choose ${values.bindings[1].reference}. Ports lists what each input reads, its value now, and the conversion at the port when the units differ.`,
        target: () => '#editEdgeProviderSection .programBindLink', skip: 'setProgramBindings', relationship: values.relationship, bindings: values.bindings,
        done: ({ document }) => bound(document)
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start. The program is started once, in a process of its own, and asked for its contribution at every step.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => written(ui.runModel)
    },
    {
        id: 'plot',
        // Its text says what the plot shows: it waits for Next once the plot is on screen.
        waitForNext: true,
        title: 'The same answer',
        text: `Click the ${values.cold} to plot it: it warms to 319.93 K in the minute while the hot body cools to 320.07 K, exactly as with the equation. The relationship still acts both ways: what the program adds to one body is taken from the other.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.cold)), skip: 'plotNode', node: values.cold,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.cold)
    },
    {
        id: 'finish',
        title: 'You have written a relationship as a program',
        text: 'C++ works the same way, compiled once when a run starts. Which Python and which compiler are used is set in Settings › Providers. A node can be a program too, computing its own states, and a program can keep state of its own between steps. Installed plugins can contribute ready-made programs.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const programRelationship = Object.freeze({
    id: 'programRelationship',
    title: 'Write a relationship as a program',
    summary: 'Write a relationship as a short Python program instead of an equation, and get exactly the same result.',
    minutes: 4,
    area: 'modelling',
    tags: ['program', 'Python', 'C++', 'code', 'provider', 'bindings', 'relationship', 'implementation', 'script', 'thermal', 'conduction'],
    start: { from: 'example', example: 'thermalEquilibrium.kjt' },
    editions: ['desktop'],
    steps
});
