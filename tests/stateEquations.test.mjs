/* Copyright © 2026 Zenin Easa Panthakkalakath */

import test from 'node:test';
import assert from 'node:assert/strict';
import { derivedShortName, foldStates, foldedName, mergeOwnParts, relationshipLatexInReaderNames, renameSymbols, shortNames } from '../src/stateEquations.mjs';

test('a node\'s short name is its last letter or number, or its initials, unless a person gave it one, and is unique', () => {
    assert.equal(derivedShortName('Ground pivot A'), 'A');
    assert.equal(derivedShortName('Pump 2'), '2');
    assert.equal(derivedShortName('Battery module'), 'BM');
    assert.equal(derivedShortName('Tank'), 'T');
    const names = shortNames([{ id: 1, name: 'Battery module' }, { id: 2, name: 'Battery module' }, { id: 3, name: 'Crank pin B', shortName: 'BM' }]);
    assert.equal(names.get(3), 'BM', 'A short name a person gave is kept.');
    assert.equal(new Set(names.values()).size, 3, 'Every short name is unique.');
});

test('a relationship\'s part reads in its reader\'s names, and what is stored is unchanged', () => {
    // Crank drive X, four-bar linkage: Ground pivot A → Crank pin B, landing on B's x.
    const nodes = [
        { id: 1, name: 'Ground pivot A', states: [{ id: 2, symbol: 'x' }, { id: 3, symbol: 'y' }] },
        { id: 27, name: 'Crank pin B', states: [{ id: 28, symbol: 'x' }, { id: 29, symbol: 'y' }] }
    ];
    const edge = { source: { nodeId: 1 }, target: { nodeId: 27 } };
    const bindings = [{ symbol: 'sourceY', kind: 'state', role: 'source', stateId: 3 }, { symbol: 'targetY', kind: 'state', role: 'target', stateId: 29 }, { symbol: 'angularVelocity', kind: 'parameter' }];
    const stored = String.raw`-\mathrm{angularVelocity} \cdot \left(\mathrm{targetY} - \mathrm{sourceY}\right)`;
    const names = shortNames(nodes);
    assert.equal(relationshipLatexInReaderNames(stored, bindings, edge, nodes, 27, names), String.raw`-\mathrm{angularVelocity} \cdot \left(y - y_{\mathrm{A}}\right)`, 'On Crank pin B, its own y is bare and Ground pivot A\'s is y_A.');
    assert.equal(relationshipLatexInReaderNames(stored, bindings, edge, nodes, null, names), String.raw`-\mathrm{angularVelocity} \cdot \left(y_{\mathrm{B}} - y_{\mathrm{A}}\right)`, 'On the relationship, both ends are named.');
    assert.equal(stored, String.raw`-\mathrm{angularVelocity} \cdot \left(\mathrm{targetY} - \mathrm{sourceY}\right)`);
});

test('renaming leaves commands and longer words alone', () => {
    assert.equal(renameSymbols(String.raw`k\cdot x+\mathrm{kx}`, new Map([['x', 'y_{A}'], ['k', '\\kappa']])), String.raw`\kappa\cdot y_{A}+\mathrm{kx}`);
});

test('states nothing changes fold while they come together with one start value and unit, and their names read as one', () => {
    const states = [
        { id: 1, label: 'X position', initialValue: 1, unit: 'm' },
        { id: 2, label: 'Roll', initialValue: 0, unit: 'rad' }, { id: 3, label: 'Pitch', initialValue: 0, unit: 'rad' }, { id: 4, label: 'Yaw', initialValue: 0, unit: 'rad' },
        { id: 5, label: 'X velocity', initialValue: 0, unit: 'm/s' }, { id: 6, label: 'Y velocity', initialValue: 0, unit: 'm/s' }
    ];
    const lines = foldStates(states, (state) => state.id !== 1);
    assert.deepEqual(lines.map((line) => [line.folded, line.states.map((state) => state.id)]), [[false, [1]], [true, [2, 3, 4]], [true, [5, 6]]]);
    assert.equal(foldedName(['Roll', 'Pitch', 'Yaw']), 'Roll, pitch, yaw');
    assert.equal(foldedName(['X velocity', 'Y velocity', 'Z velocity']), 'X, Y, Z velocity');
    assert.equal(foldedName(['SOC', 'Temperature']), 'SOC, temperature');
});

test('several own parts on one state become one sum, their parameters together and a clash renamed in its part', () => {
    const merged = mergeOwnParts([
        { latex: String.raw`k\cdot\mathrm{temperature}`, bindings: [{ symbol: 'k', kind: 'parameter' }], parameters: [{ id: 1, name: 'Gain', symbol: 'k', value: 2, mode: 'constant' }] },
        { latex: String.raw`a-k`, bindings: [{ symbol: 'k', kind: 'parameter' }], parameters: [{ id: 2, name: 'Offset', symbol: 'k', value: 5, mode: 'constant' }, { id: 3, name: 'a', symbol: 'a', value: 1, mode: 'constant' }] }
    ]);
    assert.equal(merged.latex, String.raw`k\cdot\mathrm{temperature}+\left(a-\mathrm{k2}\right)`);
    assert.deepEqual(merged.parameters.map((parameter) => [parameter.symbol, parameter.value]), [['k', 2], ['k2', 5], ['a', 1]]);
    assert.deepEqual(merged.bindings.map((binding) => binding.symbol), ['k', 'k2']);
});

test('a part typed in a reader\'s names is stored in the relationship\'s own, however its subscripts are written', async () => {
    const { readerLatexToStored, relationshipLatexInReaderNames: inReader } = await import('../src/stateEquations.mjs');
    const nodes = [
        { id: 1, name: 'Ground pivot A', states: [{ id: 2, symbol: 'x' }, { id: 3, symbol: 'y' }] },
        { id: 27, name: 'Crank pin B', states: [{ id: 28, symbol: 'x' }, { id: 29, symbol: 'y' }] }
    ];
    const edge = { source: { nodeId: 1 }, target: { nodeId: 27 } };
    const bindings = [{ symbol: 'sourceY', kind: 'state', role: 'source', stateId: 3 }, { symbol: 'targetY', kind: 'state', role: 'target', stateId: 29 }];
    const names = shortNames(nodes);
    const stored = String.raw`-\mathrm{angularVelocity}\cdot\left(\mathrm{targetY}-\mathrm{sourceY}\right)`;
    // On the relationship's card both ends are named; written back, it is what was stored.
    assert.equal(readerLatexToStored(inReader(stored, bindings, edge, nodes, null, names), bindings, edge, nodes, null, names), stored);
    for (const typed of [String.raw`y_B-y_A`, String.raw`y_{B}-y_{A}`, String.raw`\mathrm{y}_{\mathrm{B}}-\mathrm{y}_{\mathrm{A}}`, String.raw`y_{\mathrm{B}}-y_{\mathrm{A}}`]) {
        assert.equal(readerLatexToStored(typed, bindings, edge, nodes, null, names), String.raw`\mathrm{targetY}-\mathrm{sourceY}`, typed);
    }
    // On Crank pin B's own card its y is bare.
    assert.equal(readerLatexToStored(String.raw`y-y_A`, bindings, edge, nodes, 27, names), String.raw`\mathrm{targetY}-\mathrm{sourceY}`);
    // A command, a parameter and a state of no end are left as written.
    assert.equal(readerLatexToStored(String.raw`\cdot k\sqrt{y_C}`, bindings, edge, nodes, null, names), String.raw`\cdot k\sqrt{y_C}`);
});
