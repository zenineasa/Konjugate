/* Copyright © 2026 Zenin Easa Panthakkalakath */

// RLC circuits driven by a 10 V DC step from rest.
//
// Series RLC (seriesRlc.kjt): one node for the circuit, one for the source.
//     L di/dt = V_s - R i - v_C        C dv_C/dt = i
// Coupled pair (coupledRlc.kjt): the driven loop and a second, undriven loop, each its own node, their capacitors joined by a coupling
// resistor R_c, so each loop reads the other's capacitor voltage through the snapshot:
//     L1 di1/dt = V_s - R1 i1 - v1     C1 dv1/dt = i1 + (v2 - v1)/R_c
//     L2 di2/dt = -R2 i2 - v2          C2 dv2/dt = i2 + (v1 - v2)/R_c
//
// Each loop also integrates the charge the source delivers, dq/dt = i (loop 1), and the energy its resistors dissipate, dE/dt = R i²
// (half the coupling resistor's (v1 - v2)²/R_c to each loop). The node lists the current before the capacitor voltage, so a
// semi-implicit node updates the voltage from the new current (symplectic Euler for the LC part).
//
// Reference: linear with constant forcing, so x = [i, v, q] (and [i1, v1, q1, i2, v2]) is exact by the matrix exponential. The energy
// dissipated follows exactly from the energy balance: E(t) = V_s q(t) - (½ L i² + ½ C v²)(t), summed over the loops.

import { join } from 'node:path';
import { affineSolution } from '../../lib/linearAlgebra.mjs';
import { conservationDrift } from '../../lib/metrics.mjs';
import { createModel, difference, negate, parameter, product, quotient, square, state, sum } from '../../lib/project.mjs';
import { createChecks, engineRun, referenceAgreement, linePlot, methodName, referenceData, resultRow, runAndCompare, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const seriesModelPath = join(directory, 'seriesRlc.kjt');
export const coupledModelPath = join(directory, 'coupledRlc.kjt');

export const constants = Object.freeze({
    sourceVoltage: 10,
    series: { resistance: 2, inductance: 10e-3, capacitance: 100e-6 },
    coupled: {
        first: { resistance: 2, inductance: 10e-3, capacitance: 100e-6 },
        second: { resistance: 1, inductance: 20e-3, capacitance: 50e-6 },
        couplingResistance: 20
    }
});

const loopStates = (withCharge) => [
    ['current', 'Inductor current', 0, 'A'],
    ['voltage', 'Capacitor voltage', 0, 'V'],
    ...(withCharge ? [['charge', 'Charge delivered', 0, 'C']] : []),
    ['dissipated', 'Energy dissipated', 0, 'J']
];

function addLoop(model, loop, { resistance, inductance, capacitance }, withCharge) {
    const R = parameter('Resistance', resistance, 'Ω');
    model.sourceTerm(loop, 'current', quotient(negate(sum(product('resistance', 'current'), 'voltage')), 'inductance'), {
        resistance: R, current: state(loop, 'current'), voltage: state(loop, 'voltage'), inductance: parameter('Inductance', inductance, 'H')
    });
    model.sourceTerm(loop, 'voltage', quotient('current', 'capacitance'), { current: state(loop, 'current'), capacitance: parameter('Capacitance', capacitance, 'F') });
    if (withCharge) model.sourceTerm(loop, 'charge', 'current', { current: state(loop, 'current') });
    model.sourceTerm(loop, 'dissipated', product('resistance', square('current')), { resistance: parameter('Resistance', resistance, 'Ω'), current: state(loop, 'current') });
}

function addSource(model, loop, inductance) {
    const source = model.node('DC source', { type: 'Voltage source', position: [-3, 0, 0], color: '#d98b54', shape: 'sphere', states: [['voltage', 'Voltage', constants.sourceVoltage, 'V']] });
    model.edge('Source voltage', source, loop, 'current', quotient('sourceVoltage', 'inductance'), {
        sourceVoltage: state(source, 'voltage'), inductance: parameter('Inductance', inductance, 'H')
    }, { color: '#d98b54' });
}

export function buildSeries() {
    const model = createModel('Benchmark: series RLC circuit');
    const loop = model.node('Series RLC', { type: 'RLC circuit', color: '#3f6fb0', states: loopStates(true) });
    addLoop(model, loop, constants.series, true);
    addSource(model, loop, constants.series.inductance);
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -16, outputInterval: 2 ** -11 } }), loop };
}

