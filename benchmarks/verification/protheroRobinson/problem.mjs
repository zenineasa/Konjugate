/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Prothero and Robinson's test (Prothero and Robinson, 1974; Hairer and Wanner, Solving Ordinary Differential Equations II, IV.15):
//     dy/dt = λ (y - sin t) + cos t,   y(0) = 0,   exact y = sin t for every λ.
// With λ = -1e6 the problem is stiff: every solution is drawn onto sin t within a microsecond. The same model with λ = -1 is the control:
// not stiff, so a method shows its classical order.
//
// What it measures, honestly: Rodas4 at fixed steps is fourth order on the control. On the stiff problem it does not keep order four in
// h: its error is proportional to h / |λ| -- first order in h, and a hundred times smaller for a hundred times stiffer λ (λ = -1e4 beside
// λ = -1e6 shows it). The same numbers come with the exact Jacobian and df/dt in place of the finite differences (checked while building
// it), so this is the method's own behaviour on this problem, not its Jacobian's. Being stiffly accurate is what makes the error carry
// the factor 1 / |λ|: at the coarser steps it is far below the control's, at the finest the control's fourth order has caught up.
//
// Reported, for Rodas4 at fixed steps (its error control off): the error against sin t over halvings of the step and its observed order,
// at λ = -1e6, -1e4 and -1; the error's scaling with λ; and under Stiff and Adaptive at the same tolerance at λ = -1e6, the steps each
// takes.

import { join } from 'node:path';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { createModel, difference, parameter, product, state, sum, time } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const lambdas = Object.freeze({ stiff: -1e6, moderate: -1e4, control: -1 });
const modelPath = (key) => join(directory, `${key}.kjt`);

export function build(lambda) {
    const model = createModel(`Benchmark: Prothero–Robinson, λ = ${lambda}`);
    const node = model.node('Prothero–Robinson', { type: 'Test equation', color: '#6a7fa8', states: [['y', 'Value', 0, '']] });
    model.sourceTerm(node, 'y', sum(product('lambda', difference('y', ['Sin', 't'])), ['Cos', 't']), {
        lambda: parameter('Stiffness', lambda, '1/s'), y: state(node, 'y'), t: time
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.0625, outputInterval: 0.0625 } }), ids: [node.stateIds.y] };
}

export const models = Object.fromEntries(Object.entries(lambdas).map(([key, lambda]) => [key, () => build(lambda).document]));

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const ids = build(-1).ids;
    const orderSeries = [];
    const byCase = {};
    for (const [key, settings] of Object.entries(config.cases)) {
        const errors = [];
        for (const step of settings.globalTimeSteps) {
            const run = engineRun({ targetTime: config.targetTime, globalTimeStep: step, outputInterval: config.outputInterval });
            const variant = { method: 'rodas4', stepsPerGlobalStep: 1 };
            const result = await engine.run(modelPath(key), variant, run);
            const metrics = errorMetrics(trajectory(result, ids), result.times.map((value) => [Math.sin(value)]));
            errors.push(metrics.relativeError);
            rows.push(resultRow({ caseName: `Prothero–Robinson, λ = ${lambdas[key]}: convergence`, model: key, variant, run, errors: metrics, work: result.work, unit: '' }));
        }
        const order = observedOrder(settings.globalTimeSteps, errors);
        rows.at(-1).observedOrder = order.fitted;
        rows.at(-1).note = `observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
        const label = key[0].toUpperCase() + key.slice(1);
        add(`order${label}`, order.fitted, `Prothero–Robinson, λ = ${lambdas[key]}, Rodas4 at fixed steps: observed order, least squares over ${settings.globalTimeSteps.length} steps`);
        add(`error${label}`, Math.max(...errors), `Prothero–Robinson, λ = ${lambdas[key]}, Rodas4 at fixed steps: the largest error relative to range, at the coarsest step`);
        orderSeries.push(series(`Konjugate, Rodas4 at fixed steps, λ = ${lambdas[key]}`, { stiff: 'rodas4', moderate: 'semiImplicit', control: 'reference' }[key], settings.globalTimeSteps, errors));
        byCase[key] = errors;
    }
    // The error's scaling with the stiffness: a hundred times stiffer λ, a hundred times smaller error, at every step.
    const ratios = byCase.moderate.map((error, index) => error / byCase.stiff[index]);
    add('stiffnessScaling', Math.max(...ratios.map((ratio) => Math.abs(Math.log10(ratio) - 2))), 'Prothero–Robinson, Rodas4 at fixed steps: |log10(error at λ = -1e4 / error at λ = -1e6) - 2|, largest over every step (0: the error is exactly proportional to 1 / |λ|)');
    notes.push(`Rodas4 at fixed steps on the stiff problem: its error is proportional to h / |λ| (λ = -1e4 against -1e6: ratios ${ratios.map((ratio) => ratio.toFixed(1)).join(', ')}), first order in h but divided by the stiffness: at most ${Math.max(...byCase.stiff).toExponential(1)} of the range at λ = -1e6, below the non-stiff control's at the coarser steps and above it once the control's fourth order has caught up; the same with the exact Jacobian.`);
    const steps = config.cases.control.globalTimeSteps;
    plots.push(linePlot({
        id: 'protheroRobinsonConvergence', title: 'Prothero–Robinson: error against step size', subtitle: `Largest error against sin t, relative to range, over ${config.targetTime} s`,
        xLabel: 'Step h (s)', yLabel: 'Relative error', logX: true, logY: true, xTicks: steps,
        series: [...orderSeries, series('Fourth order (slope 4)', 'guide', steps, steps.map((step) => orderSeries.at(-1).points[0][1] * (step / steps[0]) ** 4))]
    }));

    // Stiff against Adaptive at the same tolerance on the stiff case: the steps each takes.
    const comparison = config.explicitComparison;
    const counts = {};
    for (const variant of comparison.variants) {
        const run = engineRun(comparison.run);
        const result = await engine.run(modelPath('stiff'), variant, run);
        const metrics = errorMetrics(trajectory(result, ids), result.times.map((value) => [Math.sin(value)]));
        counts[variant.method] = result.work.methodSteps;
        rows.push(resultRow({ caseName: `Prothero–Robinson, λ = ${lambdas.stiff}: ${methodName(variant)}`, model: 'stiff', variant, run, errors: metrics, work: result.work, unit: '',
            note: `${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected, ${result.work.modelEvaluations} evaluations of the model` }));
        if (variant.method === 'rodas4') add('stiffToleranceError', metrics.relativeError, `Prothero–Robinson, λ = ${lambdas.stiff}, Stiff at relative tolerance ${variant.tolerance.relative}: largest error against sin t`);
    }
    add('explicitStepRatio', counts.dormandPrince54 / counts.rodas4, `Prothero–Robinson, λ = ${lambdas.stiff}: steps Adaptive takes for each step Stiff takes, at the same tolerance`);
    notes.push(`λ = ${lambdas.stiff}, ${comparison.run.targetTime} s at the same tolerance: Adaptive took ${counts.dormandPrince54.toLocaleString()} steps, Stiff ${counts.rodas4.toLocaleString()}.`);
    return { rows, checks, plots, notes };
}
