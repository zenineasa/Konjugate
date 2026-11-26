/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A node's own program (its `implementation`, see docs/projectSchema.md) as the canvas edits it: a Python or C++
// computational-node provider, or an installed FMU, reading inputs (any node's states, shared parameters) under keys
// and writing outputs (this node's states) under keys. Pure functions of their arguments.

import { distinctPartName } from './boxPorts.mjs';

export const nodeProgramKeyPattern = /^[a-z][A-Za-z0-9]*$/;

// What an input may read, each as { value, label, binding } where `value` is the dropdown's text: this node's states,
// every other node's states (read from the step's synchronisation snapshot), and every shared parameter.
// Each candidate also says its unit and its group, by whose it is: "This node", another node's name, or "Shared parameters" (the
// Connect to… picker, docs/proposals/fmuImportWorkflow.md stage 5, which shows the unit after the label; the code editor's Ports shows
// units in a column of their own, so the label carries none).
export function nodeProgramInputCandidates(node, nodes, sharedParameters) {
    const candidates = [];
    for (const state of node.states ?? []) {
        candidates.push({ value: `state:${node.id}:${state.id}`, label: `this.${state.symbol}`, unit: state.unit ?? '', group: 'This node', binding: { kind: 'state', stateId: state.id } });
    }
    for (const other of nodes) {
        if (other.id === node.id) continue;
        const name = other.title ?? other.name;
        for (const state of other.states ?? []) {
            candidates.push({ value: `state:${other.id}:${state.id}`, label: `${name}.${state.symbol}`, unit: state.unit ?? '', group: name, binding: { kind: 'state', nodeId: other.id, stateId: state.id } });
        }
    }
    for (const shared of sharedParameters) {
        candidates.push({ value: `shared:${shared.id}`, label: `shared ${shared.name} (${shared.symbol})`, unit: shared.unit ?? '', group: 'Shared parameters', binding: { kind: 'parameter', sharedParameterId: shared.id } });
    }
    return candidates;
}

