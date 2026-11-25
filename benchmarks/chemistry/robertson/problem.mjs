/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Robertson's chemical kinetics (Robertson, 1966; Hairer and Wanner, Solving Ordinary Differential Equations II, IV.1), the classic stiff
// problem: three species, A → B slowly, B + B → C + B very fast, B + C → A + C fast, from A = 1:
//     dA/dt = -0.04 A + 1e4 B C
//     dB/dt =  0.04 A - 1e4 B C - 3e7 B²
//     dC/dt =  3e7 B²
// B settles within about 1e-3 s at a concentration near 4e-5, and the rest unfolds over 1e11 s: rates differing by fourteen orders of
// magnitude. An explicit method's step is held by stability to below about 1e-3 s however slowly the concentrations then change, so
// only a stiff method can cross 1e11 s. The total, A + B + C, is 1 at every instant: every reaction moves concentration from one species
// to another.
//
// oneNode.kjt holds the three species in one node. twoNodes.kjt splits them: A on its own and B with C, joined by one bidirectional
// relationship whose flux, 0.04 A - 1e4 B C, leaves A and enters B. Not three: a relationship reads only the two nodes it joins, and the
// third reaction's rate reads B and C together. Each species sets its own absolute tolerance (numerics.absoluteTolerance), 1e-12 for A
// and C and 1e-18 for B, whose concentration falls to 1e-13: one absolute tolerance cannot suit both, as the proposal says.
//
// Reported, under Stiff (Rodas4, docs/proposals/integrators.md) and under BDF beside it: the concentrations at Hairer and Wanner's checkpoints 0.4, 4, ..., 4e10 s
// and at 1e11 s, each run on its own with the global step its whole length, against the reference, as the largest relative error of each
// species; the total's largest departure from 1; the most negative concentration reached; the steps and work to 1e11 s; the two-node model
// against the one-node model; and Adaptive over the first 40 s beside it, the steps each takes.
//
// Reference (reference.json): SciPy solve_ivp, Radau with the exact Jacobian at rtol = 1e-12 with an absolute tolerance per species,
// checked against BDF at the same tolerances and against the IVP test set's published values at 1e11.

import { join } from 'node:path';
import { createModel, difference, negate, parameter, product, square, state, sum } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
const modelPath = (name) => join(directory, `${name}.kjt`);
export const rates = Object.freeze({ k1: 0.04, k2: 3e7, k3: 1e4 });
// Each species' own absolute tolerance: B's concentration is eleven orders of magnitude below the others'.
export const absoluteTolerances = Object.freeze({ a: 1e-12, b: 1e-18, c: 1e-12 });

const k1 = () => parameter('A to B', rates.k1, '1/s');
const k2 = () => parameter('B + B to C + B', rates.k2, '1/s');
const k3 = () => parameter('B + C to A + C', rates.k3, '1/s');

function withTolerances(document) {
    for (const node of document.nodes) {
        for (const species of node.states) species.numerics = { absoluteTolerance: absoluteTolerances[species.symbol] };
    }
    return document;
}

export function buildOneNode() {
    const model = createModel('Benchmark: Robertson chemical kinetics, one node');
    const reactor = model.node('Reactor', { type: 'Reaction vessel', color: '#7f8c4a', states: [
        ['a', 'Species A', 1, 'mol/L'], ['b', 'Species B', 0, 'mol/L'], ['c', 'Species C', 0, 'mol/L']
    ] });
    const species = { a: state(reactor, 'a'), b: state(reactor, 'b'), c: state(reactor, 'c') };
    model.sourceTerm(reactor, 'a', sum(negate(product('k1', 'a')), product('k3', 'b', 'c')), { k1: k1(), k3: k3(), a: species.a, b: species.b, c: species.c });
    model.sourceTerm(reactor, 'b', difference(difference(product('k1', 'a'), product('k3', 'b', 'c')), product('k2', square('b'))),
        { k1: k1(), k2: k2(), k3: k3(), a: species.a, b: species.b, c: species.c });
    model.sourceTerm(reactor, 'c', product('k2', square('b')), { k2: k2(), b: species.b });
    const document = withTolerances(model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 40, outputInterval: 40 } }));
    return { document, ids: [reactor.stateIds.a, reactor.stateIds.b, reactor.stateIds.c] };
}

