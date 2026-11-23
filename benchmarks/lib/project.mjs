/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds the benchmark models as ordinary Konjugate project documents (docs/projectSchema.md): nodes with states and their own source
// terms, relationships (edges) between them, parameters with units. Equations are written once, as the executable MathJSON the engine
// runs; their LaTeX, which the app shows and edits, is derived from it here. Every model opens in the app like any other project.

import { exampleOwnership } from '../../scripts/exampleOwnership.mjs';

function latexOf(expression) {
    if (typeof expression === 'number') return String(expression);
    if (expression === 't') return 't';
    // A one-letter symbol is written as it is: the app reads \mathrm{x} as an upright x, a different symbol from x, and would refuse
    // the equation when the model is opened.
    if (typeof expression === 'string') return expression.length === 1 ? expression : `\\mathrm{${expression}}`;
    const [operator, ...operands] = expression;
    const wrapped = (operand) => (Array.isArray(operand) && operand[0] === 'Add' ? `\\left(${latexOf(operand)}\\right)` : latexOf(operand));
    switch (operator) {
        case 'Add':
            return operands.map((operand, index) => {
                if (Array.isArray(operand) && operand[0] === 'Negate') return `${index ? ' - ' : '-'}${wrapped(operand[1])}`;
                return `${index ? ' + ' : ''}${latexOf(operand)}`;
            }).join('');
        case 'Negate': return `-${wrapped(operands[0])}`;
        case 'Multiply': return operands.map(wrapped).join('\\cdot ');
        case 'Divide': return `\\frac{${latexOf(operands[0])}}{${latexOf(operands[1])}}`;
        case 'Power': return `{${wrapped(operands[0])}}^{${latexOf(operands[1])}}`;
        case 'Sin': return `\\sin\\left(${latexOf(operands[0])}\\right)`;
        case 'Cos': return `\\cos\\left(${latexOf(operands[0])}\\right)`;
        case 'Exp': return `\\exp\\left(${latexOf(operands[0])}\\right)`;
        case 'Ln': return `\\ln\\left(${latexOf(operands[0])}\\right)`;
        case 'Tanh': return `\\tanh\\left(${latexOf(operands[0])}\\right)`;
        case 'Sqrt': return `\\sqrt{${latexOf(operands[0])}}`;
        case 'Abs': return `\\left|${latexOf(operands[0])}\\right|`;
        case 'Max': return `\\max\\left(${latexOf(operands[0])}, ${latexOf(operands[1])}\\right)`;
        case 'Min': return `\\min\\left(${latexOf(operands[0])}, ${latexOf(operands[1])}\\right)`;
        case 'Less': return operands.map(latexOf).join(' < ');
        case 'LessEqual': return operands.map(latexOf).join(' \\le ');
        case 'Greater': return operands.map(latexOf).join(' > ');
        case 'GreaterEqual': return operands.map(latexOf).join(' \\ge ');
        case 'And': return operands.map(latexOf).join(' \\land ');
        case 'Or': return operands.map(latexOf).join(' \\lor ');
        // Cases: condition, value pairs, the last condition "True" (otherwise).
        case 'Which': {
            const branches = [];
            for (let index = 0; index < operands.length; index += 2) {
                branches.push(`${latexOf(operands[index + 1])} & ${operands[index] === 'True' ? '\\text{otherwise}' : latexOf(operands[index])}`);
            }
            return `\\begin{cases} ${branches.join(' \\\\ ')} \\end{cases}`;
        }
        default: throw new Error(`No LaTeX form for ${operator}.`);
    }
}