// What an FMU's input row says of what it reads (stage 5): a unit that differs from the input's own, warned and not converted,
// and, when it reads another node's state, when it reads it: at the start of each step, so one step late.
export function fmuConnectionNotes(binding, port, node, nodes) {
    if (binding?.kind !== 'state' || binding.stateId === null || binding.stateId === undefined) return [];
    const owner = binding.nodeId === undefined || binding.nodeId === null ? node : nodes.find((candidate) => candidate.id === binding.nodeId);
    const state = owner?.states?.find((candidate) => candidate.id === binding.stateId);
    if (!state) return [];
    const notes = [];
    const name = owner === node ? `this.${state.symbol}` : `${owner.title ?? owner.name}.${state.symbol}`;
    const unit = state.unit ?? '';
    if (port?.unit && unit !== port.unit) notes.push(unit ? `${name} is in ${unit}; this input is in ${port.unit}. It is not converted.` : `${name} has no unit; this input is in ${port.unit}.`);
    if (owner !== node) notes.push('Read at the start of each step, so one step late.');
    return notes;
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

// The rows of an FMU node's card, one per input or parameter in the FMU's own order, each with its binding found by key (or reading
// nothing, the FMU's own start, when the file left it out: implementationForFile), then any binding the FMU has no port for. The
// card draws and writes each row by its key, never by its place in `bindings`, whose order follows the file and the connections
// made (a drag appends). `index` is the binding's place in `bindings` (-1 when it has none), for its row's errors only.
export function fmuInputRows(portInputs, bindings) {
    const list = bindings ?? [];
    const used = new Set();
    const rows = (portInputs ?? []).map((port) => {
        const index = list.findIndex((binding, at) => binding?.key === port.key && !used.has(at));
        if (index >= 0) used.add(index);
        return { key: port.key, binding: index >= 0 ? list[index] : { key: port.key, kind: 'state', stateId: null }, index };
    });
    list.forEach((binding, index) => { if (!used.has(index)) rows.push({ key: binding?.key, binding, index }); });
    return rows;
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
// A project that keeps an FMU's archive in its file (container version 2, src/projectFile.mjs) says so too (stage 8).
export const fmuAttachmentsRequirement = 'fmuAttachments';
// The largest FMU archive kept in a project by default: a larger one is linked to the library instead, which its card can change.
export const fmuKeepLimitBytes = 16 * 1024 * 1024;

// Whether a node's FMU is kept in the project's file (its archive, by fmuSha256), rather than linked to the library.
export function fmuKeptInProject(implementation) {
    return implementation?.kind === 'fmi' && typeof implementation.fmuSha256 === 'string' && !implementation.fmuLink;
}

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
    const others = (previous ?? []).filter((entry) => entry !== fmuStartValuesRequirement && entry !== fmuAttachmentsRequirement);
    const fmuNodes = (nodes ?? []).filter((node) => node?.implementation?.kind === 'fmi');
    const needed = fmuNodes.some((node) => fmuUsesStartValues(node.implementation))
        || ((previous ?? []).includes(fmuStartValuesRequirement) && fmuNodes.length > 0);
    const kept = fmuNodes.some((node) => fmuKeptInProject(node.implementation));
    return [...others, ...(needed ? [fmuStartValuesRequirement] : []), ...(kept ? [fmuAttachmentsRequirement] : [])];
}

// ---- The node an FMU becomes (docs/proposals/fmuImportWorkflow.md, stage 3) -----------------------------------------------
// Choosing an FMU builds the node from it: a state for every output, named by the FMU's variable, with its unit and its start
// value, each set by the FMU; every input and parameter listed, reading nothing (so keeping the FMU's start value) unless the
// earlier wiring read something under the same key. A state that already stands for an output (it was that output's state, or
// its symbol is the output's key) is kept as the person left it. States in `removableStateIds` (the untouched state a new node
// starts with) go, and are never taken for an output. `newId()` gives an id for each new state, and `makeState` its shape (the
// canvas keeps a state's name as `label`, with the value text it shows). Returns
// { states, implementation, name } -- name the FMU's model name when the node still has a new node's name, else its own.
export const newNodeName = 'New node';

export function fmiNodeFromPorts(definition, { guid, version, ports, newId, removableStateIds = [], makeState = (state) => state, takenNames = [] }) {
    const previous = definition.implementation?.kind === 'fmi' ? definition.implementation : null;
    const implementation = fmiImplementation(guid, version, ports, previous);
    // Kept in the project by its archive's SHA-256 (stage 8), unless the node was linked, or the archive is over the limit kept by
    // default (then linked, which the card says and can change).
    if (ports.about?.archiveSha256) {
        implementation.fmuSha256 = ports.about.archiveSha256;
        if (previous?.fmuLink || (!previous?.fmuSha256 && ports.about.archiveBytes > fmuKeepLimitBytes)) implementation.fmuLink = true;
    }
    const removable = new Set(removableStateIds);
    // The untouched state a new node starts with is never taken for an output, even one of the same symbol (Dahlquist's x):
    // the output's state starts where the FMU starts it.
    const states = (definition.states ?? []).filter((state) => !removable.has(state.id));
    const previousOutputState = new Map((previous?.outputs ?? []).map((output) => [output.key, output.stateId]));
    const used = new Set();
    const symbols = new Set(states.map((state) => state.symbol));
    implementation.outputs = (ports.outputs ?? []).map((port) => {
        const earlier = states.find((state) => state.id === previousOutputState.get(port.key) && !used.has(state.id))
            ?? states.find((state) => state.symbol === port.key && !used.has(state.id));
        let state = earlier;
        if (!state) {
            let symbol = port.key;
            for (let suffix = 2; symbols.has(symbol); suffix += 1) symbol = `${port.key}${suffix}`;
            symbols.add(symbol);
            state = makeState({ id: newId(), name: port.name, symbol, initialValue: Number.isFinite(port.start) ? port.start : 0, unit: port.unit ?? '' });
            states.push(state);
        }
        used.add(state.id);
        return { key: port.key, stateId: state.id, setsValue: true };
    });
    return {
        states,
        implementation,
        // In the canvas a node's name is its `title`; in the file, its `name`. Named after the FMU, it is numbered when another node
        // (`takenNames`) has that name already: the same FMU added twice is "PidController" and "PidController 2".
        name: ((current) => (!current || current === newNodeName ? (ports.name ? distinctPartName(ports.name, takenNames) : current) : current))(definition.title ?? definition.name)
    };
}

// How an FMU's input or parameter is described on its row: "parameter · tunable", "parameter · fixed: set when the run
// starts", "input"; with its unit and bounds, for the row's hint.
export function fmuPortRole(port) {
    if (port.causality !== 'parameter') return 'input';
    return port.variability === 'tunable' ? 'parameter · tunable' : 'parameter · fixed';
}

export function fmuPortHint(port) {
    const parts = [];
    if (port.description) parts.push(port.description);
    if (Number.isFinite(port.min) || Number.isFinite(port.max)) {
        parts.push(`from ${Number.isFinite(port.min) ? port.min : '−∞'} to ${Number.isFinite(port.max) ? port.max : '∞'}${port.unit ? ` ${port.unit}` : ''}`);
    }
    if (port.causality === 'parameter' && port.variability !== 'tunable') parts.push('set once, when the run starts');
    return parts.join(' · ');
}

// The lines of the card's "About this FMU", from what describeInstalledFmuPorts gives as `about` (src/fmiResolver.mjs).
export function fmuAboutLines(about) {
    if (!about) return [];
    const lines = [];
    lines.push(`FMI ${about.fmiVersion} Co-Simulation${about.generationTool ? ` · generated by ${about.generationTool}` : ''}`);
    if (about.description) lines.push(about.description);
    const made = [about.author && `by ${about.author}`, about.version && `version ${about.version}`, about.copyright, about.license && `license: ${about.license}`].filter(Boolean);
    if (made.length) lines.push(made.join(' · '));
    if (about.platforms?.length) lines.push(`Binaries for ${about.platforms.join(', ')}${about.runsHere === false ? ' (none for this computer)' : ''}`);
    const step = about.coSimulation?.fixedInternalStepSize;
    const steps = [];
    if (Number.isFinite(step)) steps.push(`its own step is ${step} s`);
    if (about.coSimulation && !about.coSimulation.canHandleVariableCommunicationStepSize) steps.push('it needs every step the same length');
    if (steps.length) lines.push(`Steps: ${steps.join('; ')}`);
    const experiment = about.defaultExperiment;
    if (experiment && Object.keys(experiment).length) {
        const said = [
            Number.isFinite(experiment.stopTime) && `to ${experiment.stopTime} s`,
            Number.isFinite(experiment.stepSize) && `in steps of ${experiment.stepSize} s`,
            Number.isFinite(experiment.tolerance) && `tolerance ${experiment.tolerance}`
        ].filter(Boolean);
        if (said.length) lines.push(`Suggested run: ${said.join(', ')}`);
    }
    lines.push(about.canGetAndSetFMUState ? 'Can save and restore its state (checkpoints, forks, rewinding a twin)' : 'Cannot save its state: checkpoints, forks and rewinding are not available with it');
    if (about.coSimulation?.canBeInstantiatedOnlyOncePerProcess) lines.push('Only one copy of it can run at a time');
    return lines;
}
