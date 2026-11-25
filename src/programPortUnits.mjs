/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The conversion a version 2 program's port applies (docs/proposals/codeEditor.md, Ports), worked out in the page exactly as the engine
// works it out when a run starts (engine/src/programUnits.cpp and ProgramBackend::addProgramInstance in providerRuntime.cpp), so the
// code editor's Ports panel and a run cannot disagree. It reads units with the app's catalogue (src/units.mjs), the one the engine's
// copy follows; tests/engine/programDescription.mjs holds this module to the engine's answers, number for number.
//
//   portUnitConversion(from, to, { rate })   value in `to` = value in `from` x scale + offset: { scale, offset, identity } or { error }
//   inputPortConversion(boundUnit, portUnit) what reaches an input from what it is bound to (a state's or a parameter's unit)
//   outputPortConversion(portUnit, state)    what reaches a state from an output; `state` is { unit, rate } (a Rate state takes unit/s)
//   perSecond(unit)                          the unit of a rate of a quantity in `unit`, as the engine writes it ("K" gives "K/s")
//
// Each answer without an error also has `text`, the words the Ports panel shows ("°C → K at the port"), or null when nothing is converted.
// An empty unit on either side means the port is not checked and nothing is converted, as the engine does.

import { parseUnit } from './units.mjs';

const angle = 7;
const time = 2;

// The engine's tidy(): a value within 1e-12 of a whole number is that number; anything else is left exactly as computed.
const tidy = (value) => (Math.abs(value - Math.round(value)) < 1e-12 * Math.max(1, Math.abs(value)) ? Math.round(value) : value);

// unitConversion() in engine/src/programUnits.cpp, with its words.
export function portUnitConversion(from, to, { rate = false } = {}) {
    const source = parseUnit(from);
    const target = parseUnit(to);
    if (!source) return { error: `"${from}" is not a unit Konjugate knows` };
    if (!target) return { error: `"${to}" is not a unit Konjugate knows` };
    // An angular speed and a frequency, or an angle and a pure number, differ only by an angle.
    const onlyAngle = Math.abs(Math.abs(source.dimensions[angle] - target.dimensions[angle]) - 1) < 1e-12
        && source.dimensions.every((value, index) => index === angle || value === target.dimensions[index]);
    const same = source.dimensions.every((value, index) => value === target.dimensions[index]);
    if (!same && !onlyAngle) return { error: `${from === '' ? 'a pure number' : from} and ${to === '' ? 'a pure number' : to} measure different kinds of quantity` };
    const asCycles = onlyAngle && source.dimensions[time] < 0;
    const cycle = asCycles ? (source.dimensions[angle] > target.dimensions[angle] ? 1 / (2 * Math.PI) : 2 * Math.PI) : 1;
    const scale = tidy(source.scale * cycle / target.scale);
    const offset = rate ? 0 : tidy((source.offset - target.offset) / target.scale);
    return { scale, offset, identity: scale === 1 && offset === 0 };
}

export function perSecond(unit) {
    if (!unit) return 'Hz';
    if (!/[/*· ]/.test(unit)) return `${unit}/s`;
    return `(${unit})/s`;
}

const described = (conversion, from, to) => (conversion.error ? conversion : { ...conversion, text: conversion.identity ? null : `${from} → ${to} at the port` });

// An input: the bound value's unit onto the port's. Unchecked (identity) when either has no unit.
export function inputPortConversion(boundUnit, portUnit) {
    if (!boundUnit || !portUnit) return { scale: 1, offset: 0, identity: true, text: null };
    return described(portUnitConversion(boundUnit, portUnit), boundUnit, portUnit);
}

// An output: the port's unit onto its state's; a Rate state takes the state's unit per second, and a rate never takes an offset.
export function outputPortConversion(portUnit, { unit, rate = true } = {}) {
    if (!portUnit || !unit) return { scale: 1, offset: 0, identity: true, text: null };
    const expected = rate ? perSecond(unit) : unit;
    return described(portUnitConversion(portUnit, expected, { rate }), portUnit, expected);
}
