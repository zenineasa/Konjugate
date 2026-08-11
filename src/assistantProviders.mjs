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

function requestedTarget(context, request) {
    const candidates = context.nodes.filter((node) => temperatureState(node));
    return candidates.find((node) => request.toLowerCase().includes(node.name.toLowerCase())) ??
        candidates.find((node) => /battery/i.test(node.name)) ?? candidates[0];
}

async function generateLocalProposal({ context, request, signal }) {
    await Promise.resolve();
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
    const text = request.trim();
    if (!text) throw new AssistantProviderError('Describe the model change you want to make.', 'emptyRequest');
    if (/(?:set|change|update)\b/i.test(text) && /temperature/i.test(text)) {
        const target = requestedTarget(context, text);
        const targetState = target && temperatureState(target);
        if (!target || !targetState) {
            throw new AssistantProviderError('The requested node does not have a temperature state that can be updated.', 'missingContext');
        }
        const requestedTemperature = text.match(/(-?\d+(?:\.\d+)?)\s*(?:k|kelvin)\b/i);
        if (!requestedTemperature) throw new AssistantProviderError('Include the new temperature in kelvin.', 'missingValue');
        return {
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
            throw new AssistantProviderError('Name the node or relationship to disable or enable.', 'missingContext');
        }
        return matchedNode
            ? {
                proposalVersion: 1,
                summary: `${enabled ? 'Enable' : 'Disable'} ${matchedNode.name}.`,
                operations: [{ kind: 'updateNode', nodeRef: matchedNode.id, enabled }]
            }
            : {
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
    const target = requestedTarget(context, text);
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
