/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A bouncing ball whose floor is a stiff spring and damper: a 1 kg ball dropped from 1 m at rest, one node, with height h and velocity v:
//     dh/dt = v        dv/dt = -g                              while h ≥ 0 (flight)
//                      dv/dt = -g - (k h + c v) / m            while h < 0 (contact: the floor pushes back, and damps)
// k = 10,000 N/m and c = 20 N s/m (damping ratio 0.1), so a contact lasts about π / ω_d ≈ 31 ms and each bounce returns about
// e^(-ζπ/√(1-ζ²)) ≈ 0.73 of its speed. The switch is a condition on the height, a state: where it changes is not known in advance, which
// is what event location (docs/proposals/integrators.md, Event location) finds. Runge–Kutta 4, Adaptive and Stiff (Rodas4) locate each
// contact's start and end and step to them; explicit Euler does not, and its step must also stay below the contact's stability limit (2ζ/ω_n = 2 ms).
// No new kind of equation is needed: the ball's velocity is not set at the bounce, the floor's force reverses it.
//
// Reference: exact, piece by piece. In flight h is a parabola; in contact, m h'' + c h' + k h = -m g is a damped oscillation about -m g/k.
// Each contact's start is a parabola's root and its end the oscillation's next upward zero, found by bisection to the last bit; the
// solution is evaluated in closed form between them.

import { join } from 'node:path';
import { trajectory, sampleTimes } from '../../lib/engine.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { cases, createModel, difference, negate, parameter, product, quotient, state, sum } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'bouncingBall.kjt');
export const constants = Object.freeze({ mass: 1, gravity: 9.81, stiffness: 10000, damping: 20, height: 1 });

export function build() {
    const model = createModel('Benchmark: bouncing ball on a stiff floor');
    const ball = model.node('Ball', { type: 'Point mass', color: '#a05d3a', states: [['height', 'Height', constants.height, 'm'], ['velocity', 'Velocity', 0, 'm/s']] });
    model.sourceTerm(ball, 'height', 'velocity', { velocity: state(ball, 'velocity') });
    // The floor's force while the ball is below its surface: the spring compressed by -h and the damper.
    model.sourceTerm(ball, 'velocity', sum(negate('gravity'), cases(['Less', 'height', 0], quotient(negate(sum(product('stiffness', 'height'), product('damping', 'velocity'))), 'mass'), 'True', 0)), {
        gravity: parameter('Gravity', constants.gravity, 'm/s²'), height: state(ball, 'height'), velocity: state(ball, 'velocity'),
        stiffness: parameter('Floor stiffness', constants.stiffness, 'N/m'), damping: parameter('Floor damping', constants.damping, 'N s/m'), mass: parameter('Mass', constants.mass, 'kg')
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -9, outputInterval: 2 ** -6 } }), ids: [ball.stateIds.height, ball.stateIds.velocity] };
}

export const models = { bouncingBall: () => build().document };

// The exact motion as pieces: each flight and each contact, with its start, end and starting state.
export function exactPieces(until) {
    const { mass: m, gravity: g, stiffness: k, damping: c } = constants;
    const naturalFrequency = Math.sqrt(k / m);
    const dampingRatio = c / (2 * Math.sqrt(k * m));
    const dampedFrequency = naturalFrequency * Math.sqrt(1 - dampingRatio * dampingRatio);
    const rest = -m * g / k;
    const contactAt = (v0, tau) => {
        const u0 = -rest;
        const a = u0;
        const b = (v0 + dampingRatio * naturalFrequency * u0) / dampedFrequency;
        const decay = Math.exp(-dampingRatio * naturalFrequency * tau);
        const cos = Math.cos(dampedFrequency * tau);
        const sin = Math.sin(dampedFrequency * tau);
        const u = decay * (a * cos + b * sin);
        const du = decay * ((-dampingRatio * naturalFrequency) * (a * cos + b * sin) + dampedFrequency * (-a * sin + b * cos));
        return [rest + u, du];
    };
    const pieces = [];
    let time = 0;
    let h = constants.height;
    let v = 0;
    while (time < until) {
        // Flight to the floor.
        const fall = (v + Math.sqrt(v * v + 2 * g * h)) / g;
        pieces.push({ kind: 'flight', start: time, end: time + fall, h, v });
        time += fall;
        v -= g * fall;
        h = 0;
        if (time >= until) break;
        // Contact until the height comes back up through zero.
        const entry = v;
        const step = Math.PI / dampedFrequency / 400;
        let low = step;
        // A ball that no longer leaves the floor rests on it: the contact lasts for good.
        while (contactAt(entry, low + step)[0] < 0 && low < 40 * Math.PI / dampedFrequency) low += step;
        if (!(contactAt(entry, low + step)[0] >= 0)) {
            pieces.push({ kind: 'contact', start: time, end: Infinity, h: 0, v: entry, contactAt, exitVelocity: NaN });
            break;
        }
        let high = low + step;
        for (let iteration = 0; iteration < 200; ++iteration) {
            const middle = 0.5 * (low + high);
            if (!(middle > low && middle < high)) break;
            (contactAt(entry, middle)[0] < 0 ? (low = middle) : (high = middle));
        }
        const duration = high;
        pieces.push({ kind: 'contact', start: time, end: time + duration, h: 0, v: entry, contactAt });
        const [, exit] = contactAt(entry, duration);
        pieces.at(-1).exitVelocity = exit;
        time += duration;
        h = 0;
        v = exit;
    }
    return pieces;
}