export function buildTwoNodes() {
    const model = createModel('Benchmark: Robertson chemical kinetics, two nodes');
    const first = model.node('Species A', { type: 'Reaction vessel', color: '#7f8c4a', states: [['a', 'Species A', 1, 'mol/L']] });
    const rest = model.node('Species B and C', { type: 'Reaction vessel', position: [3, 0, 0], color: '#8c6d4a', states: [
        ['b', 'Species B', 0, 'mol/L'], ['c', 'Species C', 0, 'mol/L']
    ] });
    // B + B → C + B, within the node.
    model.sourceTerm(rest, 'b', negate(product('k2', square('b'))), { k2: k2(), b: state(rest, 'b') });
    model.sourceTerm(rest, 'c', product('k2', square('b')), { k2: k2(), b: state(rest, 'b') });
    // A → B and B + C → A + C: one flux from A into B, 0.04 A - 1e4 B C; bidirectional, so what enters B leaves A.
    model.edge('Exchange of A and B', first, rest, 'b', difference(product('k1', 'a'), product('k3', 'b', 'c')),
        { k1: k1(), k3: k3(), a: state(first, 'a'), b: state(rest, 'b'), c: state(rest, 'c') });
    const document = withTolerances(model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 40, outputInterval: 40 } }));
    document.edges[0].directionality = 'bidirectional';
    return { document, ids: [first.stateIds.a, rest.stateIds.b, rest.stateIds.c] };
}

export const models = { oneNode: () => buildOneNode().document, twoNodes: () => buildTwoNodes().document };

