/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Lotka–Volterra predator and prey over a long run (about 50 cycles).
//     dx/dt = α x - β x y        dy/dt = δ x y - γ y
// Its orbits are closed: V = δ x - γ ln x + β y - α ln y is constant along every one. The benchmark reports how far V drifts, relative
// to V(0) - V*, the orbit's level above the equilibrium (x*, y*) = (γ/δ, α/β); a drift of 1 would mean the orbit had collapsed onto, or
// grown by as much as, its own size.
//
// Two models of the same equations:
//   oneNode.kjt   prey and predator are two states of one node; a semi-implicit node updates the prey first, then the predator from the
//                 new prey.
//   twoNodes.kjt  prey and predator are separate nodes and the predation terms are relationships between them, read through the snapshot.
//                 Each node then holds a single state, so semi-implicit integration has nothing to reorder, and with one substep the
//                 split model takes exactly the explicit Euler steps of the one-node model; the run checks both.
//
// There is no closed-form trajectory. The numerical reference (reference.json) is SciPy's solve_ivp with DOP853 at rtol = atol = 1e-12,
// an independent high-accuracy solution, not absolute truth; its own V drifts by the amount recorded there.

import { join } from 'node:path';
import { trajectory } from '../../lib/engine.mjs';
import { conservationDrift, errorMetrics } from '../../lib/metrics.mjs';
import { createModel, negate, parameter, product, state } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const oneNodePath = join(directory, 'oneNode.kjt');
export const twoNodesPath = join(directory, 'twoNodes.kjt');
export const constants = Object.freeze({ alpha: 1.1, beta: 0.4, delta: 0.1, gamma: 0.4, prey: 10, predator: 10 });

const rate = (name, symbol) => parameter(name, constants[symbol], '1/s');
const interaction = (name, symbol) => parameter(name, constants[symbol], '1/s per individual');

export function buildOneNode() {
    const model = createModel('Benchmark: Lotka–Volterra, one node');
    const ecosystem = model.node('Ecosystem', { type: 'Population model', color: '#4f8a5b', states: [
        ['prey', 'Prey', constants.prey, 'individuals'],
        ['predator', 'Predator', constants.predator, 'individuals']
    ] });
    model.sourceTerm(ecosystem, 'prey', product('alpha', 'prey'), { alpha: rate('Prey growth rate', 'alpha'), prey: state(ecosystem, 'prey') });
    model.sourceTerm(ecosystem, 'prey', negate(product('beta', 'prey', 'predator')), { beta: interaction('Predation rate', 'beta'), prey: state(ecosystem, 'prey'), predator: state(ecosystem, 'predator') });
    model.sourceTerm(ecosystem, 'predator', product('delta', 'prey', 'predator'), { delta: interaction('Predator growth per prey', 'delta'), prey: state(ecosystem, 'prey'), predator: state(ecosystem, 'predator') });
    model.sourceTerm(ecosystem, 'predator', negate(product('gamma', 'predator')), { gamma: rate('Predator death rate', 'gamma'), predator: state(ecosystem, 'predator') });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -6, outputInterval: 0.5 } }), ids: [ecosystem.stateIds.prey, ecosystem.stateIds.predator] };
}

export function buildTwoNodes() {
    const model = createModel('Benchmark: Lotka–Volterra, two nodes');
    const prey = model.node('Prey', { type: 'Population', color: '#4f8a5b', states: [['population', 'Population', constants.prey, 'individuals']] });
    const predator = model.node('Predator', { type: 'Population', position: [3, 0, 0], color: '#8a4f4f', states: [['population', 'Population', constants.predator, 'individuals']] });
    model.sourceTerm(prey, 'population', product('alpha', 'prey'), { alpha: rate('Prey growth rate', 'alpha'), prey: state(prey, 'population') });
    model.edge('Predation', predator, prey, 'population', negate(product('beta', 'prey', 'predator')), {
        beta: interaction('Predation rate', 'beta'), prey: state(prey, 'population'), predator: state(predator, 'population')
    });
    model.edge('Feeding', prey, predator, 'population', product('delta', 'prey', 'predator'), {
        delta: interaction('Predator growth per prey', 'delta'), prey: state(prey, 'population'), predator: state(predator, 'population')
    });
    model.sourceTerm(predator, 'population', negate(product('gamma', 'predator')), { gamma: rate('Predator death rate', 'gamma'), predator: state(predator, 'population') });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -6, outputInterval: 0.5 } }), ids: [prey.stateIds.population, predator.stateIds.population] };
}

export const models = { oneNode: () => buildOneNode().document, twoNodes: () => buildTwoNodes().document };

export function invariant([prey, predator]) {
    const { alpha, beta, delta, gamma } = constants;
    return delta * prey - gamma * Math.log(prey) + beta * predator - alpha * Math.log(predator);
}

