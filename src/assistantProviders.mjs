/* Copyright © 2026 Zenin Easa Panthakkalakath */

export class AssistantProviderError extends Error {
    constructor(message, code = 'providerError') {
        super(message);
        this.name = 'AssistantProviderError';
        this.code = code;
    }
}

function finiteValue(request, pattern, fallback) {
    const match = request.match(pattern);
    if (!match) return fallback;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : fallback;
}

function temperatureState(node) {
    return node.states.find((state) => state.symbol.toLowerCase() === 'temperature') ??
        node.states.find((state) => state.name.toLowerCase().includes('temperature'));
}

function temperatureCandidates(context) {
    return context.nodes.filter((node) => temperatureState(node));
}

// A whole-name substring match ("battery module" literally inside the request) is too strict for
// how people actually phrase things ("the battery" already leaves out "module"), so this matches
// on any significant word (longer than 2 characters, to skip "at"/"of"/etc.) from the node's own
// name appearing in the request -- still a genuine "the user named this" signal, just not
// requiring the exact full name. Callers decide what to do when nothing matches and more than
// one candidate exists (ask, for genuinely ambiguous cases; fall through to the sole candidate
// silently when there's only one).
function explicitTarget(context, request) {
    const lowerRequest = request.toLowerCase();
    return temperatureCandidates(context).find((node) =>
        node.name.toLowerCase().split(/\s+/).some((word) => word.length > 2 && lowerRequest.includes(word)));
}

// This regex provider has no real language understanding, so it can't resolve a *contradicting*
// revision ("actually enable it instead") -- concatenating history is purely additive, meant to
// let a clarification reply ("Battery module, 320K") combine with the original request ("raise
// the temperature") so the regexes in attemptResolve match against the combined text. Real
// revision semantics need an LLM-backed provider.
function textWithHistory(request, history) {
    return [...(history ?? []).map((turn) => turn.request), request].join(' ');
}

