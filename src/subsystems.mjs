/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A subsystem's boundary is not stored: which relationships cross it is derived from the current edges and node membership
// whenever it is needed (see subsystemBoundaryCrossings). A document written before that may still carry a `ports` array on
// each subsystem; it is read past and never written again (docs/subsystems.md).
export function hydrateSubsystems(document, registerId) {
    const subsystemIds = new Set();
    const subsystems = (document.subsystems ?? []).map((subsystem) => {
        registerId(subsystem.id, 'Every subsystem must have a unique positive integer id.');
        subsystemIds.add(subsystem.id);
        return {
            id: subsystem.id,
            name: subsystem.name || 'Untitled subsystem',
            parentSubsystemId: subsystem.parentSubsystemId ?? null,
            position: Array.isArray(subsystem.position) && subsystem.position.length === 3
                ? subsystem.position.map(Number) : [0, 0, 0],
            deleted: false
        };
    });
    subsystems.forEach((subsystem) => {
        if (subsystem.parentSubsystemId !== null && !subsystemIds.has(subsystem.parentSubsystemId)) {
            throw new Error(`Subsystem “${subsystem.name}” references a missing parent subsystem.`);
        }
    });
    document.nodes.forEach((node) => {
        if (node.subsystemId !== undefined && node.subsystemId !== null && !subsystemIds.has(node.subsystemId)) {
            throw new Error(`Node “${node.name ?? node.id}” references a missing subsystem.`);
        }
    });
    return subsystems;
}

// An edge's endpoint is a node id on the canvas and `{ nodeId }` in a project document; either is accepted.
const endpointNodeId = (endpoint) => Number(endpoint !== null && typeof endpoint === 'object' ? endpoint.nodeId : endpoint);

// Whether a node in `nodeSubsystemId` (null at the top level) lies inside `subsystemId`, directly or through nested subsystems.
export function subsystemContains({ subsystems, subsystemId, nodeSubsystemId }) {
    const parents = new Map(subsystems.map((subsystem) => [subsystem.id, subsystem.parentSubsystemId ?? null]));
    const seen = new Set();
    for (let current = nodeSubsystemId ?? null; current !== null && !seen.has(current); current = parents.get(current) ?? null) {
        if (current === subsystemId) return true;
        seen.add(current);
    }
    return false;
}

// The one place a subsystem's boundary is worked out, used by the proxy in the parent view (its count) and by the terminals
// drawn inside it. A relationship crosses the boundary when exactly one of its endpoints is inside the subsystem, counting
// nodes in nested subsystems as inside; the other endpoint may be at the top level, in a parent subsystem or in a sibling.
// Each crossing names the relationship, its inside and outside node, the inside node's role, and the direction seen from
// inside: `incoming` when the outside node is the source, `outgoing` when it is the target, `bidirectional` for an edge that
// applies its result to both ends (docs/edgeDirectionality.md). Deleted entities, given as `deleted: true`, are left out, as
// are subsystems that are deleted themselves. Edge-group members are ordinary edges here, each crossing on its own.
export function subsystemBoundaryCrossings({ subsystemId, subsystems = [], nodes = [], edges = [] }) {
    const live = subsystems.filter((subsystem) => !subsystem.deleted);
    if (!live.some((subsystem) => subsystem.id === subsystemId)) return [];
    const inside = new Map();
    nodes.forEach((node) => {
        if (node.deleted) return;
        inside.set(Number(node.id), subsystemContains({ subsystems: live, subsystemId, nodeSubsystemId: node.subsystemId ?? null }));
    });
    return edges.flatMap((edge) => {
        if (edge.deleted) return [];
        const sourceNodeId = endpointNodeId(edge.source);
        const targetNodeId = endpointNodeId(edge.target);
        if (!inside.has(sourceNodeId) || !inside.has(targetNodeId)) return [];
        const sourceInside = inside.get(sourceNodeId);
        if (sourceInside === inside.get(targetNodeId)) return [];
        return [{
            edgeId: edge.id,
            internalNodeId: sourceInside ? sourceNodeId : targetNodeId,
            externalNodeId: sourceInside ? targetNodeId : sourceNodeId,
            role: sourceInside ? 'source' : 'target',
            direction: edge.directionality === 'bidirectional' ? 'bidirectional' : sourceInside ? 'outgoing' : 'incoming'
        }];
    });
}

export function executionProjectDocument(document) {
    const flattened = structuredClone(document);
    delete flattened.subsystems;
    flattened.nodes.forEach((node) => delete node.subsystemId);
    return flattened;
}
