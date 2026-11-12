/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Steer a model by hand" (docs/proposals/tutorials.md), starting from the Position Controlled Joint example: two keys bound to the joint's
// live target angle in Settings › Controllers (W ramps it up, S down, the whole range in five seconds), an online run paced in real time,
// and the joint steered with the keys while it runs, every change recorded with the result. Bindings are the app's, kept across projects,
// which the closing card says. Steering needs a run that takes commands while it goes; the web edition's threaded build has one and its
// other build does not, so this tutorial is for the desktop app.

export const steerByHandValues = Object.freeze({
    joint: 'Joint link',
    setpoint: { name: 'Setpoint angle', symbol: 'setpointAngle', parameterId: 21 },
    keys: { up: 'KeyW', down: 'KeyS' },
    runSeconds: 20
});
const values = steerByHandValues;

const binding = (ui) => ui.bindings.find((entry) => entry.symbol === values.setpoint.symbol) ?? null;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Steer a model by hand',
        text: 'A live parameter can be moved while a run goes, with its slider, and also with a gamepad, a MIDI controller or the keyboard. Here you will bind two keys to this joint\'s target angle and steer the joint with them as it runs, in real time.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openControllers',
        title: 'Open Settings › Controllers',
        text: 'Open Settings (the gear in the title bar) and choose Controllers. It lists every control bound to a parameter, here or in any model.',
        target: (ui) => (ui.settingsOpen ? '[data-settings-target="controllers"]' : '#settingsButton'), skip: 'openControllers',
        done: ({ ui }) => ui.controllersShown || binding(ui) !== null
    },
    {
        id: 'bindKey',
        title: 'Bind a key',
        text: `Under "Bind a control", choose "${values.setpoint.name}", press Bind, then press W.`,
        target: '#controllerBindButton', skip: 'bindKey', symbol: values.setpoint.symbol, parameterName: values.setpoint.name, key: values.keys.up,
        done: ({ ui }) => binding(ui) !== null
    },
    {
        id: 'addDownKey',
        title: 'Add a key for down',
        text: 'One key can only push one way. Press Change… beside the new binding, then "Add a key for down…", press S, and save. W and S are now one control: held, they ramp the angle up and down.',
        target: '#controllerBindingList', skip: 'bindKeyPair', symbol: values.setpoint.symbol, parameterName: values.setpoint.name, keys: values.keys,
        done: ({ ui }) => binding(ui)?.type === 'keys'
    },
    {
        id: 'startRun',
        title: 'Start a run in real time',
        text: `Close Settings and press Run. Turn on "Online", set the pacing to "Real time" so a second of the model takes a second, set "Run until" to ${values.runSeconds} s, and press Start.`,
        target: (ui) => (ui.settingsOpen ? '#settingsClose' : ui.runDialogOpen ? '#runOnlineMode' : '#runButton'), skip: 'startOnlineRun', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.steerable || ui.steered.includes(values.setpoint.parameterId)
    },
    {
        id: 'steer',
        title: 'Steer it',
        text: 'Click the canvas so no field has the keys, then hold W: the target angle ramps up, and the joint turns after it. Hold S to bring it back down. The live controls beside the timeline show the angle moving.',
        target: '#liveParameterButton', skip: 'steerWithKeys', key: values.keys.up,
        done: ({ ui }) => ui.steered.includes(values.setpoint.parameterId)
    },
    {
        id: 'plot',
        title: 'See what you did',
        text: `When the run has ended, click the ${values.joint} to plot it: its angle follows the target you steered. Every change you made is in the result, by its size and time, and Changes beside the timeline lists them.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.joint)), skip: 'plotNode', node: values.joint,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.joint)
    },
    {
        id: 'finish',
        title: 'You have steered a model by hand',
        text: 'A run steered by hand can be repeated exactly from its record, so what you did can be shown again or compared. Gamepads and MIDI controllers bind the same way, sticks and knobs across a parameter\'s range. Your W and S binding stays in Settings › Controllers, for any model with a setpoint angle; remove it there if you do not want it.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const steerByHand = Object.freeze({
    id: 'steerByHand',
    title: 'Steer a model by hand',
    summary: 'Bind two keys to a live parameter and steer a joint with them while it runs in real time.',
    minutes: 4,
    area: 'control',
    tags: ['steer', 'keyboard', 'keys', 'gamepad', 'joystick', 'MIDI', 'controller', 'binding', 'live parameter', 'real time', 'online', 'human in the loop', 'setpoint'],
    start: { from: 'example', example: 'positionControlledJoint.kjt' },
    editions: ['desktop'],
    steps
});
