/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Switching circuits: a synchronous buck converter, switched and averaged, and a half-wave rectifier with a piecewise-linear diode.
//
// Synchronous buck (buckSwitched.kjt, buckAveraged.kjt): 12 V in, switching at 20 kHz with duty D = 0.4, L = 100 µH with a 50 mΩ winding,
// two switches of 20 mΩ each, C = 100 µF into a 2 Ω load, from rest. Three nodes: the input supply, the inductor, and the output capacitor
// with its load. The PWM is the relationship from the supply to the inductor: s(t) = 1 while cos(ω t - π D) ≥ cos(π D) (the first D of
// every period), else 0, so
//     L di/dt = s V_in - (r_w + r_s) i - v        C dv/dt = i - v / R
// Both switches have the same on-resistance, so the loop's resistance is the same whichever conducts, and between switching instants the
// circuit is linear: the exact solution is the matrix exponential, interval by interval. The averaged model replaces s(t) by D; it is
// linear throughout, and exact by one matrix exponential. The inductor integrates the energy drawn from the input, dE_in/dt = s V_in i, and
// the energy lost in its winding and the switches, (r_w + r_s) i²; the capacitor the energy delivered to the load, v²/R. The energy balance
// E_in = ½ L i² + ½ C v² + E_loss + E_load is checked from Konjugate's own states.
//
// Konjugate has no event location: a switching instant takes effect at the first step (or Runge–Kutta stage) that starts after it. That is
// an error of up to one step per switching edge, so the switched model converges at first order whatever the method; the averaged model,
// which is smooth, shows each method's own order.
//
// Half-wave rectifier (rectifier.kjt): a 10 V, 50 Hz source charges a 470 µF capacitor through a diode, into a 100 Ω load. The diode is
// the relationship from the source to the capacitor, piecewise linear: 1 Ω while the voltage across it is positive, 1 MΩ otherwise.
//     C dv/dt = i_d - v / R_L,   i_d = (v_s - v) / R_d,   v_s = V sin(2π f t)
// The capacitor integrates the source's work v_s i_d, the diode's loss (v_s - v) i_d and the load's v²/R_L. The diode switches when the
// state crosses the source, so the switching instant is not known in advance; the reference (SciPy's DOP853 at rtol = atol = 1e-12,
// restarted at each switching instant found by its event function) is numerical.
//
// ngspice runs both circuits as a cross-check (benchmarks/electrical/switchedCircuits/generateReference.py).

import { join } from 'node:path';
import { expm, multiplyVector, scaled } from '../../lib/linearAlgebra.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { cases, createModel, difference, negate, parameter, product, quotient, square, state, sum, time } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const buckSwitchedPath = join(directory, 'buckSwitched.kjt');
export const buckAveragedPath = join(directory, 'buckAveraged.kjt');
export const rectifierPath = join(directory, 'rectifier.kjt');

export const constants = Object.freeze({
    buck: { inputVoltage: 12, frequency: 20e3, duty: 0.4, inductance: 100e-6, windingResistance: 0.05, switchResistance: 0.02, capacitance: 100e-6, load: 2 },
    rectifier: { amplitude: 10, frequency: 50, onResistance: 1, offResistance: 1e6, capacitance: 470e-6, load: 100 }
});

