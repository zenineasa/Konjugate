/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A double pendulum released from rest with both arms at 2 rad (θ1 = θ2 = 2, about 115°, the single pendulum's angle), one node: two 1 kg point masses on massless 1 m rods,
// g = 9.81 m/s², angles from the downward vertical, d = θ1 - θ2:
//     dθ1/dt = ω1        dθ2/dt = ω2
//     dω1/dt = (-g (2 m1 + m2) sin θ1 - m2 g sin(θ1 - 2 θ2) - 2 sin d m2 (ω2² L2 + ω1² L1 cos d)) / (L1 (2 m1 + m2 - m2 cos 2d))
//     dω2/dt = 2 sin d (ω1² L1 (m1 + m2) + g (m1 + m2) cos θ1 + ω2² L2 m2 cos d) / (L2 (2 m1 + m2 - m2 cos 2d))
// Energy, E = ½ (m1 + m2) L1² ω1² + ½ m2 L2² ω2² + m2 L1 L2 ω1 ω2 cos d - (m1 + m2) g L1 cos θ1 - m2 g L2 cos θ2, is constant; its drift is
// reported relative to the energy above the bottom, E(0) + (m1 + m2) g L1 + m2 g L2.
//
// The motion is chaotic. Reported, for each method in benchmark.json: the trajectory's error over the first seconds and its predictability
// horizon; energy over a long run; the sensitivity to initial conditions, from perturbed.kjt (θ1 larger by 1e-9 rad), against the
// reference's own; and the observed order.
//
// Semi-implicit Euler updates the angles, then the angular velocities from the new angles, in the order the node lists its states. For a
// single pendulum that is the symplectic Euler method, whose energy stays bounded. Here it is not: the kinetic energy depends on the
// angles (through cos d), so the Hamiltonian is not separable and an update in angles and angular velocities, rather than angles and
// canonical momenta, is not symplectic. Its energy is measured, not promised.
//
// Reference (reference.json, generateReference.py): SciPy solve_ivp, DOP853 at rtol = atol = 1e-13, with its own error estimated at every
// sample against 1e-12. Every comparison stops where that estimate reaches 1 % of the angle the horizons are judged at: beyond it the
// reference is no longer trusted to say which motion is right.

import { join } from 'node:path';
import { trajectory } from '../../lib/engine.mjs';
import { conservationDrift, errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { createModel, difference, negate, parameter, product, quotient, state, sum } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
const paths = { doublePendulum: join(directory, 'doublePendulum.kjt'), perturbed: join(directory, 'perturbed.kjt') };
export const constants = Object.freeze({ m1: 1, m2: 1, l1: 1, l2: 1, gravity: 9.81, theta1: 2, theta2: 2, perturbation: 1e-9 });

export function build({ perturbed = false } = {}) {
    const model = createModel(perturbed ? 'Benchmark: double pendulum, θ1 + 1e-9 rad' : 'Benchmark: double pendulum');
    const pendulum = model.node('Double pendulum', { type: 'Double pendulum', color: '#5d7885', shape: 'sphere', states: [
        ['theta1', 'Upper angle', constants.theta1 + (perturbed ? constants.perturbation : 0), 'rad'],
        ['theta2', 'Lower angle', constants.theta2, 'rad'],
        ['omega1', 'Upper angular velocity', 0, 'rad/s'],
        ['omega2', 'Lower angular velocity', 0, 'rad/s']
    ] });
    const s = (symbol) => state(pendulum, symbol);
    const p = () => ({ m1: parameter('Upper mass', constants.m1, 'kg'), m2: parameter('Lower mass', constants.m2, 'kg'), l1: parameter('Upper length', constants.l1, 'm'),
        l2: parameter('Lower length', constants.l2, 'm'), g: parameter('Gravity', constants.gravity, 'm/s²') });
    const d = difference('theta1', 'theta2');
    // 2 m1 + m2 - m2 cos 2d
    const massTerm = difference(sum(product(2, 'm1'), 'm2'), product('m2', ['Cos', product(2, d)]));
    model.sourceTerm(pendulum, 'theta1', 'omega1', { omega1: s('omega1') });
    model.sourceTerm(pendulum, 'theta2', 'omega2', { omega2: s('omega2') });
    model.sourceTerm(pendulum, 'omega1', quotient(
        sum(
            negate(product('g', sum(product(2, 'm1'), 'm2'), ['Sin', 'theta1'])),
            negate(product('m2', 'g', ['Sin', difference('theta1', product(2, 'theta2'))])),
            negate(product(2, ['Sin', d], 'm2', sum(product(['Power', 'omega2', 2], 'l2'), product(['Power', 'omega1', 2], 'l1', ['Cos', d]))))
        ),
        product('l1', massTerm)
    ), { ...p(), theta1: s('theta1'), theta2: s('theta2'), omega1: s('omega1'), omega2: s('omega2') });
    model.sourceTerm(pendulum, 'omega2', quotient(
        product(2, ['Sin', d], sum(
            product(['Power', 'omega1', 2], 'l1', sum('m1', 'm2')),
            product('g', sum('m1', 'm2'), ['Cos', 'theta1']),
            product(['Power', 'omega2', 2], 'l2', 'm2', ['Cos', d])
        )),
        product('l2', massTerm)
    ), { ...p(), theta1: s('theta1'), theta2: s('theta2'), omega1: s('omega1'), omega2: s('omega2') });
    const ids = ['theta1', 'theta2', 'omega1', 'omega2'].map((symbol) => pendulum.stateIds[symbol]);
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -12, outputInterval: 2 ** -6 } }), ids };
}

