/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A tuning objective written in the equation editor is LaTeX, like every other formula, and the engine reads it as text
// (engine/include/fittingObjective.hpp). This is the one place the two meet: the LaTeX is parsed with the same parser and checked with
// the same function as an equation, then its MathJSON is written out as the engine's text. What the text means (and whether it is a
// single number at all) is decided by the engine alone, so this only translates and never judges.
//
// How a summary over the run is written in the editor, each being something the parser already reads:
//   the value at the end   \lim_{t\to T}\left(x\right)   (what x approaches as t reaches the end of the run, T)
//   the highest / lowest   \max\left(x\right)   \min\left(x\right)
//   the average            \operatorname{mean}\left(x\right)
//   the total over time    \int_{0}^{T}x\,dt        (T is the end of the run)

import { latexForBinding, validateEquationLatex } from './equationModel.mjs';

export const objectiveSummaries = Object.freeze([
    { id: 'final', label: 'final', title: 'The value at the end of the run', template: '\\lim_{t\\to T}\\left(#@\\right)', text: 'final' },
    { id: 'max', label: 'max', title: 'The highest value reached', template: '\\max\\left(#@\\right)', text: 'max' },
    { id: 'min', label: 'min', title: 'The lowest value reached', template: '\\min\\left(#@\\right)', text: 'min' },
    { id: 'mean', label: 'mean', title: 'The average over the run', template: '\\operatorname{mean}\\left(#@\\right)', text: 'mean' },
    { id: 'integral', label: '∫ over the run', title: 'The total over the run: the value added up over time, in its unit times seconds', template: '\\int_{0}^{T}#@\\,dt', text: 'integral' }
]);

const objectiveOperators = ['Limit', 'Mean', 'Integrate', 'Function', 'Block', 'Limits'];
const functionNames = { Sqrt: 'sqrt', Abs: 'abs', Exp: 'exp', Ln: 'ln', Sin: 'sin', Cos: 'cos', Tan: 'tan' };
const binaryOperators = { Add: '+', Multiply: '*' };

class ObjectiveTextError extends Error {}

function write(expression, names) {
    if (typeof expression === 'number') {
        if (!Number.isFinite(expression)) throw new ObjectiveTextError('A number in the objective is not finite.');
        return expression < 0 ? `(${expression})` : String(expression);
    }
    if (typeof expression === 'string') {
        if (!names.has(expression)) throw new ObjectiveTextError(`${expression} means the end of the run, and only belongs in an integral.`);
        return expression;
    }
    if (!Array.isArray(expression)) throw new ObjectiveTextError('The objective is not a formula.');
    const [operator, ...operands] = expression;
    const each = () => operands.map((operand) => write(operand, names));
    if (binaryOperators[operator]) return `(${each().join(` ${binaryOperators[operator]} `)})`;
    if (functionNames[operator]) return `${functionNames[operator]}(${each().join(', ')})`;
    switch (operator) {
    case 'Negate': return `(-${write(operands[0], names)})`;
    case 'Divide': return `(${write(operands[0], names)} / ${write(operands[1], names)})`;
    case 'Power': return `(${write(operands[0], names)} ^ ${write(operands[1], names)})`;
    case 'Max':
    case 'Min':
        if (operands.length !== 1) throw new ObjectiveTextError(`${operator === 'Max' ? 'max' : 'min'} over a run takes one expression: the highest or lowest value of it reached.`);
        return `${operator === 'Max' ? 'max' : 'min'}(${write(operands[0], names)})`;
    case 'Mean': return `mean(${write(operands[0], names)})`;
    case 'Limit': {
        const [body, approaches] = operands;
        const wrapped = Array.isArray(body) && body[0] === 'Function' && Array.isArray(body[1]) && body[1][0] === 'Block';
        if (approaches !== 'T' || !wrapped) throw new ObjectiveTextError('A limit in an objective is the value at the end of the run: use the final button, which has t approach T.');
        return `final(${write(body[1][1], names)})`;
    }
    case 'Integrate': {
        const [body, limits] = operands;
        // The parser wraps a body in a function of t, except a lone symbol, which it leaves as it is.
        const wrapped = Array.isArray(body) && body[0] === 'Function' && Array.isArray(body[1]) && body[1][0] === 'Block';
        const bodyExpression = wrapped ? body[1][1] : body;
        if (!Array.isArray(limits) || limits[0] !== 'Limits' || limits[2] !== 0 || limits[3] !== 'T' || bodyExpression === undefined) {
            throw new ObjectiveTextError('An integral in an objective goes from 0 to T, the end of the run: use the ∫ over the run button.');
        }
        return `integral(${write(bodyExpression, names)})`;
    }
    default: throw new ObjectiveTextError(`${operator} cannot be used in an objective.`);
    }
}

// `(a + b)` is `a + b`, but `(a) + (b)` keeps its brackets: the first one only when the bracket at the start closes at the very end.
function withoutOuterBrackets(text) {
    if (!text.startsWith('(') || !text.endsWith(')')) return text;
    let depth = 0;
    for (let index = 0; index < text.length - 1; index += 1) {
        if (text[index] === '(') depth += 1;
        else if (text[index] === ')') depth -= 1;
        if (depth === 0) return text;
    }
    return text.slice(1, -1);
}

// The engine's text for a LaTeX objective, or why it cannot be made. `names` are the names the objective may use.
export function latexToObjectiveText(latex, names) {
    const known = new Set(names);
    const validation = validateEquationLatex(latex, names.map((symbol) => ({ symbol })), { extraOperators: objectiveOperators, extraSymbols: ['T', 't'], numbersOnly: true });
    if (!validation.valid) return { valid: false, text: null, errors: validation.errors };
    try {
        const text = write(validation.mathJson, known);
        return { valid: true, text: withoutOuterBrackets(text), errors: [] };
    } catch (error) {
        if (error instanceof ObjectiveTextError) return { valid: false, text: null, errors: [error.message] };
        throw error;
    }
}

// How a name is written in the editor: as any other symbol is.
export const objectiveNameLatex = (name) => latexForBinding({ symbol: name });