export function buildCoupled() {
    const model = createModel('Benchmark: coupled RLC circuits');
    const { first, second, couplingResistance } = constants.coupled;
    const loop1 = model.node('Driven loop', { type: 'RLC circuit', color: '#3f6fb0', states: loopStates(true) });
    const loop2 = model.node('Coupled loop', { type: 'RLC circuit', position: [3, 0, 0], color: '#3f6fb0', states: loopStates(false) });
    addLoop(model, loop1, first, true);
    addLoop(model, loop2, second, false);
    addSource(model, loop1, first.inductance);
    for (const [from, to, capacitance] of [[loop2, loop1, first.capacitance], [loop1, loop2, second.capacitance]]) {
        model.edge(`Coupling current into ${to.document.name.toLowerCase()}`, from, to, 'voltage',
            quotient(difference('otherVoltage', 'ownVoltage'), product('couplingResistance', 'capacitance')), {
                otherVoltage: state(from, 'voltage'), ownVoltage: state(to, 'voltage'),
                couplingResistance: parameter('Coupling resistance', couplingResistance, 'Ω'), capacitance: parameter('Capacitance', capacitance, 'F')
            });
        model.edge(`Coupling resistor loss, half to ${to.document.name.toLowerCase()}`, from, to, 'dissipated',
            quotient(square(difference('otherVoltage', 'ownVoltage')), product(2, 'couplingResistance')), {
                otherVoltage: state(from, 'voltage'), ownVoltage: state(to, 'voltage'),
                couplingResistance: parameter('Coupling resistance', couplingResistance, 'Ω')
            });
    }
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -16, outputInterval: 2 ** -11 } }), loop1, loop2 };
}

export const models = { seriesRlc: () => buildSeries().document, coupledRlc: () => buildCoupled().document };

// The exact [i, v, q] of the series circuit, and the energy dissipated by each time.
export function seriesReference(times) {
    const { resistance: R, inductance: L, capacitance: C } = constants.series;
    const V = constants.sourceVoltage;
    return affineSolution([[-R / L, -1 / L, 0], [1 / C, 0, 0], [1, 0, 0]], [V / L, 0, 0], [0, 0, 0], times)
        .map(([i, v, q]) => ({ states: [i, v], charge: q, dissipated: V * q - 0.5 * L * i * i - 0.5 * C * v * v }));
}

// The exact [i1, v1, q1, i2, v2] of the coupled pair, and the energy dissipated by each time.
export function coupledReference(times) {
    const { first: a, second: b, couplingResistance: Rc } = constants.coupled;
    const V = constants.sourceVoltage;
    const matrix = [
        [-a.resistance / a.inductance, -1 / a.inductance, 0, 0, 0],
        [1 / a.capacitance, -1 / (Rc * a.capacitance), 0, 0, 1 / (Rc * a.capacitance)],
        [1, 0, 0, 0, 0],
        [0, 0, 0, -b.resistance / b.inductance, -1 / b.inductance],
        [0, 1 / (Rc * b.capacitance), 0, 1 / b.capacitance, -1 / (Rc * b.capacitance)]
    ];
    return affineSolution(matrix, [V / a.inductance, 0, 0, 0, 0], [0, 0, 0, 0, 0], times).map(([i1, v1, q1, i2, v2]) => ({
        states: [i1, v1, i2, v2], charge: q1,
        dissipated: V * q1 - 0.5 * (a.inductance * i1 * i1 + a.capacitance * v1 * v1 + b.inductance * i2 * i2 + b.capacitance * v2 * v2)
    }));
}

const circuits = {
    series: {
        title: 'Series RLC', modelPath: seriesModelPath, reference: seriesReference,
        ids: () => { const { loop } = buildSeries(); return { compared: [loop.stateIds.current, loop.stateIds.voltage], charge: loop.stateIds.charge, dissipated: [loop.stateIds.dissipated], loops: [{ ...constants.series, current: loop.stateIds.current, voltage: loop.stateIds.voltage }] }; }
    },
    coupled: {
        title: 'Coupled RLC pair', modelPath: coupledModelPath, reference: coupledReference,
        ids: () => {
            const { loop1, loop2 } = buildCoupled();
            return {
                compared: [loop1.stateIds.current, loop1.stateIds.voltage, loop2.stateIds.current, loop2.stateIds.voltage],
                charge: loop1.stateIds.charge,
                dissipated: [loop1.stateIds.dissipated, loop2.stateIds.dissipated],
                loops: [{ ...constants.coupled.first, current: loop1.stateIds.current, voltage: loop1.stateIds.voltage }, { ...constants.coupled.second, current: loop2.stateIds.current, voltage: loop2.stateIds.voltage }]
            };
        }
    }
};

