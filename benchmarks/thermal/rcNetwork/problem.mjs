/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Thermal RC network: four lumped thermal masses joined by conductances, a constant heater on the first, and two of them losing heat to
// a fixed ambient temperature. Every mass is its own node; every conductance is a pair of relationships, one into each end, so each
// node's equation is
//
//     C_i dT_i/dt = Σ_j G_ij (T_j - T_i) + G_i,amb (T_amb - T_i) + P_i
//
// The ambient node also integrates the heat lost to it, dQ/dt = Σ_i G_i,amb (T_i - T_amb), so the run's energy balance can be checked
// from Konjugate's own states: Σ C_i (T_i(t) - T_i(0)) = P t - Q(t).
//
// Reference: the system is linear with constant forcing, so its exact solution is the matrix exponential of the augmented system
// (benchmarks/lib/linearAlgebra.mjs), solved in temperatures above ambient to keep it well scaled, and its steady state is the solution of A T* = -b. reference.json holds the same solution computed
// independently with scipy.linalg.expm, which the run checks against.

import { join } from 'node:path';
import { affineEquilibrium, affineSolution } from '../../lib/linearAlgebra.mjs';
import { createModel, difference, parameter, product, quotient, state } from '../../lib/project.mjs';
import { createChecks, engineRun, referenceAgreement, linePlot, referenceData, resultRow, runAndCompare, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'rcNetwork.kjt');

export const constants = Object.freeze({
    masses: [
        { key: 'A', name: 'Mass A (heated)', capacitance: 5.0e4, initial: 293.15 },
        { key: 'B', name: 'Mass B', capacitance: 2.0e4, initial: 295.15 },
        { key: 'C', name: 'Mass C', capacitance: 8.0e4, initial: 290.15 },
        { key: 'D', name: 'Mass D', capacitance: 3.0e4, initial: 300.15 }
    ],
    conductances: [['A', 'B', 20], ['B', 'C', 15], ['C', 'D', 10], ['A', 'C', 5]],
    ambientConductances: [['B', 4], ['D', 8]],
    ambientTemperature: 293.15,
    heaterPower: 500,
    heated: 'A'
});

export function build() {
    const model = createModel('Benchmark: thermal RC network');
    const masses = {};
    constants.masses.forEach((mass, index) => {
        masses[mass.key] = model.node(mass.name, { type: 'Lumped thermal mass', position: [index * 3, 0, 0], color: '#c16f55', states: [['temperature', 'Temperature', mass.initial, 'K']] });
    });
    const capacitance = (key) => parameter('Thermal capacitance', constants.masses.find((mass) => mass.key === key).capacitance, 'J/K');
    const heater = model.node('Heater', { type: 'Heat source', position: [0, 3, 0], color: '#d98b54', shape: 'sphere', states: [['power', 'Power', constants.heaterPower, 'W']] });
    const ambient = model.node('Ambient', { type: 'Temperature boundary', position: [4.5, -3, 0], color: '#52727a', states: [
        ['temperature', 'Temperature', constants.ambientTemperature, 'K'],
        ['heatLost', 'Heat lost to ambient', 0, 'J']
    ] });

    model.edge('Heater power', heater, masses.A, 'temperature', quotient('power', 'capacitance'), {
        power: state(heater, 'power'), capacitance: capacitance('A')
    }, { color: '#d98b54' });
    for (const [left, right, conductance] of constants.conductances) {
        for (const [from, to] of [[left, right], [right, left]]) {
            model.edge(`Conduction ${from} to ${to}`, masses[from], masses[to], 'temperature',
                quotient(product('conductance', difference('sourceTemperature', 'targetTemperature')), 'capacitance'), {
                    conductance: parameter('Conductance', conductance, 'W/K'),
                    sourceTemperature: state(masses[from], 'temperature'),
                    targetTemperature: state(masses[to], 'temperature'),
                    capacitance: capacitance(to)
                });
        }
    }
    for (const [key, conductance] of constants.ambientConductances) {
        model.edge(`Loss from ${key}`, ambient, masses[key], 'temperature',
            quotient(product('conductance', difference('ambientTemperature', 'targetTemperature')), 'capacitance'), {
                conductance: parameter('Conductance to ambient', conductance, 'W/K'),
                ambientTemperature: state(ambient, 'temperature'),
                targetTemperature: state(masses[key], 'temperature'),
                capacitance: capacitance(key)
            }, { color: '#73b9c2' });
        model.edge(`Heat lost from ${key}`, masses[key], ambient, 'heatLost',
            product('conductance', difference('massTemperature', 'ambientTemperature')), {
                conductance: parameter('Conductance to ambient', conductance, 'W/K'),
                massTemperature: state(masses[key], 'temperature'),
                ambientTemperature: state(ambient, 'temperature')
            }, { color: '#73b9c2' });
    }
    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 16, outputInterval: 256 } });
    return {
        document,
        ids: {
            temperatures: constants.masses.map((mass) => masses[mass.key].stateIds.temperature),
            heatLost: ambient.stateIds.heatLost
        }
    };
}

