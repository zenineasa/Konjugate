/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { ComputeEngine } from '@cortex-js/compute-engine';

const computeEngine = new ComputeEngine();
const allowedOperators = new Set([
    'Abs', 'Add', 'Cos', 'Divide', 'Exp', 'Ln', 'Log', 'Max', 'Min', 'Multiply',
    'Negate', 'Power', 'Root', 'Sin', 'Sqrt', 'Subtract', 'Tan'
]);

function upperFirst(value) {
    return value ? `${value[0].toUpperCase()}${value.slice(1)}` : '';
}

function uniqueSymbol(preferred, used) {
    let symbol = preferred;
    let suffix = 2;
    while (used.has(symbol)) symbol = `${preferred}${suffix++}`;
    used.add(symbol);
    return symbol;
}

function bindingKey(binding) {
    return binding.kind === 'parameter'
        ? `parameter:${binding.parameterId}`
        : `state:${binding.role}:${binding.nodeId}:${binding.stateId}`;
}

export function reconcileEquationBindings(existing = [], sourceNode, targetNode, parameters = []) {
    const previous = new Map(existing.map((binding) => [bindingKey(binding), binding]));
    const used = new Set();
    const bindings = [];
    for (const [role, node] of [['source', sourceNode], ['target', targetNode]]) {
        for (const state of node?.states ?? []) {
            const candidate = {
                kind: 'state', role, nodeId: node.id, stateId: state.id,
                symbol: `${role}${upperFirst(state.symbol)}`, label: `${role}.${state.symbol}`
            };
            const prior = previous.get(bindingKey(candidate));
            candidate.symbol = uniqueSymbol(prior?.symbol ?? candidate.symbol, used);
            bindings.push(candidate);
        }
    }
    for (const parameter of parameters) {
        const candidate = {
            kind: 'parameter', parameterId: parameter.id,
            symbol: parameter.symbol, label: parameter.symbol
        };
        candidate.symbol = uniqueSymbol(candidate.symbol, used);
        bindings.push(candidate);
    }
    return bindings;
}

export function latexForBinding(binding) {
    return `\\mathrm{${binding.symbol}}`;
}

function collectUnsupportedOperators(expression, unsupported = new Set()) {
    if (!Array.isArray(expression)) return unsupported;
    const [operator, ...operands] = expression;
    if (typeof operator === 'string' && !allowedOperators.has(operator)) unsupported.add(operator);
    operands.forEach((operand) => collectUnsupportedOperators(operand, unsupported));
    return unsupported;
}

export function validateEquationLatex(latex, bindings = []) {
    if (!latex?.trim()) return { valid: false, mathJson: null, symbols: [], errors: ['Enter an expression.'] };
    const expression = computeEngine.parse(latex);
    const errors = expression.errors.map(() => 'The LaTeX expression could not be parsed.');
    const knownSymbols = new Set(bindings.map((binding) => binding.symbol));
    const unknownSymbols = expression.unknowns.filter((symbol) => !knownSymbols.has(symbol));
    if (unknownSymbols.length) errors.push(`Unknown ${unknownSymbols.length === 1 ? 'symbol' : 'symbols'}: ${unknownSymbols.join(', ')}.`);
    const unsupported = [...collectUnsupportedOperators(expression.json)];
    if (unsupported.length) errors.push(`Unsupported ${unsupported.length === 1 ? 'operation' : 'operations'}: ${unsupported.join(', ')}.`);
    return {
        valid: errors.length === 0,
        mathJson: expression.json,
        symbols: expression.symbols,
        errors: [...new Set(errors)]
    };
}