export const invariantScale = () => invariant([constants.prey, constants.predator]) - invariant([constants.gamma / constants.delta, constants.alpha / constants.beta]);

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    const exact = data?.cases.longRun;
    const scale = invariantScale();
    const oneNodeIds = buildOneNode().ids;
    const twoNodesIds = buildTwoNodes().ids;
    const kept = {};
    for (const step of config.globalTimeSteps) {
        const run = engineRun(config.longRun, { globalTimeStep: step });
        for (const variant of [{ integration: 'explicit' }, { integration: 'semiImplicit' }]) {
            let result;
            try {
                result = await engine.run(oneNodePath, variant, run);
            } catch (error) {
                if (!error.diverged || step === config.longRun.globalTimeStep) throw error;
                rows.push(resultRow({ caseName: 'Lotka–Volterra, one node', model: 'oneNode', variant, run, errors: { maxAbsError: Infinity, rmse: Infinity, relativeError: Infinity },
                    conservationError: Infinity, unit: 'individuals', note: 'diverged: the engine stopped on a non-finite derivative before the end of the run' }));
                continue;
            }
            const numeric = trajectory(result, oneNodeIds);
            const drift = conservationDrift(numeric.map(invariant), scale);
            const errors = exact ? errorMetrics(numeric, exact.states) : {};
            rows.push(resultRow({ caseName: 'Lotka–Volterra, one node', model: 'oneNode', variant, run, errors, conservationError: drift.maxRelativeDrift, work: result.work, unit: 'individuals',
                note: `errors against SciPy DOP853; conservation = largest drift of V / (V(0) - V*); final ${drift.finalRelativeDrift.toExponential(2)}` }));
            const method = variant.integration === 'explicit' ? 'Explicit' : 'SemiImplicit';
            if (step === config.longRun.globalTimeStep) {
                add(`invariantDrift${method}`, drift.maxRelativeDrift, `Largest drift of V over ${run.targetTime} s, relative to V(0) - V*, one node, ${methodName(variant)}, h = 2^${Math.log2(step)} s`);
                add(`relativeError${method}`, errors.relativeError ?? NaN, `Largest population error against the SciPy reference relative to its range, one node, ${methodName(variant)}, h = 2^${Math.log2(step)} s`);
                kept[variant.integration] = { result, numeric, drift: numeric.map((sample) => (invariant(sample) - invariant(numeric[0])) / scale) };
            }
        }
    }

    // The same equations split over two nodes: with one substep explicit Euler takes the same steps; semi-implicit changes nothing.
    const run = engineRun(config.longRun);
    const split = await engine.run(twoNodesPath, { integration: 'explicit' }, run);
    const splitNumeric = trajectory(split, twoNodesIds);
    const splitDrift = conservationDrift(splitNumeric.map(invariant), scale);
    rows.push(resultRow({ caseName: 'Lotka–Volterra, two nodes', model: 'twoNodes', variant: { integration: 'explicit' }, run, errors: exact ? errorMetrics(splitNumeric, exact.states) : {},
        conservationError: splitDrift.maxRelativeDrift, work: split.work, unit: 'individuals', note: 'prey and predator as separate nodes coupled through the snapshot' }));
    const largestOf = (left, right) => Math.max(...left.map((sample, k) => Math.max(...sample.map((value, j) => Math.abs(value - right[k][j]) / Math.abs(right[k][j])))));
    add('splitMatchesOneNodeExplicit', largestOf(splitNumeric, kept.explicit.numeric), 'Two-node explicit against one-node explicit: largest relative difference (the same Euler steps, summed in another order)');
    const splitSemi = trajectory(await engine.run(twoNodesPath, { integration: 'semiImplicit' }, run), twoNodesIds);
    add('splitSemiImplicitMatchesExplicit', largestOf(splitSemi, splitNumeric), 'Two-node semi-implicit against two-node explicit: identical, since each node holds one state');

    if (exact) {
        add('referenceInvariantDrift', conservationDrift(exact.states.map(invariant), scale).maxRelativeDrift, 'The SciPy reference\'s own drift of V, relative to V(0) - V*: how far the numerical reference itself is from exact');
    } else {
        add('referenceInvariantDrift', NaN, 'reference.json is missing');
    }

    const times = kept.explicit.result.times;
    const label = `h = 2^${Math.log2(config.longRun.globalTimeStep)} s`;
    // The phase portrait covers the first few cycles, finely sampled: over the whole run explicit Euler's outward spiral fills the plot.
    const phaseRun = engineRun(config.phase);
    const phaseExact = data?.cases.phase;
    const phase = {};
    for (const integration of ['explicit', 'semiImplicit']) phase[integration] = trajectory(await engine.run(oneNodePath, { integration }, phaseRun), oneNodeIds);
    plots.push(linePlot({
        id: 'lotkaVolterraPhase', title: 'Lotka–Volterra phase portrait', subtitle: `Predator against prey over the first ${phaseRun.targetTime} s, h = 2^${Math.log2(phaseRun.globalTimeStep)} s`, xLabel: 'Prey', yLabel: 'Predator',
        series: [
            ...(phaseExact ? [series('SciPy DOP853 reference', 'reference', phaseExact.states.map((sample) => sample[0]), phaseExact.states.map((sample) => sample[1]))] : []),
            ...['explicit', 'semiImplicit'].map((integration) => series(`Konjugate, ${methodName({ integration })}`, integration, phase[integration].map((sample) => sample[0]), phase[integration].map((sample) => sample[1])))
        ]
    }));
    plots.push(linePlot({
        id: 'lotkaVolterraInvariant', title: 'Lotka–Volterra conserved quantity', subtitle: `(V(t) - V(0)) / (V(0) - V*), one node, ${label}`, xLabel: 'Time (s)', yLabel: 'Relative drift of V',
        series: ['explicit', 'semiImplicit'].map((integration) => series(`Konjugate, ${methodName({ integration })}`, integration, times, kept[integration].drift))
    }));
    return { rows, checks, plots, notes: [] };
}
