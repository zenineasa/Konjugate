/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { latexForBinding, reconcileEquationBindings, validateEquationLatex } from '../src/equationModel.mjs';

const source = { id: 1, states: [{ id: 2, symbol: 'temperature' }] };
const target = { id: 3, states: [{ id: 4, symbol: 'temperature' }] };
const parameter = { id: 5, symbol: 'conductance' };

test('creates stable-ID-backed state and parameter bindings', () => {
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    assert.deepEqual(bindings.map(({ symbol, kind }) => ({ symbol, kind })), [
        { symbol: 'sourceTemperature', kind: 'state' },
        { symbol: 'targetTemperature', kind: 'state' },
        { symbol: 'conductance', kind: 'parameter' },
        { symbol: 't', kind: 'time' }
    ]);
});

test('the time binding keeps its symbol and steps aside for a parameter named t', () => {
    const renamed = reconcileEquationBindings([], source, target, [{ id: 6, symbol: 't' }]);
    assert.deepEqual(renamed.filter((binding) => binding.kind === 'time').map((binding) => binding.symbol), ['t2']);
    const kept = reconcileEquationBindings(renamed, source, target, [{ id: 6, symbol: 't' }]);
    assert.equal(kept.find((binding) => binding.kind === 'time').symbol, 't2');
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    const validation = validateEquationLatex(String.raw`\begin{cases} \mathrm{conductance} & 10 \le t < 20 \\ 0 & \text{otherwise} \end{cases}`, bindings);
    assert.equal(validation.valid, true, validation.errors.join(' '));
});

test('preserves equation symbols when a state is renamed', () => {
    const bindings = reconcileEquationBindings([], source, target, [parameter]);
    const renamedSource = { ...source, states: [{ id: 2, symbol: 'thermalState' }] };
    const reconciled = reconcileEquationBindings(bindings, renamedSource, target, [parameter]);
    assert.equal(reconciled[0].symbol, 'sourceTemperature');
    assert.equal(reconciled[0].stateId, 2);
});

