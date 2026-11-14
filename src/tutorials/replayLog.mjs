/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Replay a lab's data log" (docs/proposals/tutorials.md), starting from the lab vessel's model beside the examples
// (examples/dataSources/labVessel.kjt): an invented lab trial's log as its own logger wrote it (examples/dataSources/labVesselLog.csv,
// written by labVessel.py with its default seed: semicolons and decimal commas, local time, °C, the heater in %, the valve as OPEN and
// CLOSED), described column by column in Parameter tuning, replayed through the model with its first guesses, calibrated on the first
// three and a half hours, and checked on the next hour and a half, which it was not calibrated on. The calibration finds the vessel's
// 501,600 J/K and 15 W/K, which the log was made with. The whole log can then be run as a live twin from the card (desktop).

export const replayLogValues = Object.freeze({
    log: 'dataSources/labVesselLog.csv',
    zone: 'Europe/Berlin',
    columns: [
        { column: 'TC1 (°C)', use: 'output', fields: { name: 'waterTemperature', unit: 'K', offset: '273.15' } },
        { column: 'Heizung (%)', use: 'input', fields: { name: 'heaterPower', unit: 'W', scale: '30' } },
        { column: 'Ventil', use: 'input', fields: { name: 'inflowRate', unit: 'kg/s', values: 'OPEN=0.015, CLOSED=0' } },
        { column: 'Raum (°C)', use: 'input', fields: { name: 'roomTemperature', unit: 'K', offset: '273.15' } }
    ],
    timeStep: 5,
    calibrateTo: 3.5,
    checkFrom: 3.5,
    checkTo: 5,
    capacitance: { id: 43, from: 418000 },
    heatLoss: { id: 44, from: 25 }
});
const values = replayLogValues;

const sharedValue = (document, id) => Number((document?.sharedParameters ?? []).find((parameter) => parameter.id === id)?.value);
const calibrated = (document) => sharedValue(document, values.capacitance.id) !== values.capacitance.from && sharedValue(document, values.heatLoss.id) !== values.heatLoss.from;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Replay a lab\'s data log',
        text: 'This model is of a 120-litre water vessel in a lab, heated by a thermostat and topped up with cold water now and then. The lab\'s logger recorded eight hours of it in its own format. You will read that log as it is, play its recorded inputs through the model to see how far the model is from the real vessel, calibrate it on part of the log, and check it on another part.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openReplay',
        title: 'Open Parameter tuning, to replay',
        text: 'Open Parameter tuning from the toolbar and press "Replay a data log" at the top of the card.',
        target: (ui) => (ui.tuningOpen ? '#parameterTuningGoalReplay' : '#parameterTuningButton'), skip: 'openReplay',
        done: ({ document, start, ui }) => ui.tuningGoal === 'replay' || ui.loggerOffered || ui.replayRead || calibrated(document)
    },
    {
        id: 'addLog',
        title: 'Add the lab\'s log',
        text: 'Download the log with the link below: it goes to your Downloads folder. Then press "Choose CSV file" in the card and pick it from there. It is not a Konjugate data log, so the card offers to read it as another logger\'s table.',
        link: { label: 'Download the log (labVesselLog.csv)', action: 'downloadTutorialData' },
        target: '#parameterTuningFileChooser', skip: 'loadReplayLog',
        done: ({ document, ui }) => ui.loggerOffered || ui.replayRead || calibrated(document)
    },
    {
        id: 'describe',
        title: 'Describe its columns',
        text: `The card has guessed the semicolons, the decimal commas, the date and time columns and their format. Set the time zone to ${values.zone}, where the lab is. Then say what each column is: TC1 (°C) is an output, waterTemperature, in K with an offset of 273.15; Heizung (%) an input, heaterPower, in W with a scale of 30 (100 % is 3 kW); Ventil an input, inflowRate, in kg/s, with the values OPEN=0.015, CLOSED=0; Raum (°C) an input, roomTemperature, in K with an offset of 273.15. Leave TC2 out, and press "Read the file". The card says what it left out: failed readings, a restart, a gap, the night the clocks went back.`,
        target: (ui) => (ui.loggerOffered ? '#loggerColumns' : '#parameterTuningFileChooser'), skip: 'describeLogger', zone: values.zone, columns: values.columns,
        done: ({ document, ui }) => ui.replayRead || calibrated(document)
    },
    {
        id: 'replay',
        title: 'Replay the first guesses',
        text: `The log's columns are matched to the model's states and parameters by name. Set the time step to ${values.timeStep} s and "To" to ${values.calibrateTo} hours, and press Replay: the recorded heater, valve and room drive the model, and its water temperature is compared with TC1. With its first guesses it goes out of step.`,
        target: '#runParameterTuningReplay', skip: 'replayStretch', timeStep: values.timeStep, from: '', to: values.calibrateTo,
        done: ({ document, ui }) => ui.replayed || calibrated(document)
    },
    {
        id: 'calibrate',
        title: 'Calibrate on that stretch',
        text: `Under Calibrate, set "To" to ${values.calibrateTo} hours, press Calibrate, then "Apply calibrated values". It finds the vessel's heat capacity and heat loss from those three and a half hours: about 501,600 J/K and 15 W/K.`,
        target: (ui) => (ui.calibrateApplyShown ? '#replayCalibrateApply' : '#replayCalibrateRun'), skip: 'calibrateStretch', to: values.calibrateTo,
        done: ({ document }) => calibrated(document)
    },
    {
        id: 'check',
        title: 'Check it on another stretch',
        text: `A calibration is only worth something on data it was not fitted to. Set "From" to ${values.checkFrom} and "To" to ${values.checkTo} hours and press Replay again: the calibrated model stays in step for the whole stretch.`,
        target: '#runParameterTuningReplay', skip: 'replayStretch', timeStep: values.timeStep, from: values.checkFrom, to: values.checkTo,
        done: ({ ui }) => ui.replayFrom === values.checkFrom && ui.replayInStep
    },
    {
        id: 'finish',
        title: 'You have replayed and calibrated on a lab\'s log',
        text: 'How the log is read is kept with the project, so it is read the same way next time. In the desktop app, "Open the live twin" under the replay plays the whole log through a twin, which finds the heater losing power in the last hours. Your own logger\'s file works the same way; a logger can also write Konjugate\'s own data log, described in the documentation.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const replayLog = Object.freeze({
    id: 'replayLog',
    title: 'Replay a lab\'s data log',
    summary: 'Read a lab logger\'s own file, replay it through a model, calibrate on one stretch and check on another.',
    minutes: 6,
    area: 'data',
    tags: ['replay', 'data log', 'logger', 'CSV', 'calibrate', 'calibration', 'validation', 'lab', 'experiment', 'time zone', 'units', 'measured data', 'parameter tuning'],
    start: { from: 'example', example: 'dataSources/labVessel.kjt' },
    data: [values.log],
    editions: ['desktop', 'web'],
    steps
});
