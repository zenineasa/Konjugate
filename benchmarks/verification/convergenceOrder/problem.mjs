/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Convergence order: the verification argument. For each problem with an exact solution, the error is measured at the same sample
// times while the global step is halved several times, and the observed order p in error ≈ C hᵖ is reported, from each halving and as
// the least-squares slope over all of them. Konjugate's methods are first order, explicit and semi-implicit Euler alike, so p ≈ 1 is
// the expected result; a different order would mean the engine is not integrating the equations it was given the way it says.
//
// Error here is the largest error over the run relative to each state's range (benchmarks/lib/metrics.mjs).

import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { createChecks, engineRun, linePlot, methodName, resultRow, series } from '../../lib/study.mjs';
import * as rcNetwork from '../../thermal/rcNetwork/problem.mjs';
import * as rlcCircuits from '../../electrical/rlcCircuits/problem.mjs';
import * as harmonicOscillator from '../../mechanical/harmonicOscillator/problem.mjs';
import * as pendulum from '../../mechanical/pendulum/problem.mjs';

export const directory = import.meta.dirname;

const cases = {
    thermal: rcNetwork.convergenceCase,
    seriesRlc: rlcCircuits.convergenceCases.find((entry) => entry.key === 'series'),
    coupledRlc: rlcCircuits.convergenceCases.find((entry) => entry.key === 'coupled'),
    oscillator: harmonicOscillator.convergenceCase,
    pendulum: pendulum.convergenceCase
};

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    for (const [key, settings] of Object.entries(config.cases)) {
        const study = cases[key];
        const stateIds = study.stateIds();
        const plotSeries = [];
        for (const integration of settings.methods) {
            const variant = { integration };
            const errors = [];
            for (const step of settings.globalTimeSteps) {
                const run = engineRun(settings, { globalTimeStep: step });
                const result = await engine.run(study.modelPath, variant, run);
                const metrics = errorMetrics(trajectory(result, stateIds), study.reference(result.times));
                errors.push(metrics.relativeError);
                rows.push(resultRow({ caseName: `${study.title}: convergence`, model: study.modelPath.split('/').at(-1).replace('.kjt', ''), variant, run, errors: metrics, work: result.work, unit: study.unit }));
            }
            const order = observedOrder(settings.globalTimeSteps, errors);
            rows.at(-1).observedOrder = order.fitted;
            rows.at(-1).note = `observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
            const method = integration === 'explicit' ? 'Explicit' : 'SemiImplicit';
            add(`${key}Order${method}`, order.fitted, `${study.title}, ${methodName(variant)}: observed order, least-squares over ${settings.globalTimeSteps.length} step sizes`);
            add(`${key}FinestOrder${method}`, order.finest, `${study.title}, ${methodName(variant)}: observed order from the finest halving`);
            plotSeries.push(series(`Konjugate, ${methodName(variant)}`, integration, settings.globalTimeSteps, errors));
            if (integration === settings.methods[0]) {
                plotSeries.push(series('First order (slope 1)', 'guide', settings.globalTimeSteps, settings.globalTimeSteps.map((step) => errors[0] * step / settings.globalTimeSteps[0])));
            }
        }
        plots.push(linePlot({
            id: `convergence${key[0].toUpperCase()}${key.slice(1)}`, title: `${study.title}: error against step size`, subtitle: `Largest error relative to range over ${settings.targetTime} s`,
            xLabel: 'Global step h (s)', yLabel: 'Relative error', logX: true, logY: true, xTicks: settings.globalTimeSteps, series: plotSeries
        }));
    }
    return { rows, checks, plots, notes: ['The thermal network is shown for explicit Euler only: every node holds one state, so semi-implicit integration gives the same numbers (checked in thermal/rcNetwork).'] };
}
