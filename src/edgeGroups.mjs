/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

function symbolState(node, symbol) {
    return node?.states.find((state) => state.symbol === symbol) ?? null;
}

// All N(N-1) ordered member pairs (both (i,j) and (j,i) for every unordered pair), sorted by node
// id so re-expanding an unchanged membership list always produces the same pairing (stable
// ids/order across edits and reloads). Ordered, not the C(N,2) unordered pairs a single
// bidirectional edge would need: see docs/edgeDirectionality.md for why -- in short, a group has
// no user-chosen source/target per pair the way a hand-authored edge does, so instead of one
// bidirectional edge with an arbitrarily-assigned direction, every member gets its own directed
// edge *to* every other member, evaluating the same equation independently in each direction.
export function memberPairs(memberNodeIds) {
    const sorted = [...memberNodeIds].sort((a, b) => a - b);
    const pairs = [];
    for (const sourceNodeId of sorted) {
        for (const targetNodeId of sorted) {
            if (sourceNodeId !== targetNodeId) pairs.push({ sourceNodeId, targetNodeId });
        }
    }
    return pairs;
}

// Builds one concrete, ordinary directed edge for a member pair from the group's shared,
// symbol-keyed definition -- resolved exactly the way a hand-authored edge's bindings are (see
// reconcileEquationBindings), just against this specific pair's two nodes. The contribution always
// lands on this edge's own target (see docs/edgeDirectionality.md): there is no separate "mirror"
// side to compute, since the group's mesh already has a second edge in the opposite direction
// covering that.
export function resolveGroupEdgeForPair({ group, sourceNode, targetNode, allocateId }) {
    const { definition } = group;
    const bindings = reconcileEquationBindings([], sourceNode, targetNode, definition.parameters);
    const outputState = symbolState(targetNode, definition.output?.symbol);
    const usesImplementation = Boolean(definition.implementation);
    const equation = usesImplementation ? '' : (definition.equation ?? '');
    const validation = usesImplementation ? null : validateEquationLatex(equation, bindings);
    const equationModel = usesImplementation ? null : {
        latex: equation,
        output: { role: 'target', stateId: outputState?.id ?? null },
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
        output: { key: definition.implementation.output?.key ?? '', role: 'target', stateId: outputState?.id ?? null }
    } : null;
    return {
        id: allocateId(),
        groupId: group.id,
        title: group.name,
        source: sourceNode.id,
        target: targetNode.id,
        sourceStateId: null,
        targetStateId: outputState?.id ?? null,
        directionality: 'directed',
        color: group.color,
        offset: 0,
        enabled: true,
        equation,
        equationModel,
        ...(implementation ? { implementation } : {}),
        parameters: structuredClone(definition.parameters)
    };
}

// Full mesh for a group's current membership -- one directed edge per ordered member pair.
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
                output: { symbol: group.definition?.output?.symbol ?? '' },
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
