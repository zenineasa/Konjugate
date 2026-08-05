/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function hydrateSubsystems(document, registerId) {
    const nodeIds = new Set(document.nodes.map((node) => node.id));
    const edgeIds = new Set(document.edges.map((edge) => edge.id));
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
            deleted: false,
            ports: (subsystem.ports ?? []).map((port) => {
                registerId(port.id, 'Every subsystem port must have a unique positive integer id.');
                if (!edgeIds.has(port.edgeId) || !nodeIds.has(port.internalNodeId) || !nodeIds.has(port.externalNodeId)) {
                    throw new Error(`A port in “${subsystem.name ?? subsystem.id}” references a missing graph entity.`);
                }
                return { ...port };
            })
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

export function deriveSubsystemPorts({ subsystemId, nodeIds, edges, allocateId }) {
    if (!Number.isSafeInteger(subsystemId) || subsystemId <= 0) {
        throw new TypeError('A subsystem requires a positive integer id.');
    }
    const members = new Set(nodeIds);
    return edges.flatMap((edge) => {
        const sourceInside = members.has(edge.source.nodeId);
        const targetInside = members.has(edge.target.nodeId);
        if (sourceInside === targetInside) return [];
        return [{
            id: allocateId(), edgeId: edge.id,
            internalNodeId: sourceInside ? edge.source.nodeId : edge.target.nodeId,
            externalNodeId: sourceInside ? edge.target.nodeId : edge.source.nodeId,
            role: sourceInside ? 'source' : 'target'
        }];
    });
}

export function executionProjectDocument(document) {
    const flattened = structuredClone(document);
    delete flattened.subsystems;
    flattened.nodes.forEach((node) => delete node.subsystemId);
    return flattened;
}
