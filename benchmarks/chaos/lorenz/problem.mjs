/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Lorenz system, σ = 10, ρ = 28, β = 8/3, from (1, 1, 1):
//     dx/dt = σ (y - x)        dy/dt = x (ρ - z) - y        dz/dt = x y - β z
// It is chaotic: two trajectories that start apart by ε separate like ε e^(λt), λ ≈ 0.906 /s, so any method's error, however small, grows
// by e every 1.1 s, and no method follows one trajectory for long. The benchmark says how long each does, and then judges what can still
// be judged after that: the attractor's statistics and the rate of separation itself.
//
//   Trajectory. Error against the reference over the first 8 s, and the predictability horizon: the first time the error exceeds 1 % of a
//   state's range. Halving the step buys only p ln 2 / λ seconds of horizon (0.77 s for a first-order method, 3.1 s for Runge–Kutta 4),
//   which the horizon study measures.
//   Statistics. Over 500 s after a 20 s transient: the mean and standard deviation of z and the root mean square of x, against an ensemble
//   of 200 reference runs of the same length; each is judged in units of the ensemble's scatter, which is how far one run of that length
//   should land from the attractor's true value.
//   Adaptive. Dormand–Prince 5(4) with its error control (docs/proposals/integrators.md) over relative tolerances from 1e-4 to 1e-11:
//   the predictability horizon against the tolerance, which a decade of tolerance lengthens by about ln 10 / λ = 2.5 s times the slope of
//   its error against its tolerance (a little under 1), with the steps and evaluations each took; two nodes against one under it; and
//   the attractor's statistics and Lyapunov exponent at one tolerance.
//   Lyapunov exponent. tangent.kjt carries the tangent equations beside the state, du/dt = J(x, y, z) u from u = (1, 0, 0); the largest
//   exponent is the growth rate of ln |u| over the same window, against the reference ensemble and Viswanath's 0.9056.
//
// Models:
//   oneNode.kjt   x, y and z as one node.
//   twoNodes.kjt  x as one node and y, z as another. A relationship reads only its two ends, and y's equation reads x and z, z's reads x
//                 and y, so the three variables cannot be three single-state nodes: y and z share a node, and x reaches them, and y
//                 reaches x, through relationships read from the snapshot. Under explicit Euler with one substep this is exactly the
//                 one-node model's step; under semi-implicit Euler it is not (x is no longer updated before y and z); under Runge–Kutta 4
//                 it equals the one-node model to rounding.
//   tangent.kjt   the one-node model with the tangent equations.
//
// Reference (reference.json, generateReference.py): a Taylor series method in 70-digit arithmetic (mpmath), checked against itself at a
// lower order and precision, so its error is far below anything measured here over the whole 40 s; SciPy's DOP853 at rtol = atol = 1e-12
// is shown beside it, to show where an ordinary tight double-precision reference loses the trajectory. Statistics and the Lyapunov
// exponent: an ensemble solved by DOP853 at 1e-10.

import { join } from 'node:path';
import { trajectory } from '../../lib/engine.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { createModel, difference, negate, parameter, product, state } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
const paths = { oneNode: join(directory, 'oneNode.kjt'), twoNodes: join(directory, 'twoNodes.kjt'), tangent: join(directory, 'tangent.kjt') };
export const constants = Object.freeze({ sigma: 10, rho: 28, beta: 8 / 3, x: 1, y: 1, z: 1 });

const sigma = () => parameter('Prandtl number σ', constants.sigma, '1/s');
const rho = () => parameter('Rayleigh number ρ', constants.rho, '');
const beta = () => parameter('Geometric factor β', constants.beta, '1/s');
const runConfiguration = { name: 'Benchmark', globalTimeStep: 2 ** -10, outputInterval: 2 ** -6 };

