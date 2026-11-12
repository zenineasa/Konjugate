/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Calibrate a model against measured data" (docs/proposals/tutorials.md), starting from the Tank Calibration example: a water tank
// whose heat capacity and heat loss are guessed wrong, fitted to eight hours of measured temperatures with Parameter tuning, then run
// with the fitted values. The measurements ship beside the example (examples/tankCalibrationMeasured.csv); the card's "Save the
// measurements" link downloads it to the Downloads folder, and the person then chooses it in Parameter tuning as they would their own data
// ("Skip this step" loads it for them).

import { edgeParameterChanged } from './steps.mjs';

export const calibrateTankValues = Object.freeze({
    tank: 'Water tank',
    measurements: 'tankCalibrationMeasured.csv',
    runSeconds: 28800
});
const values = calibrateTankValues;

// Both fitted values are in the model (the capacitance is a shared parameter, which both relationships link to).
const fittedValuesIn = (document, start) => edgeParameterChanged(document, start, 'Ambient heat loss', 'heatLossCoefficient')
    && edgeParameterChanged(document, start, 'Heater input', 'waterThermalCapacitance');

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Calibrate a model against measured data',
        text: 'This water tank is warmed by a heater and loses heat to the room, but two of its numbers are only guesses: how much heat it takes to warm it, and how fast it leaks heat away. You will fit both to eight hours of measured temperatures, put the fitted values in the model and run it. The Example guide button in the toolbar explains the model, whenever you want the details.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'openTuning',
        title: 'Open Parameter tuning',
        text: 'Parameter tuning changes a model\'s tunable parameters until its results match measurements. Open it from the toolbar.',
        target: '#parameterTuningButton', skip: 'openTuning',
        done: ({ document, start, ui }) => ui.tuningOpen || ui.tuningDataLoaded || ui.tuningFitted || fittedValuesIn(document, start)
    },
    {
        id: 'addData',
        title: 'Add the measurements',
        text: 'The measurements are the tank\'s water temperature, every ten minutes for eight hours, in a CSV file that comes with this example. Download it with the link below: it goes to your Downloads folder. Then press "Choose CSV file" in Parameter tuning and pick it from there. The file has a time column in seconds and a tankTemperature column: columns are matched to the model\'s states by name, which is how your own data will be read too.',
        link: { label: 'Download the measurements (tankCalibrationMeasured.csv)', action: 'downloadTutorialData' },
        target: '#parameterTuningFileChooser', skip: 'loadTutorialData',
        done: ({ document, start, ui }) => ui.tuningDataLoaded || ui.tuningFitted || fittedValuesIn(document, start)
    },
    {
        id: 'runFit',
        title: 'Run the fit',
        text: 'The measured column is matched to the tank\'s temperature, and the two unknowns are listed with the range each may take. Press Run fit: it tries simulation after simulation until the model\'s temperatures match the measured ones as closely as they can. This model is small, so it takes a moment.',
        target: '#runParameterTuning', skip: 'runFit',
        done: ({ document, start, ui }) => ui.tuningFitted || fittedValuesIn(document, start)
    },
    {
        id: 'apply',
        title: 'Keep the fitted values',
        text: 'The fitted values should be close to 209,000 J/K and 20 W/K, which are what the measurements were made with, and the plot compares the measured temperatures with the fitted model\'s. Press Apply fitted values to put them in the model.',
        target: '#commitParameterTuning', skip: 'applyFit',
        done: ({ document, start }) => fittedValuesIn(document, start)
    },
    {
        id: 'run',
        title: 'Run the calibrated model',
        text: `Press Run, set "Run until" to ${values.runSeconds} s, which is the eight hours the measurements cover, leave online simulation off so it runs as fast as it can, and press Start.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ start, ui }) => fittedValuesIn(ui.runModel, start)
    },
    {
        id: 'plotTank',
        title: 'See it warm',
        text: `Click the "${values.tank}" to plot its temperature: it now warms from 293 K to about 340 K over the eight hours, as the measurements did, where the guessed values warmed too slowly and settled too high.`,
        target: (ui) => (ui.nodePlotVisible ? '#nodeResultPlot' : ui.labelOf(values.tank)), skip: 'plotNode', node: values.tank,
        done: ({ ui }) => ui.plotsSeenSinceRun.includes(values.tank)
    },
    {
        id: 'finish',
        title: 'You have calibrated a model',
        text: 'Save it if you want to keep it. Parameter tuning can also tune towards a goal instead of data: choose "Optimise an objective" and write what to minimise or maximise, as a formula or as a Python or C++ program. The example guide shows both on this tank.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const calibrateTank = Object.freeze({
    id: 'calibrateTank',
    title: 'Calibrate a model against measured data',
    summary: 'Fit two unknown parameters to measured temperatures with Parameter tuning, then run the calibrated model.',
    minutes: 4,
    area: 'tuning',
    tags: ['parameter tuning', 'tuning', 'calibrate', 'calibration', 'fit', 'fitting', 'measured data', 'measurements', 'CSV', 'optimise', 'thermal', 'tank'],
    start: { from: 'example', example: 'tankCalibration.kjt' },
    data: [values.measurements],
    editions: ['desktop', 'web'],
    steps
});