export const models = { rcNetwork: () => build().document };

// x' = A x + b with x = [T_A, T_B, T_C, T_D, Q].
export function linearSystem() {
    const keys = constants.masses.map((mass) => mass.key);
    const size = keys.length + 1;
    const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
    const forcing = new Array(size).fill(0);
    const index = (key) => keys.indexOf(key);
    constants.masses.forEach((mass, i) => { if (mass.key === constants.heated) forcing[i] += constants.heaterPower / mass.capacitance; });
    for (const [left, right, conductance] of constants.conductances) {
        for (const [from, to] of [[left, right], [right, left]]) {
            const capacitance = constants.masses[index(to)].capacitance;
            matrix[index(to)][index(from)] += conductance / capacitance;
            matrix[index(to)][index(to)] -= conductance / capacitance;
        }
    }
    for (const [key, conductance] of constants.ambientConductances) {
        const capacitance = constants.masses[index(key)].capacitance;
        matrix[index(key)][index(key)] -= conductance / capacitance;
        forcing[index(key)] += conductance * constants.ambientTemperature / capacitance;
        matrix[keys.length][index(key)] += conductance;
        forcing[keys.length] -= conductance * constants.ambientTemperature;
    }
    return { matrix, forcing, initial: [...constants.masses.map((mass) => mass.initial), 0] };
}

export function reference(times) {
    const { matrix, forcing, initial } = linearSystem();
    return affineSolution(matrix, forcing, initial, times, [...constants.masses.map(() => constants.ambientTemperature), 0]);
}

export function steadyState() {
    const { matrix, forcing } = linearSystem();
    const temperatures = constants.masses.length;
    return affineEquilibrium(matrix.slice(0, temperatures).map((row) => row.slice(0, temperatures)), forcing.slice(0, temperatures));
}

export const convergenceCase = {
    title: 'Thermal RC network',
    modelPath,
    stateIds: () => build().ids.temperatures,
    reference: (times) => reference(times).map((sample) => sample.slice(0, constants.masses.length)),
    unit: 'K'
};

