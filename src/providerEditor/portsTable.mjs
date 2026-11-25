/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's Ports panel, as rows (docs/proposals/codeEditor.md, "Ports: the program in its model"): what the program declares,
// from the engine's description (describeProgram), each port beside what the model binds it to, in the model's names, with its unit,
// its value now and the conversion a run applies at the port (src/programPortUnits.mjs, the engine's own rule). Pure: the panel draws
// these rows and a unit test reads them.
//
// description: the engine's answer, { inputs, outputs, memory, clock } (null when there is none: a version 1 program, or no engine).
// context: what the project says of the program's bindings,
//   bindings: [{ key, label, unit, value }]   each binding of an input; label '' when it reads nothing, unit null when not known
//   outputs:  [{ key, label, unit, rate }]    where each output goes; rate true for a Rate state (which takes unit/s)

import { inputPortConversion, outputPortConversion } from '../programPortUnits.mjs';

const tags = { input: 'IN', parameter: 'PAR', constant: 'CONST' };

const conversionNote = (conversion) => (conversion.error
    ? { note: `Units do not match: ${conversion.error}`, state: 'problem' }
    : { note: conversion.text ?? '', state: 'ok' });

// The words of a run that finds an input bound to nothing and with no default.
export function unboundInputSentence(key) {
    return `Input ‘${key}’ is not bound to anything and has no default.`;
}

export function portsTable(description, context = {}) {
    const bindings = context.bindings ?? [];
    const outputs = context.outputs ?? [];
    const rows = [];
    if (!description) {
        // Without a description (an older program, or no engine to read it): its bindings, by key, and nothing it cannot know.
        for (const binding of bindings) {
            rows.push({ group: 'input', tag: 'IN', key: binding.key, unit: '', bound: binding.label || null, value: binding.value ?? null,
                note: binding.label ? '' : 'not bound', state: binding.label ? 'ok' : 'problem', line: null });
        }
        for (const output of outputs) {
            rows.push({ group: 'output', tag: 'OUT', key: output.key, unit: '', bound: output.label || null, value: null,
                note: output.label ? '' : 'not bound', state: output.label ? 'ok' : 'problem', line: null, part: output.rate === false ? 'a value' : 'a rate' });
        }
        return { rows, described: false };
    }

    const declaredInputs = new Set((description.inputs ?? []).map((port) => port.key));
    const declaredOutputs = new Set((description.outputs ?? []).map((port) => port.key));
    for (const port of description.inputs ?? []) {
        const binding = bindings.find((candidate) => candidate.key === port.key && candidate.label);
        const row = { group: 'input', tag: tags[port.kind] ?? 'IN', key: port.key, unit: port.unit ?? '', bound: binding?.label ?? null,
            value: binding ? binding.value ?? null : port.default ?? null, line: port.line ?? null, note: '', state: 'ok' };
        if (binding) {
            Object.assign(row, conversionNote(inputPortConversion(binding.unit ?? '', port.unit ?? '')));
        } else if (port.default === undefined || port.default === null) {
            Object.assign(row, { note: unboundInputSentence(port.key), state: 'problem' });
        } else {
            row.note = 'not bound: its default';
        }
        rows.push(row);
    }
    for (const port of description.outputs ?? []) {
        const output = outputs.find((candidate) => candidate.key === port.key && candidate.label);
        const row = { group: 'output', tag: 'OUT', key: port.key, unit: port.unit ?? '', bound: output?.label ?? null, value: null,
            line: port.line ?? null, part: output ? (output.rate === false ? 'a value' : 'a rate') : '', note: '', state: 'ok' };
        if (output) Object.assign(row, conversionNote(outputPortConversion(port.unit ?? '', { unit: output.unit ?? '', rate: output.rate !== false })));
        else Object.assign(row, { note: 'not bound: reaches no state', state: 'problem' });
        rows.push(row);
    }
    for (const memory of description.memory ?? []) {
        rows.push({ group: 'memory', tag: 'MEM', key: memory.name, unit: memory.unit ?? '', bound: null, line: memory.line ?? null,
            value: Array.isArray(memory.start) ? (memory.start.length === 1 ? memory.start[0] : memory.start) : null, note: '', state: 'ok' });
    }
    if (description.clock) {
        const period = description.clock.period;
        rows.push({ group: 'clock', tag: 'CLOCK', key: period === null || period === undefined ? 'clock' : `every ${Number(period.toPrecision(6))} s`,
            unit: '', bound: null, value: null, line: description.clock.line ?? null, note: description.clock.constant ? `its period is ${description.clock.constant}` : '', state: 'ok' });
    }
    // A binding to a key the program no longer declares stays in sight, so nothing disappears without being noticed.
    for (const binding of bindings) {
        if (binding.label && !declaredInputs.has(binding.key)) {
            rows.push({ group: 'stale', tag: 'IN', key: binding.key, unit: '', bound: binding.label, value: binding.value ?? null, line: null,
                note: 'not a port of this program', state: 'stale' });
        }
    }
    for (const output of outputs) {
        if (output.label && !declaredOutputs.has(output.key)) {
            rows.push({ group: 'stale', tag: 'OUT', key: output.key, unit: '', bound: output.label, value: null, line: null,
                note: 'not a port of this program', state: 'stale' });
        }
    }
    return { rows, described: true };
}

// A value as the panel shows it: six significant figures, a list as its first values.
export function formatPortValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.slice(0, 3).map(formatPortValue).join(', ') + (value.length > 3 ? ', …' : '');
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const number = Number(value);
    return Number.isFinite(number) ? String(Number(number.toPrecision(6))) : String(value);
}
