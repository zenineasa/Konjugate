/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { stripComponents } from './components.mjs';
import { subsystemFromDocument } from './modelCodec.mjs';

// A subsystem's boundary is not stored: which relationships cross it is derived from the current edges and node membership
// whenever it is needed (see subsystemBoundaryCrossings). A document written before that may still carry a `ports` array on
// each subsystem; it is read past and never written again (docs/subsystems.md).
export function hydrateSubsystems(document, registerId) {
    const subsystemIds = new Set();
    const subsystems = (document.subsystems ?? []).map((subsystem) => {
        registerId(subsystem.id, 'Every subsystem must have a unique positive integer id.');
        subsystemIds.add(subsystem.id);
        return subsystemFromDocument(subsystem);
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

// ---- Lifecycle (docs/subsystems.md#lifecycle) -------------------------------------------------------------------------
// The pure parts of renaming, dissolving, deleting and moving nodes in and out, so the canvas only applies what these
// work out. Subsystems and nodes are given as the canvas holds them; entities with `deleted: true` are left out.

const liveSubsystems = (subsystems) => subsystems.filter((subsystem) => !subsystem.deleted);

// The subsystem and every subsystem nested in it, at any depth, outermost first.
export function subsystemSubtreeIds({ subsystems, subsystemId }) {
    const live = liveSubsystems(subsystems);
    if (!live.some((subsystem) => subsystem.id === subsystemId)) return [];
    const ids = [subsystemId];
    for (let index = 0; index < ids.length; index += 1) {
        live.forEach((subsystem) => {
            if ((subsystem.parentSubsystemId ?? null) === ids[index] && !ids.includes(subsystem.id)) ids.push(subsystem.id);
        });
    }
    return ids;
}

// What a subsystem holds: its own nodes and subsystems (what dissolving hands to its parent) and every node at any depth.
export function subsystemContents({ subsystems, nodes, subsystemId }) {
    const subtree = new Set(subsystemSubtreeIds({ subsystems, subsystemId }));
    const liveNodes = nodes.filter((node) => !node.deleted);
    return {
        nodeIds: liveNodes.filter((node) => (node.subsystemId ?? null) === subsystemId).map((node) => node.id),
        childSubsystemIds: liveSubsystems(subsystems).filter((subsystem) => (subsystem.parentSubsystemId ?? null) === subsystemId).map((subsystem) => subsystem.id),
        allNodeIds: subtree.size ? liveNodes.filter((node) => subtree.has(node.subsystemId ?? null)).map((node) => node.id) : [],
        nestedSubsystemIds: [...subtree].filter((id) => id !== subsystemId)
    };
}

// What deleting a subsystem takes with it: every subsystem and node inside it, the relationships among them, and the
// relationships connecting them to the rest of the model (which the confirmation counts separately).
export function subsystemDeletion({ subsystems, nodes, edges, subsystemId }) {
    const contents = subsystemContents({ subsystems, nodes, subsystemId });
    if (!subsystemSubtreeIds({ subsystems, subsystemId }).length) return null;
    const inside = new Set(contents.allNodeIds);
    const insideEdgeIds = [];
    const boundaryEdgeIds = [];
    edges.forEach((edge) => {
        if (edge.deleted) return;
        const sourceInside = inside.has(endpointNodeId(edge.source));
        const targetInside = inside.has(endpointNodeId(edge.target));
        if (sourceInside && targetInside) insideEdgeIds.push(edge.id);
        else if (sourceInside || targetInside) boundaryEdgeIds.push(edge.id);
    });
    return {
        subsystemIds: [subsystemId, ...contents.nestedSubsystemIds],
        nodeIds: contents.allNodeIds,
        insideEdgeIds,
        boundaryEdgeIds
    };
}

// Every place a node can be put, in tree order, each with its path from the top ("Model / Plant / Pump"): the choices of
// the node editor's Subsystem field.
export function subsystemLocations({ subsystems, rootName = 'Model' }) {
    const live = liveSubsystems(subsystems);
    const locations = [{ id: null, path: rootName, depth: 0 }];
    const visit = (parentId, path, depth) => {
        live.filter((subsystem) => (subsystem.parentSubsystemId ?? null) === parentId)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id)
            .forEach((subsystem) => {
                const childPath = `${path} / ${subsystem.name}`;
                locations.push({ id: subsystem.id, path: childPath, depth: depth + 1 });
                visit(subsystem.id, childPath, depth + 1);
            });
    };
    visit(null, rootName, 0);
    return locations;
}

// Where a selection seen at `activeSubsystemId` can be moved in one step: into any subsystem shown there, or out to the
// parent of the one being viewed (`parent` is undefined at the top level, where there is no parent).
export function subsystemMoveTargets({ subsystems, activeSubsystemId }) {
    const live = liveSubsystems(subsystems);
    const current = live.find((subsystem) => subsystem.id === activeSubsystemId);
    return {
        into: live.filter((subsystem) => (subsystem.parentSubsystemId ?? null) === (activeSubsystemId ?? null)).map((subsystem) => subsystem.id),
        parent: activeSubsystemId === null || activeSubsystemId === undefined || !current ? undefined : current.parentSubsystemId ?? null
    };
}

// A subsystem's name as typed: trimmed, at most 120 characters, and never empty.
export function normalizeSubsystemName(name) {
    const trimmed = String(name ?? '').trim().slice(0, 120);
    return trimmed || null;
}

// What the engine is given: the flat graph, with the hierarchy and every trace of components taken out
// (src/components.mjs), so subsystems never change how a model runs.
export function executionProjectDocument(document) {
    const flattened = stripComponents(document);
    delete flattened.subsystems;
    flattened.nodes.forEach((node) => delete node.subsystemId);
    return flattened;
}
