/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The scoring half of the assistant evaluation harness (scripts/evalAssistant.mjs): runs one case through the
// provider registry the way the panel does -- generate, apply to a copy of the model, validate natively -- and
// says which stage a failure belongs to, then checks the resulting model against the case's declared outcome.
// Passing validation is necessary but not sufficient (a flipped edge or a wrong value validates), so a case
// states what the model must look like afterwards, and that nothing it did not name changed.

import { applyAssistantProposal, summarizeDocumentForAssistant } from '../../src/assistantOperations.mjs';

export const evalStages = Object.freeze(['generate', 'kind', 'apply', 'native', 'outcome']);

export function blankEvalDocument() {
    return { format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [], edges: [] };
}

const normalized = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const nameMatches = (name, needle) => normalized(name).includes(normalized(needle));
const numbersMatch = (actual, expected, tolerance = 1e-6) =>
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));

function nodesNamed(document, name) {
    return document.nodes.filter((node) => nameMatches(node.name, name));
}

// `either` accepts the relationship in both directions, for a request that connects two things without saying which way.
function edgesBetween(document, from, to, either = false) {
    const sources = new Set(nodesNamed(document, from).map((node) => node.id));
    const targets = new Set(nodesNamed(document, to).map((node) => node.id));
    const forward = document.edges.filter((edge) => sources.has(edge.source.nodeId) && targets.has(edge.target.nodeId));
    return either ? [...forward, ...edgesBetween(document, to, from)] : forward;
}

// Each check returns null when it holds, or a short sentence saying what was wrong.
const checks = {
    nodesAdded: ({ base, result }, { count }) => {
        const known = new Set(base.nodes.map((node) => node.id));
        const added = result.nodes.filter((node) => !known.has(node.id)).length;
        return added === count ? null : `expected ${count} new node(s), found ${added}`;
    },
    edgesAdded: ({ base, result }, { count }) => {
        const known = new Set(base.edges.map((edge) => edge.id));
        const added = result.edges.filter((edge) => !known.has(edge.id)).length;
        return added === count ? null : `expected ${count} new relationship(s), found ${added}`;
    },
    hasNode: ({ result }, { name }) =>
        nodesNamed(result, name).length ? null : `no node named like “${name}”`,
    // Without a symbol, any of the node's states may match: a model is free to name the symbol of a state it
    // creates, but not to give it the wrong value or unit.
    state: ({ result }, { node, symbol, initialValue, unit, tolerance }) => {
        const nodes = nodesNamed(result, node);
        if (!nodes.length) return `no node named like “${node}”`;
        const matching = nodes.some((candidate) => candidate.states.some((state) =>
            (symbol === undefined || state.symbol === symbol) &&
            (initialValue === undefined || numbersMatch(state.initialValue, initialValue, tolerance)) &&
            (unit === undefined || normalized(state.unit) === normalized(unit))));
        return matching ? null : `“${node}” has no state${symbol ? ` ${symbol}` : ''}${initialValue === undefined ? '' : ` = ${initialValue}`}${unit ? ` ${unit}` : ''}`;
    },
    // A named node's field by dotted path, for what has no check of its own (appearance.shape, numerics.substepsPerGlobalStep).
    field: ({ result }, { node, path, value }) => {
        const nodes = nodesNamed(result, node);
        if (!nodes.length) return `no node named like “${node}”`;
        const read = (entity) => path.split('.').reduce((current, key) => current?.[key], entity);
        return nodes.some((candidate) => read(candidate) === value) ? null : `“${node}” does not have ${path} = ${value}`;
    },
    hasEdge: ({ result }, { from, to, directionality, either }) => {
        const edges = edgesBetween(result, from, to, either);
        if (!edges.length) return `no relationship from “${from}” to “${to}”`;
        return directionality && !edges.some((edge) => edge.directionality === directionality)
            ? `the relationship from “${from}” to “${to}” is not ${directionality}` : null;
    },
    // A relationship between the two nodes that carries the name, for a request to rename one.
    edgeName: ({ result }, { from, to, name, either }) =>
        edgesBetween(result, from, to, either).some((edge) => nameMatches(edge.name, name)) ? null : `no relationship from “${from}” to “${to}” named like “${name}”`,
    // `uses` and `excludes` are substrings of the equation's LaTeX; `changed` requires it to differ from what the
    // relationship had before, for a request to rewrite an equation whose new text cannot be spelled out in advance.
    edgeEquation: ({ base, result }, { from, to, uses = [], excludes = [], changed = false, either }) => {
        const edges = edgesBetween(result, from, to, either);
        if (!edges.length) return `no relationship from “${from}” to “${to}”`;
        const holds = edges.some((edge) => {
            const latex = normalized(edge.equationModel?.latex ?? edge.equation);
            const before = normalized(base.edges.find((candidate) => candidate.id === edge.id)?.equationModel?.latex ?? '');
            return latex && uses.every((token) => latex.includes(normalized(token))) &&
                !excludes.some((token) => latex.includes(normalized(token))) && (!changed || latex !== before);
        });
        return holds ? null : `the equation from “${from}” to “${to}” is empty${changed ? ' or unchanged' : ''}, lacks ${uses.join(', ') || 'what was asked'}${excludes.length ? ` or still has ${excludes.join(', ')}` : ''}`;
    },
    // `all` requires every relationship between the two that has the parameter to carry the value, for a quantity the
    // model repeats on several relationships (a mass on both the spring and the damper).
    edgeParameter: ({ result }, { from, to, symbol, value, unit, tolerance, all = false, either }) => {
        const edges = edgesBetween(result, from, to, either);
        if (!edges.length) return `no relationship from “${from}” to “${to}”`;
        const matches = (parameter) =>
            (value === undefined || numbersMatch(parameter.value, value, tolerance)) &&
            (unit === undefined || normalized(parameter.unit) === normalized(unit));
        const carrying = edges.flatMap((edge) => (edge.parameters ?? []).filter((parameter) => symbol === undefined || parameter.symbol === symbol));
        const holds = all ? carrying.length > 0 && carrying.every(matches) : carrying.some(matches);
        return holds ? null : `no ${all ? 'consistent ' : ''}parameter${symbol ? ` ${symbol}` : ''}${value === undefined ? '' : ` = ${value}`} on that relationship`;
    },
    enabled: ({ result }, { node, edge, value }) => {
        const entities = node !== undefined ? nodesNamed(result, node) : result.edges.filter((candidate) => nameMatches(candidate.name, edge));
        if (!entities.length) return `nothing named like “${node ?? edge}”`;
        return entities.some((entity) => (entity.enabled !== false) === value) ? null : `“${node ?? edge}” is not ${value ? 'enabled' : 'disabled'}`;
    },
    removed: ({ base, result }, { node, edge }) => {
        const existed = node !== undefined ? nodesNamed(base, node) : base.edges.filter((candidate) => nameMatches(candidate.name, edge));
        if (!existed.length) return `the case names “${node ?? edge}”, which is not in the model`;
        const still = node !== undefined ? nodesNamed(result, node) : result.edges.filter((candidate) => nameMatches(candidate.name, edge));
        return still.length ? `“${node ?? edge}” is still there` : null;
    }
};

