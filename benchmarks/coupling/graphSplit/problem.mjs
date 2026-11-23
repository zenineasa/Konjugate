/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Graph coupling: the same system written as one node and split across three.
//
// Three masses in a row, each tied to the ground by its own spring and damper and to its neighbours by coupling springs:
//     m_i dv_i/dt = -k_i x_i - c_i v_i + Σ_neighbours kc (x_j - x_i)
// Damping is moderate (ζ ≈ 0.2), so explicit Euler is stable at every step in the study and its own energy growth does not swamp the
// coupling error being measured.
//
//   monolithic.kjt  one node with states x1, v1, x2, v2, x3, v3.
//   split.kjt       a node per mass; each coupling spring is a pair of relationships, so each mass reads its neighbours through the snapshot
//                   taken at the start of each global step (docs/parallelExecution.md). The middle mass reads two.
//
// A node that takes n substeps inside a global step H advances its own states n times while its neighbours' stay frozen at the
// snapshot. With n = 1 nothing is frozen that explicit Euler would not freeze anyway, and the split model takes exactly the monolithic
// model's steps. With n > 1 the frozen neighbours are an extra error, first order in H: the coupling error, measured here as the split
// model's difference from the monolithic model run at the same effective step H/n. More substeps shrink the error of each node's own
// integration, but not the coupling error; a smaller global step shrinks both.
//
// Runge–Kutta 4 (docs/proposals/integrators.md) is applied to the whole model at once: at every stage each node reads every node's stage
// values, the coupling included, so the split model is the one-node model -- the same method on the same equations -- and its error
// against the exact solution has the method's order, four, rather than the snapshot's one. Dormand–Prince 5(4) does the same at fifth
// order with its error control off, and under Adaptive, its error control on, the split model still takes the one-node model's steps:
// its error norm is summed node by node, so the two differ only by rounding. Rodas4, the stiff method, does the same at fourth order with
// its error control off, its Jacobian built from the graph's structure, and the split model is the one-node model to the bit: the same
// equations give the same Jacobian whatever its colouring, and the same solves. Under Stiff, its error control on, the error norm is
// summed node by node in the split model and in one group in the one-node model, so a rounding difference can tip a step's acceptance:
// the two take equally valid steps and agree within the tolerance's reach, not to rounding.
//
// Reference: the system is linear, so it is exact by the matrix exponential.

import { join } from 'node:path';
import { affineSolution } from '../../lib/linearAlgebra.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { sampleTimes, trajectory } from '../../lib/engine.mjs';
import { createModel, difference, negate, parameter, product, quotient, state } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const monolithicPath = join(directory, 'monolithic.kjt');
export const splitPath = join(directory, 'split.kjt');
export const constants = Object.freeze({
    masses: [
        { mass: 1, groundStiffness: 4, damping: 1, initialDisplacement: 1 },
        { mass: 2, groundStiffness: 3, damping: 1, initialDisplacement: 0 },
        { mass: 1.5, groundStiffness: 5, damping: 1, initialDisplacement: -0.5 }
    ],
    couplingStiffness: 2
});
const neighbours = (index) => [index - 1, index + 1].filter((other) => other >= 0 && other < constants.masses.length);

function addOwnDynamics(model, node, [x, v], { mass, groundStiffness, damping }) {
    model.sourceTerm(node, x, v, { [v]: state(node, v) });
    model.sourceTerm(node, v, quotient(negate(['Add', product('groundStiffness', x), product('damping', v)]), 'mass'), {
        groundStiffness: parameter('Ground spring stiffness', groundStiffness, 'N/m'), [x]: state(node, x), damping: parameter('Damping', damping, 'N s/m'), [v]: state(node, v), mass: parameter('Mass', mass, 'kg')
    });
}

const couplingForce = (own, other) => quotient(product('couplingStiffness', difference(other, own)), 'mass');