function buildBuck(switched) {
    const p = constants.buck;
    const model = createModel(`Benchmark: synchronous buck converter, ${switched ? 'switched' : 'averaged'}`);
    const supply = model.node('Input supply', { type: 'Voltage source', position: [-3, 0, 0], color: '#d98b54', shape: 'sphere', states: [['inputVoltage', 'Input voltage', p.inputVoltage, 'V']] });
    const inductor = model.node('Inductor', { type: 'Inductor', color: '#3f6fb0', states: [
        ['current', 'Inductor current', 0, 'A'], ['inputEnergy', 'Energy drawn from the input', 0, 'J'], ['lossEnergy', 'Energy lost in winding and switches', 0, 'J']
    ] });
    const output = model.node('Output capacitor and load', { type: 'Capacitor', position: [3, 0, 0], color: '#3f6fb0', states: [
        ['voltage', 'Output voltage', 0, 'V'], ['loadEnergy', 'Energy delivered to the load', 0, 'J']
    ] });
    // The switch state: 1 for the first D of every period, else 0 (switched), or D throughout (averaged).
    const pwm = switched
        ? (onValue) => cases(['GreaterEqual', ['Cos', difference(product('angularFrequency', 't'), 'dutyPhase')], ['Cos', 'dutyPhase']], onValue, 'True', 0)
        : (onValue) => product('duty', onValue);
    const pwmUses = switched
        ? { angularFrequency: parameter('Angular switching frequency', 2 * Math.PI * p.frequency, 'rad/s'), t: time, dutyPhase: parameter('Duty phase (π D)', Math.PI * p.duty, 'rad') }
        : { duty: parameter('Duty cycle', p.duty, '') };
    model.edge(switched ? 'High-side switch (PWM)' : 'Averaged switch (duty D)', supply, inductor, 'current', pwm(quotient('inputVoltage', 'inductance')), {
        ...pwmUses, inputVoltage: state(supply, 'inputVoltage'), inductance: parameter('Inductance', p.inductance, 'H')
    }, { color: '#d98b54' });
    model.edge('Input power', supply, inductor, 'inputEnergy', pwm(product('inputVoltage', 'current')), {
        ...pwmUses, inputVoltage: state(supply, 'inputVoltage'), current: state(inductor, 'current')
    }, { color: '#d98b54' });
    model.sourceTerm(inductor, 'current', quotient(negate(product(sum('windingResistance', 'switchResistance'), 'current')), 'inductance'), {
        windingResistance: parameter('Winding resistance', p.windingResistance, 'Ω'), switchResistance: parameter('Switch on-resistance', p.switchResistance, 'Ω'),
        current: state(inductor, 'current'), inductance: parameter('Inductance', p.inductance, 'H')
    });
    model.sourceTerm(inductor, 'lossEnergy', product(sum('windingResistance', 'switchResistance'), square('current')), {
        windingResistance: parameter('Winding resistance', p.windingResistance, 'Ω'), switchResistance: parameter('Switch on-resistance', p.switchResistance, 'Ω'), current: state(inductor, 'current')
    });
    model.edge('Output voltage across the inductor', output, inductor, 'current', quotient(negate('voltage'), 'inductance'), {
        voltage: state(output, 'voltage'), inductance: parameter('Inductance', p.inductance, 'H')
    });
    model.edge('Inductor current into the capacitor', inductor, output, 'voltage', quotient('current', 'capacitance'), {
        current: state(inductor, 'current'), capacitance: parameter('Capacitance', p.capacitance, 'F')
    });
    model.sourceTerm(output, 'voltage', quotient(negate('voltage'), product('load', 'capacitance')), {
        voltage: state(output, 'voltage'), load: parameter('Load resistance', p.load, 'Ω'), capacitance: parameter('Capacitance', p.capacitance, 'F')
    });
    model.sourceTerm(output, 'loadEnergy', quotient(square('voltage'), 'load'), { voltage: state(output, 'voltage'), load: parameter('Load resistance', p.load, 'Ω') });
    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -20, outputInterval: 2 ** -17 } });
    return { document, ids: { compared: [inductor.stateIds.current, output.stateIds.voltage], inputEnergy: inductor.stateIds.inputEnergy, lossEnergy: inductor.stateIds.lossEnergy, loadEnergy: output.stateIds.loadEnergy } };
}

