/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/dataSources/dcMotor.kjt and examples/dataSources/dcMotor.csv: the live twin's demonstration of a fast system, made to
// be run in real time and steered by hand (docs/proposals/controlRoom.md, "Demonstrations"). The slow demonstrations (the tank takes
// hours to settle, the house a day) show a twin keeping in step over time; at one second a second nothing moves for minutes. A DC
// motor answers its voltage within half a second, so an operator turning a knob, or a joystick in "Try something", is seen at once.
//
// The motor: its current i (A) and its speed ω (rad/s), L di/dt = V − R i − K ω and J dω/dt = K i − b ω. The voltage V is a shared,
// live parameter: the twin's input from the recording, and what a controller bound to it steers in a run or a sandbox. The speed is
// measured; the current is not, and the twin infers it. The recording is three minutes of an operator at the motor's controller,
// logged as the controller would (the voltage when it changes, the speed twenty times a second with a tachometer's noise), and the
// motor's bearing warming from a minute and a half in, so its friction grows and the motor runs slower than the model says: the twin
// keeps in step at first, then warns of the drift. The friction is tunable, for a refit to find or the estimator to track.
//
// The motor is simulated here with the model's own equations and step (explicit Euler, a millisecond), so the recording is what the
// model would give with the bearing's friction, plus the tachometer's noise and its 0.01 resolution.
//   node scripts/generateMotorTwin.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatDataLog } from '../src/dataLogFormat.mjs';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { gaussianFrom, mulberry32 } from '../tests/fixtures/thermalSystemCsv.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';

const root = join(import.meta.dirname, '..');

export const motor = Object.freeze({
    resistance: 2,          // Ω
    inductance: 0.01,       // H: the current settles in about 5 ms
    torqueConstant: 0.5,    // N·m/A, and V·s/rad
    inertia: 0.05,          // kg·m²: the speed settles in about a third of a second
    friction: 0.02,         // N·m·s/rad, as the model has it
    // The bearing warming: its friction from 90 s to 120 s grows to three times what the model has, and stays.
    warming: { from: 90, to: 120, factor: 3 },
    timeStep: 0.001,
    duration: 180,
    sampleEvery: 0.05,
    noise: 0.15,
    seed: 20261110
});
const ids = { node: 1, current: 2, speed: 3, voltage: 50, run: 60 };

// What the operator does: the voltage a person sets on the controller, in steps and turns of a knob, over three minutes.
function voltageAt(time) {
    if (time < 2) return 0;
    if (time < 20) return Math.min(12, 6 + (time - 2) * (6 / 15));
    if (time < 40) return 12;
    if (time < 55) return 3;
    if (time < 70) return 9;
    if (time < 85) return 9 + 6 * Math.sin((time - 70) / 15 * Math.PI);
    if (time < 150) return 12;
    if (time < 165) return 4;
    return 10;
}