export const models = { doublePendulum: () => build().document, perturbed: () => build({ perturbed: true }).document };

export function energy([theta1, theta2, omega1, omega2]) {
    const { m1, m2, l1, l2, gravity: g } = constants;
    return 0.5 * (m1 + m2) * l1 ** 2 * omega1 ** 2 + 0.5 * m2 * l2 ** 2 * omega2 ** 2 + m2 * l1 * l2 * omega1 * omega2 * Math.cos(theta1 - theta2)
        - (m1 + m2) * g * l1 * Math.cos(theta1) - m2 * g * l2 * Math.cos(theta2);
}
const energyScale = () => energy([constants.theta1, constants.theta2, 0, 0]) + (constants.m1 + constants.m2) * constants.gravity * constants.l1 + constants.m2 * constants.gravity * constants.l2;

const methodKey = (variant) => {
    const name = variant.method ?? variant.integration ?? 'explicit';
    return `${name[0].toUpperCase()}${name.slice(1)}`;
};
const roleOf = (variant) => variant.method ?? variant.integration ?? 'explicit';
const stepLabel = (step) => `h = 2^${Math.log2(step)} s`;

// The largest difference in either angle (rad) at each sample.
const angleSeparation = (left, right) => left.map((sample, k) => Math.max(Math.abs(sample[0] - right[k][0]), Math.abs(sample[1] - right[k][1])));
const firstAbove = (times, values, limit) => {
    const index = values.findIndex((value) => !(value <= limit));
    return index < 0 ? times.at(-1) : times[index];
};

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    const exact = data.cases.trajectory;
    const perturbedExact = data.cases.perturbed;
    const ids = build().ids;
    const scale = energyScale();
    const unit = 'rad, rad/s';

    // The trajectory, its predictability horizon, and its sensitivity to the starting angle.
    const run = engineRun(config.trajectory);
    const shortCount = Math.round(config.trajectory.shortHorizon / config.trajectory.outputInterval) + 1;
    const limit = config.horizonAngle;
    // The reference is trusted while its own error (either start's) stays below 1 % of the angle the horizons are judged at.
    const trustedCount = (() => {
        const index = exact.ownError.findIndex((value, k) => Math.max(value, perturbedExact.ownError[k]) > limit / 100);
        return index < 0 ? exact.times.length : index;
    })();
    const trustedTime = exact.times[trustedCount - 1];
    const trusted = (values) => values.slice(0, trustedCount);
    const referenceSeparation = angleSeparation(perturbedExact.states, exact.states);
    const referenceSensitivity = firstAbove(trusted(exact.times), trusted(referenceSeparation), limit);
    const angleSeries = [];
    const sensitivitySeries = [series('SciPy DOP853: separation of the two starts', 'reference', exact.times.slice(1), referenceSeparation.slice(1))];
    for (const { variant, globalTimeStep } of config.trajectory.methods) {
        const method = methodKey(variant);
        const stepRun = { ...run, globalTimeStep };
        const result = await engine.run(paths.doublePendulum, variant, stepRun);
        const numeric = trajectory(result, ids);
        const perturbed = trajectory(await engine.run(paths.perturbed, variant, stepRun), ids);
        const short = errorMetrics(numeric.slice(0, shortCount), exact.states.slice(0, shortCount));
        const angleError = angleSeparation(numeric, exact.states);
        const horizon = firstAbove(trusted(result.times), trusted(angleError), limit);
        const separation = angleSeparation(perturbed, numeric);
        const sensitivity = firstAbove(trusted(result.times), trusted(separation), limit);
        rows.push(resultRow({ caseName: `Double pendulum: first ${config.trajectory.shortHorizon} s`, model: 'doublePendulum', variant, run: { ...stepRun, targetTime: config.trajectory.shortHorizon }, errors: short, work: result.work, unit,
            conservationError: conservationDrift(numeric.slice(0, shortCount).map(energy), scale).maxRelativeDrift,
            note: `angle error first above ${limit} rad at ${horizon >= trustedTime ? `${trustedTime.toFixed(2)} s or later (the reference is trusted to ${trustedTime.toFixed(2)} s)` : `${horizon.toFixed(2)} s`}; from θ1 + 1e-9 rad its own run separates by ${limit} rad at ${sensitivity.toFixed(2)} s (reference ${referenceSensitivity.toFixed(2)} s)` }));
        add(`shortRelativeError${method}`, short.relativeError, `Largest error relative to range over the first ${config.trajectory.shortHorizon} s, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        add(`horizon${method}`, horizon, `Predictability horizon (s): the first time either angle's error exceeds ${limit} rad, up to the ${trustedTime.toFixed(2)} s the reference is trusted for, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        add(`sensitivityTime${method}`, Math.abs(sensitivity - referenceSensitivity), `Runs 1e-9 rad apart separate by ${limit} rad: Konjugate's time against the reference's ${referenceSensitivity.toFixed(2)} s, |difference| (s), ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        angleSeries.push(series(`Konjugate, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`, roleOf(variant), result.times, numeric.map((sample) => sample[1])));
        sensitivitySeries.push(series(`Konjugate, ${methodName(variant)}: separation of the two starts`, roleOf(variant), result.times.slice(1), separation.slice(1)));
        if (variant.method === 'rungeKutta4' || config.trajectory.methods.length === 1) {
            sensitivitySeries.push(series(`Konjugate, ${methodName(variant)}: its error against the reference`, 'extra', result.times.slice(1), angleError.slice(1)));
        }
    }
    plots.push(linePlot({
        id: 'doublePendulumAngle', title: 'Double pendulum: lower angle', subtitle: `θ2 from rest with both arms at 2 rad, the reference against Konjugate over ${run.targetTime} s`, xLabel: 'Time (s)', yLabel: 'θ2 (rad)',
        series: [series('SciPy DOP853 reference', 'reference', exact.times, exact.states.map((sample) => sample[1])), ...angleSeries]
    }));
    plots.push(linePlot({
        id: 'doublePendulumSensitivity', title: 'Double pendulum: sensitivity to the starting angle', subtitle: 'Largest angle difference between runs started 1e-9 rad apart, and a method\'s own error, against time', xLabel: 'Time (s)', yLabel: 'Angle difference (rad)', logY: true,
        series: sensitivitySeries
    }));
    const ownError = Math.max(...exact.ownError.slice(0, shortCount));
    add('referenceTrustedTime', trustedTime, `How long the reference is trusted (s): until its own error, DOP853 at 1e-13 against 1e-12, first exceeds ${limit / 100} (1 % of the horizon angle)`);
    add('referenceOwnError', ownError, `The reference's own error over the first ${config.trajectory.shortHorizon} s: DOP853 at 1e-13 against 1e-12, largest difference (rad, rad/s)`);
    add('referenceEnergyDrift', data.provenance.energyDrift, 'The reference\'s own energy drift over 20 s, relative to the energy above the bottom');

    // Energy over a long run.
    const energyRun = engineRun(config.energy);
    const energySeries = [];
    for (const { variant, globalTimeStep } of config.energy.methods) {
        const method = methodKey(variant);
        const stepRun = { ...energyRun, globalTimeStep };
        const result = await engine.run(paths.doublePendulum, variant, stepRun);
        const energies = trajectory(result, ids).map(energy);
        const drift = conservationDrift(energies, scale);
        rows.push(resultRow({ caseName: 'Double pendulum: long-run energy', model: 'doublePendulum', variant, run: stepRun, conservationError: drift.maxRelativeDrift, work: result.work, unit: 'J',
            note: `final relative energy change ${drift.finalRelativeDrift.toExponential(2)}` }));
        add(`energyDrift${method}`, drift.maxRelativeDrift, `Largest relative energy drift over ${stepRun.targetTime} s, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`);
        let largest = 0;
        energySeries.push(series(`Konjugate, ${methodName(variant)}, ${stepLabel(globalTimeStep)}`, roleOf(variant), result.times.slice(1),
            energies.map((value) => (largest = Math.max(largest, Math.abs(value - energies[0]) / scale))).slice(1)));
    }
    plots.push(linePlot({
        id: 'doublePendulumEnergy', title: 'Double pendulum: energy drift over a long run', subtitle: `Largest |E - E(0)| / (E(0) + 3 g L) up to each time, over ${energyRun.targetTime} s`, xLabel: 'Time (s)', yLabel: 'Largest relative energy drift so far', logY: true,
        series: energySeries
    }));

    // Observed order over a short run.
    const convergence = config.convergence;
    const convergenceRun = engineRun(convergence);
    const reference = exact.states.slice(0, Math.round(convergence.targetTime / convergence.outputInterval) + 1);
    const orderSeries = [];
    for (const { variant, globalTimeSteps } of convergence.methods) {
        const method = methodKey(variant);
        const errors = [];
        for (const step of globalTimeSteps) {
            const result = await engine.run(paths.doublePendulum, variant, { ...convergenceRun, globalTimeStep: step });
            const metrics = errorMetrics(trajectory(result, ids), reference);
            errors.push(metrics.relativeError);
            rows.push(resultRow({ caseName: 'Double pendulum: convergence', model: 'doublePendulum', variant, run: { ...convergenceRun, globalTimeStep: step }, errors: metrics, work: result.work, unit }));
        }
        const order = observedOrder(globalTimeSteps, errors);
        rows.at(-1).observedOrder = order.fitted;
        rows.at(-1).note = `observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
        add(`order${method}`, order.fitted, `Observed order over ${globalTimeSteps.length} step sizes, ${convergence.targetTime} s, ${methodName(variant)}`);
        add(`finestOrder${method}`, order.finest, `Observed order from the finest halving, ${methodName(variant)}`);
        orderSeries.push(series(`Konjugate, ${methodName(variant)}`, roleOf(variant), globalTimeSteps, errors));
    }
    plots.push(linePlot({
        id: 'doublePendulumConvergence', title: 'Double pendulum: error against step size', subtitle: `Largest error relative to range over the first ${convergence.targetTime} s`, xLabel: 'Global step h (s)', yLabel: 'Relative error', logX: true, logY: true,
        xTicks: [...new Set(convergence.methods.flatMap((entry) => entry.globalTimeSteps))].sort((left, right) => right - left), series: orderSeries
    }));
    return { rows, checks, plots, notes: [`The two starts differ by ${constants.perturbation} rad in θ1. The reference's runs separate by ${limit} rad at ${referenceSensitivity.toFixed(2)} s; the reference is trusted, its own error below ${limit / 100} rad, to ${trustedTime.toFixed(2)} s, and no comparison goes beyond. A method whose own error at a time is larger than the two runs' separation then cannot say which of the two motions is right: for a chaotic system, the method error, not the uncertainty of the starting state, sets how far ahead it can be trusted.`] };
}
