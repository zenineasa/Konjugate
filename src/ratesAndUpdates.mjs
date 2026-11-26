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
const present = (item) => !item.deleted;
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
// other end of a bidirectional relationship, which adds the same rate with the opposite sign. A disabled node's or
// relationship's terms reach nothing, unless `includeDisabled` asks for every term as it would be with them on; each of
// those then says `off`.
export function termsReachingStates(nodes, edges, { includeDisabled = false } = {}) {
    const counts = includeDisabled ? present : enabled;
    const reaching = new Map();
    let off = false;
    const add = (stateId, term) => {
        if (stateId == null || stateId === '') return;
        const key = Number(stateId);
        if (!reaching.has(key)) reaching.set(key, []);
        reaching.get(key).push(off ? { ...term, off: true } : term);
    };
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const firstStateId = (nodeId) => nodesById.get(nodeId)?.states?.[0]?.id ?? null;
    for (const node of nodes) {
        if (!counts(node)) continue;
        off = !enabled(node);
        for (const term of node.sourceTerms ?? []) {
            add(sourceTermStateId(node, term), { type: 'sourceTerm', nodeId: node.id, termId: term.id, setsValue: term.setsValue === true });
        }
        for (const output of node.implementation?.outputs ?? []) {
            add(output.stateId, { type: 'program', nodeId: node.id, outputKey: output.key, setsValue: output.setsValue === true || node.implementation.kind === 'fmi' });
        }
    }
    for (const edge of edges) {
        if (!counts(edge)) continue;
        const source = endpoint(edge, 'source');
        const target = endpoint(edge, 'target');
        if (!counts(nodesById.get(source.nodeId) ?? {}) || !counts(nodesById.get(target.nodeId) ?? {})) continue;
        off = !enabled(edge) || !enabled(nodesById.get(source.nodeId) ?? {}) || !enabled(nodesById.get(target.nodeId) ?? {});
        const nodeIdOf = (role) => (role === 'source' ? source.nodeId : target.nodeId);
        const outputs = edge.equationModel?.outputs;
        if (Array.isArray(outputs)) {
            outputs.forEach((output, outputIndex) => add(output.stateId, {
                type: 'relationship', edgeId: edge.id, nodeId: nodeIdOf(output.role), outputIndex, role: output.role, setsValue: true
            }));
            continue;
        }
        // A program with several outputs (implementation.outputs): each reaches its state, a rate or a value as that state's kind says.
        const programOutputs = edge.implementation?.outputs;
        if (Array.isArray(programOutputs) && programOutputs.length) {
            programOutputs.forEach((output, outputIndex) => add(output.stateId, {
                type: 'relationship', edgeId: edge.id, nodeId: nodeIdOf(output.role === 'source' ? 'source' : 'target'), outputIndex, outputKey: output.key,
                role: output.role === 'source' ? 'source' : 'target', setsValue: false, programOutput: true
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
// pasted into one that does. A state's kind is the same whether its node is on or off, so a disabled node's own terms, and a
// disabled relationship's, count.
export function stateKinds(nodes, edges) {
    const reaching = termsReachingStates(nodes, edges, { includeDisabled: true });
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

const statedLimit = (item) => (Number.isSafeInteger(item?.updatesLimit) && item.updatesLimit > 0 ? item.updatesLimit : null);

// The subsystems a node is in, at any depth, that settle their nodes' Updates, innermost first ("over a subsystem" in
// docs/proposals/ratesAndUpdates.md). `subsystems` is the project's subsystem records.
export function settlingSubsystems(node, subsystems = []) {
    const byId = new Map((subsystems ?? []).map((subsystem) => [subsystem.id, subsystem]));
    const found = [];
    const seen = new Set();
    for (let at = byId.get(node.subsystemId); at && !seen.has(at.id); at = byId.get(at.parentSubsystemId)) {
        seen.add(at.id);
        if (at.updates === 'settle') found.push(at);
    }
    return found;
}

// How a node's Updates are worked out: 'settle' or 'oncePerStep', and the most sweeps a ring of them takes -- the largest
// the node or a settling subsystem it is in gives, 1000 when none gives one, as the engine reads it. Every node of a file
// that says no kind settles. `setBy` is the innermost subsystem that settles it when the node does not say so itself.
export function nodeUpdates(node, explicit, subsystems = []) {
    const settlingAround = settlingSubsystems(node, subsystems);
    const limits = [statedLimit(node), ...settlingAround.map(statedLimit)].filter((limit) => limit !== null);
    const own = !explicit || node.updates === 'settle';
    return {
        updates: own || settlingAround.length ? 'settle' : 'oncePerStep',
        limit: limits.length ? Math.max(...limits) : 1000,
        setBy: !own && settlingAround.length ? settlingAround[0] : null
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

// Content put into a model -- pasted, placed from the library, a component, a new node -- and the model must say their
// states' kinds alike, since the engine reads a file that says no kind (every node settling) by different rules from one that
// says any: one state saying its kind anywhere would change the numbers of everything that says none. The side that says
// none is made to say them, as it is read now, so neither side's numbers change: `incomingNodes` before it goes in, or
// `existingNodes` as it does. Mutates that side; returns 'incoming', 'existing', or null when both already say alike (or
// the model is empty). `edges` is every relationship of both.
export function sayKindsAlike(existingNodes, incomingNodes, edges) {
    const existingSays = saysKinds(existingNodes);
    if (existingSays === saysKinds(incomingNodes) || !incomingNodes.length) return null;
    if (existingSays) {
        sayKinds(incomingNodes, edges);
        return 'incoming';
    }
    if (!existingNodes.length) return null;
    sayKinds(existingNodes, edges);
    return 'existing';
}

// The same model as a file that says no kind, which is what code export writes: `{ nodes, edges }`, or `{ reason }` when it
// cannot be said that way -- an Update something sets worked out once per step, a relationship's single equation setting a value,
// or an Update that reads itself.
export function withoutKinds(nodes, edges) {
    if (!saysKinds(nodes)) return { nodes, edges };
    const reaching = termsReachingStates(nodes, edges);
    const kinds = stateKinds(nodes, edges);
    const copies = structuredClone(nodes);
    const stateName = new Map();
    for (const node of nodes) for (const state of node.states ?? []) stateName.set(Number(state.id), `${nodeName(node)} · ${state.name ?? state.label ?? state.symbol}`);
    for (const node of copies) {
        // An Update nothing reaches never changes, worked out once per step or settled alike (an FMU's input port, held by the host,
        // docs/proposals/rootPorts.md): written as a state nothing changes, its numbers are the same.
        const holdsUpdate = (node.states ?? []).some((state) => kinds.get(Number(state.id))?.kind === 'update' && (reaching.get(Number(state.id)) ?? []).length > 0);
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