export function motorProject() {
    let next = 200;
    const id = () => next++;
    const parameter = (name, symbol, value, unit, extra = {}) => ({ id: id(), name, symbol, value, unit, mode: 'constant', ...extra });
    const own = (stateId, symbol) => ({ kind: 'state', nodeId: ids.node, stateId, symbol });
    const uses = (item) => ({ kind: 'parameter', parameterId: item.id, symbol: item.symbol });
    const voltage = parameter('Voltage', 'voltage', 0, 'V', { sharedParameterId: ids.voltage });
    const resistance = parameter('Winding resistance', 'resistance', motor.resistance, 'Ω');
    const inductance = parameter('Winding inductance', 'inductance', motor.inductance, 'H');
    const backEmf = parameter('Torque constant', 'torqueConstant', motor.torqueConstant, 'V·s/rad');
    const torque = parameter('Torque constant', 'torqueConstant', motor.torqueConstant, 'N·m/A');
    const friction = parameter('Bearing friction', 'friction', motor.friction, 'N·m·s/rad', { tuning: { minimum: 0.001, maximum: 0.5 } });
    const inertia = parameter('Rotor inertia', 'inertia', motor.inertia, 'kg·m²');
    const electrical = '\\frac{\\mathrm{voltage}-\\mathrm{resistance}\\cdot\\mathrm{current}-\\mathrm{torqueConstant}\\cdot\\mathrm{speed}}{\\mathrm{inductance}}';
    const mechanical = '\\frac{\\mathrm{torqueConstant}\\cdot\\mathrm{current}-\\mathrm{friction}\\cdot\\mathrm{speed}}{\\mathrm{inertia}}';
    return {
        format: 'konjugate', version: 1, ownership: exampleOwnership('DC Motor'), metadata: { units: 'SI' },
        sharedParameters: [{ id: ids.voltage, name: 'Voltage', symbol: 'voltage', value: 0, unit: 'V', mode: 'live', control: { minimum: 0, maximum: 24, step: 0.1 } }],
        runConfigurations: [{ id: ids.run, name: 'Three minutes', globalTimeStep: motor.timeStep, outputInterval: motor.sampleEvery, targetTime: motor.duration }],
        activeRunConfigurationId: ids.run,
        nodes: [{
            id: ids.node, name: 'Motor', type: 'DC motor', position: [0, 0, 0], appearance: { type: 'primitive', shape: 'box', color: '#4b8fe2' },
            states: [
                { id: ids.current, name: 'Current', symbol: 'current', initialValue: 0, unit: 'A' },
                { id: ids.speed, name: 'Speed', symbol: 'speed', initialValue: 0, unit: 'rad/s' }
            ],
            sourceTerms: [
                {
                    id: id(), state: 'current', expression: '(voltage - resistance * current - torqueConstant * speed) / inductance',
                    expressionModel: {
                        latex: electrical, output: { stateId: ids.current },
                        mathJson: ['Divide', ['Add', 'voltage', ['Negate', ['Multiply', 'resistance', 'current']], ['Negate', ['Multiply', 'torqueConstant', 'speed']]], 'inductance'],
                        bindings: [uses(voltage), uses(resistance), uses(backEmf), uses(inductance), own(ids.current, 'current'), own(ids.speed, 'speed')]
                    },
                    parameters: [voltage, resistance, backEmf, inductance]
                },
                {
                    id: id(), state: 'speed', expression: '(torqueConstant * current - friction * speed) / inertia',
                    expressionModel: {
                        latex: mechanical, output: { stateId: ids.speed },
                        mathJson: ['Divide', ['Add', ['Multiply', 'torqueConstant', 'current'], ['Negate', ['Multiply', 'friction', 'speed']]], 'inertia'],
                        bindings: [uses(torque), uses(friction), uses(inertia), own(ids.current, 'current'), own(ids.speed, 'speed')]
                    },
                    parameters: [torque, friction, inertia]
                }
            ]
        }],
        edges: [],
        // The twin, set up already: its recording's two signals mapped, and timing for a system that answers in a second (a five-second
        // window moving every second, five seconds of forecast, the model's millisecond step), so it runs at one second a second.
        twin: {
            source: { kind: 'file', fileName: 'dcMotor.csv' },
            mapping: [
                { source: 'motorVoltage', name: 'motorVoltage', role: 'input', target: { kind: 'parameter', id: ids.voltage }, unit: 'V', conversion: null },
                { source: 'motorSpeed', name: 'motorSpeed', role: 'output', target: { kind: 'state', id: ids.speed }, unit: 'rad/s', conversion: null }
            ],
            live: { window: 5, stride: 1, horizon: 5, timeStep: motor.timeStep, speed: '1' }
        }
    };
}

// Three minutes of the motor, as its controller logs them: the voltage when it changes (to a tenth of a volt), the speed every 50 ms.
export function motorRun() {
    const random = mulberry32(motor.seed);
    let current = 0;
    let speed = 0;
    const observations = [];
    let lastVoltage = null;
    const steps = Math.round(motor.duration / motor.timeStep);
    const sampleEvery = Math.round(motor.sampleEvery / motor.timeStep);
    for (let step = 0; step <= steps; step += 1) {
        const time = step * motor.timeStep;
        const voltage = Number(voltageAt(time).toFixed(1));
        if (voltage !== lastVoltage) {
            observations.push({ time: Number(time.toFixed(3)), signal: 'motorVoltage', value: voltage, quality: 'good', revision: 0 });
            lastVoltage = voltage;
        }
        if (step % sampleEvery === 0) {
            observations.push({ time: Number(time.toFixed(3)), signal: 'motorSpeed', value: Number((speed + motor.noise * gaussianFrom(random)).toFixed(2)), quality: 'good', revision: 0 });
        }
        const { from, to, factor } = motor.warming;
        const friction = motor.friction * (time < from ? 1 : time < to ? 1 + (factor - 1) * (time - from) / (to - from) : factor);
        const currentRate = (voltage - motor.resistance * current - motor.torqueConstant * speed) / motor.inductance;
        const speedRate = (motor.torqueConstant * current - friction * speed) / motor.inertia;
        current += motor.timeStep * currentRate;
        speed += motor.timeStep * speedRate;
    }
    const signals = [
        { name: 'motorVoltage', role: 'input', unit: 'V' },
        { name: 'motorSpeed', role: 'output', unit: 'rad/s' }
    ];
    return { header: { source: 'Motor controller (simulated)', epoch: Date.parse('2026-11-10T09:00:00Z'), signals }, observations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(root, 'examples', 'dataSources', 'dcMotor.kjt'), await encodeProjectFile(`${JSON.stringify(motorProject(), null, 4)}\n`));
    await writeFile(join(root, 'examples', 'dataSources', 'dcMotor.csv'), formatDataLog(motorRun()));
    console.log('Wrote examples/dataSources/dcMotor.kjt and dcMotor.csv.');
}
