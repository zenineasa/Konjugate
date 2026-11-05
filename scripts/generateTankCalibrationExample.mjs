/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/tankCalibration.kjt and examples/tankCalibrationMeasured.csv: a small water tank whose two unknowns (how fast it loses
// heat, and how much heat it takes to warm it) are to be recovered from "measured" temperatures by Parameter tuning.
//
// The measurements are made by running this same model, through the real engine, with the true values (below) on the same 10-minute grid
// the tuning will use, and adding a little deterministic noise: so the answer exists and is known, and a good fit lands close to it.
// The saved model holds wrong starting guesses. Run it after `npm run build:engine`:
//   node scripts/generateTankCalibrationExample.mjs
//
// examples/tankCalibration.md shows the same measurements inline for people to copy (nothing else in the app delivers a file to them), and
// tests/tankCalibrationExample.test.mjs checks the two have not drifted apart.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile } from '../src/engineProtocol.mjs';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { gaussianFrom, mulberry32 } from '../tests/fixtures/thermalSystemCsv.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';

const root = join(import.meta.dirname, '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');

export const tankCalibration = Object.freeze({
    // What the "measurements" were made with, and what the saved model starts from instead.
    truth: { capacitance: 209000, heatLoss: 20 },
    start: { capacitance: 300000, heatLoss: 10 },
    capacitanceBounds: { minimum: 100000, maximum: 600000 },
    heatLossBounds: { minimum: 2, maximum: 60 },
    heaterPower: 1000,
    ambient: 293.15,
    timeStep: 600,
    targetTime: 28800,
    noiseKelvin: 0.15,
    seed: 20260
});

export function tankProject({ capacitance, heatLoss, tuned }) {
    const { heaterPower, ambient, timeStep, capacitanceBounds, heatLossBounds } = tankCalibration;
    const capacitanceParameter = (id) => ({
        id, name: 'Water thermal capacitance', symbol: 'waterThermalCapacitance', value: capacitance, unit: 'J/K', mode: 'constant', sharedParameterId: 20
    });
    const state = (id, name, symbol, initialValue, unit) => ({ id, name, symbol, initialValue, unit });
    return {
        format: 'konjugate', version: 1, ownership: exampleOwnership('Tank Calibration'), metadata: { units: 'SI' },
        sharedParameters: [{
            id: 20, name: 'Water thermal capacitance', symbol: 'waterThermalCapacitance', value: capacitance, unit: 'J/K', mode: 'constant',
            ...(tuned ? { tuning: capacitanceBounds } : {})
        }],
        runConfigurations: [{ id: 30, name: 'Eight hours', globalTimeStep: timeStep, outputInterval: timeStep }],
        activeRunConfigurationId: 30,
        nodes: [
            {
                id: 1, name: 'Water tank', type: 'Lumped thermal mass', position: [0, 0, 0], sourceTerms: [],
                states: [state(2, 'Water temperature', 'tankTemperature', ambient, 'K')],
                appearance: { type: 'primitive', shape: 'cylinder', color: '#2e7591' }
            },
            {
                id: 3, name: 'Electric heater', type: 'Heat source', position: [-4, -2.5, 0], sourceTerms: [],
                states: [state(4, 'Heat flow', 'qDot', heaterPower, 'W')],
                appearance: { type: 'primitive', shape: 'sphere', color: '#c16f55' }
            },
            {
                id: 5, name: 'Ambient air', type: 'Temperature boundary', position: [4, 1, 0], sourceTerms: [],
                states: [state(6, 'Temperature', 'temperature', ambient, 'K')],
                appearance: { type: 'primitive', shape: 'box', color: '#52727a' }
            }
        ],
        edges: [
            {
                id: 7, name: 'Heater input', source: { nodeId: 3, stateId: 4 }, target: { nodeId: 1, stateId: 2 }, directionality: 'directed',
                equation: '\\frac{\\mathrm{sourceQDot}}{\\mathrm{waterThermalCapacitance}}',
                equationModel: {
                    latex: '\\frac{\\mathrm{sourceQDot}}{\\mathrm{waterThermalCapacitance}}', output: { role: 'target', stateId: 2 },
                    bindings: [
                        { kind: 'state', role: 'source', nodeId: 3, stateId: 4, symbol: 'sourceQDot' },
                        { kind: 'parameter', parameterId: 8, symbol: 'waterThermalCapacitance' }
                    ],
                    mathJson: ['Divide', 'sourceQDot', 'waterThermalCapacitance']
                },
                parameters: [capacitanceParameter(8)], appearance: { color: '#d98b54', offset: 0 }
            },
            {
                id: 9, name: 'Ambient heat loss', source: { nodeId: 5, stateId: 6 }, target: { nodeId: 1, stateId: 2 }, directionality: 'directed',
                equation: '\\frac{\\mathrm{heatLossCoefficient}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTankTemperature})}{\\mathrm{waterThermalCapacitance}}',
                equationModel: {
                    latex: '\\frac{\\mathrm{heatLossCoefficient}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTankTemperature})}{\\mathrm{waterThermalCapacitance}}',
                    output: { role: 'target', stateId: 2 },
                    bindings: [
                        { kind: 'state', role: 'source', nodeId: 5, stateId: 6, symbol: 'sourceTemperature' },
                        { kind: 'state', role: 'target', nodeId: 1, stateId: 2, symbol: 'targetTankTemperature' },
                        { kind: 'parameter', parameterId: 10, symbol: 'heatLossCoefficient' },
                        { kind: 'parameter', parameterId: 11, symbol: 'waterThermalCapacitance' }
                    ],
                    mathJson: ['Divide', ['Multiply', 'heatLossCoefficient', ['Add', 'sourceTemperature', ['Negate', 'targetTankTemperature']]], 'waterThermalCapacitance']
                },
                parameters: [
                    { id: 10, name: 'Heat loss coefficient', symbol: 'heatLossCoefficient', value: heatLoss, unit: 'W/K', mode: 'constant', ...(tuned ? { tuning: heatLossBounds } : {}) },
                    capacitanceParameter(11)
                ],
                appearance: { color: '#73b9c2', offset: 0 }
            }
        ]
    };
}

function runEngine(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
    });
}

