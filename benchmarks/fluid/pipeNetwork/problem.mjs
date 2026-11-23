/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A coupled fluid network: three open tanks joined in a loop by three pipes, one with a pump and one with a valve.
//
// Water (ρ = 1000 kg/m³, g = 9.81 m/s²). The tanks, each a node with its level h as state:
//     upper reservoir  base 10 m, area 0.5 m², 2 m of water
//     middle tank      base 0.5 m, area 0.25 m², 3 m
//     sump             base 0 m, area 0.75 m², 4 m
// The pipes, each a node with its volume flow Q as state, all 50 m long and 0.1 m across, with inertance I = ρ L / A_p and quadratic
// friction K Q|Q| (Darcy f = 0.02, so K = f (L/D) ρ / (2 A_p²)):
//     pump pipe    sump → upper reservoir, with a pump of shut-off head 14 m and Δp = ρ g 14 (1 - Q|Q| / Q0²), Q0 = 0.05 m³/s
//     valve pipe   upper reservoir → middle tank, through a valve of K_v = 20 · ρ / (2 A_p²) / u², its opening u closing from 1 to 0.3
//                  between 300 s and 305 s
//     return pipe  middle tank → sump
//     I dQ/dt = ρ g (H_from - H_to) + Δp_pump - (K + K_valve) Q|Q|,     A dh/dt = Σ Q_in - Σ Q_out,     H = base + h
// Each tank's head reaches a pipe through a relationship; each pipe's flow fills one tank and drains another through two more. Pressures
// are derived from the states: the gauge pressure at each tank's base, ρ g h, and at the pump's outlet, ρ g h_sump + Δp_pump.
//
// Mass conservation: the loop is closed, so Σ A h is constant; every flow leaves one tank and enters another in the same step, so it is
// kept to rounding by any method. The reference is SciPy's solve_ivp DOP853 at rtol = 1e-13, atol = 1e-15, integrated in pieces between the
// valve's two kinks (generateReference.py), with Radau at rtol = 1e-10 as a check of it.

import { join } from 'node:path';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { cases, createModel, difference, negate, parameter, product, quotient, state, sum, time } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'pipeNetwork.kjt');

const density = 1000;
const gravity = 9.81;
const pipeArea = Math.PI * 0.1 ** 2 / 4;
export const constants = Object.freeze({
    density, gravity,
    tanks: {
        upper: { name: 'Upper reservoir', base: 10, area: 0.5, level: 2 },
        middle: { name: 'Middle tank', base: 0.5, area: 0.25, level: 3 },
        sump: { name: 'Sump', base: 0, area: 0.75, level: 4 }
    },
    pipe: { length: 50, diameter: 0.1, friction: 0.02 },
    inertance: density * 50 / pipeArea,
    resistance: 0.02 * (50 / 0.1) * density / (2 * pipeArea ** 2),
    pump: { shutoffHead: 14, ratedFlow: 0.05 },
    valve: { coefficient: 20 * density / (2 * pipeArea ** 2), closesAt: 300, closedBy: 305, finalOpening: 0.3 },
    pipes: [
        { key: 'pumpPipe', name: 'Pump pipe', from: 'sump', to: 'upper' },
        { key: 'valvePipe', name: 'Valve pipe', from: 'upper', to: 'middle' },
        { key: 'returnPipe', name: 'Return pipe', from: 'middle', to: 'sump' }
    ]
});
const tankKeys = ['upper', 'middle', 'sump'];