test('uses the current parameter symbol after a parameter is renamed', () => {
    const bindings = reconcileEquationBindings([], source, target, [{ id: 5, symbol: 'p1' }]);
    const reconciled = reconcileEquationBindings(bindings, source, target, [{ id: 5, symbol: 'x' }]);
    assert.equal(reconciled[2].symbol, 'x');
    assert.equal(validateEquationLatex('x+1', reconciled).valid, true);
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

test('accepts a cases expression and rejects comparisons outside its conditions', () => {
    const bindings = [{ symbol: 'sourceStock' }, { symbol: 'rate' }];
    const valid = validateEquationLatex(String.raw`\begin{cases} \mathrm{rate} & \text{if } \mathrm{sourceStock} > 0 \land \mathrm{rate} \le 5 \\ 0 & \text{otherwise} \end{cases}`, bindings);
    assert.equal(valid.valid, true, valid.errors.join(' '));
    assert.equal(valid.mathJson[0], 'Which');
    assert.deepEqual(valid.mathJson.slice(2), ['rate', 'True', 0]);

    const noOtherwise = validateEquationLatex(String.raw`\begin{cases} \mathrm{rate} & \mathrm{sourceStock} > 0 \end{cases}`, bindings);
    assert.equal(noOtherwise.valid, false);
    assert.match(noOtherwise.errors.join(' '), /otherwise/);

    const bareComparison = validateEquationLatex(String.raw`\mathrm{sourceStock} > 0`, bindings);
    assert.equal(bareComparison.valid, false);
    assert.match(bareComparison.errors.join(' '), /condition of a cases expression/);
});

test('the two-argument arctangent may be typed as atan2 or as \\arctan with two arguments', () => {
    const bindings = [{ kind: 'state', symbol: 'y' }, { kind: 'state', symbol: 'x' }];
    for (const latex of [String.raw`\operatorname{atan2}(y,x)`, String.raw`\arctan(y,x)`, String.raw`\operatorname{arctan2}(y,x)`]) {
        const validation = validateEquationLatex(latex, bindings);
        assert.equal(validation.valid, true, `${latex}: ${validation.errors.join(' ')}`);
        assert.deepEqual(validation.mathJson, ['Arctan2', 'y', 'x'], latex);
    }
    for (const [latex, head] of [[String.raw`\arcsin(x)`, 'Arcsin'], [String.raw`\arccos(x)`, 'Arccos'], [String.raw`\arctan(x)`, 'Arctan'], [String.raw`\tanh(x)`, 'Tanh']]) {
        assert.deepEqual(validateEquationLatex(latex, bindings).mathJson, [head, 'x'], latex);
    }
});

// A plain evaluator of executable MathJSON, for checking that two expressions compute the same thing.
function evaluateMathJson(expression, values) {
    if (typeof expression === 'number') return expression;
    if (typeof expression === 'string') return expression === 'True' ? 1 : values[expression];
    const [operator, ...operands] = expression;
    if (operator === 'Which') {
        for (let index = 0; index < operands.length; index += 2) if (evaluateMathJson(operands[index], values)) return evaluateMathJson(operands[index + 1], values);
        return Number.NaN;
    }
    const v = operands.map((operand) => evaluateMathJson(operand, values));
    const functions = {
        Add: () => v.reduce((a, b) => a + b, 0), Multiply: () => v.reduce((a, b) => a * b, 1), Negate: () => -v[0], Subtract: () => v[0] - v[1],
        Divide: () => v[0] / v[1], Power: () => v[0] ** v[1], Sqrt: () => Math.sqrt(v[0]), Root: () => v[0] ** (1 / v[1]), Abs: () => Math.abs(v[0]),
        Exp: () => Math.exp(v[0]), Ln: () => Math.log(v[0]), Log: () => Math.log10(v[0]), Sin: () => Math.sin(v[0]), Cos: () => Math.cos(v[0]),
        Tan: () => Math.tan(v[0]), Arcsin: () => Math.asin(v[0]), Arccos: () => Math.acos(v[0]), Arctan: () => Math.atan(v[0]),
        Arctan2: () => Math.atan2(v[0], v[1]), Tanh: () => Math.tanh(v[0]), Min: () => Math.min(v[0], v[1]), Max: () => Math.max(v[0], v[1]),
        Less: () => v[0] < v[1], LessEqual: () => v[0] <= v[1], Greater: () => v[0] > v[1], GreaterEqual: () => v[0] >= v[1],
        Equal: () => v[0] === v[1], NotEqual: () => v[0] !== v[1], And: () => v.every(Boolean), Or: () => v.some(Boolean), Not: () => !v[0]
    };
    return Number(functions[operator]());
}

test('every executable expression is written as LaTeX that reads back as the same expression', async () => {
    const { mathJsonToLatex } = await import('../src/equationModel.mjs');
    const symbols = ['x', 'y', 'ab1', 'pR13'];
    const bindings = symbols.map((symbol) => ({ kind: 'state', symbol }));
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const leaf = () => (random() < 0.5 ? pick(symbols) : pick([1, 3, -2.5, 0.000026, 1e-15, 12345678901234, 0.1]));
    const condition = (depth) => (random() < 0.7
        ? [pick(['Less', 'LessEqual', 'Greater', 'GreaterEqual', 'Equal', 'NotEqual']), number(depth), number(depth)]
        : [pick(['And', 'Or']), condition(depth - 1), condition(depth - 1)]);
    const number = (depth) => {
        if (depth <= 0 || random() < 0.25) return leaf();
        const unary = ['Negate', 'Sqrt', 'Abs', 'Exp', 'Ln', 'Log', 'Sin', 'Cos', 'Tan', 'Arcsin', 'Arccos', 'Arctan', 'Tanh'];
        const binary = ['Divide', 'Power', 'Min', 'Max', 'Arctan2', 'Subtract'];
        const kind = random();
        if (kind < 0.3) return [pick(unary), number(depth - 1)];
        if (kind < 0.55) {
            const operator = pick(binary);
            // Zero to the power zero has no value; the parser folds it to "not a number" wherever it appears.
            const base = number(depth - 1);
            return [operator, operator === 'Power' && base === 0 ? 2 : base, number(depth - 1)];
        }
        if (kind < 0.75) return [pick(['Add', 'Multiply']), number(depth - 1), number(depth - 1), number(depth - 1)];
        if (kind < 0.85) return ['Which', condition(depth - 1), number(depth - 1), 'True', number(depth - 1)];
        if (kind < 0.9) return ['Which', ['Not', condition(depth - 1)], number(depth - 1), 'True', number(depth - 1)];
        return ['Root', number(depth - 1), pick([2, 3])];
    };
    const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    for (let trial = 0; trial < 400; trial += 1) {
        const expression = number(4);
        const latex = mathJsonToLatex(expression);
        const validation = validateEquationLatex(latex, bindings);
        const samples = [{ x: 0.3, y: -1.7, ab1: 2, pR13: 0.5 }, { x: 2, y: 2, ab1: -0.25, pR13: 1 }];
        // A division by a literal zero is refused, rightly, rather than read back.
        const dividesByZero = (item) => Array.isArray(item) && ((item[0] === 'Divide' && item[2] === 0) || item.slice(1).some(dividesByZero));
        if (!validation.valid && validation.errors.some((error) => /divides by zero/.test(error))
            && (dividesByZero(expression) || samples.every((values) => !Number.isFinite(evaluateMathJson(expression, values))))) continue;
        assert.equal(validation.valid, true, `${JSON.stringify(expression)} as ${latex}: ${validation.errors.join(' ')}`);
        for (const values of samples) {
            const expected = evaluateMathJson(expression, values);
            // The parser folds a product with zero to zero and a division by zero to infinity, which differ only where the
            // original is not a finite number.
            if (!Number.isFinite(expected)) continue;
            const actual = evaluateMathJson(validation.mathJson, values);
            assert.ok(same(expected, actual), `${JSON.stringify(expression)} as ${latex} reads back as ${JSON.stringify(validation.mathJson)}: ${expected} then ${actual}.`);
        }
    }
});

test('the canvas reads e, pi, exp, fractions, roots and subtraction as operations the engine runs', () => {
    const bindings = [{ kind: 'state', symbol: 'x' }];
    const cases = [
        [String.raw`\exp(x)`, ['Exp', 'x']], [String.raw`e^{x}`, ['Exp', 'x']], [String.raw`\pi x`, ['Multiply', Math.PI, 'x']],
        [String.raw`\frac{1}{2}x`, ['Multiply', ['Divide', 1, 2], 'x']], [String.raw`\sqrt[3]{x}`, ['Power', 'x', ['Divide', 1, 3]]]
    ];
    for (const [latex, mathJson] of cases) {
        const validation = validateEquationLatex(latex, bindings);
        assert.equal(validation.valid, true, `${latex}: ${validation.errors.join(' ')}`);
        assert.deepEqual(validation.mathJson, mathJson, latex);
    }
});
