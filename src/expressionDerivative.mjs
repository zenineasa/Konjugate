/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Symbolic differentiation of an equation for the stiff methods' exact Jacobian (docs/proposals/integrators.md, Jacobians for Rodas4
// and BDF), on code export's compiled expression nodes (compileExpressionNode: { op, args }, { literal }, { symbol }, { boolean }). It is
// a line-for-line mirror of differentiateExpression in engine/src/jacobianAssembly.cpp -- the same rules, the same few simplifications
// (a term whose derivative is zero dropped, a factor of 1 not written) and the same order of operands -- so an exported program
// evaluates the derivative the engine evaluates, operation for operation. A derivative that is zero everywhere is null.

const literal = (value) => ({ literal: value });
const node = (op, args) => ({ op, args });
// A Which's otherwise condition: True, which the engine compiles to the literal 1 it writes there.
const truth = { boolean: true };

// The engine compiles True and False to the literals 1 and 0.
const isLiteral = (expression) => 'literal' in expression || 'boolean' in expression;
const literalValue = (expression) => ('literal' in expression ? expression.literal : expression.boolean ? 1 : 0);
const isOne = (expression) => isLiteral(expression) && literalValue(expression) === 1;

function sum(terms) {
    const kept = terms.filter(Boolean);
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0];
    return node('Add', kept);
}

function times(factors, derivative) {
    const all = isOne(derivative) ? [...factors] : [...factors, derivative];
    if (!all.length) return literal(1);
    if (all.length === 1) return all[0];
    return node('Multiply', all);
}

const orZero = (expression) => expression ?? literal(0);

export function differentiateNode(expression, symbol) {
    if ('literal' in expression || 'boolean' in expression) return null;
    if ('symbol' in expression) return expression.symbol === symbol ? literal(1) : null;
    const args = expression.args;
    const derive = (index) => differentiateNode(args[index], symbol);
    switch (expression.op) {
        case 'Add':
            return sum(args.map((_, index) => derive(index)));
        case 'Multiply':
            return sum(args.map((_, index) => {
                const derivative = derive(index);
                if (!derivative) return null;
                const factors = [];
                args.forEach((argument, other) => {
                    if (other === index) { if (!isOne(derivative)) factors.push(derivative); } else factors.push(argument);
                });
                return !factors.length ? literal(1) : factors.length === 1 ? factors[0] : node('Multiply', factors);
            }));
        case 'Negate': {
            const derivative = derive(0);
            return derivative ? node('Negate', [derivative]) : null;
        }
        case 'Divide': {
            const [u, v] = args;
            const du = derive(0);
            const dv = derive(1);
            return sum([
                du ? node('Divide', [du, v]) : null,
                dv ? node('Negate', [node('Divide', [times([u], dv), node('Multiply', [v, v])])]) : null
            ]);
        }
        case 'Power': {
            const [u, v] = args;
            const du = derive(0);
            const dv = derive(1);
            const lowered = isLiteral(v) ? literal(literalValue(v) - 1) : node('Add', [v, literal(-1)]);
            return sum([
                du ? times([v, node('Power', [u, lowered])], du) : null,
                dv ? times([expression, node('Ln', [u])], dv) : null
            ]);
        }
        case 'Sqrt': {
            const du = derive(0);
            return du ? node('Divide', [du, node('Multiply', [literal(2), expression])]) : null;
        }
        case 'Abs': {
            const du = derive(0);
            return du ? times([node('Which', [node('Less', [args[0], literal(0)]), literal(-1), truth, literal(1)])], du) : null;
        }
        case 'Exp': {
            const du = derive(0);
            return du ? times([expression], du) : null;
        }
        case 'Ln':
        case 'Log': {
            const du = derive(0);
            return du ? node('Divide', [du, args[0]]) : null;
        }
        case 'Sin': {
            const du = derive(0);
            return du ? times([node('Cos', [args[0]])], du) : null;
        }
        case 'Cos': {
            const du = derive(0);
            return du ? node('Negate', [times([node('Sin', [args[0]])], du)]) : null;
        }
        case 'Tan': {
            const du = derive(0);
            if (!du) return null;
            const cosine = node('Cos', [args[0]]);
            return node('Divide', [du, node('Multiply', [cosine, cosine])]);
        }
        case 'Arcsin':
        case 'Arccos': {
            const du = derive(0);
            if (!du) return null;
            const u = args[0];
            const root = node('Sqrt', [node('Add', [literal(1), node('Negate', [node('Multiply', [u, u])])])]);
            const derivative = node('Divide', [du, root]);
            return expression.op === 'Arcsin' ? derivative : node('Negate', [derivative]);
        }
        case 'Arctan': {
            const du = derive(0);
            if (!du) return null;
            const u = args[0];
            return node('Divide', [du, node('Add', [literal(1), node('Multiply', [u, u])])]);
        }
        case 'Arctan2': {
            const [y, x] = args;
            const dy = derive(0);
            const dx = derive(1);
            const numerator = sum([dy ? times([x], dy) : null, dx ? node('Negate', [times([y], dx)]) : null]);
            if (!numerator) return null;
            return node('Divide', [numerator, node('Add', [node('Multiply', [x, x]), node('Multiply', [y, y])])]);
        }
        case 'Tanh': {
            const du = derive(0);
            return du ? times([node('Add', [literal(1), node('Negate', [node('Multiply', [expression, expression])])])], du) : null;
        }
        case 'Min':
        case 'Max': {
            const da = derive(0);
            const db = derive(1);
            if (!da && !db) return null;
            const [a, b] = args;
            const takesB = expression.op === 'Min' ? node('Less', [b, a]) : node('Less', [a, b]);
            return node('Which', [takesB, orZero(db), truth, orZero(da)]);
        }
        case 'Which': {
            const branches = [];
            let any = false;
            for (let index = 0; index + 1 < args.length; index += 2) {
                const derivative = derive(index + 1);
                any = any || Boolean(derivative);
                branches.push(args[index], orZero(derivative));
            }
            return any ? node('Which', branches) : null;
        }
        case 'Less': case 'LessEqual': case 'Greater': case 'GreaterEqual': case 'Equal': case 'NotEqual': case 'And': case 'Or': case 'Not':
            return null;
        default:
            throw new Error(`An expression could not be differentiated: ${expression.op}.`);
    }
}
