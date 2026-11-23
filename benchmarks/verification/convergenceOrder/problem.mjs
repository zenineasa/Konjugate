/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Convergence order: the verification argument. For each problem with an exact solution, the error is measured at the same sample
// times while the global step is halved several times, and the observed order p in error ≈ C hᵖ is reported, from each halving and as
// the least-squares slope over all of them. Explicit and semi-implicit Euler are first order, so p ≈ 1 is expected of them; Runge–Kutta
// 4, the whole model at once (docs/proposals/integrators.md), is fourth order, judged over halvings of its own (rungeKutta4GlobalSteps)
// chosen where its error is still well above rounding and its step inside its stability region; Dormand–Prince 5(4) with its error
// control off (one fixed step a global step) is fifth order, over halvings of its own (dormandPrince54GlobalSteps). A different order
// would mean the engine is not integrating the equations it was given the way it says.
//
// Adaptive (Dormand–Prince 5(4) with its error control) is judged by tolerance proportionality instead: over relative tolerances from
// 1e-3 to 1e-10 (each absolute tolerance a thousandth of it), with a global step a sixteenth of the run so the global step does not
// bind, the error falls in proportion to the tolerance (the least-squares slope of log error against log tolerance near 1; a little
// under 1 is Dormand–Prince's known behaviour, its error estimate being of order four) and stays within a stated factor of it. Each
// run's work -- steps taken and rejected, evaluations of the model -- is in its row, and each problem has a work-precision plot:
// every method's contributions evaluated against the error it reached.
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
        // Every method's work against its error, for the work-precision plot.
        const workSeries = [];
        for (const integration of settings.methods) {
            const rungeKutta4 = integration === 'rungeKutta4';
            const dormandPrince = integration === 'dormandPrince54';
            const variant = rungeKutta4 ? { method: 'rungeKutta4' } : dormandPrince ? { method: 'dormandPrince54', stepsPerGlobalStep: 1 } : { integration };
            const steps = rungeKutta4 ? settings.rungeKutta4GlobalSteps : dormandPrince ? settings.dormandPrince54GlobalSteps : settings.globalTimeSteps;
            const errors = [];
            const evaluations = [];
            for (const step of steps) {
                const run = engineRun(settings, { globalTimeStep: step });
                const result = await engine.run(study.modelPath, variant, run);
                const metrics = errorMetrics(trajectory(result, stateIds), study.reference(result.times));
                errors.push(metrics.relativeError);
                evaluations.push(result.work.evaluations);
                rows.push(resultRow({ caseName: `${study.title}: convergence`, model: study.modelPath.split('/').at(-1).replace('.kjt', ''), variant, run, errors: metrics, work: result.work, unit: study.unit }));
            }
            const order = observedOrder(steps, errors);
            rows.at(-1).observedOrder = order.fitted;
            rows.at(-1).note = `observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
            const method = { explicit: 'Explicit', semiImplicit: 'SemiImplicit', rungeKutta4: 'RungeKutta4', dormandPrince54: 'DormandPrince54' }[integration];
            add(`${key}Order${method}`, order.fitted, `${study.title}, ${methodName(variant)}: observed order, least-squares over ${steps.length} step sizes`);
            add(`${key}FinestOrder${method}`, order.finest, `${study.title}, ${methodName(variant)}: observed order from the finest halving`);
            plotSeries.push(series(`Konjugate, ${methodName(variant)}`, integration, steps, errors));
            if (rungeKutta4) plotSeries.push(series('Fourth order (slope 4)', 'guide', steps, steps.map((step) => errors[0] * (step / steps[0]) ** 4)));
            if (dormandPrince) plotSeries.push(series('Fifth order (slope 5)', 'guide', steps, steps.map((step) => errors[0] * (step / steps[0]) ** 5)));
            workSeries.push(series(`Konjugate, ${methodName(variant)}`, integration, errors, evaluations));
            if (integration === settings.methods[0]) {
                plotSeries.push(series('First order (slope 1)', 'guide', settings.globalTimeSteps, settings.globalTimeSteps.map((step) => errors[0] * step / settings.globalTimeSteps[0])));
            }
        }
        plots.push(linePlot({
            id: `convergence${key[0].toUpperCase()}${key.slice(1)}`, title: `${study.title}: error against step size`, subtitle: `Largest error relative to range over ${settings.targetTime} s`,
            xLabel: 'Global step h (s)', yLabel: 'Relative error', logX: true, logY: true,
            xTicks: [...new Set([...settings.globalTimeSteps, ...(settings.rungeKutta4GlobalSteps ?? []), ...(settings.dormandPrince54GlobalSteps ?? [])])].sort((left, right) => right - left), series: plotSeries
        }));

        // Adaptive: the error against the tolerance, with the work it took.
        const tolerance = config.toleranceStudy;
        const adaptiveRun = engineRun(settings, { globalTimeStep: settings.targetTime / tolerance.globalStepsPerRun, outputInterval: settings.targetTime / tolerance.globalStepsPerRun });
        const adaptiveErrors = [];
        const adaptiveEvaluations = [];
        for (const relative of tolerance.relativeTolerances) {
            const variant = { method: 'dormandPrince54', tolerance: { relative, absolute: relative * tolerance.absoluteFraction } };
            const result = await engine.run(study.modelPath, variant, adaptiveRun);
            const metrics = errorMetrics(trajectory(result, stateIds), study.reference(result.times));
            adaptiveErrors.push(metrics.relativeError);
            adaptiveEvaluations.push(result.work.evaluations);
            rows.push(resultRow({
                caseName: `${study.title}: tolerance`, model: study.modelPath.split('/').at(-1).replace('.kjt', ''), variant, run: adaptiveRun, errors: metrics, work: result.work, unit: study.unit,
                note: `${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected, ${result.work.modelEvaluations} evaluations of the model; error ${(metrics.relativeError / relative).toFixed(2)} times the tolerance`
            }));
        }
        // The slope of log error against log tolerance, least squares: observedOrder fits log error against log step, the same fit.
        const proportionality = observedOrder(tolerance.relativeTolerances, adaptiveErrors);
        rows.at(-1).note += `; error against tolerance: fitted slope ${proportionality.fitted.toFixed(3)}`;
        add(`${key}ToleranceSlope`, proportionality.fitted, `${study.title}, Adaptive: slope of log error against log tolerance, least squares over ${tolerance.relativeTolerances.length} tolerances from ${tolerance.relativeTolerances[0]} to ${tolerance.relativeTolerances.at(-1)}`);
        add(`${key}ToleranceFactor`, Math.max(...adaptiveErrors.map((error, index) => error / tolerance.relativeTolerances[index])), `${study.title}, Adaptive: largest error over its relative tolerance`);
        workSeries.push(series('Konjugate, Adaptive, Dormand–Prince 5(4) (tolerances)', 'extra', adaptiveErrors, adaptiveEvaluations));
        plots.push(linePlot({
            id: `workPrecision${key[0].toUpperCase()}${key.slice(1)}`, title: `${study.title}: work against precision`,
            subtitle: 'Contributions evaluated against the largest error relative to range; lower and further left is better', xLabel: 'Relative error', yLabel: 'Contributions evaluated',
            logX: true, logY: true, series: workSeries.map((entry) => ({ ...entry, points: [...entry.points].sort((left, right) => right[0] - left[0]) }))
        }));
    }
    return { rows, checks, plots, notes: [
        'The thermal network is shown for explicit Euler only: every node holds one state, so semi-implicit integration gives the same numbers (checked in thermal/rcNetwork).',
        'Dormand–Prince 5(4) at fixed steps is not judged on the thermal network: its error passes from steps too long to show the order straight to the reference\'s own rounding (about 3e-12 relative), with no halving clean of both between; it is judged there by tolerance only.'
    ] };
}
