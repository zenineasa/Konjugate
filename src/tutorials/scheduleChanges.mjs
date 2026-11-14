/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Schedule changes during a run" (docs/proposals/tutorials.md), starting from the Position Controlled Joint example: an online run in real
// time, its live controls, a sine wave set on the joint's target angle while it runs (0.5 rad either side of it, one swing every five
// seconds), the run's record of changes, and the run repeated from that record, the wave at the same steps and the same result. Repeating
// forks the run from its start, which needs the engine's checkpoints, so this tutorial is for the desktop app.

export const scheduleChangesValues = Object.freeze({
    joint: 'Joint link',
    setpoint: { name: 'Setpoint angle', parameterId: 21 },
    wave: { shape: 'waveform:sine', amplitude: 0.5, frequency: 0.2 },
    runSeconds: 15
});
const values = scheduleChangesValues;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Schedule changes during a run',
        text: 'A live parameter can be moved by hand while a model runs, and it can also be given a change to follow: a step, a ramp, a pulse, or a wave. Every change is recorded with the result, so the run can be repeated exactly. Here the joint\'s target will swing back and forth while you watch.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'startRun',
        title: 'Start a run in real time',
        text: `Press Run, turn on "Online", set the pacing to "Real time", set "Run until" to ${values.runSeconds} s, and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#runOnlineMode' : '#runButton'), skip: 'startOnlineRun', runSeconds: values.runSeconds,
        done: ({ ui }) => ui.steerable || ui.waveformScheduled
    },
    {
        id: 'openControls',
        title: 'Open the live controls',
        text: 'Press Controls beside the timeline. Each live parameter has a slider, and a menu of changes it can follow instead.',
        target: '#liveParameterButton', skip: 'openLiveControls',
        done: ({ ui }) => ui.liveControlsOpen || ui.waveformScheduled
    },
    {
        id: 'wave',
        title: 'Give the target a wave',
        text: `In the ${values.setpoint.name} row, choose Sine from the menu, set Amplitude to ${values.wave.amplitude} and Frequency to ${values.wave.frequency} Hz, and press Start. The preview draws the wave before it starts; the target now swings ${values.wave.amplitude} rad either side of where it was, once every ${1 / values.wave.frequency} seconds, and the joint chases it.`,
        target: (ui) => ui.liveControlsRowOf(values.setpoint.parameterId), skip: 'startWaveform', parameterId: values.setpoint.parameterId, wave: values.wave,
        done: ({ ui }) => ui.waveformScheduled
    },
    {
        id: 'changes',
        title: 'Read the record',
        text: 'When the run has ended, press Changes beside the timeline. It lists every change made during the run, when, and how: here, the wave you started.',
        target: '#controlHistoryButton', skip: 'openChanges',
        done: ({ ui }) => ui.changesShown
    },
    {
        id: 'repeat',
        title: 'Repeat it from the record',
        text: 'Press "Repeat from the record" in the list, then Start. The run is played again from its start with every recorded change at the same step, so it comes out the same, bit for bit: a way to show what happened, or to try the same changes on a changed model.',
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#repeatFromRecord'), skip: 'repeatFromRecord',
        done: ({ ui }) => ui.repeated
    },
    {
        id: 'plot',
        title: 'See the joint chase the wave',
        text: `Click the ${values.joint} to plot it: its angle swings with the target, a little behind it and short of its peaks, since the controller needs time to turn it.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.joint)), skip: 'plotNode', node: values.joint,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.joint)
    },
    {
        id: 'finish',
        title: 'You have scheduled changes',
        text: 'Ramps, steps and pulses take a duration; noise takes a seed, so the same noise comes back each run. A shared parameter can follow a schedule from the start of every run, set from its row in the Parameters table. A fork can start with a schedule of its own.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const scheduleChanges = Object.freeze({
    id: 'scheduleChanges',
    title: 'Schedule changes during a run',
    summary: 'Give a live parameter a wave to follow while it runs, read the record, and repeat the run exactly from it.',
    minutes: 4,
    area: 'control',
    tags: ['schedule', 'waveform', 'sine', 'ramp', 'step', 'pulse', 'noise', 'live controls', 'record', 'repeat', 'changes', 'real time', 'online', 'setpoint'],
    start: { from: 'example', example: 'positionControlledJoint.kjt' },
    editions: ['desktop'],
    steps
});