export async function evaluate({ engine, config }) {
    const { ids } = build();
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const temperatureCount = ids.temperatures.length;
    const masses = constants.masses;

    // Transient: temperatures against the exact solution.
    const runs = {};
    for (const step of [config.transient.globalTimeStep, config.transient.coarseGlobalTimeStep]) {
        const run = engineRun(config.transient, { globalTimeStep: step });
        const comparison = await runAndCompare(engine, modelPath, {}, run, ids.temperatures, (times) => reference(times).map((sample) => sample.slice(0, temperatureCount)));
        runs[step] = comparison;
        // Energy balance from Konjugate's own states: Σ C_i ΔT_i - (P t - Q), relative to the heat supplied by the end of the run.
        const heatLost = comparison.result.values.get(ids.heatLost);
        const residuals = comparison.result.times.map((time, sample) => {
            const stored = masses.reduce((sum, mass, i) => sum + mass.capacitance * (comparison.numeric[sample][i] - mass.initial), 0);
            return Math.abs(stored - (constants.heaterPower * time - heatLost[sample]));
        });
        const energyBalance = Math.max(...residuals) / (constants.heaterPower * run.targetTime);
        rows.push(resultRow({ caseName: 'transient', model: 'rcNetwork', run, errors: comparison, conservationError: energyBalance, work: comparison.result.work, unit: 'K',
            note: 'conservation = energy-balance residual / heat supplied' }));
        if (step === config.transient.globalTimeStep) {
            add('transientRelativeError', comparison.relativeError, `Largest temperature error over the transient, relative to each mass's range (h = ${step} s)`);
            add('energyBalanceResidual', energyBalance, 'Energy balance from Konjugate\'s own states, Σ C ΔT against heat supplied minus heat lost, relative to heat supplied');
        }
    }

    // Steady state: a long run against the exact equilibrium A T* = -b.
    const equilibrium = steadyState();
    const longRun = await engine.run(modelPath, {}, engineRun(config.steadyState));
    const finalTemperatures = ids.temperatures.map((stateId) => longRun.values.get(stateId).at(-1));
    const steadyStateError = Math.max(...finalTemperatures.map((value, i) => Math.abs(value - equilibrium[i])));
    rows.push(resultRow({ caseName: 'steady state', model: 'rcNetwork', run: config.steadyState, steadyStateError, work: longRun.work, unit: 'K', note: 'final temperatures against A T* = -b' }));
    add('steadyStateError', steadyStateError, `Largest final-temperature error against the exact steady state after ${config.steadyState.targetTime} s`);

    // Every node here holds one state and reads the others through the snapshot, so semi-implicit integration has nothing to reorder.
    const semiImplicit = await engine.run(modelPath, { integration: 'semiImplicit' }, engineRun(config.transient));
    const explicitRun = runs[config.transient.globalTimeStep].result;
    const largestDifference = Math.max(...ids.temperatures.map((stateId) => Math.max(...semiImplicit.values.get(stateId).map((value, i) => Math.abs(value - explicitRun.values.get(stateId)[i])))));
    add('semiImplicitDifference', largestDifference, 'Semi-implicit against explicit integration: identical, since each node has one state and other nodes are read from the snapshot');

    // Independent reference: SciPy's expm at the same times.
    const independent = referenceData(directory)?.cases.transient;
    const agreement = independent ? referenceAgreement(reference(independent.times), independent.states) : NaN;
    add('referenceAgreement', agreement, 'This reference against SciPy\'s scipy.linalg.expm (reference.json), largest difference relative to each column\'s magnitude (temperatures and heat lost)');

    const fine = runs[config.transient.globalTimeStep];
    const coarse = runs[config.transient.coarseGlobalTimeStep];
    const hours = fine.result.times.map((time) => time / 3600);
    plots.push(linePlot({
        id: 'thermalHeatedMass', title: 'Heated mass A temperature', subtitle: 'Exact solution against explicit Euler at two global steps', xLabel: 'Time (h)', yLabel: 'Temperature (K)',
        series: [
            series('Exact (matrix exponential)', 'reference', hours, fine.exact.map((sample) => sample[0])),
            series(`Konjugate, h = ${config.transient.globalTimeStep} s`, 'explicit', hours, fine.numeric.map((sample) => sample[0])),
            series(`Konjugate, h = ${config.transient.coarseGlobalTimeStep} s`, 'extra', hours, coarse.numeric.map((sample) => sample[0]))
        ]
    }));
    plots.push(linePlot({
        id: 'thermalStepError', title: 'Heated mass A: error at two global steps', subtitle: '|Konjugate - exact|, explicit Euler; a quarter of the step gives about a quarter of the error', xLabel: 'Time (h)', yLabel: 'Absolute error (K)',
        series: [
            series(`h = ${config.transient.coarseGlobalTimeStep} s`, 'extra', hours, coarse.numeric.map((sample, k) => Math.abs(sample[0] - coarse.exact[k][0]))),
            series(`h = ${config.transient.globalTimeStep} s`, 'explicit', hours, fine.numeric.map((sample, k) => Math.abs(sample[0] - fine.exact[k][0])))
        ]
    }));
    plots.push(linePlot({
        id: 'thermalError', title: 'Temperature error over time', subtitle: `|Konjugate - exact| per mass, explicit Euler, h = ${config.transient.globalTimeStep} s`, xLabel: 'Time (h)', yLabel: 'Absolute error (K)',
        series: masses.map((mass, i) => series(mass.name, `slot${i + 1}`, hours, fine.numeric.map((sample, k) => Math.abs(sample[i] - fine.exact[k][i]))))
    }));
    return { rows, checks, plots, notes: [] };
}