export function buildMonolithic() {
    const model = createModel('Benchmark: three coupled masses, one node');
    const symbols = constants.masses.map((_mass, index) => [`x${index + 1}`, `v${index + 1}`]);
    const body = model.node('Three masses', { type: 'Coupled oscillators', color: '#5d7885', states: constants.masses.flatMap((properties, index) => [
        [symbols[index][0], `Mass ${index + 1} displacement`, properties.initialDisplacement, 'm'], [symbols[index][1], `Mass ${index + 1} velocity`, 0, 'm/s']
    ]) });
    constants.masses.forEach((properties, index) => addOwnDynamics(model, body, symbols[index], properties));
    constants.masses.forEach((properties, index) => {
        for (const other of neighbours(index)) {
            const [own] = symbols[index];
            const [otherX] = symbols[other];
            model.sourceTerm(body, symbols[index][1], couplingForce(own, otherX), {
                couplingStiffness: parameter('Coupling stiffness', constants.couplingStiffness, 'N/m'), [own]: state(body, own), [otherX]: state(body, otherX), mass: parameter('Mass', properties.mass, 'kg')
            });
        }
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -6, outputInterval: 0.125 } }), ids: symbols.flat().map((symbol) => body.stateIds[symbol]) };
}

export function buildSplit() {
    const model = createModel('Benchmark: three coupled masses, three nodes');
    const nodes = constants.masses.map((properties, index) => {
        const node = model.node(`Mass ${index + 1}`, { type: 'Spring-mass', position: [index * 3, 0, 0], color: '#5d7885', states: [
            ['displacement', 'Displacement', properties.initialDisplacement, 'm'], ['velocity', 'Velocity', 0, 'm/s']
        ] });
        addOwnDynamics(model, node, ['displacement', 'velocity'], properties);
        return node;
    });
    constants.masses.forEach((properties, index) => {
        for (const other of neighbours(index)) {
            model.edge(`Coupling spring from mass ${other + 1} on mass ${index + 1}`, nodes[other], nodes[index], 'velocity', couplingForce('ownDisplacement', 'otherDisplacement'), {
                couplingStiffness: parameter('Coupling stiffness', constants.couplingStiffness, 'N/m'),
                ownDisplacement: state(nodes[index], 'displacement'), otherDisplacement: state(nodes[other], 'displacement'), mass: parameter('Mass', properties.mass, 'kg')
            });
        }
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -6, outputInterval: 0.125 } }), ids: nodes.flatMap((node) => [node.stateIds.displacement, node.stateIds.velocity]) };
}

export const models = { monolithic: () => buildMonolithic().document, split: () => buildSplit().document };

