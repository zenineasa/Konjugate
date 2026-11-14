/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Extend Konjugate" (docs/proposals/tutorials.md), starting from the Thermal Management example: the Extensions dialog's Discover list,
// an entry read, the Results Analysis add-on installed from it (from its publisher's release, so it needs the internet), Konjugate
// restarted to activate it (the tutorial carries on after the restart, at the step it was on), a run, and the add-on opened on the run's
// results from its button on the left rail. Add-ons open windows of their own beside the project window, so this is for the desktop app.

export const extendKonjugateValues = Object.freeze({
    prefix: 'konjugate.resultPlotViewer',
    title: 'Results Analysis',
    runSeconds: 10
});
const values = extendKonjugateValues;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Extend Konjugate',
        text: 'Konjugate can be extended by others. Add-ons work on a model and its results in windows of their own: plots, 3D views, reports. Plugins add new kinds of parts, programs for relationships, and examples. You will find an add-on, install it, and use it on a run.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'discover',
        title: 'Open Discover',
        text: 'Press Extensions at the top of the left rail and choose Discover. It lists what is published, by domain; Installed lists what you have, with updates.',
        target: (ui) => (ui.extensionsOpen ? '.extensionsTab[data-extensions-mode="discover"]' : '#extensionsButton'), skip: 'openDiscover',
        done: ({ ui }) => ui.discoverSeen || ui.installed.includes(values.prefix)
    },
    {
        id: 'read',
        title: `Read about ${values.title}`,
        text: `Click "${values.title}": what it does, who publishes it, its packages and a screenshot. Every package is signed by its publisher, and Konjugate checks the signature before installing it.`,
        target: '#extensionsResults', skip: 'selectExtension', prefix: values.prefix,
        done: ({ ui }) => ui.discoverEntry === values.title || ui.installed.includes(values.prefix)
    },
    {
        id: 'install',
        title: 'Install it',
        text: 'Press Install. It is downloaded from its publisher\'s release, which needs the internet, and checked before it is installed.',
        target: '#extensionsDiscoverInstall', skip: 'installExtension', prefix: values.prefix,
        done: ({ ui }) => ui.installed.includes(values.prefix)
    },
    {
        id: 'restart',
        title: 'Restart to activate it',
        text: 'An add-on is started with Konjugate. Press "Restart Konjugate" in the notice: Konjugate opens again, and this tutorial carries on from here.',
        target: '#extensionsRestartNow', skip: 'restartForExtension',
        done: ({ ui }) => ui.addonActive(values.prefix)
    },
    {
        id: 'run',
        title: 'Run a model',
        text: `Its button is on the left rail now. It works on results, so press Run, set "Run until" to ${values.runSeconds} s and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.hasResult || ui.runModel !== null
    },
    {
        id: 'open',
        title: 'Open it on the results',
        text: `Press ${values.title} on the left rail. It opens in a window of its own with the run's results: choose signals to plot against time, or one against another, and export what you see.`,
        target: (ui) => ui.addonButtonOf(values.prefix), skip: 'openAddon', prefix: values.prefix,
        done: ({ ui }) => ui.addonsOpened.includes(values.prefix)
    },
    {
        id: 'finish',
        title: 'You have extended Konjugate',
        text: 'A package can also be installed from a file someone gives you, from Installed; it is shown for review first. Installed packages can be disabled, updated or removed there. Plugins need no restart: their parts and programs can be used at once. Anyone can publish one; the documentation shows how.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const extendKonjugate = Object.freeze({
    id: 'extendKonjugate',
    title: 'Extend Konjugate',
    summary: 'Find an add-on in Extensions, install it, and use it on a run\'s results.',
    minutes: 4,
    area: 'results',
    tags: ['extensions', 'add-on', 'addon', 'plugin', 'install', 'discover', 'registry', 'results analysis', 'package', 'update'],
    start: { from: 'example', example: 'thermalManagement.kjt' },
    editions: ['desktop'],
    steps
});
