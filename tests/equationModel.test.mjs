/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { latexForBinding, reconcileEquationBindings, validateEquationLatex } from '../src/equationModel.mjs';

const source = { id: 'source-node', states: [{ id: 'source-state', symbol: 'temperature' }] };
const target = { id: 'target-node', states: [{ id: 'target-state', symbol: 'temperature' }] };
const parameter = { id: 'parameter', symbol: 'conductance' };

test('creates UUID-backed state and parameter bindings', () => {
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    assert.deepEqual(bindings.map(({ symbol, kind }) => ({ symbol, kind })), [
        { symbol: 'sourceTemperature', kind: 'state' },
        { symbol: 'targetTemperature', kind: 'state' },
        { symbol: 'conductance', kind: 'parameter' }
    ]);
});

test('preserves equation symbols when a state is renamed', () => {
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    const renamedSource = { ...source, states: [{ id: 'source-state', symbol: 'thermalState' }] };
    const reconciled = reconcileEquationBindings(bindings, renamedSource, target, [parameter]);
    assert.equal(reconciled[0].symbol, 'sourceTemperature');
    assert.equal(reconciled[0].stateId, 'source-state');
});

test('parses bound LaTeX into MathJSON', () => {
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    const latex = `${latexForBinding(bindings[2])}\\cdot(${latexForBinding(bindings[0])}-${latexForBinding(bindings[1])})`;
    const result = validateEquationLatex(latex, bindings);
    assert.equal(result.valid, true);
    assert.deepEqual(result.mathJson, [
        'Multiply', 'conductance', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]
    ]);
});

test('rejects unknown symbols and unsupported assignments', () => {
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    assert.match(validateEquationLatex('mystery+1', bindings).errors.join(' '), /Unknown/);
    assert.match(validateEquationLatex('x=2', bindings).errors.join(' '), /Unsupported/);
});
