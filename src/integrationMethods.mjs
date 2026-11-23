/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { programSourceVersion } from './providerTemplate.mjs';

// The integration methods a run can use (docs/proposals/integrators.md), named once for the Run dialog, the result's execution
// summary, code export and the benchmarks. A run configuration says `method` only when it is not Euler node by node,
// `stepsPerGlobalStep` only when it is not 1, and Adaptive's `tolerance` only where it is not the default, so a model that uses none of
// them saves exactly as before.

export const defaultIntegrationMethod = 'nodeByNode';

export const integrationMethods = Object.freeze([
    Object.freeze({
        id: 'nodeByNode',
        name: 'Euler, node by node',
        summaryName: 'Euler, node by node',
        description: 'Each node steps on its own, reading the others as they were at the start of the step. Quick, and fine for a first look; first order, so halving the step halves the error.',
        stepsPerGlobalStep: false
    }),
    Object.freeze({
        id: 'rungeKutta4',
        name: 'Runge–Kutta 4',
        summaryName: 'Runge–Kutta 4 (classical, four stages, fourth order)',
        description: 'The whole model is evaluated at four points in each step. Far more accurate for smooth models, for about four times the work a step.',
        stepsPerGlobalStep: true
    }),
    Object.freeze({
        id: 'dormandPrince54',
        name: 'Adaptive',
        summaryName: 'Adaptive: Dormand–Prince 5(4) (seven stages, fifth order, with a fourth-order error estimate)',
        description: 'Chooses its own steps to keep the error within a tolerance, smaller where things change fast. Use it when you want an accurate answer without choosing the step.',
        stepsPerGlobalStep: false,
        tolerance: true
    }),
    Object.freeze({
        id: 'rodas4',
        name: 'Stiff',
        summaryName: 'Stiff: Rodas4 (a six-stage Rosenbrock method, fourth order, with a third-order error estimate, L-stable)',
        description: 'For models with very fast and very slow parts together (chemistry, stiff springs, circuits with tiny time constants), where the others need tiny steps. Solves a set of equations each step.',
        stepsPerGlobalStep: false,
        tolerance: true
    }),
    Object.freeze({
        id: 'bdf',
        name: 'Stiff (BDF)',
        summaryName: 'Stiff, BDF: numerical differentiation formulas of orders 1 to 5, the Jacobian and its factorisation kept from step to step',
        description: 'For models with very fast and very slow parts together (chemistry, stiff springs, circuits with tiny time constants), where the others need tiny steps. Solves a set of equations each step.',
        stepsPerGlobalStep: false,
        tolerance: true,
        // Not a Method of its own: the Run dialog offers it as Stiff's solver for large models (stiffSolvers).
        offered: false
    })
]);

// Stiff's solvers, the choice the Run dialog shows under Stiff (docs/proposals/integrators.md, BDF): the Rosenbrock method, the default,
// and BDF for large models. Each is a method of its own in the file; only Rosenbrock's is the Method list's.
export const stiffSolvers = Object.freeze([
    Object.freeze({ id: 'rodas4', name: 'Rosenbrock (best for most models)', description: 'Works out the equations afresh at every step: robust, and accurate for its tolerance.' }),
    Object.freeze({ id: 'bdf', name: 'BDF (for large models, thousands of states)', description: 'Factorises its equations less often, keeping them from step to step: worth trying on a large model where that work is slow. Close to Rosenbrock\'s accuracy at the same tolerance; best where the model has few jumps (schedules, Updates, events) and oscillates little.' })
]);

// How Stiff works out its Jacobian (docs/proposals/integrators.md, Jacobians for Rodas4 and BDF): exactly from the equations, the
// default; by small changes to each state (finite differences), as it first did; or exactly and checked against finite differences.
export const defaultStiffJacobian = 'analytic';
export const stiffJacobians = Object.freeze([
    Object.freeze({ id: 'analytic', name: 'Exact (from the equations)', description: 'Each equation differentiated exactly; a program\'s terms worked out by small changes. Fewer evaluations, and no error from the Jacobian.' }),
    Object.freeze({ id: 'finiteDifference', name: 'By small changes (finite differences)', description: 'Each state changed a little and the model evaluated again, as Stiff first did: good to about a hundred-millionth of each entry.' }),
    Object.freeze({ id: 'check', name: 'Exact, checked by small changes', description: 'As Exact, and compared at every step with small changes; the run\'s summary says by how much they differ. For checking a model, not for speed.' })
]);