// Everything that existed before and was not named in `touches` must come out exactly as it went in. A relationship
// counts as touched when either end is, because removing or renaming a node legitimately changes what hangs off it.
export function untouchedChanges(base, result, touches = []) {
    const touchedNodeIds = new Set(base.nodes.filter((node) => touches.some((name) => nameMatches(node.name, name))).map((node) => node.id));
    const problems = [];
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const node of base.nodes) {
        if (touchedNodeIds.has(node.id)) continue;
        const after = result.nodes.find((candidate) => candidate.id === node.id);
        if (!after) problems.push(`node “${node.name}” was removed`);
        else if (!sameJson(node, after)) problems.push(`node “${node.name}” was changed`);
    }
    for (const edge of base.edges) {
        if (touchedNodeIds.has(edge.source.nodeId) || touchedNodeIds.has(edge.target.nodeId)) continue;
        if (touches.some((name) => nameMatches(edge.name, name))) continue;
        const after = result.edges.find((candidate) => candidate.id === edge.id);
        if (!after) problems.push(`relationship “${edge.name}” was removed`);
        else if (!sameJson(edge, after)) problems.push(`relationship “${edge.name}” was changed`);
    }
    return problems;
}

export function checkOutcome(base, result, { assertions = [], touches = [] } = {}) {
    const failures = [];
    for (const assertion of assertions) {
        const check = checks[assertion.op];
        if (!check) throw new Error(`Unknown assertion “${assertion.op}”.`);
        const failure = check({ base, result }, assertion);
        if (failure) failures.push(failure);
    }
    failures.push(...untouchedChanges(base, result, touches));
    return failures;
}

