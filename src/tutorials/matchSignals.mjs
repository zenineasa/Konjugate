/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Match your signals to the model" (docs/proposals/tutorials.md), from an empty canvas: the live twin's demonstration "A plant's names",
// the heated tank's readings as a plant's logger keeps them (instrument tags like TK1_TT101_PV, in °C and kW), which the twin's setup
// matches to the model's states by what they measure and converts to the model's units, and which, unlike the other demonstrations, it
// leaves on the mapping for the person to review. Desktop only, as the live twin is.

export const matchSignalsValues = Object.freeze({ demonstration: 'plant', tank: 'Water tank' });
const values = matchSignalsValues;

const demonstrationOpen = (document, ui) => ui.demonstration && (document?.nodes ?? []).some((node) => node.name === values.tank);

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Match your signals to the model',
        text: 'Real readings rarely arrive named the way a model names things: a plant\'s logger calls a thermometer TK1_TT101_PV and reads it in °C, while the model has a Water tank\'s temperature in kelvin. Before a twin can run, each reading has to be matched to what it measures, in the right units. The twin\'s setup suggests the matches and the conversions; you review them.',
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
        title: 'Choose "A plant\'s names"',
        text: 'Press "See a demonstration", then "A plant\'s names". It opens the heated tank\'s model in the project window and hands the twin six hours of the tank\'s readings under a plant\'s tag names and units.',
        elsewhere: 'twin', skip: 'startTwinDemo', variant: values.demonstration, waitFor: 'model',
        done: ({ document, ui }) => demonstrationOpen(document, ui)
    },
    {
        id: 'review',
        title: 'Review the matches',
        text: 'Under Mapping, each reading has the model quantity it was matched to, how sure the match is, and its unit conversion: TK1_TT101_PV in °C to the Water tank\'s temperature in K, the heater\'s kW to W. Change a match from its menu if it is wrong; a reading can also be an input that drives the model rather than one it is compared with. When they look right, press "Use every suggestion" if it is offered, then "Open the control room".',
        elsewhere: 'twin', skip: 'useTwinSuggestions',
        done: ({ ui }) => ui.twinSawRunning
    },
    {
        id: 'room',
        title: 'In step',
        text: 'The control room shows each matched reading in your units beside the model\'s line, and the model is kept in step with them as they arrive. Matches you confirm are remembered, so the next model with the same tags is matched at once.',
        elsewhere: 'twin', skip: 'waitForTwinMoves', moves: 2,
        done: ({ ui }) => ui.twinMovesSeen >= 2
    },
    {
        id: 'finish',
        title: 'You have matched signals to a model',
        text: 'With your own equipment, choose its source in the twin\'s setup: a file your logger writes (followed while it is written), an MQTT broker (listening shows the topics it sends), an OPC UA server (browsed for its tags), or a script of yours sending readings to the push service, started in Settings › Push service. Each is matched the same way.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const matchSignals = Object.freeze({
    id: 'matchSignals',
    title: 'Match your signals to the model',
    summary: 'Have the live twin match a plant\'s tag names and units to a model\'s states, review the matches, and run it.',
    minutes: 3,
    area: 'data',
    tags: ['mapping', 'match', 'signals', 'tags', 'units', 'conversion', 'live twin', 'data source', 'MQTT', 'OPC UA', 'push service', 'logger', 'plant'],
    start: { from: 'empty', fileName: 'Plant signals.kjt' },
    editions: ['desktop'],
    steps
});
