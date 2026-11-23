/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Van der Pol oscillator, from x = 2, y = 0, one node:
//     dx/dt = y        dy/dt = μ (1 - x²) y - x
// Every solution is drawn onto one limit cycle. At μ = 1 it is a smooth, nearly sinusoidal oscillation; at μ = 10 a relaxation oscillation,
// a slow drift along the cycle's flanks broken by fast jumps lasting a time of order 1/μ; at μ = 1000 the system is stiff: an explicit
// method's step is bounded by stability (h < about 2/(3μ) on the slow flanks) rather than accuracy, about 2.4 million steps a period.
//
// mu1.kjt, mu10.kjt and mu1000.kjt are the same node with μ = 1, 10, 1000. μ = 1000 waits for Konjugate's stiff method (Rodas4,
// docs/proposals/integrators.md); its model and reference are committed so that the stiff method is benchmarked by adding it to the case's
// methods in benchmark.json.
//
// Reported, for each method in a case's methods (a variant and its global step): the trajectory's error against the reference over a few
// cycles; the limit cycle's period and amplitude, measured after a long transient from Konjugate's own samples, against the reference's;
// the phase portrait; and the observed order over halvings of the step.
//
// Reference (reference.json): SciPy solve_ivp, Radau with the exact Jacobian at rtol = atol = 1e-12, checked against DOP853 at the same
// tolerances for μ = 1 and 10; the period and amplitude by event location on the same solutions.

import { join } from 'node:path';
import { trajectory } from '../../lib/engine.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { createModel, difference, parameter, product, state } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const start = Object.freeze({ x: 2, y: 0 });
export const mus = Object.freeze({ mu1: 1, mu10: 10, mu1000: 1000 });
const modelPath = (key) => join(directory, `${key}.kjt`);

export function build(mu) {
    const model = createModel(`Benchmark: Van der Pol oscillator, μ = ${mu}`);
    const oscillator = model.node('Oscillator', { type: 'Van der Pol oscillator', color: '#7a5d85', states: [
        ['x', 'Displacement', start.x, ''],
        ['y', 'Velocity', start.y, '1/s']
    ] });
    model.sourceTerm(oscillator, 'x', 'y', { y: state(oscillator, 'y') });
    model.sourceTerm(oscillator, 'y', difference(product('mu', difference(1, ['Power', 'x', 2]), 'y'), 'x'), {
        mu: parameter('Damping', mu, '1/s'), x: state(oscillator, 'x'), y: state(oscillator, 'y')
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -10, outputInterval: 2 ** -4 } }), ids: [oscillator.stateIds.x, oscillator.stateIds.y] };
}

export const models = Object.fromEntries(Object.entries(mus).map(([key, mu]) => [key, () => build(mu).document]));

// A method's name in a check: Explicit, SemiImplicit, RungeKutta4, and so for any method added later.
const methodKey = (variant) => {
    const name = variant.method ?? variant.integration ?? 'explicit';
    return `${name[0].toUpperCase()}${name.slice(1)}`;
};
const stepLabel = (step) => `h = 2^${Math.log2(step)} s`;

// The cubic Hermite interpolant on [t0, t1] through values v0, v1 with slopes d0, d1, at the fraction s of the interval.
function hermite(v0, v1, d0, d1, width, s) {
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * width * d0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * width * d1;
}