export function reference(times) {
    const size = constants.masses.length * 2;
    const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
    constants.masses.forEach(({ mass, groundStiffness, damping }, index) => {
        const x = 2 * index;
        matrix[x][x + 1] = 1;
        matrix[x + 1][x] = -groundStiffness / mass;
        matrix[x + 1][x + 1] = -damping / mass;
        for (const other of neighbours(index)) {
            matrix[x + 1][x] -= constants.couplingStiffness / mass;
            matrix[x + 1][2 * other] += constants.couplingStiffness / mass;
        }
    });
    return affineSolution(matrix, new Array(size).fill(0), constants.masses.flatMap((properties) => [properties.initialDisplacement, 0]), times);
}

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const monolithicIds = buildMonolithic().ids;
    const splitIds = buildSplit().ids;
    const exact = reference(sampleTimes(config.run.targetTime, config.run.outputInterval));
    const monolithicCache = new Map();
    async function monolithic(step, integration = 'explicit') {
        const key = `${integration}:${step}`;
        if (!monolithicCache.has(key)) {
            const variant = integration === 'rungeKutta4' ? { method: 'rungeKutta4' } : { integration };
            const result = await engine.run(monolithicPath, variant, engineRun(config.run, { globalTimeStep: step }));
            monolithicCache.set(key, { result, numeric: trajectory(result, monolithicIds) });
        }
        return monolithicCache.get(key);
    }
    const table = {};
    for (const globalStep of config.globalTimeSteps) {
        for (const substeps of config.substeps) {
            const run = engineRun(config.run, { globalTimeStep: globalStep });
            const split = await engine.run(splitPath, { integration: 'explicit', substeps }, run);
            const splitNumeric = trajectory(split, splitIds);
            const same = await monolithic(globalStep / substeps);
            const total = errorMetrics(splitNumeric, exact);
            const coupling = errorMetrics(splitNumeric, same.numeric);
            const sameStep = errorMetrics(same.numeric, exact);
            table[`${globalStep}:${substeps}`] = { total, coupling, sameStep };
            rows.push(resultRow({
                caseName: 'split, three nodes', model: 'split', variant: { integration: 'explicit', substeps }, run, errors: total, work: split.work, unit: 'm, m/s',
                note: `coupling error (against one node at h = H/n) ${coupling.relativeError.toExponential(2)}; one node at H/n ${sameStep.relativeError.toExponential(2)}`
            }));
        }
    }
    const [coarsest] = config.globalTimeSteps;
    add('couplingErrorOneSubstep', Math.max(...config.globalTimeSteps.map((step) => table[`${step}:1`].coupling.maxAbsError)), 'With one substep, the three-node model against the one-node model at the same step: largest difference (they take the same explicit Euler steps)');
    // The coupling error's order in H, at a fixed number of substeps.
    const fixedSubsteps = config.orderSubsteps;
    const couplingErrors = config.globalTimeSteps.map((step) => table[`${step}:${fixedSubsteps}`].coupling.relativeError);
    const couplingOrder = observedOrder(config.globalTimeSteps, couplingErrors);
    add('couplingErrorOrder', couplingOrder.fitted, `Observed order of the coupling error in the global step H, at ${fixedSubsteps} substeps (fitted over all H)`);
    rows.push(resultRow({ caseName: 'coupling error order in H', model: 'split', variant: { integration: 'explicit', substeps: fixedSubsteps }, observedOrder: couplingOrder.fitted,
        note: `pairwise ${couplingOrder.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
    // At a fixed global step, substeps reduce the split model's error only down to the coupling error.
    const largestSubsteps = config.substeps.at(-1);
    const atCoarse = table[`${coarsest}:${largestSubsteps}`];
    add('substepsFloorRatio', atCoarse.total.relativeError / atCoarse.coupling.relativeError, `At H = 2^${Math.log2(coarsest)} s and ${largestSubsteps} substeps, the split model's error over its coupling error: near 1 once substeps have removed the nodes' own error`);
    add('couplingFactorPerSubstepDoubling', table[`${coarsest}:${largestSubsteps}`].coupling.relativeError / table[`${coarsest}:${config.substeps.at(-2)}`].coupling.relativeError,
        'Coupling error at the largest substep count over the next smaller one, same H: near 1 (substeps do not remove it)');

    // Semi-implicit: within a node the states are updated in turn; across nodes the snapshot still holds, so even with one substep the
    // split model no longer matches the one-node model.
    const run = engineRun(config.run);
    const semiSplit = trajectory(await engine.run(splitPath, { integration: 'semiImplicit' }, run), splitIds);
    const semiOne = (await monolithic(run.globalTimeStep, 'semiImplicit')).numeric;
    for (const [name, numeric, model] of [['one node', semiOne, 'monolithic'], ['split, three nodes', semiSplit, 'split']]) {
        rows.push(resultRow({ caseName: name, model, variant: { integration: 'semiImplicit' }, run, errors: errorMetrics(numeric, exact), unit: 'm, m/s' }));
    }
    rows.push(resultRow({ caseName: 'one node', model: 'monolithic', variant: { integration: 'explicit' }, run, errors: errorMetrics((await monolithic(run.globalTimeStep)).numeric, exact), unit: 'm, m/s' }));
    add('semiImplicitSplitDifference', errorMetrics(semiSplit, semiOne).relativeError, 'Semi-implicit, one substep: split against one node, relative to range (the snapshot makes the coupling explicit)');

    // Runge–Kutta 4, the whole model at once: the split model against the one-node model, and its error's order in H.
    const rungeKutta4Errors = [];
    let rungeKutta4Difference = 0;
    for (const globalStep of config.globalTimeSteps) {
        const stepRun = engineRun(config.run, { globalTimeStep: globalStep });
        const split = await engine.run(splitPath, { method: 'rungeKutta4' }, stepRun);
        const splitNumeric = trajectory(split, splitIds);
        const one = (await monolithic(globalStep, 'rungeKutta4')).numeric;
        const total = errorMetrics(splitNumeric, exact);
        const difference = errorMetrics(splitNumeric, one).relativeError;
        rungeKutta4Difference = Math.max(rungeKutta4Difference, difference);
        rungeKutta4Errors.push(total.relativeError);
        rows.push(resultRow({
            caseName: 'split, three nodes', model: 'split', variant: { method: 'rungeKutta4' }, run: stepRun, errors: total, work: split.work, unit: 'm, m/s',
            note: `against one node at the same step ${difference.toExponential(2)}`
        }));
    }
    add('rungeKutta4SplitDifference', rungeKutta4Difference, 'Runge–Kutta 4: the three-node model against the one-node model at the same step, relative to range, largest over every H (the same method on the same equations)');
    const rungeKutta4Order = observedOrder(config.globalTimeSteps, rungeKutta4Errors);
    add('rungeKutta4ErrorOrder', rungeKutta4Order.fitted, 'Runge–Kutta 4: observed order of the three-node model\'s error against the exact solution in H (fitted over all H)');
    add('rungeKutta4FinestErrorOrder', rungeKutta4Order.finest, 'Runge–Kutta 4: observed order of the three-node model\'s error from the finest halving of H');
    rows.push(resultRow({ caseName: 'error order in H', model: 'split', variant: { method: 'rungeKutta4' }, observedOrder: rungeKutta4Order.fitted,
        note: `pairwise ${rungeKutta4Order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));

    // Dormand–Prince 5(4): at fixed steps, the order of the three-node model's error in H; under Adaptive, the split model against the
    // one-node model at each tolerance.
    const dormandPrince = config.dormandPrince54;
    const dormandPrinceErrors = [];
    for (const globalStep of dormandPrince.globalTimeSteps) {
        const stepRun = engineRun(config.run, { globalTimeStep: globalStep });
        const variant = { method: 'dormandPrince54', stepsPerGlobalStep: 1 };
        const split = await engine.run(splitPath, variant, stepRun);
        const total = errorMetrics(trajectory(split, splitIds), exact);
        dormandPrinceErrors.push(total.relativeError);
        rows.push(resultRow({ caseName: 'split, three nodes', model: 'split', variant, run: stepRun, errors: total, work: split.work, unit: 'm, m/s' }));
    }
    const dormandPrinceOrder = observedOrder(dormandPrince.globalTimeSteps, dormandPrinceErrors);
    add('dormandPrince54ErrorOrder', dormandPrinceOrder.fitted, 'Dormand–Prince 5(4), error control off: observed order of the three-node model\'s error against the exact solution in H (fitted over all H)');
    add('dormandPrince54FinestErrorOrder', dormandPrinceOrder.finest, 'Dormand–Prince 5(4), error control off: observed order of the three-node model\'s error from the finest halving of H');
    rows.push(resultRow({ caseName: 'error order in H', model: 'split', variant: { method: 'dormandPrince54', stepsPerGlobalStep: 1 }, observedOrder: dormandPrinceOrder.fitted,
        note: `pairwise ${dormandPrinceOrder.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
    let adaptiveDifference = 0;
    const adaptiveRun = engineRun(config.run, { globalTimeStep: dormandPrince.adaptiveGlobalTimeStep });
    for (const relative of dormandPrince.relativeTolerances) {
        const variant = { method: 'dormandPrince54', tolerance: { relative, absolute: relative * 1e-3 } };
        const split = await engine.run(splitPath, variant, adaptiveRun);
        const splitNumeric = trajectory(split, splitIds);
        const one = await engine.run(monolithicPath, variant, adaptiveRun);
        const difference = errorMetrics(splitNumeric, trajectory(one, monolithicIds)).relativeError;
        adaptiveDifference = Math.max(adaptiveDifference, difference);
        rows.push(resultRow({
            caseName: 'split, three nodes', model: 'split', variant, run: adaptiveRun, errors: errorMetrics(splitNumeric, exact), work: split.work, unit: 'm, m/s',
            note: `against one node with the same tolerance ${difference.toExponential(2)}; ${split.work.methodSteps} steps (one node ${one.work.methodSteps}), ${split.work.rejectedSteps} rejected`
        }));
    }
    add('adaptiveSplitDifference', adaptiveDifference, 'Adaptive: the three-node model against the one-node model at the same tolerance, relative to range, largest over every tolerance (the error norm summed node by node)');

    // Rodas4: at fixed steps, the split model against the one-node model and the order of its error in H; under Stiff, the split model
    // against the one-node model at each tolerance.
    const rodas = config.rodas4;
    const rodasErrors = [];
    let rodasDifference = 0;
    for (const globalStep of rodas.globalTimeSteps) {
        const stepRun = engineRun(config.run, { globalTimeStep: globalStep });
        const variant = { method: 'rodas4', stepsPerGlobalStep: 1 };
        const split = await engine.run(splitPath, variant, stepRun);
        const splitNumeric = trajectory(split, splitIds);
        const one = await engine.run(monolithicPath, variant, stepRun);
        const difference = errorMetrics(splitNumeric, trajectory(one, monolithicIds)).relativeError;
        rodasDifference = Math.max(rodasDifference, difference);
        const total = errorMetrics(splitNumeric, exact);
        rodasErrors.push(total.relativeError);
        rows.push(resultRow({ caseName: 'split, three nodes', model: 'split', variant, run: stepRun, errors: total, work: split.work, unit: 'm, m/s',
            note: `against one node at the same step ${difference.toExponential(2)}; ${split.work.jacobians} Jacobians` }));
    }
    add('rodas4SplitDifference', rodasDifference, 'Rodas4, error control off: the three-node model against the one-node model at the same step, relative to range, largest over every H');
    const rodasOrder = observedOrder(rodas.globalTimeSteps, rodasErrors);
    add('rodas4ErrorOrder', rodasOrder.fitted, 'Rodas4, error control off: observed order of the three-node model\'s error against the exact solution in H (fitted over all H)');
    add('rodas4FinestErrorOrder', rodasOrder.finest, 'Rodas4, error control off: observed order of the three-node model\'s error from the finest halving of H');
    rows.push(resultRow({ caseName: 'error order in H', model: 'split', variant: { method: 'rodas4', stepsPerGlobalStep: 1 }, observedOrder: rodasOrder.fitted,
        note: `pairwise ${rodasOrder.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
    let stiffDifference = 0;
    const stiffRun = engineRun(config.run, { globalTimeStep: rodas.stiffGlobalTimeStep });
    for (const relative of rodas.relativeTolerances) {
        const variant = { method: 'rodas4', tolerance: { relative, absolute: relative * 1e-3 } };
        const split = await engine.run(splitPath, variant, stiffRun);
        const splitNumeric = trajectory(split, splitIds);
        const one = await engine.run(monolithicPath, variant, stiffRun);
        const difference = errorMetrics(splitNumeric, trajectory(one, monolithicIds)).relativeError;
        stiffDifference = Math.max(stiffDifference, difference / relative);
        rows.push(resultRow({
            caseName: 'split, three nodes', model: 'split', variant, run: stiffRun, errors: errorMetrics(splitNumeric, exact), work: split.work, unit: 'm, m/s',
            note: `against one node with the same tolerance ${difference.toExponential(2)}; ${split.work.methodSteps} steps (one node ${one.work.methodSteps}), ${split.work.rejectedSteps} rejected`
        }));
    }
    add('stiffSplitDifference', stiffDifference, 'Stiff: the three-node model against the one-node model at the same tolerance, relative to range, over the relative tolerance, largest over every tolerance');

    const log2 = (value) => `2^${Math.log2(value)}`;
    plots.push(linePlot({
        id: 'couplingSubsteps', title: 'Substeps at a fixed global step', subtitle: `Error relative to range against the exact solution, H = ${log2(coarsest)} s`, xLabel: 'Substeps per global step (n)', yLabel: 'Relative error', logX: true, logY: true, xTicks: config.substeps,
        series: [
            series('Split, three nodes, H with n substeps', 'explicit', config.substeps, config.substeps.map((n) => table[`${coarsest}:${n}`].total.relativeError)),
            series('One node at the same step H/n', 'reference', config.substeps, config.substeps.map((n) => table[`${coarsest}:${n}`].sameStep.relativeError)),
            series('Coupling error (split against one node)', 'semiImplicit', config.substeps.slice(1), config.substeps.slice(1).map((n) => table[`${coarsest}:${n}`].coupling.relativeError))
        ]
    }));
    plots.push(linePlot({
        id: 'couplingGlobalStep', title: 'Coupling error against the global step', subtitle: 'Split model against one node at the same effective step, relative to range', xLabel: 'Global step H (s)', yLabel: 'Relative coupling error', logX: true, logY: true, xTicks: config.globalTimeSteps,
        series: config.substeps.slice(1).filter((n) => [2, 4, largestSubsteps].includes(n)).map((n, index) => series(`${n} substeps`, ['explicit', 'semiImplicit', 'extra'][index], config.globalTimeSteps, config.globalTimeSteps.map((step) => table[`${step}:${n}`].coupling.relativeError)))
            .concat([series('First order (slope 1)', 'guide', config.globalTimeSteps, config.globalTimeSteps.map((step) => couplingErrors[0] * step / config.globalTimeSteps[0]))])
    }));
    plots.push(linePlot({
        id: 'couplingRungeKutta4', title: 'Three nodes under Runge–Kutta 4, Dormand–Prince 5(4) and Rodas4', subtitle: 'Error of the three-node model against the exact solution, relative to range', xLabel: 'Global step H (s)', yLabel: 'Relative error', logX: true, logY: true, xTicks: config.globalTimeSteps,
        series: [
            series('Explicit Euler, one substep', 'explicit', config.globalTimeSteps, config.globalTimeSteps.map((step) => table[`${step}:1`].total.relativeError)),
            series(`Explicit Euler, ${largestSubsteps} substeps`, 'semiImplicit', config.globalTimeSteps, config.globalTimeSteps.map((step) => table[`${step}:${largestSubsteps}`].total.relativeError)),
            series('Runge–Kutta 4, the whole model', 'rungeKutta4', config.globalTimeSteps, rungeKutta4Errors),
            series('Fourth order (slope 4)', 'guide', config.globalTimeSteps, config.globalTimeSteps.map((step) => rungeKutta4Errors[0] * (step / config.globalTimeSteps[0]) ** 4)),
            series('Dormand–Prince 5(4), error control off', 'dormandPrince54', dormandPrince.globalTimeSteps, dormandPrinceErrors),
            series('Fifth order (slope 5)', 'guide', dormandPrince.globalTimeSteps, dormandPrince.globalTimeSteps.map((step) => dormandPrinceErrors[0] * (step / dormandPrince.globalTimeSteps[0]) ** 5)),
            series('Rodas4, error control off', 'rodas4', rodas.globalTimeSteps, rodasErrors)
        ]
    }));
    return { rows, checks, plots, notes: [
        'Under Runge–Kutta 4 every node reads every node\'s stage values, so the three-node model gives the one-node model\'s numbers: the coupling error substeps cannot remove is gone, and the error falls sixteen-fold per halving of the global step.',
        'Dormand–Prince 5(4) does the same at fifth order, thirty-two-fold per halving; under Adaptive the three-node model chooses the one-node model\'s steps, so the two agree to rounding at every tolerance.',
        'Rodas4 at fixed steps gives the three-node model the one-node model\'s bits, at fourth order. Under Stiff the two sum their error norm in different groups, so they may take different, equally valid steps: they agree within a small multiple of the tolerance, not to rounding.'
    ] };
}
