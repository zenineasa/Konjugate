/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The evaluation shared by the conservative mechanical problems (a one-node system of a position and a velocity with an exact solution
// and an energy that should stay constant): the trajectory error over a short run, and the energy over a long one, for explicit Euler
// for semi-implicit (symplectic) Euler and for Verlet. Explicit Euler lets an undamped oscillation's energy grow every step; symplectic
// Euler keeps it within a band of width O(h) for as long as the run lasts, and Verlet, symplectic and second order, within one of O(h²).

import { trajectory } from './engine.mjs';
import { conservationDrift } from './metrics.mjs';
import { engineRun, linePlot, methodName, resultRow, runAndCompare, series } from './study.mjs';

export async function evaluateConservative({ engine, config, add, modelPath, modelName, stateIds, reference, energy, energyScale, title, unit, plotPrefix, plotUnits }) {
    const rows = [];
    const plots = [];
    const short = {};
    const long = {};
    for (const variant of [{ integration: 'explicit' }, { integration: 'semiImplicit' }, { integration: 'verlet' }]) {
        const method = { explicit: 'Explicit', semiImplicit: 'SemiImplicit', verlet: 'Verlet' }[variant.integration];
        const run = engineRun(config.accuracy);
        const comparison = await runAndCompare(engine, modelPath, variant, run, stateIds, reference);
        const shortEnergy = conservationDrift(comparison.numeric.map(energy), energyScale);
        rows.push(resultRow({ caseName: `${title}: trajectory`, model: modelName, variant, run, errors: comparison, conservationError: shortEnergy.maxRelativeDrift, work: comparison.result.work, unit,
            note: 'conservation = largest relative energy drift' }));
        add(`relativeError${method}`, comparison.relativeError, `Largest state error relative to its range over ${run.targetTime} s, ${methodName(variant)}, h = 2^${Math.log2(run.globalTimeStep)} s`);
        short[variant.integration] = comparison;

        const longRun = engineRun(config.longRun);
        const result = await engine.run(modelPath, variant, longRun);
        const energies = trajectory(result, stateIds).map(energy);
        const drift = conservationDrift(energies, energyScale);
        rows.push(resultRow({ caseName: `${title}: long-run energy`, model: modelName, variant, run: longRun, conservationError: drift.maxRelativeDrift, work: result.work, unit: 'J',
            note: `final relative energy change ${drift.finalRelativeDrift.toExponential(2)}` }));
        add(`energyDrift${method}`, drift.maxRelativeDrift, `Largest relative energy drift over ${longRun.targetTime} s, ${methodName(variant)}, h = 2^${Math.log2(longRun.globalTimeStep)} s`);
        // The largest drift so far: an oscillating energy's drift passes through zero twice a period, which on a log scale is noise.
        let largest = 0;
        long[variant.integration] = { times: result.times, drift: energies.map((value) => (largest = Math.max(largest, Math.abs(value - energies[0]) / energyScale))) };
    }
    const times = short.explicit.result.times;
    plots.push(linePlot({
        id: `${plotPrefix}Trajectory`, title: `${title}: ${plotUnits.stateName}`, subtitle: `Exact solution against Konjugate, h = 2^${Math.log2(config.accuracy.globalTimeStep)} s`,
        xLabel: 'Time (s)', yLabel: plotUnits.stateAxis,
        series: [
            series('Exact', 'reference', times, short.explicit.exact.map((sample) => sample[0])),
            series('Konjugate, explicit Euler', 'explicit', times, short.explicit.numeric.map((sample) => sample[0])),
            series('Konjugate, semi-implicit Euler', 'semiImplicit', times, short.semiImplicit.numeric.map((sample) => sample[0])),
            series('Konjugate, Verlet', 'verlet', times, short.verlet.numeric.map((sample) => sample[0]))
        ]
    }));
    // Log scale: the first sample's drift is exactly zero, so the plot starts from the second.
    plots.push(linePlot({
        id: `${plotPrefix}Energy`, title: `${title}: energy drift over a long run`, subtitle: `Largest |E - E(0)| / ${plotUnits.energyScaleName} up to each time, h = 2^${Math.log2(config.longRun.globalTimeStep)} s`,
        xLabel: 'Time (s)', yLabel: 'Largest relative energy drift so far', logY: true,
        series: ['explicit', 'semiImplicit', 'verlet'].map((integration) => series(`Konjugate, ${methodName({ integration })}`, integration, long[integration].times.slice(1), long[integration].drift.slice(1)))
    }));
    return { rows, plots };
}
