/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

function symbolState(node, symbol) {
    return node?.states.find((state) => state.symbol === symbol) ?? null;
}

// All C(N,2) unordered member pairs, sorted by node id so re-expanding an unchanged membership
// list always produces the same pairing (stable ids/order across edits and reloads).
export function memberPairs(memberNodeIds) {
    const sorted = [...memberNodeIds].sort((a, b) => a - b);
    const pairs = [];
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            pairs.push({ sourceNodeId: sorted[i], targetNodeId: sorted[j] });
        }
    }
    return pairs;
}

// Builds one concrete, ordinary-shaped edge definition for a member pair from the group's shared,
// symbol-keyed definition. `output.role` is always resolved against `output.symbol` on both nodes:
// the named role's node supplies equationModel.output, and the other node's matching-symbol state
// (when it has one) is recorded as the mirror stateId the engine's bidirectional handling reads
// directly from the edge's own source/target.stateId fields (engine/src/executionPlan.cpp) --
// every group edge is bidirectional, so both sides always receive the same computed value with the
// sign flipped on the far side.
export function resolveGroupEdgeForPair({ group, sourceNode, targetNode, allocateId }) {
    const { definition } = group;
    const bindings = reconcileEquationBindings([], sourceNode, targetNode, definition.parameters);
    const outputRole = definition.output?.role === 'source' ? 'source' : 'target';
    const primaryNode = outputRole === 'source' ? sourceNode : targetNode;
    const mirrorNode = outputRole === 'source' ? targetNode : sourceNode;
    const outputState = symbolState(primaryNode, definition.output?.symbol);
    const mirrorState = symbolState(mirrorNode, definition.output?.symbol);
    const usesImplementation = Boolean(definition.implementation);
    const equation = usesImplementation ? '' : (definition.equation ?? '');
    const validation = usesImplementation ? null : validateEquationLatex(equation, bindings);
    const equationModel = usesImplementation ? null : {
        latex: equation,
        output: { role: outputRole, stateId: outputState?.id ?? null },
        bindings,
        mathJson: validation?.valid ? validation.mathJson : null
    };
    const implementation = usesImplementation ? {
        kind: definition.implementation.kind,
        providerApiVersion: definition.implementation.providerApiVersion,
        source: definition.implementation.source,
        bindings: definition.implementation.bindings.map((binding) => binding.kind === 'parameter'
            ? { key: binding.key, kind: 'parameter', parameterId: binding.parameterId }
            : {
                key: binding.key,
                kind: 'state',
                role: binding.role,
                nodeId: (binding.role === 'source' ? sourceNode : targetNode)?.id ?? null,
                stateId: symbolState(binding.role === 'source' ? sourceNode : targetNode, binding.symbol)?.id ?? null
            }),
        output: { key: definition.implementation.output?.key ?? '', role: outputRole, stateId: outputState?.id ?? null }
    } : null;
    return {
        id: allocateId(),
        groupId: group.id,
        title: group.name,
        source: sourceNode.id,
        target: targetNode.id,
        sourceStateId: (outputRole === 'source' ? outputState : mirrorState)?.id ?? null,
        targetStateId: (outputRole === 'target' ? outputState : mirrorState)?.id ?? null,
        directionality: 'bidirectional',
        color: group.color,
        offset: 0,
        enabled: true,
        equation,
        equationModel,
        ...(implementation ? { implementation } : {}),
        parameters: structuredClone(definition.parameters)
    };
}

// Full mesh for a group's current membership -- one bidirectional edge per unordered pair.
export function expandEdgeGroup({ group, nodesById, allocateId }) {
    return memberPairs(group.memberNodeIds).map(({ sourceNodeId, targetNodeId }) => resolveGroupEdgeForPair({
        group,
        sourceNode: nodesById.get(sourceNodeId),
        targetNode: nodesById.get(targetNodeId),
        allocateId
    }));
}

// The single state a member node must supply for the group's definition to resolve on it: the
// state named by the shared `output.symbol`. Other symbols the equation references are exposed or
// left unresolved per state per reconcileEquationBindings/validateEquationLatex exactly like a
// hand-authored edge -- this option only targets the one binding that's structurally required for
// the edge to have anywhere to write its contribution.
export function unresolvedGroupSymbols({ group, node }) {
    const symbol = group.definition.output?.symbol;
    if (!symbol) return [];
    return symbolState(node, symbol) ? [] : [symbol];
}

// A member edge stores its own copy of the group's shared parameters (same ids, so
// reconcileEquationBindings resolves the same binding symbol on every member edge) rather than
// owning independent parameter records -- the caller hydrating document.edges is expected to
// register each edge's own id but skip re-registering parameter ids on a `groupId`-tagged edge,
// since those ids are registered exactly once here, against the group's own definition.
export function hydrateEdgeGroups(document, registerId) {
    const nodeIds = new Set(document.nodes.map((node) => node.id));
    const groupIds = new Set();
    const groups = (document.edgeGroups ?? []).map((group) => {
        registerId(group.id, 'Every edge group must have a unique positive integer id.');
        groupIds.add(group.id);
        const memberNodeIds = Array.isArray(group.memberNodeIds) ? group.memberNodeIds.map(Number) : [];
        memberNodeIds.forEach((nodeId) => {
            if (!nodeIds.has(nodeId)) {
                throw new Error(`Edge group “${group.name ?? group.id}” references a missing node.`);
            }
        });
        const parameters = Array.isArray(group.definition?.parameters)
            ? group.definition.parameters.map((parameter) => ({ ...parameter })) : [];
        parameters.forEach((parameter) => {
            registerId(parameter.id, `Every parameter in edge group “${group.name ?? group.id}” must have a unique positive integer id.`);
        });
        return {
            id: group.id,
            name: group.name || 'Untitled edge group',
            memberNodeIds,
            // Stored as a parsed integer, matching node/edge `color` fields (see
            // serializeProjectDocument's `#${color.toString(16)...}` round trip) -- not the hex
            // string the document itself uses.
            color: Number.parseInt(String(group.color ?? '#2fb8a4').replace('#', ''), 16),
            deleted: false,
            definition: {
                parameters,
                output: group.definition?.output ? { ...group.definition.output } : { role: 'target', symbol: '' },
                equation: group.definition?.implementation ? '' : (group.definition?.equation ?? ''),
                implementation: group.definition?.implementation ? { ...group.definition.implementation } : null
            }
        };
    });
    document.edges.forEach((edge) => {
        if (edge.groupId != null && !groupIds.has(edge.groupId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing edge group.`);
        }
    });
    return groups;
}

export function stripEdgeGroups(document) {
    const flattened = structuredClone(document);
    delete flattened.edgeGroups;
    flattened.edges.forEach((edge) => delete edge.groupId);
    return flattened;
}
