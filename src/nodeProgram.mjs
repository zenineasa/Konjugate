/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A node's own program (its `implementation`, see docs/projectSchema.md) as the canvas edits it: a Python or C++
// computational-node provider, or an installed FMU, reading inputs (any node's states, shared parameters) under keys
// and writing outputs (this node's states) under keys. Pure functions of their arguments.

export const nodeProgramKeyPattern = /^[a-z][A-Za-z0-9]*$/;

// What an input may read, each as { value, label, binding } where `value` is the dropdown's text: this node's states,
// every other node's states (read from the step's synchronisation snapshot), and every shared parameter.
export function nodeProgramInputCandidates(node, nodes, sharedParameters) {
    const candidates = [];
    for (const state of node.states ?? []) {
        candidates.push({ value: `state:${node.id}:${state.id}`, label: `this.${state.symbol}`, binding: { kind: 'state', stateId: state.id } });
    }
    for (const other of nodes) {
        if (other.id === node.id) continue;
        for (const state of other.states ?? []) {
            candidates.push({ value: `state:${other.id}:${state.id}`, label: `${other.title ?? other.name}.${state.symbol}`, binding: { kind: 'state', nodeId: other.id, stateId: state.id } });
        }
    }
    for (const shared of sharedParameters) {
        candidates.push({ value: `shared:${shared.id}`, label: `shared ${shared.name} (${shared.symbol})`, binding: { kind: 'parameter', sharedParameterId: shared.id } });
    }
    return candidates;
}

// The dropdown value of an input binding, '' when it reads nothing yet.
export function nodeProgramInputValue(binding, node) {
    if (binding?.kind === 'parameter' && binding.sharedParameterId !== undefined) return `shared:${binding.sharedParameterId}`;
    if (binding?.kind === 'state' && binding.stateId !== undefined && binding.stateId !== null) return `state:${binding.nodeId ?? node.id}:${binding.stateId}`;
    return '';
}

// Why the program cannot run as written, as { inputs: [errors per row], outputs: [errors per row], errors: [general] }.
export function nodeProgramErrors(implementation, node, nodes, sharedParameters) {
    const result = { inputs: [], outputs: [], errors: [] };
    if (!implementation) return result;
    const known = new Set(nodeProgramInputCandidates(node, nodes, sharedParameters).map((candidate) => candidate.value));
    const keyErrors = (key, seen, what) => {
        if (!nodeProgramKeyPattern.test(key ?? '')) return [`"${key ?? ''}" is not a valid ${what} key: start with a lowercase letter and use only letters and digits.`];
        if (seen.has(key)) return [`Two ${what}s are called "${key}".`];
        seen.add(key);
        return [];
    };
    const inputKeys = new Set();
    for (const binding of implementation.bindings ?? []) {
        const errors = keyErrors(binding.key, inputKeys, 'input');
        const value = nodeProgramInputValue(binding, node);
        if (!value) errors.push('Choose what this input reads.');
        else if (!known.has(value)) errors.push('What this input read is gone; choose again.');
        result.inputs.push(errors);
    }
    const outputKeys = new Set();
    const ownStates = new Set((node.states ?? []).map((state) => state.id));
    for (const output of implementation.outputs ?? []) {
        const errors = keyErrors(output.key, outputKeys, 'output');
        if (!ownStates.has(output.stateId)) errors.push('Choose which of this node\'s states this output changes.');
        result.outputs.push(errors);
    }
    if (!(implementation.outputs ?? []).length) result.errors.push('Add an output: a program changes at least one of its node\'s states.');
    if (implementation.kind === 'fmi' && !(implementation.fmuId && implementation.fmuVersion)) result.errors.push('Choose an installed FMU.');
    return result;
}

// A key not yet used among `items`, from `base` (base, base2, base3, ...).
export function freeKey(items, base) {
    const taken = new Set(items.map((item) => item.key));
    if (!taken.has(base)) return base;
    for (let index = 2; ; index += 1) if (!taken.has(`${base}${index}`)) return `${base}${index}`;
}

// An installed FMU wired into a node: one input per FMU input or parameter and one output per FMU output, each under
// the FMU's own key, keeping whatever the node's earlier wiring read and wrote under the same keys. Every FMU output
// sets its state's value (the FMU reports values, not rates).
export function fmiImplementation(guid, version, ports, previous = null) {
    const bindings = new Map((previous?.bindings ?? []).map((binding) => [binding.key, binding]));
    const outputs = new Map((previous?.outputs ?? []).map((output) => [output.key, output]));
    return {
        kind: 'fmi', fmuId: guid, fmuVersion: version,
        bindings: ports.inputs.map(({ key }) => {
            const earlier = bindings.get(key);
            return earlier ? { ...earlier, key } : { key, kind: 'state', stateId: null };
        }),
        outputs: ports.outputs.map(({ key }) => ({ key, stateId: outputs.get(key)?.stateId ?? null, setsValue: true }))
    };
}