// The Method the Run dialog shows for a method: Stiff for each of Stiff's solvers.
export function dialogMethodOf(method) {
    return stiffSolvers.some((solver) => solver.id === method) ? 'rodas4' : method;
}

// Whether a stiff model suits BDF better than the Rosenbrock solver (the user's decision, docs/proposals/integrators.md, BDF): many
// integrated states, and few discontinuities -- no stored schedules, no Updates or values set from other states, no live parameters,
// and no node that is a program of its own (stepped, and read held, every global step) -- each of which starts BDF's history again.
export const bdfStateThreshold = 2000;
export function bdfSuits(document) {
    const nodes = (document?.nodes ?? []).filter((node) => node.enabled !== false);
    const states = nodes.reduce((sum, node) => sum + (node.states ?? []).filter((state) => state.kind !== 'update').length, 0);
    if (states < bdfStateThreshold) return false;
    if ((document?.sharedParameters ?? []).some((parameter) => parameter.schedule)) return false;
    const jumps = (parameters) => (parameters ?? []).some((parameter) => parameter.mode === 'live' || parameter.schedule);
    if (nodes.some((node) => node.implementation || (node.states ?? []).some((state) => state.kind === 'update')
        || (node.sourceTerms ?? []).some((term) => term.setsValue === true || jumps(term.parameters)))) return false;
    if ((document?.edges ?? []).some((edge) => edge.enabled !== false && jumps(edge.parameters))) return false;
    return true;
}

// Choosing a method: the short guide the Run dialog's "?" opens (beside Method, the Stiff solver and a node's Integration), and the one
// source of docs/choosingAMethod.md (methodGuideMarkdown; scripts/writeMethodGuide.mjs writes it, and a test checks it is current). Each
// sign names what to try and the benchmark that shows it, a path under benchmarks/; a sign's topic is what it is shown first for (the
// Stiff solver's "?", or a node's Integration).
export const benchmarkEvidenceUrl = (path) => `https://github.com/zenineasa/Konjugate/tree/master/benchmarks/${path}`;
export const methodGuide = Object.freeze({
    title: 'Choosing a method',
    lead: 'Start with Euler, node by node. Change the method when you see one of these signs.',
    signs: Object.freeze([
        Object.freeze({
            sign: 'Halving the global step changes the results you care about.',
            advice: 'Use Runge–Kutta 4, or Adaptive to have the steps chosen for you.',
            evidence: Object.freeze([Object.freeze({ name: 'Convergence order', path: 'verification/convergenceOrder' })])
        }),
        Object.freeze({
            sign: 'Energy grows in an oscillator that should keep it: a spring, a pendulum, an LC circuit.',
            topic: 'integration',
            advice: 'On the node\'s Numerics tab, set Integration to Semi-implicit Euler, or Verlet for second order.',
            evidence: Object.freeze([Object.freeze({ name: 'Harmonic oscillator', path: 'mechanical/harmonicOscillator' }), Object.freeze({ name: 'Pendulum', path: 'mechanical/pendulum' })])
        }),
        Object.freeze({
            sign: 'Results jump or lag at a switch: a PWM, a thermostat, a contact.',
            advice: 'Use Runge–Kutta 4, Adaptive or Stiff: each finds the instant a condition switches and steps to it.',
            evidence: Object.freeze([Object.freeze({ name: 'Switched circuits', path: 'electrical/switchedCircuits' }), Object.freeze({ name: 'Bouncing ball', path: 'mechanical/bouncingBall' })])
        }),
        Object.freeze({
            sign: 'Tightly coupled nodes need many substeps, or disagree with the same model built as one node.',
            advice: 'Use Runge–Kutta 4, Adaptive or Stiff, which step every node together.',
            evidence: Object.freeze([Object.freeze({ name: 'Graph split', path: 'coupling/graphSplit' })])
        }),
        Object.freeze({
            sign: 'The model check says the model is stiff, or Adaptive takes tiny steps and rejects many.',
            topic: 'stiff',
            advice: 'Use Stiff.',
            evidence: Object.freeze([Object.freeze({ name: 'Robertson', path: 'chemistry/robertson' }), Object.freeze({ name: 'Van der Pol', path: 'oscillators/vanDerPol' }),
                Object.freeze({ name: 'Prothero–Robinson', path: 'verification/protheroRobinson' })])
        }),
        Object.freeze({
            sign: 'A stiff model with thousands of states is slow under Stiff.',
            topic: 'stiff',
            advice: 'Under Stiff, try the BDF solver, which factorises less often. Keep Rosenbrock if the model switches often.',
            evidence: Object.freeze([Object.freeze({ name: 'Stiff network', path: 'scaling/stiffNetwork' })])
        })
    ]),
    methods: Object.freeze([
        Object.freeze({ name: 'Euler, node by node', use: 'The default. Each node steps on its own: quick, and fine for a first look. A node\'s Integration can be Explicit, Semi-implicit or Verlet.' }),
        Object.freeze({ name: 'Semi-implicit Euler and Verlet', use: 'For a node that oscillates: its energy stays bounded instead of growing. Verlet is second order.' }),
        Object.freeze({ name: 'Runge–Kutta 4', use: 'Smooth models, accurate at a step you choose.' }),
        Object.freeze({ name: 'Adaptive', use: 'An accurate answer without choosing the step: it keeps the error within a tolerance.' }),
        Object.freeze({ name: 'Stiff, Rosenbrock', use: 'Models with very fast and very slow parts together. Best for most stiff models.' }),
        Object.freeze({ name: 'Stiff, BDF', use: 'Large stiff models, thousands of states, that switch rarely: it factorises less often than Rosenbrock, which pays where factorising is slow.' })
    ])
});