// A model under construction. Entity IDs are handed out in order, so building the same model again gives the same document.
export function createModel(title) {
    let nextId = 1;
    const allocate = () => nextId++;
    const nodes = [];
    const edges = [];
    const symbolsOf = new Map();

    // Bindings name what an equation reads: a symbol of the equation's own node or of the edge's two ends ({ node, state }), or a
    // parameter ({ parameter: [name, value, unit] }).
    function compileBindings(uses, roles) {
        const bindings = [];
        const parameters = [];
        for (const [symbol, use] of Object.entries(uses)) {
            if (use.time) {
                bindings.push({ kind: 'time', symbol });
            } else if (use.parameter) {
                const [name, value, unit] = use.parameter;
                const parameterId = allocate();
                parameters.push({ id: parameterId, name, symbol, value, unit, mode: 'constant' });
                bindings.push({ kind: 'parameter', parameterId, symbol });
            } else {
                const role = roles?.get(use.node.id);
                bindings.push({ kind: 'state', ...(role ? { role } : {}), nodeId: use.node.id, stateId: use.node.stateIds[use.state], symbol });
            }
        }
        return { bindings, parameters };
    }

    return {
        // states: [[symbol, name, initialValue, unit], ...] in the order the node lists them (the order a semi-implicit node updates them).
        node(name, { type, states, position = [0, 0, 0], color = '#5d7885', shape = 'box' }) {
            const id = allocate();
            const stateIds = {};
            const document = {
                id, name, ...(type ? { type } : {}), position,
                numerics: { substepsPerGlobalStep: 1, integration: 'explicit' },
                states: states.map(([symbol, stateName, initialValue, unit]) => {
                    stateIds[symbol] = allocate();
                    return { id: stateIds[symbol], name: stateName, symbol, initialValue, unit };
                }),
                sourceTerms: [],
                appearance: { type: 'primitive', shape, color }
            };
            nodes.push(document);
            symbolsOf.set(id, stateIds);
            return { id, stateIds, document };
        },
        // A node's own equation: d(state)/dt += expression, reading only that node's states and its own parameters.
        sourceTerm(node, state, mathJson, uses) {
            const { bindings, parameters } = compileBindings(uses);
            const latex = latexOf(mathJson);
            node.document.sourceTerms.push({
                id: allocate(), state, expression: latex,
                expressionModel: { latex, bindings, output: { stateId: node.stateIds[state] }, mathJson },
                ...(parameters.length ? { parameters } : {})
            });
        },
        // A relationship from one node to another: d(target state)/dt += expression. It reads the source node through the snapshot taken
        // at the start of each global step, and its own target node as that node's substeps advance.
        edge(name, source, target, targetState, mathJson, uses, { color = '#70cfc7' } = {}) {
            const roles = new Map([[source.id, 'source'], [target.id, 'target']]);
            const { bindings, parameters } = compileBindings(uses, roles);
            const sourceStateUse = Object.values(uses).find((use) => use.node?.id === source.id);
            const latex = latexOf(mathJson);
            edges.push({
                id: allocate(), name,
                source: { nodeId: source.id, stateId: source.stateIds[sourceStateUse?.state ?? Object.keys(source.stateIds)[0]] },
                target: { nodeId: target.id, stateId: target.stateIds[targetState] },
                directionality: 'directed',
                equation: latex,
                equationModel: { latex, output: { role: 'target', stateId: target.stateIds[targetState] }, bindings, mathJson },
                parameters,
                appearance: { color, offset: 0 }
            });
        },
        document({ runConfiguration }) {
            const id = allocate();
            return {
                format: 'konjugate', version: 1, ownership: exampleOwnership(title), metadata: { units: 'SI' },
                runConfigurations: [{ id, name: runConfiguration.name, globalTimeStep: runConfiguration.globalTimeStep, outputInterval: runConfiguration.outputInterval }],
                activeRunConfigurationId: id,
                nodes, edges
            };
        }
    };
}

export const state = (node, symbol) => ({ node, state: symbol });
export const parameter = (name, value, unit) => ({ parameter: [name, value, unit] });
// The simulation time in seconds; bind it to the symbol t (docs/projectSchema.md, time binding).
export const time = { time: true };

// MathJSON shorthands.
export const sum = (...terms) => ['Add', ...terms];
export const negate = (term) => ['Negate', term];
export const difference = (left, right) => ['Add', left, ['Negate', right]];
export const product = (...factors) => ['Multiply', ...factors];
export const quotient = (numerator, denominator) => ['Divide', numerator, denominator];
export const square = (term) => ['Power', term, 2];
export const cases = (...conditionValuePairs) => ['Which', ...conditionValuePairs];