// `validateNative(document)` resolves to { available, errors: [message] }. A model that already carries errors (a
// blank one has no run configuration) is not blamed for them: only messages the proposal introduced count.
export async function runEvalCase(evalCase, { base, registry, configuration, credential = '', validateNative = null, baselineErrors = [], signal }) {
    const started = performance.now();
    const outcome = { id: evalCase.id, family: evalCase.family, domain: evalCase.domain, style: evalCase.style, expectedKind: evalCase.expect?.kind ?? 'proposal', stage: 'pass', passed: false, attempts: 1, outputCharacters: 0, seconds: 0, messages: [], response: null, native: 'skipped' };
    const finish = (stage, messages = []) => {
        outcome.stage = stage;
        outcome.passed = stage === 'pass';
        outcome.messages = messages;
        outcome.seconds = Number(((performance.now() - started) / 1000).toFixed(2));
        return outcome;
    };
    const onProgress = (progress) => {
        outcome.attempts = progress.attempt;
        outcome.outputCharacters = Math.max(outcome.outputCharacters, progress.outputCharacters);
    };
    let response;
    try {
        response = await registry.generate({
            configuration, credential, context: summarizeDocumentForAssistant(base),
            request: evalCase.request, history: evalCase.history ?? [], signal, onProgress
        });
    } catch (error) {
        outcome.errorCode = error.code ?? error.name;
        return finish('generate', [String(error.message).slice(0, 400)]);
    }
    outcome.response = response;
    const kind = response?.responseKind === 'clarification' ? 'clarification' : 'proposal';
    const expectedKind = evalCase.expect?.kind ?? 'proposal';
    if (kind !== expectedKind) return finish('kind', [`expected a ${expectedKind}, got a ${kind}`]);
    if (kind === 'clarification') {
        const wanted = evalCase.expect?.suggestionsInclude ?? [];
        const missing = wanted.filter((name) => !(response.suggestions ?? []).some((suggestion) => nameMatches(suggestion, name)));
        return missing.length ? finish('outcome', missing.map((name) => `no suggestion like “${name}”`)) : finish('pass');
    }
    let prepared;
    try {
        prepared = applyAssistantProposal(structuredClone(base), response);
    } catch (error) {
        return finish('apply', [String(error.message).slice(0, 400)]);
    }
    if (validateNative) {
        const validation = await validateNative(prepared.document);
        if (validation.available) {
            const introduced = validation.errors.filter((message) => !baselineErrors.includes(message));
            outcome.native = introduced.length ? 'failed' : 'passed';
            if (introduced.length) return finish('native', introduced.slice(0, 5));
        }
    }
    const failures = checkOutcome(base, prepared.document, evalCase.expect);
    return failures.length ? finish('outcome', failures) : finish('pass');
}

const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function summarizeGroup(results) {
    const passed = results.filter((result) => result.passed);
    const stages = {};
    for (const result of results) if (!result.passed) stages[result.stage] = (stages[result.stage] ?? 0) + 1;
    return {
        cases: results.length,
        passed: passed.length,
        passRate: results.length ? passed.length / results.length : 0,
        // Passing only after the registry asked the model to correct itself is the repair loop working, not the model.
        firstAttemptPassRate: results.length ? passed.filter((result) => result.attempts === 1).length / results.length : 0,
        meanAttempts: results.length ? results.reduce((sum, result) => sum + result.attempts, 0) / results.length : 0,
        medianSeconds: median(results.map((result) => result.seconds)),
        failuresByStage: stages
    };
}

// The same results cut three ways, because a model can be fine on average and fail one kind of request every time:
// by what is being asked (family), the field it concerns (domain) and how it is worded (style).
export function summarizeEvalResults(results) {
    const grouped = (key) => {
        const values = [...new Set(results.map((result) => result[key] ?? 'untagged'))].sort();
        return Object.fromEntries(values.map((value) => [value, summarizeGroup(results.filter((result) => (result[key] ?? 'untagged') === value))]));
    };
    return { overall: summarizeGroup(results), byFamily: grouped('family'), byDomain: grouped('domain'), byStyle: grouped('style'), conduct: summarizeConduct(results) };
}

// A pass rate hides which way a model is wrong, and the two ways cost a user very differently. Asking when the request was
// clear costs a reply; acting when it should have asked, or acting on the right thing with the wrong result, costs a
// proposal a skimming user may approve. So these are counted apart:
//   wrongProceed   a clarification was expected and the model proposed an edit anyway
//   needlessAsk    a proposal was expected and the model asked a question
//   confidentWrong a proposal was expected and the model gave one that is valid but does not do what was asked
// Rates are per case that could have gone that way. A case the model failed to answer at all (stage 'generate') is none of these.
export function summarizeConduct(results) {
    const shouldAsk = results.filter((result) => result.expectedKind === 'clarification');
    const shouldAct = results.filter((result) => (result.expectedKind ?? 'proposal') === 'proposal');
    const count = (list, test) => list.filter(test).length;
    const rate = (n, of) => (of ? n / of : 0);
    const wrongProceed = count(shouldAsk, (result) => result.stage === 'kind');
    const needlessAsk = count(shouldAct, (result) => result.stage === 'kind');
    const confidentWrong = count(shouldAct, (result) => result.stage === 'outcome');
    return {
        shouldAsk: shouldAsk.length, shouldAct: shouldAct.length,
        wrongProceed, wrongProceedRate: rate(wrongProceed, shouldAsk.length),
        needlessAsk, needlessAskRate: rate(needlessAsk, shouldAct.length),
        confidentWrong, confidentWrongRate: rate(confidentWrong, shouldAct.length)
    };
}