function attemptResolve(context, text) {
    if (/(?:set|change|update)\b/i.test(text) && /temperature/i.test(text)) {
        const candidates = temperatureCandidates(context);
        const explicit = explicitTarget(context, text);
        if (!explicit && candidates.length > 1) {
            return {
                responseKind: 'clarification',
                question: 'Which node should I update?',
                suggestions: candidates.map((node) => node.name)
            };
        }
        const target = explicit ?? candidates[0];
        const targetState = target && temperatureState(target);
        if (!target || !targetState) {
            throw new AssistantProviderError('The requested node does not have a temperature state that can be updated.', 'missingContext');
        }
        const requestedTemperature = text.match(/(-?\d+(?:\.\d+)?)\s*(?:k|kelvin)\b/i);
        if (!requestedTemperature) {
            return { responseKind: 'clarification', question: `What temperature (in K) should ${target.name} be set to?` };
        }
        return {
            responseKind: 'proposal',
            proposalVersion: 1,
            summary: `Update the initial temperature of ${target.name}.`,
            assumptions: ['The requested temperature applies to the initial state, not a live simulation value.'],
            operations: [{ kind: 'updateState', stateRef: targetState.id, initialValue: Number.parseFloat(requestedTemperature[1]), unit: 'K' }]
        };
    }
    if (/\b(disable|enable)\b/i.test(text)) {
        const enabled = !/\bdisable\b/i.test(text);
        const matchedNode = context.nodes.find((node) => text.toLowerCase().includes(node.name.toLowerCase()));
        const matchedEdge = !matchedNode && context.edges.find((edge) => text.toLowerCase().includes(edge.name.toLowerCase()));
        if (!matchedNode && !matchedEdge) {
            return {
                responseKind: 'clarification',
                question: `Which node or relationship should I ${enabled ? 'enable' : 'disable'}?`,
                suggestions: [...context.nodes.map((node) => node.name), ...context.edges.map((edge) => edge.name)].slice(0, 5)
            };
        }
        return matchedNode
            ? {
                responseKind: 'proposal',
                proposalVersion: 1,
                summary: `${enabled ? 'Enable' : 'Disable'} ${matchedNode.name}.`,
                operations: [{ kind: 'updateNode', nodeRef: matchedNode.id, enabled }]
            }
            : {
                responseKind: 'proposal',
                proposalVersion: 1,
                summary: `${enabled ? 'Enable' : 'Disable'} ${matchedEdge.name}.`,
                operations: [{ kind: 'updateEdge', edgeRef: matchedEdge.id, enabled }]
            };
    }
    if (!/ambient|environment|surroundings/i.test(text) || !/thermal|temperature|heat|conduct/i.test(text)) {
        throw new AssistantProviderError(
            'The local demonstration provider currently supports adding an ambient thermal boundary, updating a node’s initial temperature, and enabling/disabling a node or relationship. Try “Add an ambient boundary at 293.15 K and connect it to the battery with a conductance of 10 W/K.”',
            'unsupportedRequest'
        );
    }
    const target = explicitTarget(context, text) ?? temperatureCandidates(context)[0];
    const targetState = target && temperatureState(target);
    if (!target || !targetState) {
        throw new AssistantProviderError('The active model needs a node with a temperature state before an ambient thermal boundary can be connected.', 'missingContext');
    }

    const ambientTemperature = finiteValue(text, /(-?\d+(?:\.\d+)?)\s*(?:k|kelvin)\b/i, 293.15);
    const conductance = finiteValue(text, /(?:conductance(?:\s+of)?|with)\s*(-?\d+(?:\.\d+)?)\s*(?:w\s*\/\s*k|watt)/i, 10);
    const assumptions = [];
    if (!/(-?\d+(?:\.\d+)?)\s*(?:k|kelvin)\b/i.test(text)) assumptions.push('Ambient temperature defaults to 293.15 K.');
    if (!/(?:conductance(?:\s+of)?|with)\s*(-?\d+(?:\.\d+)?)\s*(?:w\s*\/\s*k|watt)/i.test(text)) assumptions.push('Thermal conductance defaults to 10 W/K.');

    return {
        responseKind: 'proposal',
        proposalVersion: 1,
        summary: `Add an ambient thermal boundary for ${target.name}.`,
        assumptions,
        operations: [
            { kind: 'addNode', ref: 'ambientBoundary', name: 'Ambient boundary', type: 'Thermal boundary', shape: 'sphere' },
            { kind: 'addState', ref: 'ambientTemperature', nodeRef: 'ambientBoundary', name: 'Temperature', symbol: 'temperature', initialValue: ambientTemperature, unit: 'K' },
            { kind: 'addEdge', ref: 'ambientHeatTransfer', name: 'Ambient heat transfer', sourceNodeRef: 'ambientBoundary', targetNodeRef: target.id, directionality: 'directed' },
            { kind: 'addParameter', ref: 'ambientConductance', edgeRef: 'ambientHeatTransfer', name: 'Conductance', symbol: 'conductance', value: conductance, unit: 'W/K', mode: 'constant' },
            {
                kind: 'setEdgeEquation', edgeRef: 'ambientHeatTransfer', outputStateRef: targetState.id,
                latex: '\\mathrm{conductance}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTemperature})'
            }
        ]
    };
}

// Tries the request exactly as typed first, so a fully self-sufficient new request is never
// derailed by unrelated earlier turns -- concatenating an earlier, already-resolved turn's own
// numbers or names into a later, fully-specified request could otherwise silently change which
// node or value it resolves to. Only reaches for history -- combining this text with prior
// turns -- when the plain request alone couldn't be resolved (attemptResolve asked a
// clarifying question, or matched no recognized request shape at all), i.e. when this might be
// answering an earlier clarification.
async function generateLocalProposal({ context, request, history, signal }) {
    await Promise.resolve();
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    const text = request.trim();
    if (!text) throw new AssistantProviderError('Describe the model change you want to make.', 'emptyRequest');
    try {
        const direct = attemptResolve(context, text);
        if (direct.responseKind !== 'clarification' || !history?.length) return direct;
        return attemptResolve(context, textWithHistory(text, history));
    } catch (error) {
        if (!history?.length) throw error;
        try { return attemptResolve(context, textWithHistory(text, history)); }
        catch { throw error; }
    }
}

export const localAssistantProvider = Object.freeze({
    id: 'localDemonstration',
    name: 'Local demonstration',
    locality: 'local',
    generateProposal: generateLocalProposal
});

export async function generateAssistantProposal(provider, request) {
    if (!provider || typeof provider.generateProposal !== 'function') {
        throw new AssistantProviderError('The selected assistant provider is unavailable.', 'providerUnavailable');
    }
    if (!request?.context || !Array.isArray(request.context.nodes)) {
        throw new AssistantProviderError('The assistant requires a valid model summary.', 'invalidContext');
    }
    return provider.generateProposal(request);
}
