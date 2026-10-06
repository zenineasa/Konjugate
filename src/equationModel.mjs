/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { ComputeEngine } from '@cortex-js/compute-engine';
import { providerReferenceValue } from './selectValues.mjs';

const computeEngine = new ComputeEngine();
const allowedOperators = new Set([
    'Abs', 'Add', 'Cos', 'Divide', 'Exp', 'Ln', 'Log', 'Max', 'Min', 'Multiply',
    'Negate', 'Power', 'Root', 'Sin', 'Sqrt', 'Subtract', 'Tan',
    // \begin{cases} and the comparisons/logic its conditions use
    'Which', 'Less', 'LessEqual', 'Greater', 'GreaterEqual', 'Equal', 'NotEqual', 'And', 'Or', 'Not'
]);
const conditionOperators = new Set(['Less', 'LessEqual', 'Greater', 'GreaterEqual', 'Equal', 'NotEqual', 'And', 'Or', 'Not']);

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
    if (binding.kind === 'time') return 'time';
    // The same encoding the provider "Reference" dropdown uses (see selectValues.mjs), so a binding's
    // key and its dropdown value can never drift apart.
    return providerReferenceValue(binding);
}

// Simulation time, available to every equation as t (renamed only if t is already taken). The
// engine reads it at the start of the substep, or at the end for an algebraic (setsValue) term.
export function timeBinding(usedSymbols = new Set(), preferred = 't') {
    const symbol = uniqueSymbol(preferred, usedSymbols);
    return { kind: 'time', symbol, label: `${symbol} (time)` };
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
    bindings.push(timeBinding(used, previous.get('time')?.symbol));
    return bindings;
}

export function latexForBinding(binding) {
    return binding.symbol.length === 1 ? binding.symbol : `\\mathrm{${binding.symbol}}`;
}

function collectUnsupportedOperators(expression, unsupported = new Set()) {
    if (!Array.isArray(expression)) return unsupported;
    const [operator, ...operands] = expression;
    if (typeof operator === 'string' && !allowedOperators.has(operator)) unsupported.add(operator);
    operands.forEach((operand) => collectUnsupportedOperators(operand, unsupported));
    return unsupported;
}

// Mirrors the engine's typed check (engine/src/modelValidator.cpp): comparisons only as cases
// conditions, numbers everywhere else, and every cases expression ends in an otherwise branch.
function collectConditionErrors(expression, condition = false, errors = new Set()) {
    if (!Array.isArray(expression)) {
        const isBoolean = expression === 'True' || expression === 'False';
        if (condition && !isBoolean) errors.add('A condition must be a comparison such as x > 0.');
        if (!condition && isBoolean) errors.add('True/False can only be used as a condition.');
        return errors;
    }
    const [operator, ...operands] = expression;
    const isCondition = conditionOperators.has(operator);
    if (isCondition && !condition) {
        errors.add('Unsupported comparison: comparisons can only be used as the condition of a cases expression.');
        return errors;
    }
    if (!isCondition && condition) {
        errors.add('A condition must be a comparison such as x > 0.');
        return errors;
    }
    if (operator === 'Which') {
        operands.forEach((operand, index) => collectConditionErrors(operand, index % 2 === 0, errors));
        if (operands.length < 2 || operands.length % 2 !== 0 || operands[operands.length - 2] !== 'True') {
            errors.add('A cases expression needs a final \\text{otherwise} branch.');
        }
        return errors;
    }
    const childCondition = operator === 'And' || operator === 'Or' || operator === 'Not';
    operands.forEach((operand) => collectConditionErrors(operand, childCondition, errors));
    return errors;
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
    else errors.push(...collectConditionErrors(expression.json));
    return {
        valid: errors.length === 0,
        mathJson: expression.json,
        symbols: expression.symbols,
        errors: [...new Set(errors)]
    };
}
