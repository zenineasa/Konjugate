/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Suggesting how a source's signals map to a model (src/signalMatching.mjs): plant-style tags matched by their words, their ISA
// letters, their units and their behaviour, with the conversion proposed; the same name as near certain; a quantity of another kind
// never suggested; each model quantity used once; and a match confirmed before remembered.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mappingCandidates, nameWords, rememberMapping, suggestMapping } from '../src/signalMatching.mjs';
import { tankRigProject } from '../scripts/generateTankRigModel.mjs';

const rig = tankRigProject();
const smooth = Array.from({ length: 30 }, (_, index) => 25 + index * 0.4);
const steps = Array.from({ length: 30 }, (_, index) => (index % 10 < 5 ? 1 : 0));
const byName = (suggestions) => Object.fromEntries(suggestions.map((suggestion) => [suggestion.name, suggestion]));

test('a name\'s words: separators, camelCase, digits, decorations, abbreviations and ISA tags', () => {
    assert.deepEqual(nameWords('TK1.TT101.PV').words, ['tank', 'temperature']);
    assert.equal(nameWords('TK1.TT101.PV').instrument.quantity, 'temperature');
    assert.deepEqual(nameWords('heaterPowerValue').words, ['heater', 'power']);
    assert.deepEqual(nameWords('AMB_Temp').words, ['ambient', 'temperature']);
    assert.deepEqual(nameWords('ns=2;s=Line3/Heater/Pwr').words, ['line', 'heater', 'power']);
    assert.equal(nameWords('JI-204').instrument.quantity, 'power');
    assert.equal(nameWords('TK1').instrument, null, 'A tank numbered 1 is not a temperature tag: a loop number has two digits or more.');
});

test('plant-style tags on the simulated rig: each found by its words, its tag letters, its unit and its behaviour, with the conversion', () => {
    const suggestions = byName(suggestMapping([
        { id: 'a', name: 'TK1.TT101.PV', unit: '°C', values: smooth },
        { id: 'b', name: 'TK1.JI101.PV', unit: 'kW', values: steps },
        { id: 'c', name: 'AMB.TT102.PV', unit: '°C', values: Array(30).fill(20.1) }
    ], rig));
    const tank = suggestions['TK1.TT101.PV'];
    assert.equal(tank.target.label, 'Water tank · Water temperature');
    assert.equal(tank.role, 'output');
    assert.deepEqual([tank.conversion.scale, tank.conversion.offset], [1, 273.15]);
    assert.ok(tank.confidence >= 0.75, `Confident: ${tank.confidence}.`);
    assert.ok(tank.reasons.some((reason) => /°C converts to K/.test(reason)));
    const heater = suggestions['TK1.JI101.PV'];
    assert.equal(heater.target.label, 'Shared · Heater power');
    assert.equal(heater.role, 'input', 'A power that steps, onto a shared parameter, is an input.');
    assert.deepEqual([heater.conversion.scale, heater.conversion.offset], [1000, 0]);
    assert.equal(suggestions['AMB.TT102.PV'].target.label, 'Ambient air · Temperature');
});

test('the same name is near certain; a quantity of another kind is never suggested; a stranger finds nothing', () => {
    const suggestions = byName(suggestMapping([
        { id: 1, name: 'tankTemperature', unit: 'K' },
        { id: 2, name: 'TankPressure', unit: 'kPa', values: smooth },
        { id: 3, name: 'Stirrer.ST201.PV', unit: 'rpm' }
    ], rig));
    assert.equal(suggestions.tankTemperature.target.label, 'Water tank · Water temperature');
    assert.equal(suggestions.tankTemperature.confidence, 0.97);
    assert.deepEqual(suggestions.tankTemperature.reasons, ['the same name']);
    assert.equal(suggestions.TankPressure.target, null, 'A pressure is not the tank\'s temperature, whatever the name shares.');
    assert.equal(suggestions['Stirrer.ST201.PV'].target, null);
    assert.equal(suggestions['Stirrer.ST201.PV'].role, null);
});

test('each model quantity is suggested once, the most confident pair first; the other keeps it as an alternative', () => {
    const suggestions = byName(suggestMapping([
        { id: 1, name: 'tankTemperature', unit: 'K' },
        { id: 2, name: 'TK1.TT101.PV', unit: '°C', values: smooth }
    ], rig));
    assert.equal(suggestions.tankTemperature.target.label, 'Water tank · Water temperature');
    assert.notEqual(suggestions['TK1.TT101.PV'].target?.label, 'Water tank · Water temperature');
    assert.ok(suggestions['TK1.TT101.PV'].alternatives.some((alternative) => alternative.target.label === 'Water tank · Water temperature'));
});

test('a match confirmed before is remembered by the quantity\'s name, and comes first wherever that quantity is', () => {
    const tank = mappingCandidates(rig).find((candidate) => candidate.label === 'Water tank · Water temperature');
    const memory = rememberMapping({}, [{ name: 'X_17', role: 'output', target: { kind: 'state', id: tank.id }, conversion: { scale: 1, offset: 273.15 } }], rig);
    assert.deepEqual(memory.X_17, { kind: 'state', label: 'Water tank · Water temperature', symbol: tank.symbol, conversion: { scale: 1, offset: 273.15 } });
    const [suggestion] = suggestMapping([{ id: 1, name: 'X_17', unit: '°C' }], rig, { memory });
    assert.equal(suggestion.target.label, 'Water tank · Water temperature');
    assert.equal(suggestion.confidence, 0.99);
    assert.deepEqual(suggestion.reasons, ['matched to it before']);
    assert.deepEqual([suggestion.conversion.scale, suggestion.conversion.offset], [1, 273.15]);
    // In another project whose ids differ, the label still finds it.
    const other = structuredClone(rig);
    for (const node of other.nodes) for (const state of node.states) state.id += 1000;
    const [elsewhere] = suggestMapping([{ id: 1, name: 'X_17', unit: '°C' }], other, { memory });
    assert.equal(elsewhere.target.label, 'Water tank · Water temperature');
    assert.equal(elsewhere.target.id, tank.id + 1000);
});

test('a role the source declares is kept: a measured signal never drives a parameter', () => {
    const [heater] = suggestMapping([{ id: 1, name: 'TK1_JI101_PV', unit: 'kW', role: 'output' }], rig);
    assert.notEqual(heater.target?.kind, 'parameter', 'Declared measured, it is not suggested for the heater power parameter.');
    const [input] = suggestMapping([{ id: 1, name: 'TK1_JI101_PV', unit: 'kW', role: 'input' }], rig);
    assert.equal(input.target.label, 'Shared · Heater power');
});
