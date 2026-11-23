/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Code export's symbolic differentiation (src/expressionDerivative.mjs), the mirror of the engine's (engine/src/jacobianAssembly.cpp):
// every rule against central differences, its few simplifications, and what it leaves out. That the two give the same arithmetic is
// tests/engine/codeExportFidelity.mjs's (a model using every operation, exported under Rodas4 and BDF, against the engine).

import test from 'node:test';
import assert from 'node:assert/strict';
import { compileExpressionNode } from '../src/codeExport.mjs';
import { differentiateNode } from '../src/expressionDerivative.mjs';

// The value of a compiled node, as the engine evaluates it (True is 1, a Which takes its first branch that holds).
function evaluate(node, values) {
    if ('literal' in node) return node.literal;
    if ('boolean' in node) return node.boolean ? 1 : 0;
    if ('symbol' in node) return values[node.symbol];
    const a = node.args.map((argument) => () => evaluate(argument, values));
    switch (node.op) {
        case 'Add': return a.reduce((sum, value) => sum + value(), 0);
        case 'Multiply': return a.reduce((product, value) => product * value(), 1);
        case 'Negate': return -a[0]();
        case 'Divide': return a[0]() / a[1]();
        case 'Power': return a[0]() ** a[1]();
        case 'Sqrt': return Math.sqrt(a[0]());
        case 'Abs': return Math.abs(a[0]());
        case 'Exp': return Math.exp(a[0]());
        case 'Ln': case 'Log': return Math.log(a[0]());
        case 'Sin': return Math.sin(a[0]());
        case 'Cos': return Math.cos(a[0]());
        case 'Tan': return Math.tan(a[0]());
        case 'Arcsin': return Math.asin(a[0]());
        case 'Arccos': return Math.acos(a[0]());
        case 'Arctan': return Math.atan(a[0]());
        case 'Arctan2': return Math.atan2(a[0](), a[1]());
        case 'Tanh': return Math.tanh(a[0]());
        case 'Min': { const [x, y] = [a[0](), a[1]()]; return y < x ? y : x; }
        case 'Max': { const [x, y] = [a[0](), a[1]()]; return x < y ? y : x; }
        case 'Less': return a[0]() < a[1]() ? 1 : 0;
        case 'Greater': return a[0]() > a[1]() ? 1 : 0;
        case 'Which': {
            for (let index = 0; index + 1 < a.length; index += 2) if (a[index]() !== 0) return a[index + 1]();
            return NaN;
        }
        default: throw new Error(`No evaluation for ${node.op}.`);
    }
}

const cases = {
    product: ['Multiply', '-50', 'x', 'y', 'x'],
    sum: ['Add', 'x', ['Negate', 'y'], '3'],
    quotient: ['Divide', ['Exp', ['Negate', 'x']], ['Add', '1', ['Power', 'y', '2']]],
    constantPower: ['Power', 'x', '3'],
    variablePower: ['Power', ['Add', '1', ['Power', 'x', '2']], 'y'],
    root: ['Sqrt', ['Add', 'x', '1']],
    absolute: ['Abs', ['Add', 'y', '-0.5']],
    logarithm: ['Ln', ['Add', '1', 'x']],
    trigonometry: ['Add', ['Sin', 'x'], ['Cos', 'y'], ['Tan', ['Multiply', '0.1', 'x']]],
    inverse: ['Add', ['Arcsin', ['Multiply', '0.1', 'x']], ['Arccos', ['Multiply', '0.1', 'y']], ['Arctan', 'x'], ['Arctan2', 'y', ['Add', 'x', '1']]],
    hyperbolic: ['Tanh', ['Multiply', 'x', 'y']],
    extremes: ['Add', ['Min', 'x', 'y'], ['Max', ['Multiply', '2', 'x'], 'y']],
    piecewise: ['Which', ['Greater', 'x', '0.5'], ['Multiply', '-3', 'x', 'y'], 'True', ['Power', 'y', '2']]
};

test('every rule of the exact Jacobian\'s differentiation agrees with central differences', () => {
    for (const [name, mathJson] of Object.entries(cases)) {
        const node = compileExpressionNode(mathJson);
        for (const point of [{ x: 0.8, y: 0.3 }, { x: 0.2, y: 0.7 }]) {
            for (const symbol of ['x', 'y']) {
                const derivative = differentiateNode(node, symbol);
                const h = 1e-6;
                const numeric = (evaluate(node, { ...point, [symbol]: point[symbol] + h }) - evaluate(node, { ...point, [symbol]: point[symbol] - h })) / (2 * h);
                const exact = derivative ? evaluate(derivative, point) : 0;
                assert.ok(Math.abs(exact - numeric) <= 1e-6 * Math.max(1, Math.abs(numeric)), `${name}, d/d${symbol} at ${JSON.stringify(point)}: ${exact} against ${numeric}.`);
            }
        }
    }
});

test('the differentiation drops what is zero, writes no factor of 1, and keeps a Which\'s conditions', () => {
    // A term without the symbol, and a comparison, have no derivative.
    assert.equal(differentiateNode(compileExpressionNode(['Multiply', '2', 'y']), 'x'), null);
    assert.equal(differentiateNode(compileExpressionNode(['Less', 'x', '1']), 'x'), null);
    // d(-50 x y)/dx is -50 y: the derivative 1 is not written.
    assert.deepEqual(differentiateNode(compileExpressionNode(['Multiply', '-50', 'x', 'y']), 'x'), { op: 'Multiply', args: [{ literal: -50 }, { symbol: 'y' }] });
    // A constant exponent is lowered as a literal: d(x^3)/dx = 3 x^2.
    assert.deepEqual(differentiateNode(compileExpressionNode(['Power', 'x', '3']), 'x'),
        { op: 'Multiply', args: [{ literal: 3 }, { op: 'Power', args: [{ symbol: 'x' }, { literal: 2 }] }] });
    // A Which keeps its conditions, a branch without the symbol becoming 0.
    assert.deepEqual(differentiateNode(compileExpressionNode(['Which', ['Greater', 'x', '0'], 'x', 'True', 'y']), 'x'),
        { op: 'Which', args: [{ op: 'Greater', args: [{ symbol: 'x' }, { literal: 0 }] }, { literal: 1 }, { boolean: true }, { literal: 0 }] });
});
