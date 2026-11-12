/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Run a live digital twin" (docs/proposals/tutorials.md), from an empty canvas: the Live twin window, its demonstration of a heated tank
// whose recording plays as if it were arriving now, the control room keeping the model in step with it, and the drift warning when the real
// tank (losing heat faster than the model says) falls out of step. The twin runs in a window of its own, in front of this one: a step whose
// work is there (`elsewhere: 'twin'`) is shown in that window too. Desktop only, as the live twin is.

export const liveTwinValues = Object.freeze({
    demonstration: 'drifting',
    tank: 'Water tank',
    moves: 3
});
const values = liveTwinValues;

const demonstrationOpen = (document, ui) => ui.demonstration && (document?.nodes ?? []).some((node) => node.name === values.tank);

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Run a live digital twin',
        text: 'A digital twin is a model kept in step with a real system as its readings arrive: it is reset to what was measured every few minutes, runs ahead to forecast, and says when the real system stops behaving as the model expects. You will run one on a heated tank, from a recording that plays as if it were arriving now, no equipment needed.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openTwin',
        title: 'Open the live twin',
        text: 'Press Live twin in the toolbar. It opens a window of its own, in front of this one, where a twin is set up and watched; this tutorial follows you there.',
        target: '#liveTwinButton', skip: 'openTwin',
        done: ({ document, ui }) => ui.twinWindowOpen || ui.twinSawRunning || demonstrationOpen(document, ui)
    },
    {
        id: 'chooseDemo',
        title: 'Choose a demonstration',
        text: 'A twin needs a model and somewhere its readings come from: a file a logger writes, an MQTT broker, an OPC UA server, or a script sending them. This model is empty, so in the twin\'s window press "See a demonstration", then "A rig that drifts". It opens the rig\'s model in the project window, matches the recording\'s signals to it, and starts the twin.',
        elsewhere: 'twin', skip: 'startTwinDemo', variant: values.demonstration,
        done: ({ document, ui }) => ui.twinSawRunning || demonstrationOpen(document, ui)
    },
    {
        id: 'watch',
        title: 'The control room',
        text: 'Each tile is a measured signal: the reading, and the model\'s line beside it. Every few minutes of the recording the twin moves: it resets the model to the latest readings and runs it on, and the forecast reaches ahead of them. The recording plays at 600 times real time, so six hours take about half a minute.',
        elsewhere: 'twin', skip: 'waitForTwinMoves', moves: values.moves,
        done: ({ ui }) => ui.twinMovesSeen >= values.moves || ui.twinSawAlarm
    },
    {
        id: 'drift',
        title: 'Watch it drift',
        text: 'This tank loses heat faster than its model says. At first the model is close; then, move by move, the readings fall below it, until the room warns that the real system is drifting. The Live twin button in the project window\'s toolbar turns red too, so a drift is seen from anywhere.',
        elsewhere: 'twin', skip: 'waitForTwinAlarm',
        done: ({ ui }) => ui.twinSawAlarm
    },
    {
        id: 'finish',
        title: 'You have run a live twin',
        text: 'In the twin\'s window, the Engineer view can refit the heat loss on the latest readings and keep it in the model, so the twin follows the real tank again. With your own equipment, choose its file, broker or server as the source instead, and match its signals to your model\'s states. The demonstrations are under the twin window\'s More menu.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const liveTwin = Object.freeze({
    id: 'liveTwin',
    title: 'Run a live digital twin',
    summary: 'Keep a model in step with a tank\'s readings as they arrive, and see the room warn when the tank drifts away from it.',
    minutes: 3,
    area: 'data',
    tags: ['live twin', 'digital twin', 'twin', 'control room', 'readings', 'sensor', 'data source', 'drift', 'warning', 'forecast', 'real time', 'demonstration', 'tank'],
    start: { from: 'empty', fileName: 'Live twin.kjt' },
    editions: ['desktop'],
    steps
});
