/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What changed between two model documents (docs/proposals/assistantHistory.md): the nodes and relationships added, removed and
// changed, matched by their ids, never by where they sit in a list, and for a changed one which of its fields changed, with its
// states, source terms and parameters matched by id too. Plain data in and out; used to show what an applied proposal did.

const label = (item, fallback) => item?.name || item?.symbol || item?.label || `${fallback} ${item?.id ?? ''}`.trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const singular = { states: 'state', sourceTerms: 'source term', parameters: 'parameter', ports: 'port' };

// Which fields of one entity changed: plain fields by name, and lists of things with ids as "state temperature added" and so on.
function changedFields(before, after) {
    const fields = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        if (key === 'id' || same(before[key], after[key])) continue;
        const was = before[key];
        const now = after[key];
        const listOfIdentified = (value) => Array.isArray(value) && value.every((item) => item && typeof item === 'object' && 'id' in item);
        if (listOfIdentified(was ?? []) && listOfIdentified(now ?? []) && (Array.isArray(was) || Array.isArray(now))) {
            const kind = singular[key] ?? key;
            const wasById = new Map((was ?? []).map((item) => [String(item.id), item]));
            const nowById = new Map((now ?? []).map((item) => [String(item.id), item]));
            for (const [id, item] of nowById) {
                if (!wasById.has(id)) fields.push(`${kind} ${label(item, kind)} added`);
                else if (!same(wasById.get(id), item)) fields.push(`${kind} ${label(item, kind)} changed`);
            }
            for (const [id, item] of wasById) if (!nowById.has(id)) fields.push(`${kind} ${label(item, kind)} removed`);
        } else {
            fields.push(key);
        }
    }
    return fields;
}

function diffList(before = [], after = [], kind) {
    const wasById = new Map(before.map((item) => [String(item.id), item]));
    const nowById = new Map(after.map((item) => [String(item.id), item]));
    const result = { added: [], removed: [], changed: [] };
    for (const [id, item] of nowById) {
        if (!wasById.has(id)) result.added.push({ id: item.id, name: label(item, kind) });
        else if (!same(wasById.get(id), item)) result.changed.push({ id: item.id, name: label(item, kind), fields: changedFields(wasById.get(id), item) });
    }
    for (const [id, item] of wasById) if (!nowById.has(id)) result.removed.push({ id: item.id, name: label(item, kind) });
    return result;
}

export function diffModels(before, after) {
    return {
        nodes: diffList(before?.nodes ?? [], after?.nodes ?? [], 'node'),
        edges: diffList(before?.edges ?? [], after?.edges ?? [], 'relationship')
    };
}

export const diffIsEmpty = (diff) => ['nodes', 'edges'].every((kind) => ['added', 'removed', 'changed'].every((what) => !diff[kind][what].length));

// The diff as lines a person reads, nodes first: "Added node “Heat sink”", "Changed relationship “Heat to sink”: equation".
export function describeModelDiff(diff) {
    const lines = [];
    for (const [kind, noun] of [['nodes', 'node'], ['edges', 'relationship']]) {
        for (const item of diff[kind].added) lines.push(`Added ${noun} “${item.name}”`);
        for (const item of diff[kind].changed) lines.push(`Changed ${noun} “${item.name}”${item.fields.length ? `: ${item.fields.join(', ')}` : ''}`);
        for (const item of diff[kind].removed) lines.push(`Removed ${noun} “${item.name}”`);
    }
    return lines;
}