// The guide as a documentation page (docs/choosingAMethod.md), its evidence linked to the benchmarks beside it.
export function methodGuideMarkdown() {
    const evidence = (item) => item.evidence.map((entry) => `[${entry.name}](../benchmarks/${entry.path})`).join(', ');
    return [
        '---',
        'type: Guide',
        `title: ${methodGuide.title}`,
        'description: When to use each integration method, from the signs a run shows, with the benchmark behind each. Written from src/integrationMethods.mjs (methodGuide), which the Run dialog\'s "?" shows.',
        'tags: [integration, methods, help, in-app]',
        'status: stable',
        '---',
        '',
        `# ${methodGuide.title}`,
        '',
        '<!-- Written by scripts/writeMethodGuide.mjs from src/integrationMethods.mjs (methodGuide); edit it there. -->',
        '',
        methodGuide.lead,
        '',
        '## Signs',
        '',
        ...methodGuide.signs.map((item) => `* **${item.sign}** ${item.advice} Evidence: ${evidence(item)}.`),
        '',
        '## The methods',
        '',
        ...methodGuide.methods.map((item) => `* **${item.name}**: ${item.use}`),
        ''
    ].join('\n');
}

// The method a stiffness finding offers, by its id: "Use Stiff".
export const stiffIntegrationMethod = 'rodas4';

// Adaptive's tolerances when a run configuration does not say (docs/proposals/integrators.md, decision 4).
export const defaultTolerance = Object.freeze({ relative: 1e-6, absolute: 1e-9 });

export function integrationMethod(id) {
    return integrationMethods.find((method) => method.id === (id ?? defaultIntegrationMethod)) ?? null;
}

// A run configuration's method and its steps per global step, with their defaults.
export function methodOf(configuration) {
    return configuration?.method ?? defaultIntegrationMethod;
}

export function stepsPerGlobalStepOf(configuration) {
    return integrationMethod(methodOf(configuration))?.stepsPerGlobalStep ? (configuration?.stepsPerGlobalStep ?? 1) : 1;
}

// A run configuration's tolerances, each with its default.
export function toleranceOf(configuration) {
    return { relative: configuration?.tolerance?.relative ?? defaultTolerance.relative, absolute: configuration?.tolerance?.absolute ?? defaultTolerance.absolute };
}

// `configuration` with `method`, `stepsPerGlobalStep` and `tolerance` set as chosen, each written only when the method uses it and it is
// not its default (a tolerance, each of its two numbers on its own).
export function withIntegrationMethod(configuration, method, stepsPerGlobalStep = 1, tolerance = defaultTolerance, jacobian = configuration?.jacobian) {
    const result = { ...configuration };
    delete result.method;
    delete result.stepsPerGlobalStep;
    delete result.tolerance;
    delete result.jacobian;
    // Stiff's Jacobian, only when it is not the default.
    if (stiffSolvers.some((solver) => solver.id === method) && jacobian && jacobian !== defaultStiffJacobian) result.jacobian = jacobian;
    if (method && method !== defaultIntegrationMethod) result.method = method;
    if (integrationMethod(method)?.stepsPerGlobalStep && stepsPerGlobalStep !== 1) result.stepsPerGlobalStep = stepsPerGlobalStep;
    if (integrationMethod(method)?.tolerance) {
        const written = {};
        if (tolerance?.relative !== undefined && tolerance.relative !== defaultTolerance.relative) written.relative = tolerance.relative;
        if (tolerance?.absolute !== undefined && tolerance.absolute !== defaultTolerance.absolute) written.absolute = tolerance.absolute;
        if (Object.keys(written).length) result.tolerance = written;
    }
    return result;
}