export function build() {
    const c = constants;
    const model = createModel('Benchmark: pumped fluid network');
    const positions = { upper: [0, 4, 0], middle: [4, 0, 0], sump: [-4, 0, 0] };
    const tanks = Object.fromEntries(tankKeys.map((key) => [key, model.node(c.tanks[key].name, { type: 'Open tank', position: positions[key], color: '#3f6fb0', shape: 'cylinder', states: [['level', 'Water level', c.tanks[key].level, 'm']] })]));
    const pipePositions = { pumpPipe: [-2, 2, 0], valvePipe: [2, 2, 0], returnPipe: [0, -1, 0] };
    const pipes = Object.fromEntries(c.pipes.map((pipe) => [pipe.key, model.node(pipe.name, { type: pipe.key === 'pumpPipe' ? 'Pipe with pump' : pipe.key === 'valvePipe' ? 'Pipe with valve' : 'Pipe', position: pipePositions[pipe.key], color: '#5d7885', states: [['flow', 'Volume flow', 0, 'm³/s']] })]));
    const inertance = () => parameter('Inertance (ρ L / A)', c.inertance, 'kg/m⁴');
    for (const pipe of c.pipes) {
        const node = pipes[pipe.key];
        for (const [end, sign] of [[pipe.from, 1], [pipe.to, -1]]) {
            const head = product('density', 'gravity', sum('base', 'level'));
            model.edge(`Head of the ${c.tanks[end].name.toLowerCase()} on the ${pipe.name.toLowerCase()}`, tanks[end], node, 'flow', quotient(sign > 0 ? head : negate(head), 'inertance'), {
                density: parameter('Density', density, 'kg/m³'), gravity: parameter('Gravity', gravity, 'm/s²'), base: parameter('Tank base elevation', c.tanks[end].base, 'm'),
                level: state(tanks[end], 'level'), inertance: inertance()
            }, { color: '#3f6fb0' });
        }
        for (const [end, sign] of [[pipe.to, 1], [pipe.from, -1]]) {
            model.edge(`${pipe.name} ${sign > 0 ? 'filling' : 'draining'} the ${c.tanks[end].name.toLowerCase()}`, node, tanks[end], 'level', quotient(sign > 0 ? 'flow' : negate('flow'), 'area'), {
                flow: state(node, 'flow'), area: parameter('Tank area', c.tanks[end].area, 'm²')
            }, { color: '#5d7885' });
        }
        const flowSquared = product('flow', ['Abs', 'flow']);
        const friction = { resistance: parameter('Pipe friction coefficient', c.resistance, 'kg/m⁷'), flow: state(node, 'flow'), inertance: inertance() };
        if (pipe.key === 'pumpPipe') {
            model.sourceTerm(node, 'flow', quotient(difference(product('density', 'gravity', 'shutoffHead', difference(1, quotient(flowSquared, square2('ratedFlow')))), product('resistance', flowSquared)), 'inertance'), {
                density: parameter('Density', density, 'kg/m³'), gravity: parameter('Gravity', gravity, 'm/s²'), shutoffHead: parameter('Pump shut-off head', c.pump.shutoffHead, 'm'),
                ratedFlow: parameter('Pump flow at zero head', c.pump.ratedFlow, 'm³/s'), ...friction
            });
        } else if (pipe.key === 'valvePipe') {
            const { closesAt, closedBy, finalOpening } = c.valve;
            const opening = cases(['Less', 't', 'closesAt'], 1, ['Less', 't', 'closedBy'], difference(1, product(1 - finalOpening, quotient(difference('t', 'closesAt'), difference('closedBy', 'closesAt')))), 'True', finalOpening);
            model.sourceTerm(node, 'flow', quotient(negate(product(sum('resistance', quotient('valveCoefficient', square2(opening))), flowSquared)), 'inertance'), {
                ...friction, valveCoefficient: parameter('Valve coefficient, fully open', c.valve.coefficient, 'kg/m⁷'), t: time,
                closesAt: parameter('Valve starts closing', closesAt, 's'), closedBy: parameter('Valve closed by', closedBy, 's')
            });
        } else {
            model.sourceTerm(node, 'flow', quotient(negate(product('resistance', flowSquared)), 'inertance'), friction);
        }
    }
    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.0625, outputInterval: 2 } });
    return { document, ids: [...tankKeys.map((key) => tanks[key].stateIds.level), ...c.pipes.map((pipe) => pipes[pipe.key].stateIds.flow)] };
}

function square2(term) {
    return ['Power', term, 2];
}

export const models = { pipeNetwork: () => build().document };

// Pressures derived from a sample [h_upper, h_middle, h_sump, Q_pump, Q_valve, Q_return]: gauge at each tank's base and at the pump outlet.
export function pressures(sample) {
    const { density: rho, gravity: g, pump } = constants;
    const [hu, hm, hs, qp] = sample;
    const pumpRise = rho * g * pump.shutoffHead * (1 - qp * Math.abs(qp) / pump.ratedFlow ** 2);
    return [rho * g * hu, rho * g * hm, rho * g * hs, rho * g * hs + pumpRise];
}

