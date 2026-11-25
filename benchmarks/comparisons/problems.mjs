/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The problems Konjugate is compared on with SciPy, Julia's DifferentialEquations.jl and OpenModelica (benchmarks/README.md, Comparisons
// with established tools). Each is a committed benchmark's own model, or the scaling benchmark's generated grid, so the equations are the
// ones the accuracy benchmarks check; beside the model, each problem states the same equations in a form the other tools are given
// (`kind` and `parameters`, written out again in scipyRunner.py, juliaRunner.jl and the Modelica models), the samples every tool reports
// at, the states compared, the absolute tolerance of each state relative to the relative tolerance, and the reference the error is
// measured against.
//
// State vectors of the other tools, in order:
//   robertson  [A, B, C]
//   vanDerPol  [x, y]
//   lorenz     [x, y, z]
//   linear     the temperatures (and, for the RC network, the heat lost to ambient Q): x' = A x + b, A given as rows of (column, value)
//   buck       [i, v, E_in, E_loss, E_load]
//
// The error of a run is the suite's relative error (lib/metrics.mjs): for each compared state, its largest difference from the reference
// over the samples divided by the reference's range over them; the largest over the states.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOneNode as robertsonModel, rates as robertsonRates, absoluteTolerances as robertsonAbsolute } from '../chemistry/robertson/problem.mjs';
import { build as vanDerPolModel } from '../oscillators/vanDerPol/problem.mjs';
import { buildOneNode as lorenzModel, constants as lorenzConstants } from '../chaos/lorenz/problem.mjs';
import { build as rcModel, linearSystem as rcSystem, reference as rcReference } from '../thermal/rcNetwork/problem.mjs';
import { constants as switchedConstants, buckSwitchedReference, models as switchedModels } from '../electrical/switchedCircuits/problem.mjs';
import { generateGraph, graphDocument } from '../scaling/graphScalability/graphs.mjs';
import { sampleTimes } from '../lib/engine.mjs';

const benchmarks = join(import.meta.dirname, '..');
const committedReference = (path) => JSON.parse(readFileSync(join(benchmarks, path, 'reference.json'), 'utf8'));

// Relative tolerances of every work–precision study, each absolute tolerance this times the state's own scale.
export const tolerances = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10];

// Konjugate's methods and their counterparts (README, Comparisons): explicit Runge–Kutta pairs, Rosenbrock and other one-step implicit
// methods, and multistep BDF.
export const families = {
    explicit: { title: 'Explicit Runge–Kutta pairs', konjugate: ['dormandPrince54', 'tsit5'], scipy: ['RK45', 'DOP853'], julia: ['Tsit5', 'DP5'], openmodelica: [] },
    oneStepImplicit: { title: 'Rosenbrock and implicit Runge–Kutta', konjugate: ['rodas4', 'rodas5p'], scipy: ['Radau'], julia: ['Rodas4', 'Rodas5P'], openmodelica: [] },
    multistep: { title: 'Multistep (BDF) and automatic switching', konjugate: ['bdf'], scipy: ['BDF', 'LSODA'], julia: ['FBDF', 'QNDF'], openmodelica: ['dassl', 'cvode'] }
};

function stateIdOf(document, nodeName, symbol) {
    const node = document.nodes.find((candidate) => candidate.name === nodeName);
    const found = node?.states.find((candidate) => candidate.symbol === symbol);
    if (!found) throw new Error(`No state ${symbol} on node ${nodeName}.`);
    return found.id;
}

function every(samples, stride, count) {
    return Array.from({ length: count }, (_unused, index) => samples[index * stride]);
}

function robertson() {
    const { document, ids } = robertsonModel();
    const run = { targetTime: 1e11, outputInterval: 1e9 };
    return {
        id: 'robertson', title: 'Robertson chemical kinetics', kind: 'robertson', stiff: true,
        parameters: { ...robertsonRates }, initial: [1, 0, 0], document, stateIds: ids, compared: [0, 1, 2],
        // A and C 1e-4, B 1e-10 of the relative tolerance: at 1e-8, the benchmark's own 1e-12 and 1e-18 (chemistry/robertson).
        absoluteScale: [robertsonAbsolute.a / 1e-8, robertsonAbsolute.b / 1e-8, robertsonAbsolute.c / 1e-8],
        run, times: sampleTimes(run.targetTime, run.outputInterval),
        // No closed form, and the committed reference holds only the checkpoints: computed by scipyRunner.py --reference (Radau with the
        // exact Jacobian at rtol 1e-12, restarted at every sample) and checked against the committed checkpoints it shares.
        reference: { computed: 'radau', checkpoints: committedReference('chemistry/robertson') },
        skipped: { explicit: 'An explicit method\'s step is held by stability below about 1e-3 s here, so crossing 1e11 s would take on the order of 1e14 steps.' }
    };
}

function vanDerPol() {
    const { document, ids } = vanDerPolModel(1000);
    const run = { targetTime: 3200, outputInterval: 16 };
    const data = committedReference('oscillators/vanDerPol').cases.mu1000;
    return {
        id: 'vanDerPol', title: 'Van der Pol oscillator, μ = 1000', kind: 'vanDerPol', stiff: true,
        parameters: { mu: 1000 }, initial: [2, 0], document, stateIds: ids, compared: [0, 1], absoluteScale: [1, 1],
        run, times: sampleTimes(run.targetTime, run.outputInterval),
        reference: { samples: every(data.states, 32, 201), source: 'oscillators/vanDerPol/reference.json: SciPy Radau with the exact Jacobian at rtol = atol = 1e-12' },
        skipped: { explicit: 'An explicit method\'s step is held by stability near 3.3/μ on the slow flanks, about 2.4 million steps a period; over two periods its cost says nothing about accuracy.' }
    };
}

