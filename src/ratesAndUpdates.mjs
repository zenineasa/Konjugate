/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Rates and Updates (docs/proposals/ratesAndUpdates.md), as the canvas and code export see them: what each state is, every
// term that reaches it, and moving a file between the two ways of saying it -- by its states' `kind` (explicit), or, in a
// file written before, by `setsValue` markers and relationships' several equations (legacy), which settles every node.
//
// It reads a project document's nodes and relationships, or the canvas's own definitions of them: a node's `name` or
// `title`, a relationship's endpoints as `{ nodeId, stateId }` or as `source`/`sourceStateId`. No DOM, so `npm test` runs it.

const nodeName = (node) => node.name ?? node.title ?? '';
const edgeName = (edge) => edge.name ?? edge.title ?? '';
const endpoint = (edge, role) => {
    const value = edge[role];
    if (value && typeof value === 'object') return { nodeId: value.nodeId, stateId: value.stateId || null };
    return { nodeId: value, stateId: edge[`${role}StateId`] || null };
};
const enabled = (item) => item.enabled !== false && !item.deleted;
// The state a node's source term reaches: a program's output, or the equation's, or the state its `state` symbol names.
export function sourceTermStateId(node, term) {
    const programmable = term.implementation && ['cpp', 'python', 'plugin'].includes(term.implementation.kind);
    const stateId = programmable ? term.implementation.output?.stateId : term.expressionModel?.output?.stateId;
    return stateId ?? (programmable ? null : (node.states ?? []).find((state) => state.symbol === term.state)?.id ?? null);
}

// Whether the file says its states' kinds. One state saying it is enough: the engine then reads every state that says
// nothing as a Rate, and settles only the nodes that say so.
export function saysKinds(nodes) {
    return nodes.some((node) => (node.states ?? []).some((state) => state.kind !== undefined));
}

// Every term that reaches a state, by state id, in the order a person reads them: the node's own source terms, then its
// program's outputs, then relationships. Each is { type: 'sourceTerm' | 'program' | 'relationship', nodeId, termId?,
// edgeId?, outputKey?, outputIndex?, role?, setsValue, reciprocal? } -- `setsValue` as the file says it, `reciprocal` for the
// other end of a bidirectional relationship, which adds the same rate with the opposite sign.
export function termsReachingStates(nodes, edges) {
    const reaching = new Map();
    const add = (stateId, term) => {
        if (stateId == null || stateId === '') return;
        const key = Number(stateId);
        if (!reaching.has(key)) reaching.set(key, []);
        reaching.get(key).push(term);
    };
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const firstStateId = (nodeId) => nodesById.get(nodeId)?.states?.[0]?.id ?? null;
    for (const node of nodes) {
        if (!enabled(node)) continue;
        for (const term of node.sourceTerms ?? []) {
            add(sourceTermStateId(node, term), { type: 'sourceTerm', nodeId: node.id, termId: term.id, setsValue: term.setsValue === true });
        }
        for (const output of node.implementation?.outputs ?? []) {
            add(output.stateId, { type: 'program', nodeId: node.id, outputKey: output.key, setsValue: output.setsValue === true || node.implementation.kind === 'fmi' });
        }
    }
    for (const edge of edges) {
        if (!enabled(edge)) continue;
        const source = endpoint(edge, 'source');
        const target = endpoint(edge, 'target');
        if (!enabled(nodesById.get(source.nodeId) ?? {}) || !enabled(nodesById.get(target.nodeId) ?? {})) continue;
        const nodeIdOf = (role) => (role === 'source' ? source.nodeId : target.nodeId);
        const outputs = edge.equationModel?.outputs;
        if (Array.isArray(outputs)) {
            outputs.forEach((output, outputIndex) => add(output.stateId, {
                type: 'relationship', edgeId: edge.id, nodeId: nodeIdOf(output.role), outputIndex, role: output.role, setsValue: true
            }));
            continue;
        }
        const output = edge.implementation?.output ?? edge.equationModel?.output ?? { role: 'target', stateId: target.stateId };
        const role = output.role === 'source' ? 'source' : 'target';
        const stateId = output.stateId || (role === 'source' ? source.stateId : target.stateId) || firstStateId(nodeIdOf(role));
        add(stateId, { type: 'relationship', edgeId: edge.id, nodeId: nodeIdOf(role), role, setsValue: false });
        if (edge.directionality === 'bidirectional') {
            const otherRole = role === 'source' ? 'target' : 'source';
            const other = (otherRole === 'source' ? source.stateId : target.stateId) || firstStateId(nodeIdOf(otherRole));
            add(other, { type: 'relationship', edgeId: edge.id, nodeId: nodeIdOf(otherRole), role: otherRole, setsValue: false, reciprocal: true });
        }
    }
    return reaching;
}

