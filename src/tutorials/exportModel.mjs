/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Take a model elsewhere" (docs/proposals/tutorials.md), starting from the Spring Mass Damper example: the model exported as a standalone
// Python program (or C++, serial or parallel), which runs without Konjugate and prints the same results, and as an FMU, the standard
// package other simulation tools load as a component (desktop: it is compiled by the engine). Both go through the system's save dialog, or a
// download in the web edition, which the person answers: their skips open it and wait.

export const exportModelValues = Object.freeze({
    language: 'python',
    parallelism: 'serial'
});
const values = exportModelValues;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Take a model elsewhere',
        text: 'A model built here does not have to stay here. It can be written out as an ordinary program, to run on a server or inside other code without Konjugate, or as an FMU, the package other simulation tools take as a component.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openExport',
        title: 'Open the export',
        text: 'Press "Export simulation code" in the title bar (the ‹/› button).',
        target: '#exportCodeButton', skip: 'openExportCode',
        done: ({ ui }) => ui.exportDialogOpen || ui.exportedKinds.length > 0
    },
    {
        id: 'program',
        title: 'Export it as a program',
        text: 'Keep the format "Standalone program", choose Python and Serial, press Export and choose where to save it. The file is the whole model, with its equations, values and run settings, in plain Python with nothing to install: "python3" and the file\'s name runs it and prints every state over time. C++ can also be split across threads with OpenMP, or across machines with MPI.',
        target: (ui) => (ui.exportDialogOpen ? '#exportCodeLanguage' : '#exportCodeButton'), skip: 'exportProgram', language: values.language, parallelism: values.parallelism,
        done: ({ ui }) => ui.exportedKinds.includes(values.language)
    },
    {
        id: 'fmu',
        title: 'Export it as an FMU',
        text: 'Open the export again, set the format to "FMU (FMI 2.0 Co-Simulation)", press Export and choose where to save it. Konjugate compiles the model into the package, with its states and parameters as the FMU\'s variables, for any tool that takes FMI 2.0 components.',
        target: (ui) => (ui.exportDialogOpen ? '#exportCodeFormat' : '#exportCodeButton'), skip: 'exportFmu',
        editions: ['desktop'],
        done: ({ ui }) => ui.exportedKinds.includes('fmu')
    },
    {
        id: 'finish',
        title: 'You have taken a model elsewhere',
        text: 'An exported program reproduces the engine\'s results closely, and says so where it cannot (a program inside a relationship, say). The way in works too: an FMU from another tool can compute a node of a Konjugate model, once installed as a plugin from Extensions. Exports carry the project\'s owner, copyright and licence.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const exportModel = Object.freeze({
    id: 'exportModel',
    title: 'Take a model elsewhere',
    summary: 'Export a model as a standalone Python or C++ program, and as an FMU for other simulation tools.',
    minutes: 3,
    area: 'results',
    tags: ['export', 'code', 'Python', 'C++', 'program', 'standalone', 'FMU', 'FMI', 'co-simulation', 'OpenMP', 'MPI', 'parallel', 'share'],
    start: { from: 'example', example: 'springMassDamper.kjt' },
    editions: ['desktop', 'web'],
    steps
});