export function buildRectifier() {
    const p = constants.rectifier;
    const model = createModel('Benchmark: half-wave rectifier');
    const source = model.node('AC source', { type: 'Voltage source', position: [-3, 0, 0], color: '#d98b54', shape: 'sphere', states: [['amplitude', 'Peak voltage', p.amplitude, 'V']] });
    const output = model.node('Smoothing capacitor and load', { type: 'Capacitor', color: '#3f6fb0', states: [
        ['voltage', 'Capacitor voltage', 0, 'V'], ['sourceEnergy', 'Energy from the source', 0, 'J'], ['diodeEnergy', 'Energy lost in the diode', 0, 'J'], ['loadEnergy', 'Energy delivered to the load', 0, 'J']
    ] });
    const sourceVoltage = product('amplitude', ['Sin', product('angularFrequency', 't')]);
    const across = difference(sourceVoltage, 'voltage');
    // The diode current: (v_s - v) / R_on while the voltage across it is positive, (v_s - v) / R_off otherwise.
    const diodeCurrent = cases(['Greater', across, 0], quotient(across, 'onResistance'), 'True', quotient(across, 'offResistance'));
    const uses = () => ({
        amplitude: state(source, 'amplitude'), angularFrequency: parameter('Angular frequency', 2 * Math.PI * p.frequency, 'rad/s'), t: time, voltage: state(output, 'voltage'),
        onResistance: parameter('Diode forward resistance', p.onResistance, 'Ω'), offResistance: parameter('Diode reverse resistance', p.offResistance, 'Ω')
    });
    model.edge('Diode current into the capacitor', source, output, 'voltage', quotient(diodeCurrent, 'capacitance'), { ...uses(), capacitance: parameter('Capacitance', p.capacitance, 'F') }, { color: '#d98b54' });
    model.edge('Source power', source, output, 'sourceEnergy', product(sourceVoltage, diodeCurrent), uses(), { color: '#d98b54' });
    model.edge('Diode loss', source, output, 'diodeEnergy', product(across, diodeCurrent), uses(), { color: '#d98b54' });
    model.sourceTerm(output, 'voltage', quotient(negate('voltage'), product('load', 'capacitance')), {
        voltage: state(output, 'voltage'), load: parameter('Load resistance', p.load, 'Ω'), capacitance: parameter('Capacitance', p.capacitance, 'F')
    });
    model.sourceTerm(output, 'loadEnergy', quotient(square('voltage'), 'load'), { voltage: state(output, 'voltage'), load: parameter('Load resistance', p.load, 'Ω') });
    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -16, outputInterval: 2 ** -11 } });
    return { document, ids: { voltage: output.stateIds.voltage, sourceEnergy: output.stateIds.sourceEnergy, diodeEnergy: output.stateIds.diodeEnergy, loadEnergy: output.stateIds.loadEnergy } };
}

export const models = { buckSwitched: () => buildBuck(true).document, buckAveraged: () => buildBuck(false).document, rectifier: () => buildRectifier().document };

// The buck's [i, v, E_in] as x' = A x + b: on (s = 1), off (s = 0) or averaged (s = D).
function buckSystem(s) {
    const p = constants.buck;
    const r = p.windingResistance + p.switchResistance;
    return {
        matrix: [[-r / p.inductance, -1 / p.inductance, 0], [1 / p.capacitance, -1 / (p.load * p.capacitance), 0], [s * p.inputVoltage, 0, 0]],
        forcing: [s * p.inputVoltage / p.inductance, 0, 0]
    };
}

function augmented({ matrix, forcing }) {
    return [...matrix.map((row, index) => [...row, forcing[index]]), new Array(matrix.length + 1).fill(0)];
}

// The switched buck exactly: the matrix exponential across each on and off interval in turn, from rest.
export function buckSwitchedReference(times) {
    const p = constants.buck;
    const period = 1 / p.frequency;
    const on = augmented(buckSystem(1));
    const off = augmented(buckSystem(0));
    let stateVector = [0, 0, 0, 1];
    let now = 0;
    let cycle = 0;
    let conducting = true;
    const nextEdge = () => (conducting ? cycle * period + p.duty * period : (cycle + 1) * period);
    return times.map((t) => {
        while (nextEdge() <= t) {
            const edge = nextEdge();
            stateVector = multiplyVector(expm(scaled(conducting ? on : off, edge - now)), stateVector);
            now = edge;
            if (!conducting) cycle += 1;
            conducting = !conducting;
        }
        return multiplyVector(expm(scaled(conducting ? on : off, t - now)), stateVector).slice(0, 3);
    });
}

export function buckAveragedReference(times) {
    const start = [0, 0, 0, 1];
    const system = augmented(buckSystem(constants.buck.duty));
    return times.map((t) => multiplyVector(expm(scaled(system, t)), start).slice(0, 3));
}