// What each state is, by state id: { kind: 'rate' | 'update', said } -- `said` when the file says it. A state that says
// no kind is an Update when a setsValue source term, a program's setsValue output or a relationship's several equations
// set it, and a Rate otherwise, as the engine reads it -- in a file that says no kind at all, and for a state placed or
// pasted into one that does.
export function stateKinds(nodes, edges, reaching = termsReachingStates(nodes, edges)) {
    const kinds = new Map();
    for (const node of nodes) {
        for (const state of node.states ?? []) {
            if (state.kind !== undefined) {
                kinds.set(Number(state.id), { kind: state.kind === 'update' ? 'update' : 'rate', said: true });
                continue;
            }
            const setByValue = (reaching.get(Number(state.id)) ?? []).some((term) => term.setsValue);
            kinds.set(Number(state.id), { kind: setByValue ? 'update' : 'rate', said: false });
        }
    }
    return kinds;
}

// How a node's Updates are worked out: 'settle' or 'oncePerStep', and the most sweeps a ring of them takes. Every node of a
// file that says no kind settles.
export function nodeUpdates(node, explicit) {
    return {
        updates: !explicit ? 'settle' : node.updates === 'settle' ? 'settle' : 'oncePerStep',
        limit: Number.isSafeInteger(node.updatesLimit) && node.updatesLimit > 0 ? node.updatesLimit : 1000
    };
}

// The same model, saying its kinds: every state its kind as the engine reads it now, every node that holds an Update
// settling (the numbers stay as they were), and a source term's `setsValue` dropped (an Update's terms set its value by
// being its terms). A relationship's several equations and a program's outputs keep theirs: those still say it. Mutates
// and returns `nodes`; a file that already says its kinds is returned as it was.
export function sayKinds(nodes, edges) {
    if (saysKinds(nodes)) return nodes;
    const kinds = stateKinds(nodes, edges);
    for (const node of nodes) {
        let holdsUpdate = false;
        for (const state of node.states ?? []) {
            state.kind = kinds.get(Number(state.id))?.kind ?? 'rate';
            if (state.kind === 'update') holdsUpdate = true;
        }
        if (holdsUpdate) node.updates = 'settle';
        for (const term of node.sourceTerms ?? []) delete term.setsValue;
    }
    return nodes;
}

// The same model as a file that says no kind, which is what code export writes: `{ nodes, edges }`, or `{ reason }` when it
// cannot be said that way -- an Update worked out once per step, a relationship's single equation setting a value, or an
// Update that reads itself.
export function withoutKinds(nodes, edges) {
    if (!saysKinds(nodes)) return { nodes, edges };
    const reaching = termsReachingStates(nodes, edges);
    const kinds = stateKinds(nodes, edges, reaching);
    const copies = structuredClone(nodes);
    const stateName = new Map();
    for (const node of nodes) for (const state of node.states ?? []) stateName.set(Number(state.id), `${nodeName(node)} · ${state.name ?? state.label ?? state.symbol}`);
    for (const node of copies) {
        const holdsUpdate = (node.states ?? []).some((state) => kinds.get(Number(state.id))?.kind === 'update');
        if (holdsUpdate && node.updates !== 'settle') {
            return { reason: `Node "${nodeName(node)}" works its updates out once per step` };
        }
        for (const term of node.sourceTerms ?? []) {
            const stateId = sourceTermStateId(node, term);
            if (kinds.get(Number(stateId))?.kind !== 'update') continue;
            term.setsValue = true;
            const reads = (term.expressionModel?.bindings ?? []).some((binding) => binding.kind === 'state' && Number(binding.stateId) === Number(stateId));
            if (reads) return { reason: `State "${stateName.get(Number(stateId))}" reads itself` };
        }
        for (const state of node.states ?? []) delete state.kind;
        delete node.updates;
        delete node.updatesLimit;
    }
    for (const [stateId, terms] of reaching) {
        if (kinds.get(stateId)?.kind !== 'update') continue;
        const single = terms.find((term) => term.type === 'relationship' && term.outputIndex === undefined);
        if (single) {
            const edge = edges.find((candidate) => candidate.id === single.edgeId);
            return { reason: `Relationship "${edgeName(edge)}" sets the value of "${stateName.get(stateId)}" with a single equation` };
        }
    }
    return { nodes: copies, edges };
}
