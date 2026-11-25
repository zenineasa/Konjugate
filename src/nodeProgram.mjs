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
    const isFmu = implementation.kind === 'fmi';
    for (const binding of implementation.bindings ?? []) {
        const errors = keyErrors(binding.key, inputKeys, 'input');
        const value = nodeProgramInputValue(binding, node);
        // An FMU's input or parameter that reads nothing keeps the FMU's own start value; one given a value keeps that.
        if (isFmu && binding?.kind === 'value') {
            if (!Number.isFinite(binding.value)) errors.push('Give this input a number.');
        } else if (!value) {
            if (!isFmu) errors.push('Choose what this input reads.');
        }
        if (value && !known.has(value)) errors.push('What this input read is gone; choose again.');
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

const floatTypes = new Set(['Real', 'Float64', 'Float32']);

function listOf(names) {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// What the person wiring an FMU should know about how it runs here, as short sentences under the FMU's name: which of
// its binaries runs, the parameters it fixes when the run starts, the ports that are not real numbers and how they are
// converted, and what is not wired at all. ports is what describeInstalledFmuPorts returns (src/fmiResolver.mjs).
export function fmuPortNotes(ports) {
    const notes = [];
    if (ports.binary) notes.push(ports.binary);
    const inputs = ports.inputs ?? [];
    const outputs = ports.outputs ?? [];
    const fixed = inputs.filter((port) => port.causality === 'parameter' && port.variability !== 'tunable').map((port) => port.name);
    if (fixed.length) notes.push(`Set once, when the run starts (fixed): ${listOf(fixed)}.`);
    const whole = inputs.filter((port) => port.type && !floatTypes.has(port.type) && port.type !== 'Boolean').map((port) => `${port.name} (${port.type})`);
    if (whole.length) notes.push(`Take the nearest whole number: ${listOf(whole)}.`);
    const flags = inputs.filter((port) => port.type === 'Boolean').map((port) => port.name);
    if (flags.length) notes.push(`True for anything other than 0: ${listOf(flags)}.`);
    const read = outputs.filter((port) => port.type && !floatTypes.has(port.type));
    if (read.length) {
        const booleans = read.some((port) => port.type === 'Boolean') ? ', true as 1 and false as 0' : '';
        notes.push(`Read as numbers${booleans}: ${listOf(read.map((port) => `${port.name} (${port.type})`))}.`);
    }
    const notExposed = (ports.notExposed ?? []).map((variable) => `${variable.name} (${variable.type})`);
    if (notExposed.length) notes.push(`Not wired, so the FMU keeps its own value: ${listOf(notExposed)}.`);
    return notes;
}

// ---- An FMU's start values (docs/proposals/fmuImportWorkflow.md, stage 2) -------------------------------------------------
// An FMU's input or parameter with no binding keeps the FMU's own start value, and one bound as `{ key, kind: "value", value }`
// is set to that value once, when the run starts (src/fmiResolver.mjs). A file that relies on either says so with this entry in
// its `requires`, so a Konjugate from before refuses it by name rather than running it differently.
export const fmuStartValuesRequirement = 'fmuStartValues';

// Whether a binding of an FMU node reads something: a state, a shared parameter or a value of its own.
function fmuBindingTargeted(binding) {
    if (binding?.kind === 'value') return true;
    if (binding?.kind === 'parameter') return binding.sharedParameterId !== undefined && binding.sharedParameterId !== null;
    if (binding?.kind === 'state') return binding.stateId !== undefined && binding.stateId !== null;
    return false;
}

// Whether a node's FMU takes any start value of its own or any value given in the file.
export function fmuUsesStartValues(implementation) {
    if (implementation?.kind !== 'fmi') return false;
    return (implementation.bindings ?? []).some((binding) => binding?.kind === 'value' || !fmuBindingTargeted(binding));
}

// An implementation as the file keeps it: an FMU's inputs that read nothing are left out (they keep the FMU's start value).
export function implementationForFile(implementation) {
    if (implementation?.kind !== 'fmi' || !Array.isArray(implementation.bindings)) return implementation;
    if (implementation.bindings.every(fmuBindingTargeted)) return implementation;
    return { ...implementation, bindings: implementation.bindings.filter(fmuBindingTargeted) };
}

// The document's `requires`, from what it required when it was opened (`previous`) and its nodes now: `fmuStartValues` while
// a node's FMU takes a start value or a given value. A file opened with it keeps it while it still has an FMU node, since a
// binding it left out is not known here without the FMU's ports.
export function documentRequires(previous, nodes) {
    const others = (previous ?? []).filter((entry) => entry !== fmuStartValuesRequirement);
    const fmuNodes = (nodes ?? []).filter((node) => node?.implementation?.kind === 'fmi');
    const needed = fmuNodes.some((node) => fmuUsesStartValues(node.implementation))
        || ((previous ?? []).includes(fmuStartValuesRequirement) && fmuNodes.length > 0);
    return needed ? [...others, fmuStartValuesRequirement] : others;
}