function lorenz() {
    const { document, ids } = lorenzModel();
    const run = { targetTime: 10, outputInterval: 0.125 };
    const data = committedReference('chaos/lorenz').cases.trajectory;
    return {
        id: 'lorenz', title: 'Lorenz system, first 10 s', kind: 'lorenz', stiff: false,
        parameters: { sigma: lorenzConstants.sigma, rho: lorenzConstants.rho, beta: lorenzConstants.beta }, initial: [lorenzConstants.x, lorenzConstants.y, lorenzConstants.z],
        document, stateIds: ids, compared: [0, 1, 2], absoluteScale: [1e-3, 1e-3, 1e-3],
        run, times: sampleTimes(run.targetTime, run.outputInterval),
        reference: { samples: every(data.states, 8, 81), source: 'chaos/lorenz/reference.json: Taylor series in 70-digit arithmetic' },
        skipped: {}
    };
}

function rcNetwork() {
    const { document, ids } = rcModel();
    const run = { targetTime: 16384, outputInterval: 256 };
    const { matrix, forcing, initial } = rcSystem();
    const times = sampleTimes(run.targetTime, run.outputInterval);
    return {
        id: 'rcNetwork', title: 'Thermal RC network', kind: 'linear', stiff: false,
        parameters: { rows: matrix.map((row) => row.map((value, column) => [column, value]).filter(([, value]) => value !== 0)), forcing },
        initial, document, stateIds: [...ids.temperatures, ids.heatLost], compared: [0, 1, 2, 3, 4],
        // Temperatures near 300 K, the heat lost to ambient up to about 1e7 J.
        absoluteScale: [0.1, 0.1, 0.1, 0.1, 1e3],
        run, times, reference: { samples: rcReference(times), source: 'the exact solution (matrix exponential, thermal/rcNetwork)' }, skipped: {}
    };
}

function grid(size) {
    const runs = { 256: { targetTime: 20, outputInterval: 2 }, 1024: { targetTime: 40, outputInterval: 4 } };
    const run = runs[size];
    const graph = generateGraph('grid', size);
    const { document, stateIds } = graphDocument(graph, { globalTimeStep: run.outputInterval, outputInterval: run.outputInterval });
    const { offsets, neighbours, coefficients, own } = graph.system;
    const rows = Array.from({ length: graph.nodeCount }, (_unused, index) => {
        let diagonal = own[index];
        const row = [];
        for (let position = offsets[index]; position < offsets[index + 1]; ++position) {
            row.push([neighbours[position], coefficients[position]]);
            diagonal -= coefficients[position];
        }
        return [[index, diagonal], ...row].sort((left, right) => left[0] - right[0]);
    });
    const times = sampleTimes(run.targetTime, run.outputInterval);
    return {
        id: `stiffGrid${size}`, title: `Stiff thermal grid, ${graph.nodeCount} nodes`, kind: 'linear', stiff: true, sparse: true,
        parameters: { rows, forcing: new Array(graph.nodeCount).fill(0), side: graph.sides[0] },
        initial: Array.from(graph.initial), document, stateIds, compared: stateIds.map((_id, index) => index),
        // The stiff network benchmark's own absolute tolerance, 1e-9 at a relative 1e-6 (scaling/stiffNetwork).
        absoluteScale: new Array(graph.nodeCount).fill(1e-3),
        run, times, reference: { samples: times.map((time) => Array.from(graph.exact(time))), source: 'the exact solution (three decaying sine modes, scaling/graphScalability)' },
        skipped: {}
    };
}

function buck() {
    const document = switchedModels.buckSwitched();
    const p = switchedConstants.buck;
    const run = { targetTime: 0.0078125, outputInterval: 7.62939453125e-06 };
    const times = sampleTimes(run.targetTime, run.outputInterval);
    const stateIds = [
        stateIdOf(document, 'Inductor', 'current'), stateIdOf(document, 'Output capacitor and load', 'voltage'),
        stateIdOf(document, 'Inductor', 'inputEnergy'), stateIdOf(document, 'Inductor', 'lossEnergy'), stateIdOf(document, 'Output capacitor and load', 'loadEnergy')
    ];
    return {
        id: 'buck', title: 'Switched buck converter, 156 switching periods', kind: 'buck', stiff: false,
        parameters: { ...p }, initial: [0, 0, 0, 0, 0], document, stateIds, compared: [0, 1], absoluteScale: [1e-3, 1e-3, 1e-3, 1e-3, 1e-3],
        run, times,
        reference: { samples: buckSwitchedReference(times).map((sample) => sample.slice(0, 2)), source: 'the exact solution (matrix exponential across every switching interval, electrical/switchedCircuits)' },
        // Konjugate locates each switch from the condition in its equation; SciPy and Julia are run both with the switch as written in
        // the right-hand side and given the switching instants, which a modeller of a PWM would give them.
        switchingInstants: true, skipped: {}
    };
}

export function comparisonProblems() {
    return [robertson(), vanDerPol(), lorenz(), rcNetwork(), grid(256), grid(1024), buck()];
}

// What the other tools are given: everything but Konjugate's model.
export function toolSpecification(problem, reference) {
    const { document: _document, stateIds: _stateIds, reference: _reference, ...rest } = problem;
    return { ...rest, reference, tolerances, families };
}