const volume = (sample) => tankKeys.reduce((total, key, index) => total + constants.tanks[key].area * sample[index], 0);
const variantOf = (method) => (method === 'rungeKutta4' ? { method: 'rungeKutta4' } : { integration: 'explicit' });
const methodKey = (method) => (method === 'explicit' ? 'Explicit' : 'RungeKutta4');

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    if (!data) throw new Error('fluid/pipeNetwork needs its reference.json (generateReference.py).');
    const { ids } = build();
    const reference = data.states;
    const traces = {};
    for (const method of ['explicit', 'rungeKutta4']) {
        const steps = config.globalTimeSteps[method];
        const errors = [];
        for (const step of steps) {
            const run = engineRun(config.run, { globalTimeStep: step });
            const result = await engine.run(modelPath, variantOf(method), run);
            if (result.times.length !== reference.length) throw new Error('The network\'s samples do not match its reference.json.');
            const numeric = trajectory(result, ids);
            const levels = errorMetrics(numeric.map((sample) => sample.slice(0, 3)), reference.map((sample) => sample.slice(0, 3)));
            const flows = errorMetrics(numeric.map((sample) => sample.slice(3)), reference.map((sample) => sample.slice(3)));
            const pressure = errorMetrics(numeric.map(pressures), reference.map(pressures));
            const all = errorMetrics(numeric, reference);
            const initialVolume = volume(numeric[0]);
            const massDefect = Math.max(...numeric.map((sample) => Math.abs(volume(sample) - initialVolume))) / initialVolume;
            errors.push(all.relativeError);
            rows.push(resultRow({
                caseName: 'Levels and flows', model: 'pipeNetwork', variant: variantOf(method), run, errors: all, conservationError: massDefect, work: result.work, unit: 'm, m³/s',
                note: `relative to range: levels ${levels.relativeError.toExponential(2)}, flows ${flows.relativeError.toExponential(2)}, pressures ${pressure.relativeError.toExponential(2)} (largest ${pressure.maxAbsError.toExponential(2)} Pa); conservation = drift of the total volume / volume`
            }));
            if (step === config.run.globalTimeStep) {
                traces[method] = { result, numeric };
                add(`levelRelativeError${methodKey(method)}`, levels.relativeError, `Tank levels: largest error relative to range, ${methodName(variantOf(method))}, h = ${step} s`);
                add(`flowRelativeError${methodKey(method)}`, flows.relativeError, `Pipe flows: largest error relative to range, ${methodName(variantOf(method))}, h = ${step} s`);
                add(`pressureRelativeError${methodKey(method)}`, pressure.relativeError, `Pressures (tank bases and pump outlet): largest error relative to range, ${methodName(variantOf(method))}, h = ${step} s`);
                add(`massConservation${methodKey(method)}`, massDefect, `Total water volume Σ A h: largest drift relative to the volume, from Konjugate's own states, ${methodName(variantOf(method))}`);
            }
        }
        const order = observedOrder(steps, errors);
        rows.push(resultRow({ caseName: 'Error order in h', model: 'pipeNetwork', variant: variantOf(method), observedOrder: order.fitted, note: `pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
        add(`order${methodKey(method)}`, order.fitted, `Observed order of the error in h, ${methodName(variantOf(method))} (fitted over every h)`);
    }
    add('referenceSelfAgreement', referenceAgreement(data.radau, data.states), 'The reference (DOP853, rtol 1e-13) against Radau at rtol 1e-10, largest difference relative to each state\'s magnitude');

    const times = traces.explicit.result.times;
    const tankNames = tankKeys.map((key) => constants.tanks[key].name);
    plots.push(linePlot({
        id: 'pipeNetworkLevels', title: 'Fluid network: tank levels', subtitle: `SciPy DOP853 against Konjugate, h = ${config.run.globalTimeStep} s; the valve closes to 30 % at 300–305 s`, xLabel: 'Time (s)', yLabel: 'Level (m)',
        series: tankNames.flatMap((name, index) => [
            series(`Reference, ${name.toLowerCase()}`, 'reference', times, reference.map((sample) => sample[index])),
            series(`Konjugate, ${name.toLowerCase()}, explicit Euler`, ['explicit', 'semiImplicit', 'extra'][index], times, traces.explicit.numeric.map((sample) => sample[index]))
        ])
    }));
    plots.push(linePlot({
        id: 'pipeNetworkFlows', title: 'Fluid network: pipe flows', subtitle: `SciPy DOP853 against Konjugate, h = ${config.run.globalTimeStep} s`, xLabel: 'Time (s)', yLabel: 'Flow (m³/s)',
        series: constants.pipes.flatMap((pipe, index) => [
            series(`Reference, ${pipe.name.toLowerCase()}`, 'reference', times, reference.map((sample) => sample[3 + index])),
            series(`Konjugate, ${pipe.name.toLowerCase()}, explicit Euler`, ['explicit', 'semiImplicit', 'extra'][index], times, traces.explicit.numeric.map((sample) => sample[3 + index]))
        ])
    }));
    plots.push(linePlot({
        id: 'pipeNetworkPumpPressure', title: 'Fluid network: pump outlet pressure', subtitle: 'Gauge pressure, derived from the sump level and the pump flow', xLabel: 'Time (s)', yLabel: 'Pressure (kPa)',
        series: [
            series('Reference', 'reference', times, reference.map((sample) => pressures(sample)[3] / 1000)),
            series('Konjugate, explicit Euler', 'explicit', times, traces.explicit.numeric.map((sample) => pressures(sample)[3] / 1000)),
            series('Konjugate, Runge–Kutta 4', 'rungeKutta4', times, traces.rungeKutta4.numeric.map((sample) => pressures(sample)[3] / 1000))
        ]
    }));
    return { rows, checks, plots, notes: ['Every flow leaves one tank and enters another within the same step, so the network\'s total volume is kept to rounding under either method. The valve\'s kinks fall on step boundaries, so Runge–Kutta 4 keeps its order through them.'] };
}