export const convergenceCases = Object.entries(circuits).map(([key, circuit]) => ({
    key, title: circuit.title, modelPath: circuit.modelPath, stateIds: () => circuit.ids().compared,
    reference: (times) => circuit.reference(times).map((sample) => sample.states), unit: 'A, V'
}));

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    for (const [key, circuit] of Object.entries(circuits)) {
        const ids = circuit.ids();
        const run = engineRun(config.run);
        const coarse = engineRun(config.run, { globalTimeStep: config.run.coarseGlobalTimeStep });
        const traces = {};
        for (const variant of [{ integration: 'explicit' }, { integration: 'semiImplicit' }]) {
            for (const [label, chosen] of [['fine', run], ['coarse', coarse]]) {
                const comparison = await runAndCompare(engine, circuit.modelPath, variant, chosen, ids.compared, (times) => circuit.reference(times).map((sample) => sample.states));
                const exact = circuit.reference(comparison.result.times);
                const values = comparison.result.values;
                const dissipated = comparison.result.times.map((_time, k) => ids.dissipated.reduce((total, stateId) => total + values.get(stateId)[k], 0));
                const finalExactDissipated = exact.at(-1).dissipated;
                const dissipatedError = Math.max(...dissipated.map((value, k) => Math.abs(value - exact[k].dissipated))) / finalExactDissipated;
                // The energy balance from Konjugate's own states: source work V q against energy stored plus energy dissipated.
                const balance = comparison.result.times.map((_time, k) => {
                    const stored = ids.loops.reduce((total, loop) => total + 0.5 * loop.inductance * values.get(loop.current)[k] ** 2 + 0.5 * loop.capacitance * values.get(loop.voltage)[k] ** 2, 0);
                    return constants.sourceVoltage * values.get(ids.charge)[k] - stored - dissipated[k];
                });
                const balanceDefect = conservationDrift(balance, constants.sourceVoltage * exact.at(-1).charge).maxRelativeDrift;
                rows.push(resultRow({
                    caseName: `${circuit.title}: currents and voltages`, model: key === 'series' ? 'seriesRlc' : 'coupledRlc', variant, run: chosen,
                    errors: comparison, conservationError: balanceDefect, work: comparison.result.work, unit: 'A, V',
                    note: `dissipated-energy error ${dissipatedError.toExponential(2)} of the total; conservation = energy-balance defect / source work`
                }));
                traces[`${variant.integration}:${label}`] = { comparison, dissipated, exact };
                if (label === 'fine') {
                    const method = variant.integration === 'explicit' ? 'Explicit' : 'SemiImplicit';
                    add(`${key}RelativeError${method}`, comparison.relativeError, `${circuit.title}: largest current/voltage error relative to range, ${methodName(variant)}, h = 2^${Math.log2(run.globalTimeStep)} s`);
                    add(`${key}DissipatedEnergyError${method}`, dissipatedError, `${circuit.title}: largest error in energy dissipated, relative to the exact total, ${methodName(variant)}`);
                    add(`${key}EnergyBalanceDefect${method}`, balanceDefect, `${circuit.title}: energy-balance defect V q - stored - dissipated from Konjugate's own states, relative to the source's work, ${methodName(variant)}`);
                }
            }
        }
        const independent = data?.cases[key];
        const agreement = independent ? referenceAgreement(circuit.reference(independent.times).map((sample) => [...sample.states, sample.dissipated]), independent.states) : NaN;
        add(`${key}ReferenceAgreement`, agreement, `${circuit.title}: this reference against SciPy's expm and energy balance (reference.json), largest difference relative to each column's magnitude`);

        const milliseconds = traces['explicit:coarse'].comparison.result.times.map((time) => time * 1000);
        plots.push(linePlot({
            id: `${key}RlcCurrent`, title: `${circuit.title}: inductor current${key === 'coupled' ? ' (driven loop)' : ''}`,
            subtitle: `Exact solution against Konjugate at h = 2^${Math.log2(coarse.globalTimeStep)} s`, xLabel: 'Time (ms)', yLabel: 'Current (A)',
            series: [
                series('Exact (matrix exponential)', 'reference', milliseconds, traces['explicit:coarse'].exact.map((sample) => sample.states[0])),
                series('Konjugate, explicit Euler', 'explicit', milliseconds, traces['explicit:coarse'].comparison.numeric.map((sample) => sample[0])),
                series('Konjugate, semi-implicit Euler', 'semiImplicit', milliseconds, traces['semiImplicit:coarse'].comparison.numeric.map((sample) => sample[0]))
            ]
        }));
        plots.push(linePlot({
            id: `${key}RlcDissipated`, title: `${circuit.title}: energy dissipated`,
            subtitle: `Exact (energy balance) against Konjugate's integrated R i², h = 2^${Math.log2(coarse.globalTimeStep)} s`, xLabel: 'Time (ms)', yLabel: 'Energy (J)',
            series: [
                series('Exact', 'reference', milliseconds, traces['explicit:coarse'].exact.map((sample) => sample.dissipated)),
                series('Konjugate, explicit Euler', 'explicit', milliseconds, traces['explicit:coarse'].dissipated),
                series('Konjugate, semi-implicit Euler', 'semiImplicit', milliseconds, traces['semiImplicit:coarse'].dissipated)
            ]
        }));
    }
    return { rows, checks, plots, notes: [] };
}