const at = (result, ids) => ids.map((id) => result.values.get(id).at(-1));

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const data = referenceData(directory);
    // Stiff (Rodas4), and BDF and Rodas5P beside it: each check of theirs is named as Rodas4's with Bdf or Rodas5p after it.
    const variants = [[config.variant, ''], ...(config.bdfVariant ? [[config.bdfVariant, 'Bdf']] : []), ...(config.rodas5pVariant ? [[config.rodas5pVariant, 'Rodas5p']] : [])];
    const methodLabels = { '': 'Stiff', Bdf: 'BDF', Rodas5p: 'Rodas5P' };
    const byModel = {};
    // The one-node model's largest error over every checkpoint and species, and the work to 1e11 s, for the Jacobian's comparison below.
    const measured = {};
    for (const [variant, suffix] of variants) for (const [name, build] of [['oneNode', buildOneNode], ['twoNodes', buildTwoNodes]]) {
        const method = methodLabels[suffix];
        const ids = build().ids;
        const values = [];
        let steps = 0;
        let evaluations = 0;
        let linearAlgebra = '';
        let worst = [0, 0, 0];
        let conservation = 0;
        let lowest = Infinity;
        for (const [index, time] of data.times.entries()) {
            // Each checkpoint its own run, its global step the whole run, so every step lands only where the method chooses.
            const run = engineRun({ targetTime: time, globalTimeStep: time, outputInterval: time });
            const result = await engine.run(modelPath(name), variant, run);
            const reached = at(result, ids);
            values.push(reached);
            const reference = data.states[index];
            worst = worst.map((value, species) => Math.max(value, Math.abs(reached[species] - reference[species]) / reference[species]));
            conservation = Math.max(conservation, Math.abs(reached[0] + reached[1] + reached[2] - 1));
            lowest = Math.min(lowest, ...reached);
            if (time === data.times.at(-1)) {
                steps = result.work.methodSteps;
                evaluations = result.work.modelEvaluations;
                linearAlgebra = `${result.work.jacobians} Jacobians and ${result.work.factorisations} factorisations`;
            }
            rows.push(resultRow({ caseName: `Robertson, ${name === 'oneNode' ? 'one node' : 'two nodes'}: t = ${time.toExponential(1)} s`, model: name, variant, run, work: result.work, unit: 'mol/L',
                errors: { relativeError: Math.max(...reached.map((value, species) => Math.abs(value - reference[species]) / reference[species])) },
                conservationError: Math.abs(reached[0] + reached[1] + reached[2] - 1),
                note: `A ${reached[0].toPrecision(10)}, B ${reached[1].toPrecision(10)}, C ${reached[2].toPrecision(10)}; ${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected` }));
        }
        // The whole run to 1e11 s sampled at every 1e9 s too: the total and the concentrations' signs at every sample, not only at the checkpoints.
        const long = await engine.run(modelPath(name), variant, engineRun(config.longRun));
        for (let sample = 0; sample < long.times.length; ++sample) {
            const reached = ids.map((id) => long.values.get(id)[sample]);
            conservation = Math.max(conservation, Math.abs(reached[0] + reached[1] + reached[2] - 1));
            lowest = Math.min(lowest, ...reached);
        }
        byModel[`${name}${suffix}`] = values;
        measured[`${name}${suffix}`] = { worst: Math.max(...worst), evaluations, steps, linearAlgebra };
        const label = `${name === 'oneNode' ? 'OneNode' : 'TwoNodes'}${suffix}`;
        ['A', 'B', 'C'].forEach((species, index) => add(`relativeError${species}${label}`, worst[index], `Robertson, ${name === 'oneNode' ? 'one node' : 'two nodes'}, ${method}: largest relative error of ${species} at the checkpoints 0.4 s to 1e11 s`));
        add(`conservation${label}`, conservation, `Robertson, ${name === 'oneNode' ? 'one node' : 'two nodes'}, ${method}: largest |A + B + C - 1| at the checkpoints and every 1e9 s to 1e11 s`);
        add(`lowestConcentration${label}`, lowest, `Robertson, ${name === 'oneNode' ? 'one node' : 'two nodes'}, ${method}: the lowest concentration reached (negative would be unphysical)`);
        add(`steps${label}`, steps, `Robertson, ${name === 'oneNode' ? 'one node' : 'two nodes'}, ${method}: steps taken from 0 to 1e11 s`);
        notes.push(`${method}, ${name === 'oneNode' ? 'one node' : 'two nodes'}: ${steps.toLocaleString()} steps, ${evaluations.toLocaleString()} evaluations of the model (each Jacobian one evaluation per colour, three here), ${linearAlgebra}, from 0 to 1e11 s at relative tolerance ${variant.tolerance.relative}.`);
    }
    // The exact Jacobian against finite differences (docs/proposals/integrators.md, Jacobians for Rodas4): the one-node model again with
    // the Jacobian worked out by finite differences, as Stiff first did, its largest error at the checkpoints and the work to 1e11 s.
    for (const [variant, suffix, method] of [[config.variant, '', 'Stiff'], ...(config.bdfVariant ? [[config.bdfVariant, 'Bdf', 'BDF']] : [])]) {
        const differenced = { ...variant, jacobian: 'finiteDifference' };
        const ids = buildOneNode().ids;
        let worst = 0;
        let work = null;
        for (const [index, time] of data.times.entries()) {
            const result = await engine.run(modelPath('oneNode'), differenced, engineRun({ targetTime: time, globalTimeStep: time, outputInterval: time }));
            const reached = at(result, ids);
            worst = Math.max(worst, ...reached.map((value, species) => Math.abs(value - data.states[index][species]) / data.states[index][species]));
            if (time === data.times.at(-1)) work = result.work;
        }
        const exact = measured[`oneNode${suffix}`];
        rows.push(resultRow({ caseName: 'Robertson, one node: the exact Jacobian against finite differences', model: 'oneNode', variant: differenced, work, unit: 'mol/L',
            errors: { relativeError: worst }, note: `${work.methodSteps.toLocaleString()} steps and ${work.modelEvaluations.toLocaleString()} evaluations to 1e11 s, against ${
                exact.steps.toLocaleString()} and ${exact.evaluations.toLocaleString()} with the exact Jacobian, whose largest error is ${exact.worst.toExponential(2)}` }));
        const label = suffix || 'Rodas4';
        add(`evaluationRatio${label}`, exact.evaluations / work.modelEvaluations, `Robertson, one node, ${method}: evaluations of the model to 1e11 s with the exact Jacobian over those with finite differences`);
        add(`errorRatio${label}`, exact.worst / worst, `Robertson, one node, ${method}: the largest error at the checkpoints with the exact Jacobian over that with finite differences`);
    }
    // Rodas5P against Rodas4 at the same tolerance: how many times fewer steps the fifth-order method takes to 1e11 s.
    if (measured.oneNodeRodas5p) {
        add('stepRatioRodas5p', measured.oneNode.steps / measured.oneNodeRodas5p.steps, 'Robertson, one node: steps Rodas4 takes to 1e11 s for each step Rodas5P takes, at the same tolerance');
    }
    // The split model against the one node: the same equations under the same tolerances, their error norms summed in different groups.
    const split = Math.max(...byModel.twoNodes.flatMap((reached, index) => reached.map((value, species) => Math.abs(value - byModel.oneNode[index][species]) / data.states[index][species])));
    add('splitDifference', split, 'Robertson, Stiff: the two-node model against the one-node model at every checkpoint, relative to the reference, largest over species');
    if (byModel.oneNodeBdf) {
        const bdfSplit = Math.max(...byModel.twoNodesBdf.flatMap((reached, index) => reached.map((value, species) => Math.abs(value - byModel.oneNodeBdf[index][species]) / data.states[index][species])));
        add('splitDifferenceBdf', bdfSplit, 'Robertson, BDF: the two-node model against the one-node model at every checkpoint, relative to the reference, largest over species');
    }

    // Adaptive over the first 40 s beside Stiff: the steps each takes.
    const comparison = config.explicitComparison;
    const comparisonSteps = {};
    for (const entry of comparison.variants) {
        const result = await engine.run(modelPath('oneNode'), entry, engineRun(comparison.run));
        comparisonSteps[entry.method] = result.work.methodSteps;
        rows.push(resultRow({ caseName: `Robertson, one node: first ${comparison.run.targetTime} s`, model: 'oneNode', variant: entry, run: engineRun(comparison.run), work: result.work, unit: 'mol/L',
            note: `${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected, ${result.work.modelEvaluations} evaluations of the model` }));
    }
    add('explicitStepRatio', comparisonSteps.dormandPrince54 / comparisonSteps.rodas4, `Robertson: steps Adaptive takes over the first ${comparison.run.targetTime} s for each step Stiff takes, at the same tolerances`);
    notes.push(`First ${comparison.run.targetTime} s at the same tolerances: Adaptive took ${comparisonSteps.dormandPrince54.toLocaleString()} steps, Stiff ${comparisonSteps.rodas4.toLocaleString()}. To 1e11 s Adaptive would need about ${(comparisonSteps.dormandPrince54 / comparison.run.targetTime * 1e11).toExponential(0)} steps, held near 1e-3 s by stability.`);

    // The reference's own agreement: Radau against BDF, and against the IVP test set's published values at 1e11.
    add('referenceAgreement', data.radauBdfAgreement, 'The Radau reference against BDF at the same tolerances, relative, worst species and checkpoint');
    add('testSetAgreement', Math.max(...data.states.at(-1).map((value, species) => Math.abs(value - data.testSetAt1e11[species]) / data.testSetAt1e11[species])), 'The Radau reference at 1e11 against the IVP test set\'s published values, relative, worst species');

    plots.push(linePlot({
        id: 'robertsonConcentrations', title: 'Robertson: concentrations against time', subtitle: 'At the checkpoints, 0.4 s to 1e11 s; B multiplied by 1e4 to share the axis', xLabel: 'Time (s)', yLabel: 'Concentration (mol/L)', logX: true,
        series: [
            series('SciPy Radau, A', 'reference', data.times, data.states.map((value) => value[0])),
            series('SciPy Radau, 1e4 B', 'reference', data.times, data.states.map((value) => 1e4 * value[1])),
            series('SciPy Radau, C', 'reference', data.times, data.states.map((value) => value[2])),
            series(`Konjugate, ${methodName(config.variant)}, A`, 'rodas4', data.times, byModel.oneNode.map((value) => value[0])),
            series(`Konjugate, ${methodName(config.variant)}, 1e4 B`, 'rodas4', data.times, byModel.oneNode.map((value) => 1e4 * value[1])),
            series(`Konjugate, ${methodName(config.variant)}, C`, 'rodas4', data.times, byModel.oneNode.map((value) => value[2]))
        ]
    }));
    return { rows, checks, plots, notes };
}
