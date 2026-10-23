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

// A fragment may carry the shared parameters its nodes and relationships link to (a library template does, since it has
// to stand alone), each a project-document shared parameter with an `id`.
function fragmentEntityIds(fragment) {
    return collectEntityIds([fragment.nodes, fragment.edges, fragment.sharedParameters ?? []]);
}

// Every id a fragment gives to something of its own, for telling a reference to inside it from one to outside.
export function fragmentIdSet(fragment) {
    return new Set(fragmentEntityIds(fragment));
}

// Every shared parameter a fragment's nodes and relationships link to, by id, whether or not the fragment carries it.
export function fragmentSharedParameterReferences(fragment) {
    const found = new Set();
    const visit = (value) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) {
                if (key === 'sharedParameterId' && typeof child === 'number') found.add(child);
                else visit(child);
            }
        }
    };
    visit([fragment.nodes, fragment.edges]);
    return [...found];
}

export function validateGraphFragment(fragment) {
    if (fragment?.format !== graphFragmentFormat || fragment.version !== graphFragmentVersion ||
        !Array.isArray(fragment.nodes) || !fragment.nodes.length || !Array.isArray(fragment.edges) ||
        (fragment.sharedParameters !== undefined && !Array.isArray(fragment.sharedParameters))) return false;
    const ids = fragmentEntityIds(fragment);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return false;
    const nodeIds = new Set(fragment.nodes.map((node) => node.id));
    return fragment.edges.every((edge) => nodeIds.has(edge.source?.nodeId) && nodeIds.has(edge.target?.nodeId));
}

// `includeSharedParameters` carries the shared parameters the copied nodes and relationships link to, so the fragment can
// stand alone (a library template has to); a paste into the model it came from links to the originals instead.
export function createGraphFragment(document, selectedNodeIds, { includeSharedParameters = false } = {}) {
    const selected = new Set(selectedNodeIds);
    const nodes = (document.nodes ?? []).filter((node) => selected.has(node.id)).map((node) => structuredClone(node));
    const includedNodeIds = new Set(nodes.map((node) => node.id));
    const edges = (document.edges ?? []).filter((edge) => (
        includedNodeIds.has(edge.source?.nodeId) && includedNodeIds.has(edge.target?.nodeId)
    )).map((edge) => structuredClone(edge));
    if (!nodes.length) return null;
    const fragment = { format: graphFragmentFormat, version: graphFragmentVersion, nodes, edges };
    if (includeSharedParameters) {
        const linked = new Set(fragmentSharedParameterReferences(fragment));
        const carried = (document.sharedParameters ?? []).filter((shared) => linked.has(shared.id)).map((shared) => structuredClone(shared));
        if (carried.length) fragment.sharedParameters = carried;
    }
    return fragment;
}

// `nameSuffix` is appended to every copied name (a pasted copy says it is one; a library template placed on the canvas
// keeps its own names). `reuse` maps the id of a shared parameter the fragment carries to the id of one already in the
// project, which the copy then links to instead of making its own.
export function remapGraphFragment(fragment, firstId, positionOffset = [1, 0, 1], { nameSuffix = ' copy', reuse = new Map() } = {}) {
    if (!validateGraphFragment(fragment) || !Number.isSafeInteger(firstId) || firstId <= 0) {
        throw new Error('The copied graph fragment is invalid.');
    }
    let nextId = firstId;
    const ids = new Map(fragmentEntityIds(fragment).filter((id) => !reuse.has(id)).map((id) => [id, nextId++]));
    reuse.forEach((existingId, id) => ids.set(id, existingId));
    const nodes = fragment.nodes.map((node) => ({
        ...remapIds(node, ids),
        name: `${node.name}${nameSuffix}`,
        position: (node.position ?? [0, 0, 0]).map((value, index) => Number(value) + Number(positionOffset[index] ?? 0))
    }));
    const edges = fragment.edges.map((edge) => ({ ...remapIds(edge, ids), name: `${edge.name}${nameSuffix}` }));
    const sharedParameters = (fragment.sharedParameters ?? []).filter((shared) => !reuse.has(shared.id)).map((shared) => remapIds(shared, ids));
    return { nodes, edges, sharedParameters, nextId };
}
