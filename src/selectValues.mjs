/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The editor's dropdowns can only hold text, while the model's ids are numbers. Each dropdown that
// has to carry an id (or two) therefore encodes it as a string and decodes it again on change.
// Keeping each encoder next to its decoder here, as pure functions, is what makes that round trip
// testable -- and it exists because the round trip was once done by hand at the call site and got
// wrong: a relationship's "Updates" choice came back as the string "7", never matched the model's
// number 7 under ===, and so silently reset to the target's first state every time.
//
// The decoders are strict on purpose: they accept only what the matching encoder produces
// (canonical, non-negative integers; known roles) and return null for anything else, so a malformed
// value is visible at the call site instead of turning into NaN further along.

// "0", "7", "12" -- no sign, no fraction, no exponent, no leading zeros, no whitespace.
const canonicalId = /^(0|[1-9]\d*)$/;

function parseId(text) {
    if (typeof text !== 'string' || !canonicalId.test(text)) return null;
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : null;
}

const isRole = (role) => role === 'source' || role === 'target';

// ---- A relationship's "Updates" dropdown: "<role>:<stateId>", e.g. "target:7".

// Lenient on purpose (a provider without an output state yet encodes as "target:"); the decoder is
// the gate.
export function equationOutputValue(role, stateId) {
    return `${role}:${stateId ?? ''}`;
}

export function parseEquationOutput(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split(':');
    if (parts.length !== 2) return null;
    const stateId = parseId(parts[1]);
    return isRole(parts[0]) && stateId !== null ? { role: parts[0], stateId } : null;
}

// ---- A provider binding's "Reference" dropdown: "parameter:<id>" or
// "state:<role>:<nodeId>:<stateId>".

export function providerReferenceValue(reference) {
    return reference.kind === 'parameter'
        ? `parameter:${reference.parameterId}`
        : `state:${reference.role}:${reference.nodeId}:${reference.stateId}`;
}

// A parameter's id comes back as a number when it is canonical digits (a real parameter), and as
// the text itself otherwise -- the relationship builder uses placeholder ids such as
// "builderParameter0" for parameters that don't exist yet, which its caller maps to real ones.
export function parseProviderReference(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split(':');
    if (parts[0] === 'parameter' && parts.length === 2 && parts[1] !== '') {
        return { kind: 'parameter', parameterId: parseId(parts[1]) ?? parts[1] };
    }
    if (parts[0] === 'state' && parts.length === 4) {
        const nodeId = parseId(parts[2]);
        const stateId = parseId(parts[3]);
        if (isRole(parts[1]) && nodeId !== null && stateId !== null) return { kind: 'state', role: parts[1], nodeId, stateId };
    }
    return null;
}

// ---- The causal-inference column mapping dropdown: "create", or "<nodeId>:<stateId>".

export const causalMappingCreateValue = 'create';

export function causalMappingValue(nodeId, stateId) {
    return `${nodeId}:${stateId}`;
}

export function parseCausalMappingValue(value) {
    if (value === causalMappingCreateValue) return { createNew: true };
    if (typeof value !== 'string') return null;
    const parts = value.split(':');
    if (parts.length !== 2) return null;
    const nodeId = parseId(parts[0]);
    const stateId = parseId(parts[1]);
    return nodeId !== null && stateId !== null ? { createNew: false, nodeId, stateId } : null;
}

// ---- The live-run pacing dropdown: "realTime", "fastest", or "limitedRatio:<seconds per second>".

// Deliberately does no validation of its own beyond shaping the value: the engine adapter's
// normalizePacing is the authority on what is acceptable, and a test checks that every option the
// page actually offers passes it.
export function pacingFromValue(value) {
    const [mode, ratio] = String(value ?? '').split(':');
    return { mode, simulationSecondsPerWallSecond: mode === 'realTime' ? 1 : Number(ratio || 1) };
}
