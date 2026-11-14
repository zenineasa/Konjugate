/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Refit a drifting twin" (docs/proposals/tutorials.md), from an empty canvas: the live twin's demonstration "A rig that drifts", played at
// 60× so there is time to work, the control room's Engineer view refitting the tank's heat loss on the latest readings and keeping the
// result in the model, and the sandbox trying something ahead of the readings (the heater off) and keeping it as a draft scenario. The
// tank's model starts with a heat loss of 20 W/K; the drifting tank loses heat 10 % faster every hour. Desktop only, as the live twin is.

export const refitTwinValues = Object.freeze({
    demonstration: 'drifting',
    pace: '60',
    heatLoss: { parameterId: 10, from: 20 },
    tank: 'Water tank'
});
const values = refitTwinValues;

const heatLoss = (document) => (document?.edges ?? []).flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === values.heatLoss.parameterId)?.value;
const refitKept = (document) => heatLoss(document) !== undefined && heatLoss(document) !== values.heatLoss.from;
const demonstrationOpen = (document, ui) => ui.demonstration && (document?.nodes ?? []).some((node) => node.name === values.tank);

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Refit a drifting twin',
        text: 'A real system changes: insulation ages, an element scales up. A twin notices when the readings stop matching the model; then the model\'s numbers can be fitted again to the latest readings, without stopping. You will do that on a tank losing heat faster and faster, and try something out ahead of the readings.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openTwin',
        title: 'Open the live twin',
        text: 'Press Live twin in the toolbar. Its window opens in front of this one; this tutorial follows you there.',
        target: '#liveTwinButton', skip: 'openTwin',
        done: ({ document, ui }) => ui.twinWindowOpen || demonstrationOpen(document, ui)
    },
    {
        id: 'chooseDemo',
        title: 'A rig that drifts, slowly',
        text: 'Press "See a demonstration". Set "Data arrives" to 60× (a minute a second), so the six hours take six minutes and there is time to work, then choose "A rig that drifts".',
        elsewhere: 'twin', skip: 'startTwinDemo', variant: values.demonstration, pace: values.pace,
        done: ({ ui }) => ui.twinSawRunning
    },
    {
        id: 'refit',
        title: 'Refit it on the latest readings',
        text: 'Press Engineer at the top of the room: the view for the twin\'s numbers, its timing and its warning. A refit needs the twin\'s first move, about a minute in at this pace. Under "Refit on the latest window", press Refit: the tank\'s tunable numbers are fitted again to the readings of the last few moves. When it is done, press "Keep in the model": the twin goes on with the new values, and the project\'s model keeps them.',
        elsewhere: 'twin', skip: 'refitTwinAndKeep',
        done: ({ document }) => refitKept(document)
    },
    {
        id: 'try',
        title: 'Try something ahead',
        text: 'Press "Try something…": the room opens a sandbox from the latest state, where the inputs can be changed and the model run ahead without touching the twin. Set the heater to 0 and press Run ahead: the tiles draw what would happen, dotted. Press "Back to live": what you tried is kept as a draft scenario in the project.',
        elsewhere: 'twin', skip: 'tryInTwinSandbox',
        done: ({ ui }) => ui.scenarios > 0
    },
    {
        id: 'finish',
        title: 'You have refitted a twin',
        text: 'The Engineer view also sets how big a drift is warned about, how far ahead the twin forecasts and how often it moves, and can track a parameter as it changes with an estimator, with a band showing how sure it is. Scenarios kept in the project can be renamed or deleted from the room\'s Scenarios list.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const refitTwin = Object.freeze({
    id: 'refitTwin',
    title: 'Refit a drifting twin',
    summary: 'In the twin\'s Engineer view, refit a drifting tank on its latest readings, keep it, and try something ahead.',
    minutes: 5,
    area: 'data',
    tags: ['live twin', 'refit', 'engineer', 'drift', 'calibrate', 'sandbox', 'scenario', 'try something', 'estimator', 'forecast', 'warning', 'tank'],
    start: { from: 'empty', fileName: 'Drifting rig.kjt' },
    editions: ['desktop'],
    steps
});