function rootOf(f) {
    let low = 0;
    let high = 1;
    const sign = Math.sign(f(low));
    for (let iteration = 0; iteration < 80; ++iteration) {
        const middle = (low + high) / 2;
        if (Math.sign(f(middle)) === sign) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}

// The limit cycle's period and amplitude from a run's samples, as the reference finds them: the period from the last three intervals
// between upward zero crossings of x, the amplitude from the last three maxima of x (where y falls through zero). Between samples, x and y
// are the cubic Hermite interpolants with their exact slopes, dx/dt = y and dy/dt = μ (1 - x²) y - x, from the samples themselves.
export function limitCycle(times, samples, mu) {
    const slopeOfY = ([x, y]) => mu * (1 - x * x) * y - x;
    const crossings = [];
    const peaks = [];
    for (let k = 0; k + 1 < samples.length; ++k) {
        const [x0, y0] = samples[k];
        const [x1, y1] = samples[k + 1];
        const width = times[k + 1] - times[k];
        if (x0 < 0 && x1 >= 0) crossings.push(times[k] + width * rootOf((s) => hermite(x0, x1, y0, y1, width, s)));
        if (y0 > 0 && y1 <= 0) {
            const s = rootOf((fraction) => hermite(y0, y1, slopeOfY(samples[k]), slopeOfY(samples[k + 1]), width, fraction));
            peaks.push(hermite(x0, x1, y0, y1, width, s));
        }
    }
    if (crossings.length < 4 || peaks.length < 3) return { period: NaN, amplitude: NaN };
    const last = crossings.slice(-4);
    return { period: (last[3] - last[0]) / 3, amplitude: peaks.slice(-3).reduce((sum, value) => sum + value, 0) / 3 };
}

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const data = referenceData(directory);
    const ids = build(1).ids;
    for (const [key, settings] of Object.entries(config.cases)) {
        const mu = mus[key];
        const exact = data?.cases[key];
        const title = `Van der Pol, μ = ${mu}`;
        if (settings.pending) {
            rows.push({ ...resultRow({ caseName: `${title}: trajectory and limit cycle`, model: key, run: engineRun(settings.run), unit: '', note: settings.pending }), method: settings.pendingMethod });
            notes.push(`μ = ${mu}: ${settings.pending}${exact ? ` The reference is ready: period ${exact.limitCycle.period.toFixed(4)} s, amplitude ${exact.limitCycle.amplitude.toFixed(6)} (Radau, rtol = atol = 1e-12).` : ''}`);
            continue;
        }
        const run = engineRun(settings.run);
        const cycleRun = engineRun(settings.cycleRun);
        const portrait = [];
        const timeSeries = [];
        for (const { variant, globalTimeStep } of settings.methods) {
            const method = methodKey(variant);
            const result = await engine.run(modelPath(key), variant, { ...run, globalTimeStep });
            const numeric = trajectory(result, ids);
            const errors = errorMetrics(numeric, exact.states);
            const cycleResult = await engine.run(modelPath(key), variant, { ...cycleRun, globalTimeStep });
            const cycle = limitCycle(cycleResult.times, trajectory(cycleResult, ids), mu);
            const periodError = Math.abs(cycle.period - exact.limitCycle.period) / exact.limitCycle.period;
            const amplitudeError = Math.abs(cycle.amplitude - exact.limitCycle.amplitude) / exact.limitCycle.amplitude;
            rows.push(resultRow({ caseName: `${title}: trajectory`, model: key, variant, run: { ...run, globalTimeStep }, errors, work: result.work, unit: 'x, y = dx/dt',
                note: `errors against SciPy Radau over ${run.targetTime} s` }));
            rows.push(resultRow({ caseName: `${title}: limit cycle`, model: key, variant, run: { ...cycleRun, globalTimeStep }, work: cycleResult.work, unit: 'relative',
                errors: { relativeError: Math.max(periodError, amplitudeError) },
                note: `period ${cycle.period.toFixed(6)} s (reference ${exact.limitCycle.period.toFixed(6)} s, error ${periodError.toExponential(2)}); amplitude ${cycle.amplitude.toFixed(6)} (reference ${exact.limitCycle.amplitude.toFixed(6)}, error ${amplitudeError.toExponential(2)})` }));
            add(`${key}RelativeError${method}`, errors.relativeError, `${title}: largest error relative to range over ${run.targetTime} s, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
            add(`${key}PeriodError${method}`, periodError, `${title}: limit-cycle period, relative error, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
            add(`${key}AmplitudeError${method}`, amplitudeError, `${title}: limit-cycle amplitude, relative error, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
            const role = variant.method ?? variant.integration;
            portrait.push(series(`Konjugate, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`, role, numeric.map((sample) => sample[0]), numeric.map((sample) => sample[1])));
            timeSeries.push(series(`Konjugate, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`, role, result.times, numeric.map((sample) => sample[0])));
        }
        plots.push(linePlot({
            id: `vanDerPol${key.slice(2)}Phase`, title: `${title}: phase portrait`, subtitle: `y = dx/dt against x over ${run.targetTime} s, from (2, 0)`, xLabel: 'x', yLabel: 'y = dx/dt',
            series: [series('SciPy Radau reference', 'reference', exact.states.map((sample) => sample[0]), exact.states.map((sample) => sample[1])), ...portrait]
        }));
        plots.push(linePlot({
            id: `vanDerPol${key.slice(2)}Trajectory`, title: `${title}: x against time`, subtitle: `Reference against Konjugate over ${run.targetTime} s`, xLabel: 'Time (s)', yLabel: 'x',
            series: [series('SciPy Radau reference', 'reference', exact.times, exact.states.map((sample) => sample[0])), ...timeSeries]
        }));

        // Observed order over halvings of the step, against the reference at the same samples.
        const convergence = settings.convergence;
        const convergenceRun = engineRun(convergence);
        const reference = exact.states.slice(0, Math.round(convergence.targetTime / convergence.outputInterval) + 1);
        const orderSeries = [];
        for (const { variant, globalTimeSteps } of convergence.methods) {
            const method = methodKey(variant);
            const errors = [];
            for (const step of globalTimeSteps) {
                const result = await engine.run(modelPath(key), variant, { ...convergenceRun, globalTimeStep: step });
                const metrics = errorMetrics(trajectory(result, ids), reference);
                errors.push(metrics.relativeError);
                rows.push(resultRow({ caseName: `${title}: convergence`, model: key, variant, run: { ...convergenceRun, globalTimeStep: step }, errors: metrics, work: result.work, unit: 'x, y = dx/dt' }));
            }
            const order = observedOrder(globalTimeSteps, errors);
            rows.at(-1).observedOrder = order.fitted;
            rows.at(-1).note = `observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
            add(`${key}Order${method}`, order.fitted, `${title}, ${methodName(variant)}: observed order, least-squares over ${globalTimeSteps.length} step sizes, ${convergence.targetTime} s`);
            add(`${key}FinestOrder${method}`, order.finest, `${title}, ${methodName(variant)}: observed order from the finest halving`);
            orderSeries.push(series(`Konjugate, ${methodName(variant)}`, variant.method ?? variant.integration, globalTimeSteps, errors));
        }
        const steps = [...new Set(convergence.methods.flatMap((entry) => entry.globalTimeSteps))].sort((left, right) => right - left);
        plots.push(linePlot({
            id: `vanDerPol${key.slice(2)}Convergence`, title: `${title}: error against step size`, subtitle: `Largest error relative to range over ${convergence.targetTime} s`,
            xLabel: 'Global step h (s)', yLabel: 'Relative error', logX: true, logY: true, xTicks: steps, series: orderSeries
        }));

        if (exact.dop853States) {
            add(`${key}ReferenceAgreement`, referenceAgreement(exact.states, exact.dop853States), `${title}: the Radau reference against DOP853 at the same tolerances, relative to each column's magnitude`);
            add(`${key}ReferencePeriodAgreement`, Math.abs(exact.limitCycle.period - exact.dop853LimitCycle.period) / exact.limitCycle.period, `${title}: the reference period, Radau against DOP853, relative`);
        }
    }
    return { rows, checks, plots, notes };
}
