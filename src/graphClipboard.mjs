/* Copyright © 2026 Zenin Easa Panthakkalakath */

export const graphFragmentFormat = 'konjugateGraphFragment';
export const graphFragmentVersion = 1;

// Every entity in a project document carries a positive integer `id` (see the project schema), and everything that refers
// to one does so in a field named `id` or ending in `Id` (`nodeId`, `stateId`, `parameterId`, `sharedParameterId`) or
// `Ids`. Copying a graph gives each copied entity a new id and rewrites each such field that names one; it does not list
// the places a reference can appear, so a new kind of binding, or a new entity with an id, is copied correctly the day it
// is added. A reference to something that was not copied (a state of a node left behind, a shared parameter) is left alone.
const isIdKey = (key) => key === 'id' || key.endsWith('Id');
const isIdListKey = (key) => key.endsWith('Ids');

function collectEntityIds(value, found = []) {
    if (Array.isArray(value)) {
        value.forEach((item) => collectEntityIds(item, found));
    } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            if (key === 'id' && typeof child === 'number') found.push(child);
            else collectEntityIds(child, found);
        }
    }
    return found;
}

function remapIds(value, ids) {
    if (Array.isArray(value)) return value.map((item) => remapIds(item, ids));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
        if (isIdKey(key) && typeof child === 'number' && ids.has(child)) return [key, ids.get(child)];
        if (isIdListKey(key) && Array.isArray(child)) return [key, child.map((id) => (ids.has(id) ? ids.get(id) : id))];
        return [key, remapIds(child, ids)];
    }));
}

function fragmentEntityIds(fragment) {
    return collectEntityIds([fragment.nodes, fragment.edges]);
}

export function validateGraphFragment(fragment) {
    if (fragment?.format !== graphFragmentFormat || fragment.version !== graphFragmentVersion ||
        !Array.isArray(fragment.nodes) || !fragment.nodes.length || !Array.isArray(fragment.edges)) return false;
    const ids = fragmentEntityIds(fragment);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return false;
    const nodeIds = new Set(fragment.nodes.map((node) => node.id));
    return fragment.edges.every((edge) => nodeIds.has(edge.source?.nodeId) && nodeIds.has(edge.target?.nodeId));
}

export function createGraphFragment(document, selectedNodeIds) {
    const selected = new Set(selectedNodeIds);
    const nodes = (document.nodes ?? []).filter((node) => selected.has(node.id)).map((node) => structuredClone(node));
    const includedNodeIds = new Set(nodes.map((node) => node.id));
    const edges = (document.edges ?? []).filter((edge) => (
        includedNodeIds.has(edge.source?.nodeId) && includedNodeIds.has(edge.target?.nodeId)
    )).map((edge) => structuredClone(edge));
    if (!nodes.length) return null;
    return { format: graphFragmentFormat, version: graphFragmentVersion, nodes, edges };
}

export function remapGraphFragment(fragment, firstId, positionOffset = [1, 0, 1]) {
    if (!validateGraphFragment(fragment) || !Number.isSafeInteger(firstId) || firstId <= 0) {
        throw new Error('The copied graph fragment is invalid.');
    }
    let nextId = firstId;
    const ids = new Map(fragmentEntityIds(fragment).map((id) => [id, nextId++]));
    const nodes = fragment.nodes.map((node) => ({
        ...remapIds(node, ids),
        name: `${node.name} copy`,
        position: (node.position ?? [0, 0, 0]).map((value, index) => Number(value) + Number(positionOffset[index] ?? 0))
    }));
    const edges = fragment.edges.map((edge) => ({ ...remapIds(edge, ids), name: `${edge.name} copy` }));
    return { nodes, edges, nextId };
}