export function reference(times) {
    const pieces = exactPieces(times.at(-1));
    const g = constants.gravity;
    return times.map((time) => {
        const piece = pieces.find((candidate) => time >= candidate.start && time < candidate.end) ?? pieces.at(-1);
        const tau = time - piece.start;
        if (piece.kind === 'flight') return [piece.h + piece.v * tau - 0.5 * g * tau * tau, piece.v - g * tau];
        return piece.contactAt(piece.v, tau);
    });
}

const roleOf = (variant) => variant.method ?? variant.integration ?? 'explicit';
const methodKey = (variant) => {
    const name = variant.method ?? variant.integration ?? 'explicit';
    return `${name[0].toUpperCase()}${name.slice(1)}`;
};

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const ids = build().ids;
    const exactTimes = sampleTimes(config.run.targetTime, config.run.outputInterval);
    const exact = reference(exactTimes);
    const pieces = exactPieces(config.run.targetTime);
    const contacts = pieces.filter((piece) => piece.kind === 'contact' && piece.end < config.run.targetTime);
    const switches = contacts.flatMap((piece) => [piece.start, piece.end]);
    const restitutions = contacts.map((piece) => -piece.exitVelocity / piece.v);
    // The instants a run switched at (its located events), each against the exact switch nearest it.
    const switchError = (eventList) => {
        const instants = [...new Set((eventList ?? []).map((event) => event.time))];
        if (instants.length < switches.length) return Infinity;
        return Math.max(...switches.map((time) => Math.min(...instants.map((instant) => Math.abs(instant - time)))));
    };

    // Order over halvings of the step, each method over steps of its own.
    const trajectorySeries = [];
    for (const { variant, globalTimeSteps } of config.methods) {
        const method = methodKey(variant);
        const errors = [];
        let last = null;
        for (const step of globalTimeSteps) {
            const run = engineRun(config.run, { globalTimeStep: step });
            const result = await engine.run(modelPath, variant, run);
            const metrics = errorMetrics(trajectory(result, ids), exact);
            errors.push(metrics.relativeError);
            last = { result, metrics, run };
            rows.push(resultRow({ caseName: 'Bouncing ball: trajectory', model: 'bouncingBall', variant, run, errors: metrics, work: result.work, unit: 'm, m/s',
                note: result.integration?.events !== undefined ? `${result.integration.events} switches located; largest switch-time error ${switchError(result.integration.eventList).toExponential(2)} s` : 'switches not located' }));
        }
        const order = observedOrder(globalTimeSteps, errors);
        rows.at(-1).observedOrder = order.fitted;
        rows.at(-1).note += `; observed order: fitted ${order.fitted.toFixed(3)}; per halving ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}`;
        add(`order${method}`, order.fitted, `Observed order over ${globalTimeSteps.length} step sizes, ${methodName(variant)}`);
        add(`relativeError${method}`, errors.at(-1), `Largest error relative to range over ${config.run.targetTime} s at h = 2^${Math.log2(globalTimeSteps.at(-1))} s, ${methodName(variant)}`);
        if (last.result.integration?.eventList) {
            add(`switchTimeError${method}`, switchError(last.result.integration.eventList), `Largest error in a contact's start or end (s) at h = 2^${Math.log2(globalTimeSteps.at(-1))} s, ${methodName(variant)}`);
        }
        trajectorySeries.push(series(`Konjugate, ${methodName(variant)}`, roleOf(variant), globalTimeSteps, errors));
        if (variant.method === 'rungeKutta4') {
            trajectorySeries.push(series('Fourth order (slope 4)', 'guide', globalTimeSteps, globalTimeSteps.map((step) => errors[0] * (step / globalTimeSteps[0]) ** 4)));
            const heights = trajectory(last.result, ids).map((sample) => sample[0]);
            plots.push(linePlot({ id: 'bouncingBallHeight', title: 'Bouncing ball: height against time', subtitle: `Exact against Runge–Kutta 4 with its contacts located, h = 2^${Math.log2(globalTimeSteps.at(-1))} s`,
                xLabel: 'Time (s)', yLabel: 'Height (m)', series: [series('Exact', 'reference', exactTimes, exact.map((sample) => sample[0])), series('Konjugate, Runge–Kutta 4', 'rungeKutta4', last.result.times, heights)] }));
        }
    }
    plots.push(linePlot({ id: 'bouncingBallConvergence', title: 'Bouncing ball: error against step size', subtitle: `Largest error relative to range over ${config.run.targetTime} s`,
        xLabel: 'Global step h (s)', yLabel: 'Relative error', logX: true, logY: true,
        xTicks: [...new Set(config.methods.flatMap((entry) => entry.globalTimeSteps))].sort((left, right) => right - left), series: trajectorySeries }));

    // Adaptive and Stiff against their tolerance, with the work they took.
    const adaptive = config.adaptive;
    const adaptiveRun = engineRun(config.run, { globalTimeStep: config.run.outputInterval });
    const toleranceSeries = [];
    let adaptiveErrors = [];
    for (const [methodLabel, method, suffix, longName] of [['Adaptive', 'dormandPrince54', 'Adaptive', 'Adaptive, Dormand–Prince 5(4)'], ['Stiff', 'rodas4', 'Rodas4', 'Stiff, Rodas4']]) {
        const errors = [];
        for (const relative of adaptive.relativeTolerances) {
            const variant = { method, tolerance: { relative, absolute: relative * adaptive.absoluteFraction } };
            const result = await engine.run(modelPath, variant, adaptiveRun);
            const metrics = errorMetrics(trajectory(result, ids), exact);
            errors.push(metrics.relativeError);
            rows.push(resultRow({ caseName: 'Bouncing ball: against tolerance', model: 'bouncingBall', variant, run: adaptiveRun, errors: metrics, work: result.work, unit: 'm, m/s',
                note: `${result.integration.events} switches located, largest switch-time error ${switchError(result.integration.eventList).toExponential(2)} s; ${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected, ${result.work.modelEvaluations} evaluations of the model` }));
            if (relative === adaptive.switchTolerance) add(`switchTimeError${suffix}`, switchError(result.integration.eventList), `Largest error in a contact's start or end (s), ${methodLabel} at relative tolerance ${relative}`);
        }
        const proportionality = observedOrder(adaptive.relativeTolerances, errors);
        rows.at(-1).note += `; error against tolerance: fitted slope ${proportionality.fitted.toFixed(3)}`;
        add(`toleranceSlope${suffix}`, proportionality.fitted, `${methodLabel}: slope of log error against log tolerance over ${adaptive.relativeTolerances.length} tolerances`);
        add(`toleranceFactor${suffix}`, Math.max(...errors.map((error, index) => error / adaptive.relativeTolerances[index])), `${methodLabel}: largest error over its relative tolerance`);
        toleranceSeries.push(series(`Konjugate, ${longName}`, method, adaptive.relativeTolerances, errors));
        if (method === 'dormandPrince54') adaptiveErrors = errors;
    }
    plots.push(linePlot({ id: 'bouncingBallTolerance', title: 'Bouncing ball: Adaptive\'s and Stiff\'s error against their tolerance', subtitle: 'Largest error relative to range, every contact located',
        xLabel: 'Relative tolerance', yLabel: 'Relative error', logX: true, logY: true, xTicks: adaptive.relativeTolerances,
        series: [...toleranceSeries,
            series('Proportional (slope 1)', 'guide', adaptive.relativeTolerances, adaptive.relativeTolerances.map((relative) => adaptiveErrors[0] * relative / adaptive.relativeTolerances[0]))] }));
    add('exactRestitution', restitutions[0], 'The exact model\'s first bounce: exit speed over entry speed, from its closed form (about e^(-ζπ/√(1-ζ²)))');
    return { rows, checks, plots, notes: [`The exact motion over ${config.run.targetTime} s has ${contacts.length} contacts; each returns ${restitutions.map((value) => value.toFixed(4)).join(', ')} of its entry speed (a contact that ends where the height crosses zero, not where the force does, so slightly more than e^(-ζπ/√(1-ζ²)) = ${Math.exp(-0.1 * Math.PI / Math.sqrt(1 - 0.01)).toFixed(4)}).`] };
}