// The measured temperatures: the true model's tank temperature every 10 minutes, plus noise, rounded to 0.01 K as a thermometer would.
export async function measuredTemperatures() {
    const { truth, timeStep, targetTime, noiseKelvin, seed } = tankCalibration;
    const directory = await mkdtemp(join(tmpdir(), 'konjugateTankCalibration-'));
    try {
        const input = join(directory, 'truth.kjt');
        const configuration = join(directory, 'truth.json');
        const output = join(directory, 'truth.bin');
        await writeFile(input, await encodeProjectFile(`${JSON.stringify(tankProject({ ...truth, tuned: false }))}\n`));
        await writeFile(configuration, JSON.stringify({ name: 'Truth', targetTime, globalTimeStep: timeStep, outputInterval: timeStep, execution: { backend: 'serial' } }));
        await runEngine(['run', input, '--configuration', configuration, '--output', output]);
        const random = mulberry32(seed);
        return decodeResultFile(await readFile(output)).samples.map((sample) => ({
            time: sample.time,
            value: Math.round((sample.states.find((entry) => entry.stateId === 2).value + noiseKelvin * gaussianFrom(random)) * 100) / 100
        }));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export const measuredCsv = (rows) => `${['time,tankTemperature', ...rows.map((row) => `${row.time},${row.value.toFixed(2)}`)].join('\n')}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
    const rows = await measuredTemperatures();
    await writeFile(join(root, 'examples', 'tankCalibrationMeasured.csv'), measuredCsv(rows));
    await writeFile(join(root, 'examples', 'tankCalibration.kjt'), await encodeProjectFile(`${JSON.stringify(tankProject({ ...tankCalibration.start, tuned: true }), null, 4)}\n`));
    console.log(`Wrote the tank calibration example: ${rows.length} measurements, ${rows[0].value} K to ${rows.at(-1).value} K.`);
}
