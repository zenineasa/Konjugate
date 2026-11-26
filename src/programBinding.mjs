/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Binding a program's ports (docs/proposals/codeEditor.md, "Binding happens here"): what the code editor's Ports panel writes into a
// program's implementation.bindings, the same entries the card's binding rows wrote before it (so a file is the same whichever wrote it),
// and the choices it offers for a port, those whose unit converts to the port's first. Pure, for the project window and a unit test.

import { inputPortConversion } from './programPortUnits.mjs';

// A relationship's binding to one of its ends' states or one of its parameters, by key (as the relationship card's rows wrote it).
export function referenceToProviderBinding(key, reference) {
    return reference.kind === 'parameter'
        ? { key, kind: 'parameter', parameterId: reference.parameterId }
        : { key, kind: 'state', role: reference.role, nodeId: reference.nodeId, stateId: reference.stateId };
}

// A node's own part's binding to one of its states or one of the part's parameters (as the part's rows wrote it).
export function sourceTermReferenceToBinding(key, reference) {
    return reference.kind === 'parameter'
        ? { key, kind: 'parameter', parameterId: reference.parameterId }
        : { key, kind: 'state', stateId: reference.stateId };
}

// The bindings with `key` bound as `binding` (an entry without its key), in place of its binding when it had one, else after the others;
// `binding` null leaves the key bound to nothing. A new array; the entries of the others are kept as they were. `hint`, the place a row
// was drawn at, only tells apart entries of the same key (entryIndexByKey).
export function bindPort(bindings, key, binding, hint = -1) {
    const list = [...(bindings ?? [])];
    const index = entryIndexByKey(list, key, hint);
    if (!binding) {
        if (index >= 0) list.splice(index, 1);
        return list;
    }
    const entry = { key, ...binding };
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    return list;
}

// What a port can be bound to: each candidate ({ value, label, unit }) with whether its unit converts to the port's and the conversion,
// those that convert first (each group in the model's order). One that cannot is listed, not offered, with the reason.
export function portBindingChoices(portUnit, candidates) {
    const choices = (candidates ?? []).map((candidate, index) => {
        const conversion = inputPortConversion(candidate.unit ?? '', portUnit ?? '');
        return conversion.error
            ? { ...candidate, index, compatible: false, note: `Cannot be bound: ${conversion.error}` }
            : { ...candidate, index, compatible: true, note: conversion.text ?? '' };
    });
    return [...choices.filter((choice) => choice.compatible), ...choices.filter((choice) => !choice.compatible)].map(({ index, ...choice }) => choice);
}

// Where the entry a row was drawn for stands now: by its key, the row's drawn place `hint` used only to tell apart entries of the same
// key (several new rows with no key yet). A row's handler can run after the list was changed under it (reordered, an entry before it
// removed), so it never writes by its drawn place alone. -1 when no entry has the key.
export function entryIndexByKey(entries, key, hint = -1) {
    const list = entries ?? [];
    if (hint >= 0 && hint < list.length && list[hint]?.key === key) return hint;
    return list.findIndex((entry) => entry?.key === key);
}