// What a tolerance says wrong, in plain words, or null: a relative one is a fraction below 1, an absolute one in the state's own unit.
export function toleranceProblem(tolerance) {
    const { relative, absolute } = { ...defaultTolerance, ...tolerance };
    if (!Number.isFinite(relative) || !(relative > 0) || !(relative < 1)) return 'The relative tolerance must be a number greater than 0 and less than 1.';
    if (!Number.isFinite(absolute) || !(absolute > 0)) return 'The absolute tolerance must be a number greater than 0.';
    return null;
}

// What a project document's method, steps per global step and tolerance say wrong, in plain words, or null.
export function integrationMethodProblem(method, stepsPerGlobalStep, tolerance) {
    if (!integrationMethod(method)) return `The method “${method}” is not one this version of Konjugate knows.`;
    if (!Number.isInteger(stepsPerGlobalStep) || stepsPerGlobalStep < 1 || stepsPerGlobalStep > 10000) {
        return 'Steps per global step must be a whole number from 1 through 10,000.';
    }
    if (integrationMethod(method).tolerance && tolerance !== undefined) return toleranceProblem(tolerance);
    return null;
}

// A state's own absolute tolerance (numerics.absoluteTolerance, docs/proposals/integrators.md), or undefined when it has none.
export function stateAbsoluteToleranceOf(state) {
    return state?.numerics?.absoluteTolerance;
}

// `state` with its own absolute tolerance set, or removed when `value` is undefined; `numerics` is written only while it holds one.
export function withStateAbsoluteTolerance(state, value) {
    const result = { ...state };
    const numerics = { ...(state?.numerics ?? {}) };
    delete numerics.absoluteTolerance;
    if (value !== undefined) numerics.absoluteTolerance = value;
    if (Object.keys(numerics).length) result.numerics = numerics;
    else delete result.numerics;
    return result;
}

// Under a whole-model method, what cannot take part in its stages (docs/proposals/integrators.md, Programs and Nodes that cannot take
// stages): a node that is a program of its own in the older program format (an imported FMU among them) is stepped on its own, and a term
// written as a program in the older format is held, evaluated once per global step; a version 1 program cannot be known to be pure, and a
// version 2 program takes every stage (docs/proposals/programSdkV2.md). Each with the name to show; `older` lists every program in the
// older format with where it is, for "Convert to version 2 ›".
export function stageParticipation(document) {
    const nodes = (document?.nodes ?? []).filter((node) => node.enabled !== false);
    const nodeName = new Map(nodes.map((node) => [node.id, node.name || `Node ${node.id}`]));
    const older = (implementation) => (implementation?.kind === 'cpp' || implementation?.kind === 'python')
        && programSourceVersion(implementation.kind, implementation.source) === 1;
    const stepped = [];
    const programs = [];
    const olderPrograms = [];
    for (const node of nodes) {
        if (node.implementation && (node.implementation.kind === 'fmi' || older(node.implementation))) {
            stepped.push(nodeName.get(node.id));
            if (older(node.implementation)) olderPrograms.push({ name: `${nodeName.get(node.id)}'s program`, target: { type: 'node', nodeId: node.id } });
        }
        for (const term of node.sourceTerms ?? []) {
            if (!term.implementation || term.setsValue === true || !older(term.implementation)) continue;
            const name = `${nodeName.get(node.id)}'s ${term.state ?? 'term'}`;
            programs.push(name);
            olderPrograms.push({ name, target: { type: 'sourceTerm', nodeId: node.id, termId: term.id } });
        }
    }
    for (const edge of document?.edges ?? []) {
        if (edge.enabled === false || !nodeName.has(edge.source?.nodeId) || !nodeName.has(edge.target?.nodeId)) continue;
        if (!edge.implementation || !older(edge.implementation)) continue;
        const name = edge.name || `Relationship ${edge.id}`;
        programs.push(name);
        olderPrograms.push({ name, target: { type: 'edge', edgeId: edge.id } });
    }
    return { stepped, programs, older: olderPrograms };
}

// A short list of names: the first few, then how many more.
export function nameList(names, shown = 4) {
    if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
    return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}