const variantOf = (method) => (method === 'rungeKutta4' ? { method: 'rungeKutta4' } : { integration: 'explicit' });
const sumAt = (values, ids, k) => ids.reduce((total, id) => total + values.get(id)[k], 0);

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const data = referenceData(directory);
    const p = constants.buck;

    // The buck, switched and averaged: errors over a range of steps for each method, then the energy balance at the configured step.
    const buckCases = {
        switched: { title: 'Buck, switched', path: buckSwitchedPath, build: () => buildBuck(true), reference: buckSwitchedReference, model: 'buckSwitched' },
        averaged: { title: 'Buck, averaged', path: buckAveragedPath, build: () => buildBuck(false), reference: buckAveragedReference, model: 'buckAveraged' }
    };
    const sweeps = {};
    const traces = {};
    for (const [key, buck] of Object.entries(buckCases)) {
        const { ids } = buck.build();
        sweeps[key] = {};
        for (const method of ['explicit', 'rungeKutta4']) {
            const steps = config.buck.globalTimeSteps[`${key}:${method}`];
            const errors = [];
            for (const step of steps) {
                const run = engineRun(config.buck.run, { globalTimeStep: step });
                const result = await engine.run(buck.path, variantOf(method), run);
                const exact = buck.reference(result.times);
                const numeric = trajectory(result, ids.compared);
                const metrics = errorMetrics(numeric, exact.map((sample) => sample.slice(0, 2)));
                const values = result.values;
                const inputEnergyError = Math.max(...result.times.map((_t, k) => Math.abs(values.get(ids.inputEnergy)[k] - exact[k][2]))) / exact.at(-1)[2];
                const balance = result.times.map((_t, k) => values.get(ids.inputEnergy)[k] - 0.5 * p.inductance * values.get(ids.compared[0])[k] ** 2
                    - 0.5 * p.capacitance * values.get(ids.compared[1])[k] ** 2 - sumAt(values, [ids.lossEnergy, ids.loadEnergy], k));
                const balanceDefect = Math.max(...balance.map(Math.abs)) / values.get(ids.inputEnergy).at(-1);
                errors.push(metrics.relativeError);
                rows.push(resultRow({
                    caseName: `${buck.title}: inductor current and output voltage`, model: buck.model, variant: variantOf(method), run, errors: metrics, conservationError: balanceDefect, work: result.work, unit: 'A, V',
                    note: `input-energy error ${inputEnergyError.toExponential(2)} of the total; conservation = energy-balance defect / energy drawn`
                }));
                if (step === config.buck.run.globalTimeStep) {
                    traces[`${key}:${method}`] = { result, numeric, exact };
                    const name = `${key}${method === 'explicit' ? 'Explicit' : 'RungeKutta4'}`;
                    add(`${name}RelativeError`, metrics.relativeError, `${buck.title}: largest current/voltage error relative to range, ${methodName(variantOf(method))}, h = 2^${Math.log2(step)} s`);
                    add(`${name}InputEnergyError`, inputEnergyError, `${buck.title}: largest error in the energy drawn from the input, relative to the exact total, ${methodName(variantOf(method))}`);
                    add(`${name}EnergyBalanceDefect`, balanceDefect, `${buck.title}: energy-balance defect E_in - stored - lost - delivered from Konjugate's own states, relative to the energy drawn, ${methodName(variantOf(method))}`);
                }
            }
            const order = observedOrder(steps, errors);
            sweeps[key][method] = { steps, errors, order };
            rows.push(resultRow({ caseName: `${buck.title}: error order in h`, model: buck.model, variant: variantOf(method), observedOrder: order.fitted, note: `pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
            add(`${key}${method === 'explicit' ? 'Explicit' : 'RungeKutta4'}Order`, order.fitted, `${buck.title}: observed order of the error in h, ${methodName(variantOf(method))} (fitted over every h)`);
        }
    }
    // The averaged model's own error: how far the exact averaged solution is from the exact switched one (a modelling error, not a numerical one).
    const buckTimes = traces['switched:explicit'].result.times;
    const switchedExact = buckSwitchedReference(buckTimes);
    const averagedExact = buckAveragedReference(buckTimes);
    const averaging = errorMetrics(averagedExact.map((sample) => sample.slice(0, 2)), switchedExact.map((sample) => sample.slice(0, 2)));
    rows.push({ ...resultRow({ caseName: 'Averaged against switched, both exact', model: 'buckAveraged', errors: averaging, unit: 'A, V', note: 'the averaging error of the model itself (ripple and startup), not Konjugate\'s' }), method: 'exact (matrix exponential)' });
    notes.push(`The averaged buck departs from the switched one by ${(averaging.relativeError * 100).toFixed(1)} % of range at most (both exact): that is the ripple and the startup the average leaves out, a property of the model rather than of Konjugate.`);

    add('buckReferenceAgreement', data ? referenceAgreement(buckSwitchedReference(data.buck.times), data.buck.switched) : NaN, 'Buck, switched: this exact reference against SciPy\'s expm interval by interval (reference.json), largest difference relative to each column\'s magnitude');
    add('buckAveragedReferenceAgreement', data ? referenceAgreement(buckAveragedReference(data.buck.times), data.buck.averaged) : NaN, 'Buck, averaged: this exact reference against SciPy\'s expm (reference.json)');
    add('buckNgspiceAgreement', data ? referenceAgreement(data.buck.ngspice, buckSwitchedReference(data.buck.times).map((sample) => sample.slice(0, 2))) : NaN, 'Buck, switched: ngspice (real switches, 1 ns gate edges) against the exact solution, largest difference relative to each column\'s magnitude');

    // The rectifier: each method at the configured step against the event-located numerical reference.
    const rectifier = buildRectifier();
    const rc = constants.rectifier;
    const rectifierTraces = {};
    for (const method of ['explicit', 'rungeKutta4']) {
        const steps = config.rectifier.globalTimeSteps[method];
        const errors = [];
        for (const step of steps) {
            const run = engineRun(config.rectifier.run, { globalTimeStep: step });
            const result = await engine.run(rectifierPath, variantOf(method), run);
            if (result.times.length !== data.rectifier.times.length) throw new Error('The rectifier\'s samples do not match its reference.json.');
            const exact = data.rectifier.states;
            const numeric = trajectory(result, [rectifier.ids.voltage]);
            const metrics = errorMetrics(numeric, exact.map((sample) => [sample[0]]));
            const values = result.values;
            const energyError = (id, column) => Math.max(...result.times.map((_t, k) => Math.abs(values.get(id)[k] - exact[k][column]))) / exact.at(-1)[column];
            const diodeEnergyError = energyError(rectifier.ids.diodeEnergy, 2);
            const sourceEnergyError = energyError(rectifier.ids.sourceEnergy, 1);
            const balance = result.times.map((_t, k) => values.get(rectifier.ids.sourceEnergy)[k] - 0.5 * rc.capacitance * values.get(rectifier.ids.voltage)[k] ** 2
                - values.get(rectifier.ids.diodeEnergy)[k] - values.get(rectifier.ids.loadEnergy)[k]);
            const balanceDefect = Math.max(...balance.map(Math.abs)) / values.get(rectifier.ids.sourceEnergy).at(-1);
            errors.push(metrics.relativeError);
            rows.push(resultRow({
                caseName: 'Rectifier: capacitor voltage', model: 'rectifier', variant: variantOf(method), run, errors: metrics, conservationError: balanceDefect, work: result.work, unit: 'V',
                note: `diode-loss error ${diodeEnergyError.toExponential(2)}, source-energy error ${sourceEnergyError.toExponential(2)} of their totals`
            }));
            if (step === config.rectifier.run.globalTimeStep) {
                rectifierTraces[method] = { result, numeric, exact };
                const name = `rectifier${method === 'explicit' ? 'Explicit' : 'RungeKutta4'}`;
                add(`${name}RelativeError`, metrics.relativeError, `Rectifier: largest capacitor-voltage error relative to range, ${methodName(variantOf(method))}, h = 2^${Math.log2(step)} s`);
                add(`${name}DiodeEnergyError`, diodeEnergyError, `Rectifier: largest error in the energy lost in the diode, relative to the reference total, ${methodName(variantOf(method))}`);
                add(`${name}EnergyBalanceDefect`, balanceDefect, `Rectifier: energy-balance defect (source work - stored - diode - load) from Konjugate's own states, relative to the source's work, ${methodName(variantOf(method))}`);
            }
        }
        const order = observedOrder(steps, errors);
        rows.push(resultRow({ caseName: 'Rectifier: error order in h', model: 'rectifier', variant: variantOf(method), observedOrder: order.fitted, note: `pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
        add(`rectifier${method === 'explicit' ? 'Explicit' : 'RungeKutta4'}Order`, order.fitted, `Rectifier: observed order of the error in h, ${methodName(variantOf(method))} (fitted over every h)`);
        sweeps[`rectifier:${method}`] = { steps, errors, order };
    }
    add('rectifierNgspiceAgreement', data ? referenceAgreement(data.rectifier.ngspice.map((value) => [value]), data.rectifier.states.map((sample) => [sample[0]])) : NaN, 'Rectifier: ngspice (a switch controlled by its own voltage) against the SciPy reference, largest difference relative to the voltage\'s magnitude');

    // Plots: the switched buck's first millisecond, the energy, the rectifier, and the convergence of every case.
    const firstMs = buckTimes.map((t) => t * 1000).filter((t) => t <= 2);
    const window = (values) => values.slice(0, firstMs.length);
    plots.push(linePlot({
        id: 'buckInductorCurrent', title: 'Buck converter: inductor current at start-up', subtitle: `Exact switched and averaged against Konjugate, h = 2^${Math.log2(config.buck.run.globalTimeStep)} s, first 2 ms`, xLabel: 'Time (ms)', yLabel: 'Current (A)',
        series: [
            series('Exact, switched (matrix exponential per interval)', 'reference', firstMs, window(switchedExact.map((sample) => sample[0]))),
            series('Konjugate, switched, explicit Euler', 'explicit', firstMs, window(traces['switched:explicit'].numeric.map((sample) => sample[0]))),
            series('Konjugate, switched, Runge–Kutta 4', 'rungeKutta4', firstMs, window(traces['switched:rungeKutta4'].numeric.map((sample) => sample[0]))),
            series('Exact, averaged', 'semiImplicit', firstMs, window(averagedExact.map((sample) => sample[0])))
        ]
    }));
    const rectifierMs = rectifierTraces.explicit.result.times.map((t) => t * 1000);
    plots.push(linePlot({
        id: 'rectifierVoltage', title: 'Half-wave rectifier: capacitor voltage', subtitle: `SciPy DOP853 (event-located) against Konjugate, h = 2^${Math.log2(config.rectifier.run.globalTimeStep)} s`, xLabel: 'Time (ms)', yLabel: 'Voltage (V)',
        series: [
            series('Reference (DOP853, events)', 'reference', rectifierMs, data.rectifier.states.map((sample) => sample[0])),
            series('Source voltage', 'guide', rectifierMs, rectifierMs.map((t) => rc.amplitude * Math.sin(2 * Math.PI * rc.frequency * t / 1000))),
            series('Konjugate, explicit Euler', 'explicit', rectifierMs, rectifierTraces.explicit.numeric.map((sample) => sample[0])),
            series('Konjugate, Runge–Kutta 4', 'rungeKutta4', rectifierMs, rectifierTraces.rungeKutta4.numeric.map((sample) => sample[0]))
        ]
    }));
    plots.push(linePlot({
        id: 'buckConvergence', title: 'Buck converter: error against the step', subtitle: 'Largest error relative to range. Without event location a switching edge costs up to a step, so the switched converter converges at first order under either method; the averaged one, smooth, at each method\'s own order', xLabel: 'Step h (s)', yLabel: 'Relative error', logX: true, logY: true,
        series: [
            series('Switched, explicit Euler', 'explicit', sweeps.switched.explicit.steps, sweeps.switched.explicit.errors),
            series('Switched, Runge–Kutta 4', 'rungeKutta4', sweeps.switched.rungeKutta4.steps, sweeps.switched.rungeKutta4.errors),
            series('Averaged, explicit Euler', 'semiImplicit', sweeps.averaged.explicit.steps, sweeps.averaged.explicit.errors),
            series('Averaged, Runge–Kutta 4', 'extra', sweeps.averaged.rungeKutta4.steps, sweeps.averaged.rungeKutta4.errors)
        ]
    }));
    plots.push(linePlot({
        id: 'rectifierConvergence', title: 'Half-wave rectifier: error against the step', subtitle: 'Largest capacitor-voltage error relative to range; the diode switches inside steps, which caps Runge–Kutta 4 near second order', xLabel: 'Step h (s)', yLabel: 'Relative error', logX: true, logY: true,
        series: [
            series('Explicit Euler', 'explicit', sweeps['rectifier:explicit'].steps, sweeps['rectifier:explicit'].errors),
            series('Runge–Kutta 4', 'rungeKutta4', sweeps['rectifier:rungeKutta4'].steps, sweeps['rectifier:rungeKutta4'].errors)
        ]
    }));
    notes.push('Konjugate has no event location: a switch or a diode changes state at the first step or stage that starts after the instant it should. Runge–Kutta 4 is therefore about first order on the switched buck (its advantage a constant factor) and about second order on the rectifier, whose diode switches on the state; on the averaged converter, which is smooth, it is fourth order.');
    return { rows, checks, plots, notes };
}