export function buildOneNode({ tangent = false } = {}) {
    const model = createModel(tangent ? 'Benchmark: Lorenz system with its tangent equations' : 'Benchmark: Lorenz system, one node');
    const lorenz = model.node('Lorenz', { type: 'Lorenz system', color: '#5b6f8a', states: [
        ['x', 'Convection', constants.x, ''],
        ['y', 'Horizontal temperature difference', constants.y, ''],
        ['z', 'Vertical temperature difference', constants.z, ''],
        ...(tangent ? [['u', 'Tangent x', 1, ''], ['v', 'Tangent y', 0, ''], ['w', 'Tangent z', 0, '']] : [])
    ] });
    const s = (symbol) => state(lorenz, symbol);
    model.sourceTerm(lorenz, 'x', product('sigma', difference('y', 'x')), { sigma: sigma(), x: s('x'), y: s('y') });
    model.sourceTerm(lorenz, 'y', difference(product('x', difference('rho', 'z')), 'y'), { rho: rho(), x: s('x'), y: s('y'), z: s('z') });
    model.sourceTerm(lorenz, 'z', difference(product('x', 'y'), product('beta', 'z')), { beta: beta(), x: s('x'), y: s('y'), z: s('z') });
    if (tangent) {
        // du/dt = J u, J the Jacobian of the system at (x, y, z).
        model.sourceTerm(lorenz, 'u', product('sigma', difference('v', 'u')), { sigma: sigma(), u: s('u'), v: s('v') });
        model.sourceTerm(lorenz, 'v', difference(difference(product(difference('rho', 'z'), 'u'), 'v'), product('x', 'w')), { rho: rho(), x: s('x'), z: s('z'), u: s('u'), v: s('v'), w: s('w') });
        model.sourceTerm(lorenz, 'w', difference(['Add', product('y', 'u'), product('x', 'v')], product('beta', 'w')), { beta: beta(), x: s('x'), y: s('y'), u: s('u'), v: s('v'), w: s('w') });
    }
    const ids = ['x', 'y', 'z', ...(tangent ? ['u', 'v', 'w'] : [])].map((symbol) => lorenz.stateIds[symbol]);
    return { document: model.document({ runConfiguration }), ids };
}

export function buildTwoNodes() {
    const model = createModel('Benchmark: Lorenz system, two nodes');
    const convection = model.node('Convection', { type: 'Lorenz convection', color: '#5b6f8a', states: [['x', 'Convection', constants.x, '']] });
    const temperature = model.node('Temperature', { type: 'Lorenz temperature', position: [3, 0, 0], color: '#8a6f5b', states: [
        ['y', 'Horizontal temperature difference', constants.y, ''],
        ['z', 'Vertical temperature difference', constants.z, '']
    ] });
    model.sourceTerm(convection, 'x', negate(product('sigma', 'x')), { sigma: sigma(), x: state(convection, 'x') });
    model.edge('Buoyancy', temperature, convection, 'x', product('sigma', 'y'), { sigma: sigma(), y: state(temperature, 'y') });
    model.sourceTerm(temperature, 'y', negate('y'), { y: state(temperature, 'y') });
    model.sourceTerm(temperature, 'z', negate(product('beta', 'z')), { beta: beta(), z: state(temperature, 'z') });
    model.edge('Horizontal advection', convection, temperature, 'y', product('x', difference('rho', 'z')), { rho: rho(), x: state(convection, 'x'), z: state(temperature, 'z') });
    model.edge('Vertical advection', convection, temperature, 'z', product('x', 'y'), { x: state(convection, 'x'), y: state(temperature, 'y') });
    return { document: model.document({ runConfiguration }), ids: [convection.stateIds.x, temperature.stateIds.y, temperature.stateIds.z] };
}

export const models = { oneNode: () => buildOneNode().document, twoNodes: () => buildTwoNodes().document, tangent: () => buildOneNode({ tangent: true }).document };

const methodKey = (variant) => {
    const name = variant.method ?? variant.integration ?? 'explicit';
    return `${name[0].toUpperCase()}${name.slice(1)}`;
};
const roleOf = (variant) => variant.method ?? variant.integration ?? 'explicit';
const stepLabel = (step) => `h = 2^${Math.log2(step)} s`;

// Per sample, the largest error over the states relative to each state's range over the reference.
function errorHistory(numeric, reference, ranges) {
    return numeric.map((sample, k) => Math.max(...sample.map((value, j) => Math.abs(value - reference[k][j]) / ranges[j])));
}

// The first sample time at which the relative error exceeds the tolerance; the run's end if it never does.
function horizonOf(times, history, tolerance) {
    const index = history.findIndex((value) => !(value <= tolerance));
    return index < 0 ? times.at(-1) : times[index];
}

function statisticsOf(times, samples, transient) {
    const kept = samples.filter((_sample, k) => times[k] >= transient - 1e-9);
    const z = kept.map((sample) => sample[2]);
    const meanZ = z.reduce((sum, value) => sum + value, 0) / z.length;
    return {
        meanZ,
        standardDeviationZ: Math.sqrt(z.reduce((sum, value) => sum + (value - meanZ) ** 2, 0) / z.length),
        rmsX: Math.sqrt(kept.reduce((sum, sample) => sum + sample[0] ** 2, 0) / kept.length)
    };
}

