/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The integration methods a run can use (docs/proposals/integrators.md), named once for the Run dialog, the result's execution
// summary, code export and the benchmarks. A run configuration says `method` only when it is not Euler node by node, and
// `stepsPerGlobalStep` only when it is not 1, so a model that uses neither saves exactly as before.

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
    })
]);

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

// `configuration` with `method` and `stepsPerGlobalStep` set as chosen, each written only when it is not its default.
export function withIntegrationMethod(configuration, method, stepsPerGlobalStep = 1) {
    const result = { ...configuration };
    delete result.method;
    delete result.stepsPerGlobalStep;
    if (method && method !== defaultIntegrationMethod) result.method = method;
    if (integrationMethod(method)?.stepsPerGlobalStep && stepsPerGlobalStep !== 1) result.stepsPerGlobalStep = stepsPerGlobalStep;
    return result;
}

// What a project document's method and steps per global step say wrong, in plain words, or null.
export function integrationMethodProblem(method, stepsPerGlobalStep) {
    if (!integrationMethod(method)) return `The method “${method}” is not one this version of Konjugate knows.`;
    if (!Number.isInteger(stepsPerGlobalStep) || stepsPerGlobalStep < 1 || stepsPerGlobalStep > 10000) {
        return 'Steps per global step must be a whole number from 1 through 10,000.';
    }
    return null;
}

// Under a whole-model method, what cannot take part in its stages (docs/proposals/integrators.md, Programs and Nodes that cannot take
// stages): a node that is a program of its own (an imported FMU among them) is stepped on its own, and a term written as a program is
// held, evaluated once per global step; a version 1 program cannot be known to be pure (docs/proposals/programSdkV2.md). Each with the
// name to show.
export function stageParticipation(document) {
    const nodes = (document?.nodes ?? []).filter((node) => node.enabled !== false);
    const nodeName = new Map(nodes.map((node) => [node.id, node.name || `Node ${node.id}`]));
    const stepped = [];
    const programs = [];
    for (const node of nodes) {
        if (node.implementation) stepped.push(nodeName.get(node.id));
        for (const term of node.sourceTerms ?? []) {
            if (term.implementation && term.setsValue !== true) programs.push(`${nodeName.get(node.id)}'s ${term.state ?? 'term'}`);
        }
    }
    for (const edge of document?.edges ?? []) {
        if (edge.enabled === false || !nodeName.has(edge.source?.nodeId) || !nodeName.has(edge.target?.nodeId)) continue;
        if (edge.implementation) programs.push(edge.name || `Relationship ${edge.id}`);
    }
    return { stepped, programs };
}

// A short list of names: the first few, then how many more.
export function nameList(names, shown = 4) {
    if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
    return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}
