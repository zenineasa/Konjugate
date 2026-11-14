/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Keep and share your work" (docs/proposals/tutorials.md), starting from the Thermal Management example: the project's properties (whose
// work it is, under what licence), a run extended from where it ended without starting again (desktop: it needs the engine's checkpoints),
// the results exported as a CSV file, and the project saved with its results so they open with it. Saving and exporting go through the
// system's save dialog (in the web edition, a download), which only the person can answer: their skips open it and wait.

export const keepAndShareValues = Object.freeze({
    battery: 'Battery module',
    runSeconds: 10,
    extendTo: 20
});
const values = keepAndShareValues;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Keep and share your work',
        text: 'A model is worth more when it can be picked up again, by you or someone else. You will see whose work this project is and on what terms, run it and carry the run on, export what it computed for a spreadsheet, and save the project with its results inside.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'properties',
        title: 'Whose work it is',
        text: 'Press Project properties (the ⓘ in the title bar). An example says who made it, its copyright and its licence; your own projects start from the details set in Settings › New projects, and they travel with the file and into anything exported from it. Close it when you have read it.',
        target: '#ownershipButton', skip: 'openProjectProperties',
        done: ({ ui }) => ui.propertiesSeen
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run, set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.hasResult || ui.runModel !== null
    },
    {
        id: 'extend',
        title: 'Carry the run on',
        text: `Press "Extend simulation" beside the timeline, set "Run until" to ${values.extendTo} s and press Start. The run goes on from where it ended, in the same result, rather than starting again.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#continueRun'), skip: 'extendRun', seconds: values.extendTo,
        editions: ['desktop'],
        done: ({ ui }) => ui.resultEnd >= values.extendTo - 1e-6
    },
    {
        id: 'export',
        title: 'Export the results',
        text: 'Press "Export results as CSV" in the title bar and choose where to save it. The file has a time column and one column for every state, named "Node — State (unit)", ready for a spreadsheet, and Parameter tuning reads it back as measurements.',
        target: '#exportCsvButton', skip: 'exportResults',
        done: ({ ui }) => ui.exported
    },
    {
        id: 'save',
        title: 'Save it with its results',
        text: 'Press Save in the title bar and keep "Model and results". This is a copy of someone else\'s example, so it asks which details the copy carries: keep them, or put your own. Then choose where to save it. Opened again, the project comes back with this run on its timeline, every branch included, without running anything.',
        target: (ui) => (ui.saveOwnershipDialogOpen ? '#saveOwnershipContinue' : ui.saveContentDialogOpen ? '#saveContentDialog' : '#saveButton'), skip: 'saveWithResults',
        done: ({ ui }) => ui.savedWithResults
    },
    {
        id: 'finish',
        title: 'You have kept your work',
        text: 'Save encrypted, beside Save, protects a project with a password: it cannot be opened, or even read, without it. "Model only" saves a smaller file without the results. Export simulation code takes the model itself elsewhere, as a program or an FMU.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const keepAndShare = Object.freeze({
    id: 'keepAndShare',
    title: 'Keep and share your work',
    summary: 'See whose work a project is, carry a run on, export its results as CSV, and save it with its results.',
    minutes: 3,
    area: 'results',
    tags: ['save', 'save with results', 'export', 'CSV', 'spreadsheet', 'project properties', 'owner', 'license', 'licence', 'copyright', 'extend', 'continue', 'encrypted', 'share'],
    start: { from: 'example', example: 'thermalManagement.kjt' },
    editions: ['desktop', 'web'],
    steps
});