const statisticNames = { meanZ: 'mean of z', standardDeviationZ: 'standard deviation of z', rmsX: 'root mean square of x', lyapunovExponent: 'largest Lyapunov exponent' };
const capitalised = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const data = referenceData(directory);
    const exact = data.cases.trajectory;
    const ranges = [0, 1, 2].map((j) => Math.max(...exact.states.map((sample) => sample[j])) - Math.min(...exact.states.map((sample) => sample[j])));
    const tolerance = config.horizonTolerance;
    const oneNodeIds = buildOneNode().ids;
    const lambda = data.statistics.lyapunovExponent.mean;

    // The trajectory: error over the short horizon, and the predictability horizon, per method.
    const trajectoryRun = engineRun(config.trajectory);
    const shortCount = Math.round(config.trajectory.shortHorizon / config.trajectory.outputInterval) + 1;
    const errorSeries = [];
    const shortSeries = [];
    const kept = {};
    for (const { variant, globalTimeStep } of config.trajectory.methods) {
        const method = methodKey(variant);
        const run = { ...trajectoryRun, globalTimeStep };
        const result = await engine.run(paths.oneNode, variant, run);
        const numeric = trajectory(result, oneNodeIds);
        const short = errorMetrics(numeric.slice(0, shortCount), exact.states.slice(0, shortCount));
        const history = errorHistory(numeric, exact.states, ranges);
        const horizon = horizonOf(result.times, history, tolerance);
        kept[JSON.stringify([variant, globalTimeStep])] = numeric;
        rows.push(resultRow({ caseName: `Lorenz, one node: first ${config.trajectory.shortHorizon} s`, model: 'oneNode', variant, run: { ...run, targetTime: config.trajectory.shortHorizon }, errors: short, work: result.work,
            note: `errors against the Taylor reference; predictability horizon (error first above ${tolerance * 100} % of a state's range) ${horizon.toFixed(2)} s` }));
        add(`shortRelativeError${method}`, short.relativeError, `Largest error relative to range over the first ${config.trajectory.shortHorizon} s, one node, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        add(`horizon${method}`, horizon, `Predictability horizon (s): the first time the error exceeds ${tolerance * 100} % of a state's range, one node, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        errorSeries.push(series(`Konjugate, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`, roleOf(variant), result.times.slice(1), history.slice(1)));
        shortSeries.push(series(`Konjugate, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`, roleOf(variant), result.times, numeric.map((sample) => sample[0])));
    }
    // The DOP853 check over the reference's whole 40 s.
    const dop853History = errorHistory(data.cases.dop853.states, exact.states, ranges);
    const dop853Horizon = horizonOf(exact.times, dop853History, tolerance);
    add('referenceDop853Horizon', dop853Horizon, `SciPy DOP853 at rtol = atol = 1e-12 against the Taylor reference: its own predictability horizon (s), at the same ${tolerance * 100} %`);
    add('referenceTaylorSelfAgreement', data.provenance.taylorSelfAgreement, 'The Taylor reference against itself at a lower order and precision, largest difference over 40 s: its own error');
    const firstError = dop853History.findIndex((value) => value > 0);
    plots.push(linePlot({
        id: 'lorenzTrajectory', title: 'Lorenz: x against time', subtitle: `The Taylor reference against Konjugate over ${config.trajectory.targetTime} s: each method follows it, then loses it`, xLabel: 'Time (s)', yLabel: 'x',
        series: [series('Taylor reference (70 digits)', 'reference', exact.times, exact.states.map((sample) => sample[0])), ...shortSeries]
    }));
    plots.push(linePlot({
        id: 'lorenzErrorGrowth', title: 'Lorenz: error against time', subtitle: `Largest error relative to range at each sample; the guide is e^(λt), λ = ${lambda.toFixed(3)} /s; an error stops growing at the attractor's size`, xLabel: 'Time (s)', yLabel: 'Relative error', logY: true,
        series: [
            ...errorSeries,
            series('SciPy DOP853, rtol 1e-12', 'extra', exact.times.slice(Math.max(firstError, 1)), dop853History.slice(Math.max(firstError, 1))),
            series(`e^(λt) guide`, 'guide', exact.times.slice(1), exact.times.slice(1).map((time) => 1e-16 * Math.exp(lambda * time)))
        ]
    }));

    // The horizon against the step: each halving buys p ln 2 / λ seconds.
    const horizonSeries = [];
    for (const { variant, globalTimeSteps, order, targetTime, checkGain } of config.horizonStudy.methods) {
        const method = methodKey(variant);
        const horizons = [];
        const studyRun = { ...trajectoryRun, targetTime };
        for (const step of globalTimeSteps) {
            const result = await engine.run(paths.oneNode, variant, { ...studyRun, globalTimeStep: step });
            horizons.push(horizonOf(result.times, errorHistory(trajectory(result, oneNodeIds), exact.states, ranges), tolerance));
        }
        // Least-squares gain in horizon per halving of the step.
        const x = globalTimeSteps.map((step) => -Math.log2(step));
        const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
        const meanY = horizons.reduce((sum, value) => sum + value, 0) / horizons.length;
        const gain = x.reduce((sum, value, k) => sum + (value - meanX) * (horizons[k] - meanY), 0) / x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
        const expected = order * Math.LN2 / lambda;
        rows.push(resultRow({ caseName: 'Lorenz, one node: predictability horizon against step', model: 'oneNode', variant, run: { ...studyRun, globalTimeStep: globalTimeSteps.at(-1) },
            note: `horizons ${horizons.map((value) => value.toFixed(2)).join(', ')} s at h = ${globalTimeSteps.map((step) => `2^${Math.log2(step)}`).join(', ')} s; least-squares gain per halving ${gain.toFixed(2)} s (p ln 2 / λ = ${expected.toFixed(2)} s)` }));
        horizons.forEach((horizon, index) => add(`horizon${method}Step${index + 1}`, horizon, `Predictability horizon (s) at h = 2^${Math.log2(globalTimeSteps[index])} s, run to ${targetTime} s, ${methodName(variant)}`));
        if (checkGain) add(`horizonGainPerHalving${method}`, gain / expected, `Horizon gained per halving of the step, least-squares, as a fraction of p ln 2 / λ (${expected.toFixed(2)} s for order ${order}), ${methodName(variant)}`);
        horizonSeries.push(series(`Konjugate, ${methodName(variant)}`, roleOf(variant), globalTimeSteps, horizons));
    }
    plots.push(linePlot({
        id: 'lorenzHorizon', title: 'Lorenz: predictability horizon against step size', subtitle: `The first time the error exceeds ${tolerance * 100} % of a state's range; the DOP853 reference at 1e-12 reaches ${dop853Horizon.toFixed(2)} s`,
        xLabel: 'Global step h (s)', yLabel: 'Predictability horizon (s)', logX: true,
        xTicks: [...new Set(config.horizonStudy.methods.flatMap((entry) => entry.globalTimeSteps))].sort((left, right) => right - left), series: horizonSeries
    }));

    // Convergence order over a short horizon, where the error is still far below the attractor's size.
    const convergence = config.convergence;
    const convergenceRun = engineRun(convergence);
    const convergenceReference = exact.states.slice(0, Math.round(convergence.targetTime / convergence.outputInterval) + 1);
    const orderSeries = [];
    for (const { variant, globalTimeSteps } of convergence.methods) {
        const method = methodKey(variant);
        const errors = [];
        for (const step of globalTimeSteps) {
            const result = await engine.run(paths.oneNode, variant, { ...convergenceRun, globalTimeStep: step });
            const metrics = errorMetrics(trajectory(result, oneNodeIds), convergenceReference);
            errors.push(metrics.relativeError);
            rows.push(resultRow({ caseName: 'Lorenz, one node: convergence', model: 'oneNode', variant, run: { ...convergenceRun, globalTimeStep: step }, errors: metrics, work: result.work }));
        }
        const order = observedOrder(globalTimeSteps, errors);
        rows.at(-1).observedOrder = order.fitted;
        rows.at(-1).note = `observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
        add(`order${method}`, order.fitted, `Observed order over ${globalTimeSteps.length} step sizes, ${convergence.targetTime} s, ${methodName(variant)}`);
        add(`finestOrder${method}`, order.finest, `Observed order from the finest halving, ${methodName(variant)}`);
        orderSeries.push(series(`Konjugate, ${methodName(variant)}`, roleOf(variant), globalTimeSteps, errors));
    }
    plots.push(linePlot({
        id: 'lorenzConvergence', title: 'Lorenz: error against step size', subtitle: `Largest error relative to range over the first ${convergence.targetTime} s`, xLabel: 'Global step h (s)', yLabel: 'Relative error', logX: true, logY: true,
        xTicks: [...new Set(convergence.methods.flatMap((entry) => entry.globalTimeSteps))].sort((left, right) => right - left), series: orderSeries
    }));

    // One node against two, over the short horizon (beyond it rounding differences grow like any other error).
    const twoNodesIds = buildTwoNodes().ids;
    const largestRelative = (left, right) => Math.max(...left.map((sample, k) => Math.max(...sample.map((value, j) => Math.abs(value - right[k][j]) / ranges[j]))));
    for (const { variant, globalTimeStep, identity } of config.trajectory.methods) {
        const method = methodKey(variant);
        const run = { ...trajectoryRun, globalTimeStep };
        const result = await engine.run(paths.twoNodes, variant, run);
        const split = trajectory(result, twoNodesIds);
        const single = kept[JSON.stringify([variant, globalTimeStep])];
        const difference = largestRelative(split.slice(0, shortCount), single.slice(0, shortCount));
        const errors = errorMetrics(split.slice(0, shortCount), exact.states.slice(0, shortCount));
        rows.push(resultRow({ caseName: `Lorenz, two nodes: first ${config.trajectory.shortHorizon} s`, model: 'twoNodes', variant, run: { ...run, targetTime: config.trajectory.shortHorizon }, errors, work: result.work,
            note: `difference from the one-node model over the first ${config.trajectory.shortHorizon} s, relative to range: ${difference.toExponential(2)}; predictability horizon ${horizonOf(result.times, errorHistory(split, exact.states, ranges), tolerance).toFixed(2)} s` }));
        add(`splitDifference${method}`, difference, identity
            ? `Two nodes against one, ${methodName(variant)}: the same steps, summed in another order, largest difference relative to range over the first ${config.trajectory.shortHorizon} s`
            : `Two nodes against one, ${methodName(variant)}: x is no longer updated before y and z, a first-order difference, relative to range over the first ${config.trajectory.shortHorizon} s`);
    }

    // The attractor's statistics over a window as long as each reference ensemble member's.
    const reference = data.statistics;
    const statisticsRun = engineRun(config.statistics);
    const transient = config.statistics.transient;
    // A method may appear at more than one step; key then names the entry's checks.
    for (const { variant, globalTimeStep, key } of config.statistics.methods) {
        const method = key ?? methodKey(variant);
        const run = { ...statisticsRun, globalTimeStep };
        // The tangent model's x, y and z take exactly the one-node model's steps (nothing feeds back from the tangent equations), so one
        // run gives both the statistics and the exponent. The tangent vector grows to about e^(0.9 × 520) ≈ 1e203: its norm is taken
        // with Math.hypot, which does not overflow.
        const tangentResult = await engine.run(paths.tangent, variant, run);
        const result = tangentResult;
        const allIds = buildOneNode({ tangent: true }).ids;
        const measured = statisticsOf(result.times, trajectory(result, allIds.slice(0, 3)), transient);
        const tangentIds = allIds.slice(3);
        const logNorm = (k) => Math.log(Math.hypot(...tangentIds.map((id) => tangentResult.values.get(id)[k])));
        const start = tangentResult.times.findIndex((time) => time >= transient - 1e-9);
        const end = tangentResult.times.length - 1;
        measured.lyapunovExponent = (logNorm(end) - logNorm(start)) / (tangentResult.times[end] - tangentResult.times[start]);
        const scores = {};
        for (const [name, value] of Object.entries(measured)) {
            scores[name] = (value - reference[name].mean) / reference[name].windowStandardDeviation;
            add(`${name}Score${method}`, Math.abs(scores[name]), `${capitalised(statisticNames[name])} over ${run.targetTime - transient} s after ${transient} s: |Konjugate - reference| in units of the scatter of one run that long, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        }
        rows.push(resultRow({ caseName: `Lorenz, one node: attractor statistics over ${run.targetTime - transient} s`, model: 'oneNode', variant, run, work: result.work,
            note: Object.entries(measured).map(([name, value]) => `${statisticNames[name]} ${value.toFixed(4)} (reference ${reference[name].mean.toFixed(4)} ± ${reference[name].windowStandardDeviation.toFixed(4)}, ${scores[name] >= 0 ? '+' : ''}${scores[name].toFixed(2)} σ)`).join('; ') }));
    }
    // Adaptive: the horizon against the tolerance, with the work it took; two nodes against one; the statistics at one tolerance.
    const adaptive = config.adaptive;
    // The global step is Adaptive's largest step: long enough not to bind at the loosest tolerance, and the samples at it, so the
    // reference is read at every one of its samples that falls on one.
    const adaptiveRun = { ...trajectoryRun, globalTimeStep: adaptive.globalTimeStep, outputInterval: adaptive.globalTimeStep, targetTime: adaptive.targetTime };
    const stride = Math.round(adaptive.globalTimeStep / config.trajectory.outputInterval);
    const adaptiveReference = exact.states.filter((_sample, k) => k % stride === 0);
    const adaptiveHorizons = [];
    const adaptiveWork = [];
    for (const [index, relative] of adaptive.relativeTolerances.entries()) {
        const variant = { method: 'dormandPrince54', tolerance: { relative, absolute: relative * adaptive.absoluteFraction } };
        const result = await engine.run(paths.oneNode, variant, adaptiveRun);
        const horizon = horizonOf(result.times, errorHistory(trajectory(result, oneNodeIds), adaptiveReference, ranges), tolerance);
        adaptiveHorizons.push(horizon);
        adaptiveWork.push(result.work.modelEvaluations);
        rows.push(resultRow({ caseName: 'Lorenz, one node: predictability horizon against tolerance', model: 'oneNode', variant, run: adaptiveRun, work: result.work,
            note: `horizon ${horizon.toFixed(2)} s; ${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected, ${result.work.modelEvaluations} evaluations of the model` }));
        add(`horizonAdaptiveTolerance${index + 1}`, horizon, `Predictability horizon (s) at relative tolerance ${relative}, run to ${adaptive.targetTime} s, ${methodName(variant)}`);
    }
    {
        const x = adaptive.relativeTolerances.map((relative) => -Math.log10(relative));
        const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
        const meanY = adaptiveHorizons.reduce((sum, value) => sum + value, 0) / adaptiveHorizons.length;
        const gain = x.reduce((sum, value, k) => sum + (value - meanX) * (adaptiveHorizons[k] - meanY), 0) / x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
        const expected = Math.LN10 / lambda;
        rows.push(resultRow({ caseName: 'Lorenz, one node: horizon gained per decade of tolerance', model: 'oneNode', variant: { method: 'dormandPrince54' },
            note: `least-squares gain ${gain.toFixed(2)} s per decade (ln 10 / λ = ${expected.toFixed(2)} s)` }));
        add('horizonGainPerDecadeAdaptive', gain / expected, `Horizon gained per decade of tolerance, least-squares, as a fraction of ln 10 / λ (${expected.toFixed(2)} s), Adaptive`);
        plots.push(linePlot({
            id: 'lorenzHorizonTolerance', title: 'Lorenz: Adaptive\'s predictability horizon against its tolerance', subtitle: `The first time the error exceeds ${tolerance * 100} % of a state's range; each point's model evaluations in the results table`,
            xLabel: 'Relative tolerance', yLabel: 'Predictability horizon (s)', logX: true, xTicks: adaptive.relativeTolerances,
            series: [series('Konjugate, Adaptive, Dormand–Prince 5(4)', 'dormandPrince54', adaptive.relativeTolerances, adaptiveHorizons)]
        }));
        plots.push(linePlot({
            id: 'lorenzWorkHorizon', title: 'Lorenz: Adaptive\'s work against its horizon', subtitle: 'Evaluations of the whole model against the predictability horizon reached', xLabel: 'Predictability horizon (s)', yLabel: 'Evaluations of the model', logY: true,
            series: [series('Konjugate, Adaptive, Dormand–Prince 5(4)', 'dormandPrince54', adaptiveHorizons, adaptiveWork)]
        }));
    }
    {
        const variant = { method: 'dormandPrince54', tolerance: { relative: adaptive.statisticsTolerance, absolute: adaptive.statisticsTolerance * adaptive.absoluteFraction } };
        const shortRun = { ...trajectoryRun, globalTimeStep: config.trajectory.outputInterval };
        const one = trajectory(await engine.run(paths.oneNode, variant, shortRun), oneNodeIds);
        const twoResult = await engine.run(paths.twoNodes, variant, shortRun);
        const difference = largestRelative(trajectory(twoResult, twoNodesIds).slice(0, shortCount), one.slice(0, shortCount));
        rows.push(resultRow({ caseName: `Lorenz, two nodes: first ${config.trajectory.shortHorizon} s`, model: 'twoNodes', variant, run: { ...shortRun, targetTime: config.trajectory.shortHorizon }, work: twoResult.work,
            note: `difference from the one-node model over the first ${config.trajectory.shortHorizon} s, relative to range: ${difference.toExponential(2)}` }));
        add('splitDifferenceAdaptive', difference, `Two nodes against one under Adaptive at relative tolerance ${adaptive.statisticsTolerance}: the same steps (the error summed node by node), largest difference relative to range over the first ${config.trajectory.shortHorizon} s`);
        const run = { ...statisticsRun, globalTimeStep: config.statistics.outputInterval };
        const tangentResult = await engine.run(paths.tangent, variant, run);
        const allIds = buildOneNode({ tangent: true }).ids;
        const measured = statisticsOf(tangentResult.times, trajectory(tangentResult, allIds.slice(0, 3)), transient);
        const tangentIds = allIds.slice(3);
        const logNorm = (k) => Math.log(Math.hypot(...tangentIds.map((id) => tangentResult.values.get(id)[k])));
        const start = tangentResult.times.findIndex((time) => time >= transient - 1e-9);
        const end = tangentResult.times.length - 1;
        measured.lyapunovExponent = (logNorm(end) - logNorm(start)) / (tangentResult.times[end] - tangentResult.times[start]);
        const scores = {};
        for (const [name, value] of Object.entries(measured)) {
            scores[name] = (value - reference[name].mean) / reference[name].windowStandardDeviation;
            add(`${name}ScoreAdaptive`, Math.abs(scores[name]), `${capitalised(statisticNames[name])} over ${run.targetTime - transient} s after ${transient} s: |Konjugate - reference| in units of the scatter of one run that long, ${methodName(variant)}`);
        }
        rows.push(resultRow({ caseName: `Lorenz, one node: attractor statistics over ${run.targetTime - transient} s`, model: 'oneNode', variant, run, work: tangentResult.work,
            note: `${Object.entries(measured).map(([name, value]) => `${statisticNames[name]} ${value.toFixed(4)} (${scores[name] >= 0 ? '+' : ''}${scores[name].toFixed(2)} σ)`).join('; ')}; ${tangentResult.work.methodSteps} steps, ${tangentResult.work.rejectedSteps} rejected` }));
    }

    const literature = data.provenance.literatureLyapunovExponent;
    add('referenceLyapunovAgainstLiterature', Math.abs(reference.lyapunovExponent.mean - literature) / reference.lyapunovExponent.standardErrorOfMean,
        `The reference ensemble's mean Lyapunov exponent against Viswanath's ${literature}, in units of the ensemble mean's standard error`);
    notes.push(`The reference's own error: the 70-digit Taylor solution agrees with its lower-order, 50-digit check to ${data.provenance.taylorSelfAgreement.toExponential(1)} over 40 s; SciPy's DOP853 at rtol = atol = 1e-12 departs from it by ${tolerance * 100} % of the range at ${dop853Horizon.toFixed(2)} s, so a double-precision reference at that tolerance would itself be useless beyond then.`);
    notes.push(`The attractor's statistics from the reference ensemble (${data.provenance.ensemble} runs of ${data.provenance.window} s): mean of z ${reference.meanZ.mean.toFixed(4)}, standard deviation of z ${reference.standardDeviationZ.mean.toFixed(4)}, root mean square of x ${reference.rmsX.mean.toFixed(4)}, largest Lyapunov exponent ${reference.lyapunovExponent.mean.toFixed(4)} /s (Viswanath: ${literature}). One ${data.provenance.window} s run scatters about them by ${reference.meanZ.windowStandardDeviation.toFixed(3)}, ${reference.standardDeviationZ.windowStandardDeviation.toFixed(3)}, ${reference.rmsX.windowStandardDeviation.toFixed(3)} and ${reference.lyapunovExponent.windowStandardDeviation.toFixed(3)} /s, so a score within about 2 σ is as close as one run can be expected to come.`);
    notes.push('Three nodes, one per variable, cannot be written: a relationship reads only its two ends, and the equations of y and z each read both other variables. The split model is x as one node and y, z as another.');
    return { rows, checks, plots, notes };
}
