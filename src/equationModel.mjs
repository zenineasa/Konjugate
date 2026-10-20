/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { ComputeEngine } from '@cortex-js/compute-engine';
import { providerReferenceValue } from './selectValues.mjs';

const computeEngine = new ComputeEngine();
const allowedOperators = new Set([
    'Abs', 'Add', 'Cos', 'Divide', 'Exp', 'Ln', 'Log', 'Max', 'Min', 'Multiply',
    'Negate', 'Power', 'Root', 'Sin', 'Sqrt', 'Subtract', 'Tan',
    'Arcsin', 'Arccos', 'Arctan', 'Arctan2', 'Tanh',
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

// What the parser folds a division by zero and the like into: no number the engine can run.
const nonFiniteSymbols = new Set(['ComplexInfinity', 'PositiveInfinity', 'NegativeInfinity', 'NaN', 'Undefined']);

function containsSymbol(expression, names) {
    if (typeof expression === 'string') return names.has(expression);
    return Array.isArray(expression) && expression.slice(1).some((operand) => containsSymbol(operand, names));
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

// Function names typed as \operatorname{...} that mean an operation the engine knows: atan2 is how most people write
// the two-argument arctangent (the parser's own spelling for it is \arctan(y, x)).
const functionAliases = new Map([['atan2', 'Arctan2'], ['arctan2', 'Arctan2'], ['Atan2', 'Arctan2']]);

// What the parser reads, in the operations the engine runs: \exp(x) and e^{x} as Exp, e and \pi as numbers, a
// fraction of two numbers as a division, an nth root as a power, and a subtraction as adding the negation.
function canonicalFunctions(expression) {
    if (expression === 'ExponentialE') return Math.E;
    if (expression === 'Pi') return Math.PI;
    // A number with more digits than a double holds comes as { num: "..." }: the engine reads doubles.
    if (expression && typeof expression === 'object' && !Array.isArray(expression)) {
        if ('num' in expression) return Number(expression.num);
        if ('sym' in expression) return canonicalFunctions(expression.sym);
        if ('fn' in expression) return canonicalFunctions(expression.fn);
    }
    if (!Array.isArray(expression)) return expression;
    const [head, ...rest] = expression;
    const operator = functionAliases.get(head) ?? head;
    if (operator === 'Power' && rest[0] === 'ExponentialE') return ['Exp', canonicalFunctions(rest[1])];
    const operands = rest.map(canonicalFunctions);
    if (operator === 'Rational') return ['Divide', ...operands];
    if (operator === 'Root') return ['Power', operands[0], ['Divide', 1, operands[1]]];
    if (operator === 'Subtract') return ['Add', operands[0], ['Negate', operands[1]]];
    return [operator, ...operands];
}

// ---- MathJSON as LaTeX ------------------------------------------------------------------------------------------------
// Writes an executable expression as LaTeX that validateEquationLatex reads back as the same expression, so an equation
// a toolbox wrote as MathJSON alone can be shown and edited in the canvas like a typed one.

const latexFunctions = {
    Sin: '\\sin', Cos: '\\cos', Tan: '\\tan', Arcsin: '\\arcsin', Arccos: '\\arccos', Arctan: '\\arctan', Tanh: '\\tanh',
    Exp: '\\exp', Ln: '\\ln', Log: '\\log', Min: '\\min', Max: '\\max', Arctan2: '\\arctan'
};
const latexComparisons = { Less: '<', LessEqual: '\\le ', Greater: '>', GreaterEqual: '\\ge ', Equal: '=', NotEqual: '\\ne ' };

function numberLatex(value) {
    if (!Number.isFinite(value)) throw new Error(`${value} cannot be written as LaTeX.`);
    const text = String(value);
    if (!/e/i.test(text)) return text;
    const [mantissa, exponent] = value.toExponential().split('e');
    return `${mantissa}\\times10^{${Number(exponent)}}`;
}

const parenthesize = (text) => `\\left(${text}\\right)`;
const isNegative = (expression) => (typeof expression === 'number' && expression < 0) || (Array.isArray(expression) && expression[0] === 'Negate');

export function mathJsonToLatex(expression) {
    if (typeof expression === 'number') return numberLatex(expression);
    if (typeof expression === 'string') {
        if (expression === 'True') return '\\text{otherwise}';
        return latexForBinding({ symbol: expression });
    }
    if (!Array.isArray(expression)) throw new Error('An expression is a number, a symbol or an operation.');
    const [operator, ...operands] = expression;
    const write = mathJsonToLatex;
    // An operand of a product or a power is wrapped unless it binds at least as tightly.
    const factor = (operand) => {
        const text = write(operand);
        return isNegative(operand) || (Array.isArray(operand) && ['Add', 'Subtract'].includes(operand[0])) ? parenthesize(text) : text;
    };
    const atom = (operand) => (typeof operand === 'string' || (typeof operand === 'number' && operand >= 0)
        || (Array.isArray(operand) && (latexFunctions[operand[0]] || ['Abs', 'Sqrt'].includes(operand[0])))
        ? write(operand) : parenthesize(write(operand)));
    if (latexFunctions[operator]) return `${latexFunctions[operator]}${parenthesize(operands.map(write).join(','))}`;
    if (latexComparisons[operator]) return operands.map(write).join(latexComparisons[operator]);
    switch (operator) {
    case 'Add': return operands.map((operand, index) => {
        if (index === 0) return write(operand);
        if (typeof operand === 'number' && operand < 0) return numberLatex(operand);
        if (Array.isArray(operand) && operand[0] === 'Negate') return `-${factor(operand[1])}`;
        return `+${write(operand)}`;
    }).join('');
    case 'Subtract': return `${write(operands[0])}-${factor(operands[1])}`;
    case 'Multiply': return operands.map(factor).join('\\cdot ');
    case 'Negate': return `-${factor(operands[0])}`;
    case 'Divide': return `\\frac{${write(operands[0])}}{${write(operands[1])}}`;
    case 'Power': return `${atom(operands[0])}^{${write(operands[1])}}`;
    case 'Sqrt': return `\\sqrt{${write(operands[0])}}`;
    case 'Root': return `\\sqrt[${write(operands[1])}]{${write(operands[0])}}`;
    case 'Abs': return `\\left|${write(operands[0])}\\right|`;
    case 'And': return operands.map((operand) => parenthesize(write(operand))).join('\\land ');
    case 'Or': return operands.map((operand) => parenthesize(write(operand))).join('\\lor ');
    case 'Not': return `\\lnot${parenthesize(write(operands[0]))}`;
    case 'Which': {
        const rows = [];
        for (let index = 0; index < operands.length; index += 2) rows.push(`${write(operands[index + 1])}&${write(operands[index])}`);
        return `\\begin{cases}${rows.join('\\\\')}\\end{cases}`;
    }
    default: throw new Error(`The operation ${operator} cannot be written as LaTeX.`);
    }
}

export function validateEquationLatex(latex, bindings = []) {
    if (!latex?.trim()) return { valid: false, mathJson: null, symbols: [], errors: ['Enter an expression.'] };
    const parsed = computeEngine.parse(latex);
    const expression = { errors: parsed.errors, unknowns: parsed.unknowns, symbols: parsed.symbols, json: canonicalFunctions(parsed.json) };
    const errors = expression.errors.map(() => 'The LaTeX expression could not be parsed.');
    const knownSymbols = new Set(bindings.map((binding) => binding.symbol));
    const unknownSymbols = expression.unknowns.filter((symbol) => !knownSymbols.has(symbol));
    if (unknownSymbols.length) errors.push(`Unknown ${unknownSymbols.length === 1 ? 'symbol' : 'symbols'}: ${unknownSymbols.join(', ')}.`);
    const unsupported = [...collectUnsupportedOperators(expression.json)];
    if (containsSymbol(expression.json, nonFiniteSymbols)) errors.push('The expression divides by zero or is otherwise not a number.');
    if (unsupported.length) errors.push(`Unsupported ${unsupported.length === 1 ? 'operation' : 'operations'}: ${unsupported.join(', ')}.`);
    else errors.push(...collectConditionErrors(expression.json));
    return {
        valid: errors.length === 0,
        mathJson: expression.json,
        symbols: expression.symbols,
        errors: [...new Set(errors)]
    };
}
