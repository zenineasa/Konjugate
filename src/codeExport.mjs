/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generates a standalone, single-file C++ or Python program that reproduces one full simulation
// run of the given (already flattened, subsystem/edgeGroup-stripped) project document -- with no
// runtime dependency on the Konjugate engine binary or GUI. See docs/codeExport.md for the
// supported subset and docs/projectSchema.md for the document shape this reads.
//
// Fidelity contract, confirmed against engine/src/executionPlan.cpp and
// engine/src/simulationRunner.cpp, for Euler node by node (the default). Under Runge–Kutta 4 (the run configuration's method,
// docs/proposals/integrators.md) the program instead steps the whole model at once, stage by stage, through the engine's own
// stepping code (engine/include/konjugate/integrators/rungeKutta4.hpp, pasted in, or its Python port), every node reading every
// node's stage values; a term written as a program is evaluated once per global step and held, as the engine holds it:
//   - each global step takes one frozen copy of the whole state vector ("snapshot"); a node's own
//     states evolve through a local, substep-updated working copy SEEDED FROM that snapshot, while
//     a binding into another node's state always reads the frozen snapshot value, for every
//     substep of every node, the whole step through. A node's freshly computed states are only
//     committed back into the global vector after every node has finished the step.
//   - contributions targeting the same state are summed in a fixed order: a node's own source
//     terms in their JSON order, then edges that touch this node in document order (a
//     bidirectional edge's negated "other side" contribution is generated independently from the
//     same expression/bindings, re-evaluated for that side, not reused as a cached number).
//   - a contribution's finalized value (post negation) must be finite or the run aborts, exactly
//     like the engine's per-task check -- sub-expression NaN/Infinity is not itself an error.

import { resolveSharedParameters } from './sharedParameters.mjs';
import { exportNoticeLines } from './ownership.mjs';
import { saysKinds, withoutKinds } from './ratesAndUpdates.mjs';
import { integrationMethod, methodOf, stepsPerGlobalStepOf, toleranceOf } from './integrationMethods.mjs';
import { differentiateNode } from './expressionDerivative.mjs';
import { bdfCpp, bdfPython, dormandPrince54Cpp, dormandPrince54Python, eventsCpp, eventsPython, linearSolveCpp, rodas4Cpp, rodas4Python, rungeKutta4Cpp,
    rungeKutta4Python, stiffSystemCpp, stiffSystemPython } from './integratorSources.mjs';
import { programSourceVersion } from './providerTemplate.mjs';
import { programSdkCpp, programSdkPython } from './programSdkSources.mjs';
import { parseUnit } from './units.mjs';

const numericLiteralPattern = /^-?\d+(\.\d+)?([eE]-?\d+)?$/;

const minimumArgumentCounts = {
    Negate: 1, Divide: 2, Power: 2, Sqrt: 1, Abs: 1, Exp: 1, Ln: 1, Log: 1, Sin: 1, Cos: 1, Tan: 1, Arcsin: 1, Arccos: 1, Arctan: 1, Arctan2: 2, Tanh: 1, Min: 2, Max: 2,
    Which: 2, Less: 2, LessEqual: 2, Greater: 2, GreaterEqual: 2, Equal: 2, NotEqual: 2, And: 2, Or: 2, Not: 1
};

// Chained comparisons (0 < x < 1) hold only when every adjacent pair does, matching the engine.
function chainedComparison(symbol, joiner) {
    return (args) => `(${args.slice(1).map((right, index) => `(${args[index]} ${symbol} ${right})`).join(` ${joiner} `)})`;
}

// "Which" is (condition, value) pairs; the last condition is always true once validated, so it
// becomes the final else. Anything else falls through to NaN, which fails the run the same way the
// engine's "no branch matched" error does.
function whichEmitter(conditional, fallback) {
    return (args, nodes) => {
        const lastIsOtherwise = nodes.length >= 2 && nodes[nodes.length - 2].boolean === true;
        const pairs = lastIsOtherwise ? args.length - 2 : args.length;
        let result = lastIsOtherwise ? args[args.length - 1] : fallback;
        for (let index = pairs - 2; index >= 0; index -= 2) result = conditional(args[index], args[index + 1], result);
        return result;
    };
}

export const cppOperators = {
    Add: (args) => (args.length ? `(${args.join(' + ')})` : '0.0'),
    Multiply: (args) => (args.length ? `(${args.join(' * ')})` : '1.0'),
    Negate: (args) => `(-${args[0]})`,
    Divide: (args) => `(${args[0]} / ${args[1]})`,
    Power: (args) => `std::pow(${args[0]}, ${args[1]})`,
    Sqrt: (args) => `std::sqrt(${args[0]})`,
    Abs: (args) => `std::abs(${args[0]})`,
    Exp: (args) => `std::exp(${args[0]})`,
    Ln: (args) => `std::log(${args[0]})`,
    Log: (args) => `std::log(${args[0]})`,
    Sin: (args) => `std::sin(${args[0]})`,
    Cos: (args) => `std::cos(${args[0]})`,
    Tan: (args) => `std::tan(${args[0]})`,
    Arcsin: (args) => `std::asin(${args[0]})`,
    Arccos: (args) => `std::acos(${args[0]})`,
    Arctan: (args) => `std::atan(${args[0]})`,
    Arctan2: (args) => `std::atan2(${args[0]}, ${args[1]})`,
    Tanh: (args) => `std::tanh(${args[0]})`,
    Min: (args) => `std::min(${args[0]}, ${args[1]})`,
    Max: (args) => `std::max(${args[0]}, ${args[1]})`,
    Which: whichEmitter((condition, value, otherwise) => `(${condition} ? ${value} : ${otherwise})`, 'std::nan("")'),
    Less: chainedComparison('<', '&&'),
    LessEqual: chainedComparison('<=', '&&'),
    Greater: chainedComparison('>', '&&'),
    GreaterEqual: chainedComparison('>=', '&&'),
    Equal: chainedComparison('==', '&&'),
    NotEqual: (args) => `(${args[0]} != ${args[1]})`,
    And: (args) => `(${args.join(' && ')})`,
    Or: (args) => `(${args.join(' || ')})`,
    Not: (args) => `(!${args[0]})`,
    True: 'true',
    False: 'false'
};

// math.pow/math.sqrt/math.log raise ValueError on inputs where std::pow/std::sqrt/std::log would
// return NaN (e.g. sqrt of a negative number) instead of propagating a non-finite value the same
// way -- an acceptable, documented divergence (docs/codeExport.md) rather than a wrong-physics
// bug, since both forms fail loudly rather than silently continuing with bad data.
const pythonOperators = {
    Add: (args) => (args.length ? `(${args.join(' + ')})` : '0.0'),
    Multiply: (args) => (args.length ? `(${args.join(' * ')})` : '1.0'),
    Negate: (args) => `(-${args[0]})`,
    Divide: (args) => `(${args[0]} / ${args[1]})`,
    Power: (args) => `math.pow(${args[0]}, ${args[1]})`,
    Sqrt: (args) => `math.sqrt(${args[0]})`,
    Abs: (args) => `abs(${args[0]})`,
    Exp: (args) => `math.exp(${args[0]})`,
    Ln: (args) => `math.log(${args[0]})`,
    Log: (args) => `math.log(${args[0]})`,
    Sin: (args) => `math.sin(${args[0]})`,
    Cos: (args) => `math.cos(${args[0]})`,
    Tan: (args) => `math.tan(${args[0]})`,
    Arcsin: (args) => `math.asin(${args[0]})`,
    Arccos: (args) => `math.acos(${args[0]})`,
    Arctan: (args) => `math.atan(${args[0]})`,
    Arctan2: (args) => `math.atan2(${args[0]}, ${args[1]})`,
    Tanh: (args) => `math.tanh(${args[0]})`,
    Min: (args) => `min(${args[0]}, ${args[1]})`,
    Max: (args) => `max(${args[0]}, ${args[1]})`,
    Which: whichEmitter((condition, value, otherwise) => `(${value} if ${condition} else ${otherwise})`, "float('nan')"),
    Less: chainedComparison('<', 'and'),
    LessEqual: chainedComparison('<=', 'and'),
    Greater: chainedComparison('>', 'and'),
    GreaterEqual: chainedComparison('>=', 'and'),
    Equal: chainedComparison('==', 'and'),
    NotEqual: (args) => `(${args[0]} != ${args[1]})`,
    And: (args) => `(${args.join(' and ')})`,
    Or: (args) => `(${args.join(' or ')})`,
    Not: (args) => `(not ${args[0]})`,
    True: 'True',
    False: 'False'
};

// Always a floating-point literal, in C++ as in Python: "75" would be an int in C++, where 1 / 2 is 0 and std::min(75,
// x) with x a double does not compile. String() already writes a large or small value with an exponent (1e+21), which
// is a double.
export function doubleLiteral(value) {
    if (!Number.isFinite(value)) throw new Error(`Cannot embed a non-finite constant (${value}) in generated code.`);
    if (Object.is(value, -0)) return '-0.0';
    const text = String(value);
    return /[.e]/.test(text) ? text : `${text}.0`;
}

function csvField(value) {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function compileExpressionNode(node) {
    if (Array.isArray(node)) {
        const [operator, ...args] = node;
        return { op: operator, args: args.map(compileExpressionNode) };
    }
    const text = String(node);
    if (text === 'True' || text === 'False') return { boolean: text === 'True' };
    return numericLiteralPattern.test(text) ? { literal: Number(text) } : { symbol: text };
}

// A contribution reads the substep's start time; an algebraic term reads the instant of the states it
// is computed from, which the emitted code holds in algebraicTime (see cppAlgebraicLines).
const timeTexts = {
    cpp: { start: 'stepTime', algebraic: 'algebraicTime' },
    python: { start: 'step_time', algebraic: 'algebraic_time' }
};

// A parameter that follows a stored schedule reads it at the instant the engine resolves it: the
// substep's start for a derivative, the algebraic instant for an algebraic term.
const scheduleCalls = {
    cpp: (index, time) => `scheduleValue(${index}, ${timeTexts.cpp[time]})`,
    python: (index, time) => `schedule_value(${index}, ${timeTexts.python[time]})`
};

// The text a symbol entry reads as in `language`: a time, a scheduled parameter's lookup, or its
// fixed text (a literal, a state slot, or an FMU member).
export function symbolText(value, language) {
    if (value.time) return timeTexts[language][value.time];
    if (value.schedule !== undefined) return scheduleCalls[language](value.schedule, value.scheduleTime);
    return value.text;
}

export function symbolTexts(symbols, language) {
    return new Map(Array.from(symbols, ([key, value]) => [key, symbolText(value, language)]));
}

export function emitExpression(node, symbols, operators) {
    if ('literal' in node) return doubleLiteral(node.literal);
    if ('boolean' in node) return operators[node.boolean ? 'True' : 'False'];
    if ('symbol' in node) {
        const resolved = symbols.get(node.symbol);
        if (!resolved) throw new Error(`Unknown executable symbol: ${node.symbol}.`);
        return resolved;
    }
    const emitter = operators[node.op];
    if (!emitter) throw new Error(`Unsupported executable operation: ${node.op}.`);
    const minimum = minimumArgumentCounts[node.op] ?? 0;
    if (node.args.length < minimum) throw new Error(`An expression is missing an argument for ${node.op}.`);
    return emitter(node.args.map((argument) => emitExpression(argument, symbols, operators)), node.args);
}

// ---- event location (docs/proposals/integrators.md, Event location): as engine/src/eventLocation.cpp, every comparison by order in a
// Which condition of a Rate term written as an equation becomes a switching function, g = left - right, and the term reads the condition's
// latch instead of comparing, so the exported program locates the same events. ----

const orderings = { Less: 0, LessEqual: 1, Greater: 2, GreaterEqual: 3 };

// Rewrites each Rate equation's mathJson in the whole-model nodes, adding a latch symbol for each comparison of a condition; returns the
// switching functions, each with its node's plan, the comparison's two sides and the term's symbols.
function latchConditions(model) {
    const functions = [];
    model.nodePlans.forEach((plan, nodeIndex) => {
        for (const contribution of plan.contributions) {
            if (contribution.implementation) continue;
            const latch = (comparison, left, right) => {
                const key = `__latch${functions.length}`;
                functions.push({ nodeIndex, plan, comparison, left, right, symbols: contribution.symbols });
                return key;
            };
            const condition = (expression) => {
                if (Array.isArray(expression) && expression[0] in orderings && expression.length >= 3) {
                    const comparison = orderings[expression[0]];
                    const reads = [];
                    for (let pair = 1; pair + 1 < expression.length; ++pair) reads.push(latch(comparison, expression[pair], expression[pair + 1]));
                    return reads.length === 1 ? reads[0] : ['And', ...reads];
                }
                if (Array.isArray(expression) && ['And', 'Or', 'Not'].includes(expression[0])) return [expression[0], ...expression.slice(1).map(condition)];
                return walk(expression);
            };
            const walk = (expression) => {
                if (!Array.isArray(expression)) return expression;
                if (expression[0] === 'Which') {
                    const args = expression.slice(1);
                    return ['Which', ...args.map((argument, index) => (index % 2 === 0 && index + 1 < args.length ? condition(argument) : walk(argument)))];
                }
                return [expression[0], ...expression.slice(1).map(walk)];
            };
            const before = functions.length;
            const rewritten = walk(contribution.mathJson);
            if (functions.length === before) continue;
            contribution.mathJson = rewritten;
            contribution.symbols = new Map(contribution.symbols);
            for (let index = before; index < functions.length; ++index) {
                contribution.symbols.set(`__latch${index}`, { text: `switching.latches[${index}]`, comment: 'the condition, latched through the step' });
            }
        }
    });
    return functions;
}

// ---- graph build: mirrors engine/src/executionPlan.cpp's compileExecutionPlan exactly enough to
// reproduce its numerics, without needing any of its parallel-execution/checkpoint machinery. ----

// `options.wholeModel`: the model is run by a whole-model method, under which a node's integration does not apply.
export function buildModel(sourceDocument, options = {}) {
    // Standalone programs have no runtime notion of sharing: bake each link to its shared value.
    const document = resolveSharedParameters(sourceDocument);
    // Rates and Updates (docs/proposals/ratesAndUpdates.md): the exported loop works values out as a file that says no kind
    // runs, settling every node, so a file that says its kinds is written as that file, and refused when it means something
    // else (an Update worked out once per step, a relationship's single equation setting a value, an Update reading itself).
    if (saysKinds(document.nodes ?? [])) {
        const legacy = withoutKinds(document.nodes ?? [], document.edges ?? []);
        if (legacy.reason) throw new Error(`${legacy.reason}, which code export cannot write yet.`);
        document.nodes = legacy.nodes;
    }
    const enabledNodes = (document.nodes ?? []).filter((node) => node.enabled !== false);
    const disabledNodeIds = new Set((document.nodes ?? []).filter((node) => node.enabled === false).map((node) => node.id));
    const stateOwnerNodeId = new Map();
    const stateRecord = new Map();
    let globalIndex = 0;
    for (const node of enabledNodes) {
        node.states.forEach((state, localIndex) => {
            stateOwnerNodeId.set(state.id, node.id);
            stateRecord.set(state.id, { node, state, globalIndex, localIndex });
            globalIndex += 1;
        });
    }
    const nodeById = new Map(enabledNodes.map((node) => [node.id, node]));
    const nodePlans = enabledNodes.map((node) => ({
        node,
        localIndexByStateId: new Map(node.states.map((state, index) => [state.id, index])),
        substeps: node.numerics?.substepsPerGlobalStep ?? 1,
        contributions: [],
        // setsValue source terms (Updates): held through the step's substeps, then worked out and
        // written directly once after it, never integrated (see applyUpdates in engine/src/executionPlan.cpp).
        algebraic: [],
        nodeProvider: null
    }));
    const nodePlanById = new Map(nodePlans.map((plan) => [plan.node.id, plan]));
    // Stored parameter schedules, one table per shared parameter however many parameters link to it.
    const schedules = { list: [], byKey: new Map() };

    for (const plan of nodePlans) {
        for (const term of plan.node.sourceTerms ?? []) {
            const programmable = term.implementation != null;
            (term.setsValue === true ? plan.algebraic : plan.contributions).push(buildContribution({
                entityLabel: `source term on node "${plan.node.name}"`, ownerPlan: plan, alwaysLocal: true,
                algebraic: term.setsValue === true,
                bindings: programmable ? term.implementation.bindings : term.expressionModel.bindings,
                outputStateId: programmable ? term.implementation.output.stateId : term.expressionModel.output.stateId,
                mathJson: programmable ? null : term.expressionModel.mathJson,
                implementation: term.implementation ?? null,
                negate: false,
                parameters: term.parameters ?? [],
                identifierField: programmable ? 'key' : 'symbol'
            }, stateRecord, schedules));
        }
        plan.algebraic = orderAlgebraicTasks(plan);
        if (plan.node.implementation) plan.nodeProvider = buildNodeProvider(plan, stateRecord, schedules);
    }

    for (const node of enabledNodes) {
        if (!options.wholeModel && node.numerics?.integration === 'semiImplicit') {
            throw new Error(`Node "${node.name}" is integrated semi-implicitly, which code export cannot write yet.`);
        }
    }
    for (const edge of document.edges ?? []) {
        if (edge.enabled === false) continue;
        if (Array.isArray(edge.equationModel?.outputs)) {
            throw new Error(`Relationship "${edge.name}" sets several states with its equations, which code export cannot write yet.`);
        }
        if (disabledNodeIds.has(edge.source.nodeId) || disabledNodeIds.has(edge.target.nodeId)) continue;
        const programmable = edge.implementation != null;
        if (programmable && Array.isArray(edge.implementation.outputs)) {
            throw new Error(`The relationship "${edge.name}" is a program with several outputs, which code export cannot write yet -- export blocked.`);
        }
        const outputRole = programmable ? edge.implementation.output.role : edge.equationModel.output.role;
        const outputStateId = programmable ? edge.implementation.output.stateId : edge.equationModel.output.stateId;
        const outputPlan = nodePlanById.get(stateOwnerNodeId.get(outputStateId));
        const bindings = programmable ? edge.implementation.bindings : edge.equationModel.bindings;
        const mathJson = programmable ? null : edge.equationModel.mathJson;
        const identifierField = programmable ? 'key' : 'symbol';
        if (outputPlan) {
            outputPlan.contributions.push(buildContribution({
                entityLabel: `relationship "${edge.name}"`, ownerPlan: outputPlan, alwaysLocal: false,
                bindings, outputStateId, mathJson, implementation: edge.implementation ?? null, negate: false,
                parameters: edge.parameters ?? [], identifierField
            }, stateRecord, schedules));
        }
        if (edge.directionality === 'bidirectional') {
            const otherNodeId = outputRole === 'target' ? edge.source.nodeId : edge.target.nodeId;
            const otherNode = nodeById.get(otherNodeId);
            const otherPlan = nodePlanById.get(otherNodeId);
            if (otherNode && otherPlan) {
                const otherEndpoint = outputRole === 'target' ? edge.source : edge.target;
                let otherStateId = otherEndpoint?.stateId;
                if (otherStateId == null || !otherNode.states.some((state) => state.id === otherStateId)) {
                    otherStateId = otherNode.states[0]?.id;
                }
                if (otherStateId == null) throw new Error(`Bidirectional relationship "${edge.name}" has an endpoint with no states.`);
                otherPlan.contributions.push(buildContribution({
                    entityLabel: `relationship "${edge.name}"`, ownerPlan: otherPlan, alwaysLocal: false,
                    bindings, outputStateId: otherStateId, mathJson, implementation: edge.implementation ?? null, negate: true,
                    parameters: edge.parameters ?? [], identifierField
                }, stateRecord, schedules));
            }
        }
    }

    // Verlet's two parts, once every relationship's contribution is in (under a whole-model method a node's integration does not apply).
    if (!options.wholeModel) {
        for (const plan of nodePlans) if (plan.node.numerics?.integration === 'verlet') plan.verletKicked = verletParts(plan);
    }
    return { nodePlans, globalStateCount: globalIndex, stateRecord, schedules: schedules.list };
}

// A Verlet node's two parts, as engine/src/executionPlan.cpp's assignVerletParts finds them: the states before the first one whose
// rate reads a state listed before it, and the rest, counting only states with a rate and only what equations read (a program term
// is held through the substep). Per state, true for the first part. A rate reading its own part is refused in the engine's words.
function verletParts(plan) {
    if (plan.nodeProvider) throw new Error('A node with a computational-node provider is integrated explicitly.');
    const states = plan.node.states;
    const count = states.length;
    const hasRate = new Array(count).fill(false);
    for (const contribution of plan.contributions) hasRate[contribution.outputLocalIndex] = true;
    const reads = Array.from({ length: count }, () => new Set());
    for (const contribution of plan.contributions) {
        if (contribution.implementation) continue;
        for (const symbol of mathJsonSymbols(contribution.mathJson)) {
            const local = /^state\[(\d+)\]$/.exec(contribution.symbols.get(symbol)?.text ?? '');
            if (local && hasRate[Number(local[1])]) reads[contribution.outputLocalIndex].add(Number(local[1]));
        }
    }
    const sorted = reads.map((set) => [...set].sort((left, right) => left - right));
    let split = sorted.findIndex((list, index) => list.length && list[0] < index);
    if (split < 0) split = count;
    const kicked = states.map((state, index) => index < split && hasRate[index]);
    const name = (entity) => entity.name || String(entity.id);
    sorted.forEach((list, index) => {
        for (const read of list) {
            if (read !== index && kicked[read] !== kicked[index]) continue;
            const splitText = split === count ? 'none of its states reads one listed before it, so they are all one part'
                : `the second part starts at ${name(states[split])}, the first state whose rate reads one listed before it`;
            const problem = read === index ? `the rate of ${name(states[index])} reads ${name(states[index])} itself`
                : `the rate of ${name(states[index])} reads ${name(states[read])}, in the same part`;
            throw new Error(`Node "${name(plan.node)}" cannot be integrated with Verlet: ${problem}. Verlet splits a node's states, in their listed order, `
                + 'in two parts and moves each from the other, so a state\'s rate may read only states of the other part, as a position\'s reads its speed '
                + `and a speed's reads positions (here ${splitText}). Reorder the states, or choose semi-implicit Euler for this node, or Runge–Kutta 4 `
                + 'for the whole model in the Run settings.');
        }
    });
    return kicked;
}

// The indexes of a Verlet node's states with a rate, in its first part (kicked) or its second (drifted), and its contributions split
// as the engine splits them: program terms held, equations into the first part, equations into the second.
function verletGroups(plan) {
    const indexes = { kicked: [], drifted: [] };
    const groups = { held: [], kick: [], drift: [] };
    for (const contribution of plan.contributions) {
        const first = plan.verletKicked[contribution.outputLocalIndex];
        const list = indexes[first ? 'kicked' : 'drifted'];
        if (!list.includes(contribution.outputLocalIndex)) list.push(contribution.outputLocalIndex);
        groups[contribution.implementation ? 'held' : first ? 'kick' : 'drift'].push(contribution);
    }
    return { ...indexes, ...groups };
}

// A node's substeps in C++, from `const double nodeTimeStep` on, with its states in `state` (shared with fmiCodeGen.mjs). Euler: every
// contribution at the substep's start, then every state moves. Verlet (engine/src/executionPlan.cpp, integrateVerletNode): program
// terms held from the substep's start; the first part half a step with its rates at the start, the second a whole step with its rates
// at the middle, the first the other half with its rates at the end, which are the next substep's at its start. Each block sets its
// own stepTime, the instant a time binding or a schedule reads.
export function cppNodeSubstepLines(plan, emitContribution) {
    const stateCount = plan.node.states.length;
    const lines = (contributions) => contributions.map(emitContribution).join('\n');
    if (!plan.verletKicked) {
        return [
            `        const double nodeTimeStep = globalTimeStep / ${plan.substeps}.0;`,
            `        for (int substep = 0; substep < ${plan.substeps}; ++substep) {`,
            '            const double stepTime = currentTime + substep * nodeTimeStep;',
            `            double derivative[${stateCount}] = {};`,
            lines(plan.contributions),
            `            for (int index = 0; index < ${stateCount}; ++index) state[index] += nodeTimeStep * derivative[index];`,
            '        }'
        ].join('\n');
    }
    const groups = verletGroups(plan);
    const block = (time, contributions, after) => [
        '            {',
        `            const double stepTime = ${time};`,
        `            double derivative[${stateCount}] = {};`,
        lines(contributions),
        ...after,
        '            }'
    ].filter(Boolean).join('\n');
    const copy = (target) => `            for (int index = 0; index < ${stateCount}; ++index) ${target}[index] = derivative[index];`;
    const kick = groups.kicked.map((index) => `            state[${index}] += halfStep * (kick[${index}] + held[${index}]);`);
    return [
        `        const double nodeTimeStep = globalTimeStep / ${plan.substeps}.0;`,
        '        const double halfStep = 0.5 * nodeTimeStep;',
        '        // Verlet: the first part in two half steps around a whole step of the second.',
        `        double kick[${stateCount}] = {};`,
        `        double held[${stateCount}] = {};`,
        '        {',
        '        const double stepTime = currentTime;',
        `        double derivative[${stateCount}] = {};`,
        lines(groups.kick),
        copy('kick').replace(/^    /, ''),
        '        }',
        `        for (int substep = 0; substep < ${plan.substeps}; ++substep) {`,
        '            const double startTime = currentTime + substep * nodeTimeStep;',
        groups.held.length ? block('startTime', groups.held, [copy('held')]) : '',
        ...kick,
        block('startTime + halfStep', groups.drift, groups.drifted.map((index) => `            state[${index}] += nodeTimeStep * (derivative[${index}] + held[${index}]);`)),
        block('currentTime + (substep + 1) * nodeTimeStep', groups.kick, [copy('kick')]),
        ...kick,
        '        }'
    ].filter(Boolean).join('\n');
}

// The same in Python, from `node_time_step` on, indented for a node's block.
function pythonNodeSubstepLines(plan, emitContribution) {
    const stateCount = plan.node.states.length;
    const lines = (contributions) => contributions.map(emitContribution).join('\n');
    const groups = verletGroups(plan);
    const kick = groups.kicked.map((index) => `        state[${index}] += half_step * (kick[${index}] + held[${index}])`);
    const outdent = (text) => text.split('\n').map((line) => line.replace(/^    /, '')).join('\n');
    return [
        `    node_time_step = global_time_step / ${plan.substeps}`,
        '    half_step = 0.5 * node_time_step',
        '    # Verlet: the first part in two half steps around a whole step of the second.',
        '    step_time = current_time',
        `    derivative = [0.0] * ${stateCount}`,
        groups.kick.length ? outdent(lines(groups.kick)) : '',
        '    kick = derivative',
        `    held = [0.0] * ${stateCount}`,
        `    for substep in range(${plan.substeps}):`,
        '        start_time = current_time + substep * node_time_step',
        ...(groups.held.length ? ['        step_time = start_time', `        derivative = [0.0] * ${stateCount}`, lines(groups.held), '        held = derivative'] : []),
        ...kick,
        '        step_time = start_time + half_step',
        `        derivative = [0.0] * ${stateCount}`,
        lines(groups.drift),
        ...groups.drifted.map((index) => `        state[${index}] += node_time_step * (derivative[${index}] + held[${index}])`),
        '        step_time = current_time + (substep + 1) * node_time_step',
        `        derivative = [0.0] * ${stateCount}`,
        lines(groups.kick),
        '        kick = derivative',
        ...kick
    ].filter(Boolean).join('\n');
}

// Same order as the engine: an algebraic state bound by another algebraic term is computed first.
function mathJsonSymbols(expression, symbols = new Set()) {
    if (Array.isArray(expression)) expression.slice(1).forEach((argument) => mathJsonSymbols(argument, symbols));
    else if (typeof expression === 'string' && !['True', 'False'].includes(expression) && !Number.isFinite(Number(expression))) symbols.add(expression);
    return symbols;
}

function orderAlgebraicTasks(plan) {
    const byOutput = new Map(plan.algebraic.map((task) => [task.outputStateId, task]));
    const ordered = [];
    const visiting = new Set();
    const done = new Set();
    const visit = (task) => {
        if (done.has(task)) return;
        if (visiting.has(task)) throw new Error(`Algebraic (setsValue) source terms on node "${plan.node.name}" depend on each other in a cycle.`);
        visiting.add(task);
        for (const stateId of task.boundStateIds) {
            const dependency = byOutput.get(stateId);
            if (dependency && dependency !== task) visit(dependency);
        }
        visiting.delete(task);
        done.add(task);
        ordered.push(task);
    };
    plan.algebraic.forEach(visit);
    return ordered;
}

// A parameter's stored schedule as a table: { hold, times, values }, checked as the engine checks it.
function compileStoredSchedule(parameter) {
    const { interpolation = 'linear', samples } = parameter.schedule;
    if (interpolation !== 'linear' && interpolation !== 'hold') throw new Error(`Parameter "${parameter.name ?? parameter.symbol}" has a schedule whose interpolation is neither linear nor hold.`);
    if (!Array.isArray(samples) || !samples.length) throw new Error(`Parameter "${parameter.name ?? parameter.symbol}" has a schedule with no samples.`);
    const times = [];
    const values = [];
    for (const sample of samples) {
        if (!Array.isArray(sample) || sample.length !== 2 || !sample.every(Number.isFinite) || (times.length && !(sample[0] > times.at(-1)))) {
            throw new Error(`Parameter "${parameter.name ?? parameter.symbol}" has a schedule whose samples are not finite [time, value] pairs in increasing time.`);
        }
        times.push(sample[0]);
        values.push(sample[1]);
    }
    return { hold: interpolation === 'hold', times, values, label: parameter.symbol };
}

// The lookup the engine's evaluateParameterSchedule() performs (executionPlan.cpp): edge-held
// outside the samples, then held or linearly interpolated, found by binary search.
export function cppScheduleLines(model) {
    if (!model.schedules.length) return '';
    const tables = model.schedules.map((schedule, index) => [
        `// ${schedule.label}: ${schedule.times.length} samples, ${schedule.hold ? 'held' : 'linear'}`,
        `const double scheduleTimes${index}[] = { ${schedule.times.map(doubleLiteral).join(', ')} };`,
        `const double scheduleValues${index}[] = { ${schedule.values.map(doubleLiteral).join(', ')} };`
    ].join('\n'));
    return [
        '// Stored parameter schedules (sharedParameters[].schedule): the parameter follows these samples over time.',
        'struct ParameterScheduleTable { const double* times; const double* values; std::size_t count; bool hold; };',
        ...tables,
        `const ParameterScheduleTable parameterSchedules[] = { ${model.schedules.map((schedule, index) => `{ scheduleTimes${index}, scheduleValues${index}, ${schedule.times.length}, ${schedule.hold} }`).join(', ')} };`,
        'inline double scheduleValue(std::size_t index, double time) {',
        '    const ParameterScheduleTable& schedule = parameterSchedules[index];',
        '    if (time <= schedule.times[0]) return schedule.values[0];',
        '    if (time >= schedule.times[schedule.count - 1]) return schedule.values[schedule.count - 1];',
        '    const std::size_t upper = static_cast<std::size_t>(std::upper_bound(schedule.times, schedule.times + schedule.count, time) - schedule.times);',
        '    if (schedule.hold) return schedule.values[upper - 1];',
        '    const double fraction = (time - schedule.times[upper - 1]) / (schedule.times[upper] - schedule.times[upper - 1]);',
        '    return schedule.values[upper - 1] + fraction * (schedule.values[upper] - schedule.values[upper - 1]);',
        '}',
        ''
    ].join('\n');
}

function pythonScheduleLines(model) {
    if (!model.schedules.length) return '';
    const literal = (value) => (Number.isInteger(value) ? `${value}.0` : doubleLiteral(value));
    return [
        '# Stored parameter schedules (sharedParameters[].schedule): the parameter follows these samples over time.',
        'PARAMETER_SCHEDULES = [',
        ...model.schedules.map((schedule) => `    (${schedule.hold ? 'True' : 'False'}, [${schedule.times.map(literal).join(', ')}], [${schedule.values.map(literal).join(', ')}]),  # ${schedule.label}`),
        ']',
        '',
        '',
        'def schedule_value(index, time):',
        '    hold, times, values = PARAMETER_SCHEDULES[index]',
        '    if time <= times[0]:',
        '        return values[0]',
        '    if time >= times[-1]:',
        '        return values[-1]',
        '    upper = bisect.bisect_right(times, time)',
        '    if hold:',
        '        return values[upper - 1]',
        '    fraction = (time - times[upper - 1]) / (times[upper] - times[upper - 1])',
        '    return values[upper - 1] + fraction * (values[upper] - values[upper - 1])',
        '',
        ''
    ].join('\n');
}

// A parameter's symbol entry: its value, or, when it follows a stored schedule, a lookup of that schedule at `time`
// ('start' of the substep, or 'algebraic' for a setsValue term's instant). `parameter` is also exposed on the entry
// (beyond text/comment) so a caller that cares about liveness -- fmiCodeGen.mjs, which exposes a live parameter as a
// real FMI input rather than baking it, unlike this module's own C++/Python export -- can tell without re-deriving
// the binding. Existing callers only read text/comment.
function parameterSymbol(parameter, time, schedules) {
    if (parameter.schedule) {
        const scheduleKey = parameter.scheduleKey ?? `parameter:${parameter.id}`;
        if (!schedules.byKey.has(scheduleKey)) {
            schedules.byKey.set(scheduleKey, schedules.list.length);
            schedules.list.push(compileStoredSchedule(parameter));
        }
        const schedule = schedules.byKey.get(scheduleKey);
        // `text` is the C++ form, read directly by provider input lists; symbolText() gives either language.
        return { schedule, scheduleTime: time, text: scheduleCalls.cpp(schedule, time), comment: `${parameter.symbol} (follows a schedule)`, parameter };
    }
    return { text: doubleLiteral(parameter.value), comment: parameter.symbol, parameter };
}

function buildContribution(spec, stateRecord, schedules) {
    const { entityLabel, ownerPlan, alwaysLocal, algebraic = false, bindings, outputStateId, mathJson, implementation, negate, parameters, identifierField } = spec;
    const outputLocalIndex = ownerPlan.localIndexByStateId.get(outputStateId);
    if (outputLocalIndex === undefined) throw new Error(`The ${entityLabel} targets a state that is not on its own node.`);
    const symbols = new Map();
    for (const binding of bindings ?? []) {
        const key = binding[identifierField];
        if (binding.kind === 'time') {
            // Language-specific, resolved by symbolTexts(): substep start for a derivative, end
            // for an algebraic term -- the same instants the engine uses.
            symbols.set(key, { time: algebraic ? 'algebraic' : 'start', comment: 'simulation time', unit: 's' });
            continue;
        }
        if (binding.kind === 'parameter') {
            const parameter = (parameters ?? []).find((item) => item.id === binding.parameterId);
            if (!parameter) throw new Error(`The ${entityLabel} has an unresolved parameter binding.`);
            symbols.set(key, { ...parameterSymbol(parameter, algebraic ? 'algebraic' : 'start', schedules), unit: parameter.unit ?? '' });
        } else {
            const record = stateRecord.get(binding.stateId);
            if (!record) throw new Error(`The ${entityLabel} references a disabled or missing state.`);
            const isLocal = alwaysLocal || binding.nodeId === ownerPlan.node.id;
            // `globalIndex`: the state's place in the program's state vector, which the stiff methods' exact Jacobian differentiates by.
            symbols.set(key, isLocal
                ? { text: `state[${ownerPlan.localIndexByStateId.get(binding.stateId)}]`, comment: `${ownerPlan.node.name}.${record.state.name}`, unit: record.state.unit ?? '', globalIndex: record.globalIndex }
                : { text: `snapshot[${record.globalIndex}]`, comment: `${record.node.name}.${record.state.name}`, unit: record.state.unit ?? '', globalIndex: record.globalIndex });
        }
    }
    // A provider may read any state it binds; an equation only the ones it uses (the node editor
    // binds all of a node's states to each source term).
    const used = implementation ? null : mathJsonSymbols(mathJson);
    const boundStateIds = (bindings ?? [])
        .filter((binding) => (binding.kind === 'state' || binding.kind === undefined) && (!used || used.has(binding[identifierField])))
        .map((binding) => binding.stateId);
    return { entityLabel, outputStateId, outputLocalIndex, negate, symbols, mathJson, implementation, boundStateIds, algebraic,
        outputUnit: stateRecord.get(outputStateId)?.state.unit ?? '' };
}

function buildNodeProvider(plan, stateRecord, schedules) {
    const implementation = plan.node.implementation;
    const symbols = new Map();
    for (const binding of implementation.bindings ?? []) {
        // A shared parameter, baked into the binding by resolveSharedParameters, read at the substep's start.
        if (binding.kind === 'parameter') {
            if (!binding.parameter) throw new Error(`The computational-node provider on node "${plan.node.name}" binds a parameter that is not a shared one.`);
            symbols.set(binding.key, parameterSymbol(binding.parameter, 'start', schedules));
            continue;
        }
        const record = stateRecord.get(binding.stateId);
        if (!record) throw new Error(`The computational-node provider on node "${plan.node.name}" references a disabled or missing state.`);
        // Its own node's state as the node advances, another node's from the step's snapshot, as the engine reads them.
        const localIndex = plan.localIndexByStateId.get(binding.stateId);
        symbols.set(binding.key, localIndex !== undefined
            ? { text: `state[${localIndex}]`, comment: `${plan.node.name}.${record.state.name}` }
            : { text: `snapshot[${record.globalIndex}]`, comment: `${record.node.name}.${record.state.name}` });
    }
    const outputs = (implementation.outputs ?? []).map((output) => {
        const localIndex = plan.localIndexByStateId.get(output.stateId);
        if (localIndex === undefined) throw new Error(`A computational-node provider output on node "${plan.node.name}" targets a state not on this node.`);
        return { key: output.key, localIndex, setsValue: output.setsValue === true };
    });
    return { entityLabel: `computational-node provider on node "${plan.node.name}"`, implementation, symbols, outputs };
}

// ---- provider blocking + registry: validates every provider-bearing entity up front (no partial
// output is ever emitted) and assigns each a stable, collision-free instance name. ----

export function collectProviders(model, kind) {
    const providers = [];
    const visit = (owner) => {
        if (!owner.implementation) return;
        const providerKind = owner.implementation.kind;
        if (providerKind === 'plugin') {
            throw new Error(`The ${owner.entityLabel} references an installed plugin provider, which has no embeddable source -- export cannot include it.`);
        }
        if (providerKind !== 'cpp' && providerKind !== 'python') {
            throw new Error(`The ${owner.entityLabel} has an unrecognized provider kind "${providerKind}".`);
        }
        // A program in the current program format (version 2) keeps its memory with the engine and is converted at its ports; code
        // export does not write that yet, so it refuses rather than write a program that would run differently.
        if (programSourceVersion(providerKind, owner.implementation.source) === 2) {
            const declared = programDeclarations(providerKind, owner.implementation.source);
            if (declared.keepsMemory) {
                throw new Error(`The program of the ${owner.entityLabel} remembers something between steps, or has a clock, which code export cannot write yet -- export blocked.`);
            }
            if (declared.ownInitialize || declared.node || declared.outputs.length !== 1) {
                throw new Error(`The program of the ${owner.entityLabel} has an initialize() of its own or several outputs, which code export cannot write yet -- export blocked.`);
            }
            owner.program = declared;
        }
        if (providerKind !== kind) {
            throw new Error(`The ${owner.entityLabel} is implemented in ${providerKind === 'cpp' ? 'C++' : 'Python'}, but export to ${kind === 'cpp' ? 'C++' : 'Python'} was requested -- export blocked. Provider source is never auto-translated between languages.`);
        }
        providers.push(owner);
    };
    for (const plan of model.nodePlans) {
        for (const contribution of [...plan.algebraic, ...plan.contributions]) visit(contribution);
        if (plan.nodeProvider) {
            if (kind === 'cpp') throw new Error(`The computational-node provider on node "${plan.node.name}" has no C++ equivalent in the engine -- export to C++ is blocked for this model.`);
            visit(plan.nodeProvider);
        }
    }
    return providers;
}

export function stripLeadingCppInclude(source) {
    return source.replace(/^#include\s*<konjugate\/relationshipProvider\.hpp>\s*\n/, '');
}

function pythonProviderClassName(source, entityLabel) {
    const match = source.match(/^class\s+(\w+)\s*\(\s*(RelationshipProvider|NodeProvider)\s*\)\s*:/m);
    if (!match) throw new Error(`Could not find a class implementing RelationshipProvider or NodeProvider in the provider source for the ${entityLabel}.`);
    return { className: match[1], baseClassName: match[2], pattern: new RegExp(`\\bclass\\s+${match[1]}\\s*\\(`) };
}

const parallelismModes = ['serial', 'openmp', 'stdThread', 'mpi'];

export function generateStandaloneProgram(document, kind, options = {}) {
    if (kind !== 'cpp' && kind !== 'python') throw new Error(`Unknown export kind "${kind}" -- expected "cpp" or "python".`);
    const parallelism = options.parallelism ?? 'serial';
    if (!parallelismModes.includes(parallelism)) {
        throw new Error(`Unknown parallelism option "${parallelism}" -- expected one of ${parallelismModes.join(', ')}.`);
    }
    if (kind === 'python' && parallelism !== 'serial' && parallelism !== 'mpi') {
        throw new Error(`"${parallelism}" has no meaningful Python equivalent -- Python threads are GIL-bound and would not actually run this CPU-bound loop in parallel. Only "serial" and "mpi" are available for a Python export.`);
    }
    const runConfiguration = (document.runConfigurations ?? []).find((item) => item.id === document.activeRunConfigurationId) ?? document.runConfigurations?.[0];
    // The run configuration's method, refused by name when this version does not know it.
    const method = methodOf(runConfiguration);
    if (!integrationMethod(method)) throw new Error(`The run configuration's method “${method}” is not one this version of Konjugate can export.`);
    const wholeModel = method !== 'nodeByNode';
    const model = buildModel(document, { wholeModel });
    const providers = collectProviders(model, kind);
    // A program in the current format takes every stage of a whole-model method, which code export does not write yet.
    const currentFormat = providers.find((provider) => provider.program);
    if (wholeModel && currentFormat) {
        throw new Error(`The program of the ${currentFormat.entityLabel} is in the current program format, which code export cannot write under ${integrationMethod(method).name} yet -- export blocked.`);
    }
    if (wholeModel) {
        const nodeProvider = model.nodePlans.find((plan) => plan.nodeProvider);
        if (nodeProvider) throw new Error(`Node "${nodeProvider.node.name}" is a program of its own, which code export cannot write under ${integrationMethod(method).name} yet.`);
    }
    const globalTimeStep = runConfiguration?.globalTimeStep ?? 0.01;
    const outputInterval = runConfiguration?.outputInterval ?? globalTimeStep;
    // Event location, as the engine: under Runge–Kutta 4, Adaptive, Stiff and BDF (not Dormand–Prince or Rodas4 with the error control off).
    const locating = method === 'rungeKutta4' || method === 'bdf' || ((method === 'dormandPrince54' || method === 'rodas4') && !runConfiguration?.stepsPerGlobalStep);
    const switching = locating ? latchConditions(model) : [];
    const meta = {
        switching,
        globalTimeStep, outputInterval, defaultTargetTime: document.exportDefaultTargetTime ?? 1, parallelism, method, stepsPerGlobalStep: stepsPerGlobalStepOf(runConfiguration),
        // Adaptive (Dormand–Prince 5(4)): its tolerances, every state's absolute one (its own where it sets one), and its fixed steps,
        // when a run configuration turns its error control off with steps per global step (0: the error control chooses).
        // Stiff (Rodas4) the same, with what its Jacobian is built from: the states each state's derivative reads, and whether a stage
        // reads the time.
        ...(method === 'dormandPrince54' || method === 'rodas4' || method === 'bdf' ? {
            tolerance: toleranceOf(runConfiguration),
            absoluteTolerances: absoluteTolerancesOf(model, toleranceOf(runConfiguration).absolute),
            fixedSteps: runConfiguration?.stepsPerGlobalStep ?? 0
        } : {}),
        ...(method === 'rodas4' || method === 'bdf' ? { stageReads: stageReadsOf(model), stagesReadTime: stagesReadTime(model) } : {})
    };
    // The stiff methods' Jacobian exactly, from the equations' derivatives, unless the run asks for finite differences.
    if (meta.stageReads) meta.exactJacobian = exactJacobianOf(model, meta.stageReads, runConfiguration?.jacobian);
    return kind === 'cpp' ? generateCpp(model, providers, meta, document) : generatePython(model, providers, meta, document);
}

// The comment lines naming the project's owner, copyright and license (the `ownership` block the host puts on the exported document,
// docs/proposals/modelOwnership.md), or nothing when the project names none. Each ends in a newline, so it can sit inside the header.
function ownershipNotice(document, commentPrefix) {
    const lines = exportNoticeLines(document.ownership);
    return lines.length ? `${lines.map((line) => `${commentPrefix}${line.replace(/[\r\n]+/g, ' ')}`).join('\n')}\n` : '';
}

// A Python string literal's contents for `text`, in ASCII alone: every other character as a \u or \U escape, which
// Python reads back as the character itself, so what the program writes is unchanged. The header names every state on
// one line, and Python 3.9 (still the system Python on macOS) refuses a source line of several thousand bytes with a
// non-ASCII character in it ("Non-UTF-8 code"), which every header has: the dash between a node's name and a state's.
function pythonStringContents(text) {
    return [...text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')].map((character) => {
        const code = character.codePointAt(0);
        if (code < 0x80) return character;
        return code > 0xffff ? `\\U${code.toString(16).padStart(8, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
    }).join('');
}

function csvHeader(model) {
    const columns = ['time (s)'];
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) columns.push(`${plan.node.name} — ${state.name}${state.unit ? ` (${state.unit})` : ''}`);
    }
    return columns.map(csvField).join(',');
}

function stateIndexComment(model, commentPrefix) {
    const lines = [];
    let index = 0;
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) {
            lines.push(`${commentPrefix} snapshot[${index}] / globalState[${index}] = ${plan.node.name}.${state.name}${state.unit ? ` (${state.unit})` : ''}`);
            index += 1;
        }
    }
    return lines.join('\n');
}

function cppRunInstructionLines(parallelism, marker) {
    if (parallelism === 'openmp') {
        return [
            `${marker}How to run this program (OpenMP -- parallel across nodes on one machine):`,
            `${marker}  1. Compile it:`,
            `${marker}       Linux:   c++ -std=c++20 -O2 -fopenmp <this file> -o simulation`,
            `${marker}       macOS:   Xcode's clang++ has no bundled OpenMP -- run "brew install libomp"`,
            `${marker}                once, then (libomp is keg-only, so -I/-L must point at it explicitly):`,
            `${marker}                c++ -std=c++20 -O2 -Xpreprocessor -fopenmp \\`,
            `${marker}                    -I"$(brew --prefix libomp)/include" -L"$(brew --prefix libomp)/lib" -lomp \\`,
            `${marker}                    <this file> -o simulation`,
            `${marker}       Windows: cl /std:c++20 /O2 /openmp <this file>`,
            `${marker}  2. Run it (OMP_NUM_THREADS controls the worker count, e.g. OMP_NUM_THREADS=4):`,
            `${marker}       macOS/Linux: ./simulation`,
            `${marker}       Windows:     simulation.exe`
        ];
    }
    if (parallelism === 'stdThread') {
        return [
            `${marker}How to run this program (std::thread -- parallel across nodes on one machine):`,
            `${marker}  1. Compile it:`,
            `${marker}       macOS/Linux: c++ -std=c++20 -O2 -pthread <this file> -o simulation`,
            `${marker}       Windows (Developer Command Prompt for VS): cl /std:c++20 /O2 <this file>`,
            `${marker}  2. Run it:`,
            `${marker}       macOS/Linux: ./simulation`,
            `${marker}       Windows:     simulation.exe`
        ];
    }
    if (parallelism === 'mpi') {
        return [
            `${marker}How to run this program (MPI -- distributed across ranks/machines):`,
            `${marker}  Needs an MPI implementation installed (e.g. OpenMPI or MPICH).`,
            `${marker}  1. Compile it:  mpic++ -std=c++20 -O2 <this file> -o simulation`,
            `${marker}  2. Run it with the desired number of ranks: mpirun -n 4 ./simulation`,
            `${marker}  Nodes are split into contiguous blocks across ranks by node count, not by`,
            `${marker}  estimated work -- a simple partition, unlike the engine's own METIS/`,
            `${marker}  communication-aware partitioner. Only rank 0 writes the output file.`
        ];
    }
    return [
        `${marker}How to run this program:`,
        `${marker}  1. Compile it:`,
        `${marker}       macOS/Linux (clang or gcc): c++ -std=c++20 -O2 <this file> -o simulation`,
        `${marker}       Windows (Developer Command Prompt for VS): cl /std:c++20 /O2 <this file>`,
        `${marker}  2. Run it:`,
        `${marker}       macOS/Linux: ./simulation`,
        `${marker}       Windows:     simulation.exe`
    ];
}

function pythonRunInstructionLines(parallelism, marker) {
    if (parallelism === 'mpi') {
        return [
            `${marker}How to run this program (MPI -- distributed across ranks/machines):`,
            `${marker}  Needs mpi4py ("pip install mpi4py") and a system MPI implementation (e.g.`,
            `${marker}  OpenMPI or MPICH) -- mpi4py links against whichever MPI your "mpirun" points to.`,
            `${marker}  Run it with the desired number of ranks: mpirun -n 4 python3 <this file>`,
            `${marker}  Nodes are split into contiguous blocks across ranks by node count, not by`,
            `${marker}  estimated work -- a simple partition, unlike the engine's own METIS/`,
            `${marker}  communication-aware partitioner. Only rank 0 writes the output file.`
        ];
    }
    return [
        `${marker}How to run this program:`,
        `${marker}  macOS/Linux: python3 <this file>`,
        `${marker}  Windows:     python <this file>`
    ];
}

function runInstructions(kind, meta, marker) {
    const lines = kind === 'cpp' ? cppRunInstructionLines(meta.parallelism ?? 'serial', marker) : pythonRunInstructionLines(meta.parallelism ?? 'serial', marker);
    lines.push(
        `${marker}Optional flags on either platform: --target-time <seconds> (default ${doubleLiteral(meta.defaultTargetTime)}), --output <path> (default results.csv)`
    );
    return lines.join('\n');
}

function initialStateLiterals(model) {
    return Array.from(model.stateRecord.values()).map((record) => doubleLiteral(record.state.initialValue ?? 0)).join(', ');
}

// Prefix sums of per-node state counts, e.g. node state counts [1, 2, 1] -> [0, 1, 3, 4]: node i
// owns global state indices [offsets[i], offsets[i + 1]). Only used by MPI's dispatch, where it is
// what makes a single contiguous-block partition (by node order) correspond to a contiguous
// global-state-index range per rank, which is what lets one MPI_Allgatherv reconcile the whole
// state vector each step instead of needing an indexed/scattered exchange.
function nodeStateOffsetLiterals(model) {
    const offsets = [0];
    let running = 0;
    for (const plan of model.nodePlans) {
        running += plan.node.states.length;
        offsets.push(running);
    }
    return offsets.join(', ');
}

function commentLines(symbols, prefix, marker) {
    return Array.from(symbols, ([key, value]) => `${prefix}${marker} ${key} <- ${value.comment}`);
}

// ---- C++ ----

export function emitCppRegularContribution(contribution) {
    const expression = emitExpression(compileExpressionNode(contribution.mathJson), symbolTexts(contribution.symbols, 'cpp'), cppOperators);
    return [
        '        {',
        ...commentLines(contribution.symbols, '            ', '//'),
        `            double contributionValue = ${expression};`,
        contribution.negate ? '            contributionValue = -contributionValue;' : '',
        '            if (!std::isfinite(contributionValue)) throw std::runtime_error("A contribution produced a non-finite derivative.");',
        `            derivative[${contribution.outputLocalIndex}] += contributionValue;`,
        '        }'
    ].filter(Boolean).join('\n');
}

// An algebraic state is a plain replacement: g(x, t) from the node's states at one instant.
export function emitCppAlgebraicTask(task, info) {
    const lines = ['        {', ...commentLines(task.symbols, '            ', '//')];
    if (task.program) {
        lines.push(...cppProgramCall(task, info, 'algebraicTime', 'algebraicValue', false));
    } else if (task.implementation) {
        const keys = Array.from(task.symbols.keys());
        const values = keys.map((key) => task.symbols.get(key).text).join(', ') || '0.0';
        const keyLiterals = keys.map((key) => `std::string_view("${key}")`).join(', ') || 'std::string_view("")';
        lines.push(
            `            const double inputValues[] = { ${values} };`,
            `            const std::string_view inputKeys[] = { ${keyLiterals} };`,
            '            konjugate::sdk::v1::OutputCollector outputCollector;',
            `            ${info.instanceVariable}->evaluate({algebraicTime, nodeTimeStep, konjugate::sdk::v1::InputView(inputValues, inputKeys)}, outputCollector);`,
            '            const double algebraicValue = outputCollector.gradient();'
        );
    } else {
        lines.push(`            const double algebraicValue = ${emitExpression(compileExpressionNode(task.mathJson), symbolTexts(task.symbols, 'cpp'), cppOperators)};`);
    }
    lines.push(
        '            if (!std::isfinite(algebraicValue)) throw std::runtime_error("An algebraic source term produced a non-finite value.");',
        `            state[${task.outputLocalIndex}] = algebraicValue;`,
        '        }'
    );
    return lines.join('\n');
}

// A node's Update (setsValue) states hold their values from the step's start through all of its
// substeps, and are worked out once after its last update, from the states the step reached at the
// step's end time -- as the engine's applyUpdates does (docs/proposals/ratesAndUpdates.md) -- so what
// the node hands back (and other nodes read next step) agrees with its states.
export function cppAlgebraicLines(plan, providerInfo) {
    if (!plan.algebraic.length) return '';
    const tasks = plan.algebraic.map((task) => emitCppAlgebraicTask(task, providerInfo.get(task))).join('\n');
    return ['        {', '            // After the last update: the value handed back with the states.', '            const double algebraicTime = currentTime + globalTimeStep;', tasks, '        }'].join('\n');
}

// Before the first step the engine computes every algebraic state once from the initial states, so
// the first row (and what other nodes read in step 0) agrees with the other initial values, even
// when a parameter it uses was edited after the stored initial value was written.
function cppSettleLines(model, providerInfo) {
    const blocks = model.nodePlans.filter((plan) => plan.algebraic.length).map((plan) => {
        const seed = plan.node.states.map((state) => `globalState[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const commitLines = plan.node.states.map((state, index) => (
            `        globalState[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`
        )).join('\n');
        return [
            `    // Settle algebraic states: ${plan.node.name}`,
            '    {',
            '        const std::vector<double>& snapshot = globalState;',
            `        double state[${plan.node.states.length}] = { ${seed} };`,
            `        const double nodeTimeStep = globalTimeStep / ${plan.substeps}.0;`,
            '        const double algebraicTime = 0.0;',
            plan.algebraic.map((task) => emitCppAlgebraicTask(task, providerInfo.get(task))).join('\n'),
            commitLines,
            '    }'
        ].join('\n');
    });
    return blocks.length ? blocks.join('\n') : null;
}

// A version 2 program's call (docs/proposals/programSdkV2.md): its inputs in its declaration order, converted at the port, its evaluate()
// given the time and nothing else, its output converted into the state's unit.
function cppProgramCall(task, info, timeName, valueName, rate) {
    const { values, output } = programCall(task, task.program, 'cpp', task.outputUnit, rate);
    return [
        values.length ? `            const double programInputs[] = { ${values.join(', ')} };` : '            const double* programInputs = nullptr;',
        `            double ${valueName} = static_cast<const konjugate::sdk::v2::Relationship&>(*${info.instanceVariable}).evaluate(${timeName}, konjugate::sdk::v2::Inputs(programInputs, nullptr, nullptr));`,
        output ? `            ${valueName} = ${valueName} * ${output.scale} + ${output.offset};` : ''
    ].filter(Boolean);
}

export function emitCppProviderContribution(contribution, info) {
    if (contribution.program) {
        return [
            '        {',
            ...commentLines(contribution.symbols, '            ', '//'),
            ...cppProgramCall(contribution, info, 'stepTime', 'contributionValue', true),
            contribution.negate ? '            contributionValue = -contributionValue;' : '',
            '            if (!std::isfinite(contributionValue)) throw std::runtime_error("A contribution produced a non-finite derivative.");',
            `            derivative[${contribution.outputLocalIndex}] += contributionValue;`,
            '        }'
        ].filter(Boolean).join('\n');
    }
    const keys = Array.from(contribution.symbols.keys());
    const values = keys.map((key) => contribution.symbols.get(key).text).join(', ') || '0.0';
    const keyLiterals = keys.map((key) => `std::string_view("${key}")`).join(', ') || 'std::string_view("")';
    return [
        '        {',
        ...commentLines(contribution.symbols, '            ', '//'),
        `            const double inputValues[] = { ${values} };`,
        `            const std::string_view inputKeys[] = { ${keyLiterals} };`,
        '            konjugate::sdk::v1::OutputCollector outputCollector;',
        `            ${info.instanceVariable}->evaluate({stepTime, nodeTimeStep, konjugate::sdk::v1::InputView(inputValues, inputKeys)}, outputCollector);`,
        '            double contributionValue = outputCollector.gradient();',
        contribution.negate ? '            contributionValue = -contributionValue;' : '',
        '            if (!std::isfinite(contributionValue)) throw std::runtime_error("A contribution produced a non-finite derivative.");',
        `            derivative[${contribution.outputLocalIndex}] += contributionValue;`,
        '        }'
    ].filter(Boolean).join('\n');
}

// Every parallelism mode calls the same per-node lambda body -- only how (and which subset of)
// nodes get called differs. Correctness relies on each lambda touching disjoint globalState
// indices (confirmed: a node's commit lines only ever write its own states' global indices), so
// running them concurrently (openmp/stdThread) or on separate processes (mpi) needs no locking.
function cppNodeIntegratorLambdas(model, providerInfo) {
    return model.nodePlans.map((plan, nodeIndex) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const emitContribution = (contribution) => (contribution.implementation
            ? emitCppProviderContribution(contribution, providerInfo.get(contribution))
            : emitCppRegularContribution(contribution));
        const commitLines = plan.node.states.map((state, index) => (
            `        globalState[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`
        )).join('\n');
        return [
            `    // Node: ${plan.node.name}`,
            `    const auto integrateNode${nodeIndex} = [&]() {`,
            `        double state[${stateCount}] = { ${seed} };`,
            cppNodeSubstepLines(plan, emitContribution),
            cppAlgebraicLines(plan, providerInfo),
            commitLines,
            '    };'
        ].join('\n');
    }).join('\n');
}

function cppDispatchLines(parallelism) {
    if (parallelism === 'openmp') {
        return [
            '        #pragma omp parallel for',
            '        for (int nodeIndex = 0; nodeIndex < nodeCount; ++nodeIndex) nodeIntegrators[static_cast<std::size_t>(nodeIndex)]();'
        ];
    }
    if (parallelism === 'stdThread') {
        return [
            '        // Spawns and joins a thread per node every step -- the simplest correct approach.',
            '        // A persistent worker pool would avoid the repeated spawn cost; left as a possible',
            '        // follow-up rather than obscuring the reference logic here.',
            '        std::vector<std::thread> workers;',
            '        workers.reserve(nodeIntegrators.size());',
            '        for (const auto& integrate : nodeIntegrators) workers.emplace_back(integrate);',
            '        for (auto& worker : workers) worker.join();'
        ];
    }
    if (parallelism === 'mpi') {
        return [
            '        for (int nodeIndex = myNodeStart; nodeIndex < myNodeEnd; ++nodeIndex) nodeIntegrators[static_cast<std::size_t>(nodeIndex)]();',
            '        MPI_Allgatherv(MPI_IN_PLACE, 0, MPI_DATATYPE_NULL, globalState.data(), recvCounts.data(), displacements.data(), MPI_DOUBLE, MPI_COMM_WORLD);'
        ];
    }
    return ['        for (const auto& integrate : nodeIntegrators) integrate();'];
}

// Splits nodes into contiguous, evenly-sized-by-node-count blocks across MPI ranks, computed at
// runtime since the rank count is an `mpirun -n` choice, not known at generation time. Contiguous
// blocks mean each rank's owned states are also one contiguous global-index range (global indices
// are assigned in node order), which is what lets one MPI_Allgatherv reconcile the full state
// vector -- every rank derives the same recvCounts/displacements independently, no extra
// coordination message needed.
function mpiSetupLines(model) {
    return [
        '    int worldRank = 0;',
        '    int worldSize = 1;',
        '    MPI_Comm_rank(MPI_COMM_WORLD, &worldRank);',
        '    MPI_Comm_size(MPI_COMM_WORLD, &worldSize);',
        `    constexpr std::size_t nodeStateOffsets[] = { ${nodeStateOffsetLiterals(model)} };`,
        '    const int nodesPerRank = (nodeCount + worldSize - 1) / worldSize;',
        '    const int myNodeStart = std::min(worldRank * nodesPerRank, nodeCount);',
        '    const int myNodeEnd = std::min(myNodeStart + nodesPerRank, nodeCount);',
        '    std::vector<int> recvCounts(static_cast<std::size_t>(worldSize));',
        '    std::vector<int> displacements(static_cast<std::size_t>(worldSize));',
        '    for (int rank = 0; rank < worldSize; ++rank) {',
        '        const int rankNodeStart = std::min(rank * nodesPerRank, nodeCount);',
        '        const int rankNodeEnd = std::min(rankNodeStart + nodesPerRank, nodeCount);',
        '        displacements[static_cast<std::size_t>(rank)] = static_cast<int>(nodeStateOffsets[static_cast<std::size_t>(rankNodeStart)]);',
        '        recvCounts[static_cast<std::size_t>(rank)] = static_cast<int>(nodeStateOffsets[static_cast<std::size_t>(rankNodeEnd)] - nodeStateOffsets[static_cast<std::size_t>(rankNodeStart)]);',
        '    }'
    ].join('\n');
}

// ---- Runge–Kutta 4, the whole model at once (docs/proposals/integrators.md) ----

// The node's states a stage adds a rate to (those its Rate terms reach), as local indexes, in order.
function integratedLocalIndexes(plan) {
    return [...new Set(plan.contributions.map((contribution) => contribution.outputLocalIndex))].sort((left, right) => left - right);
}

// Per state of the model, whether the method integrates it: 1, or 0 for a state that holds through the stages.
function integratedFlags(model) {
    const flags = new Array(model.globalStateCount).fill(0);
    for (const plan of model.nodePlans) {
        for (const local of integratedLocalIndexes(plan)) flags[model.stateRecord.get(plan.node.states[local].id).globalIndex] = 1;
    }
    return flags;
}

// A term written as a program, at a stage: evaluated once, at the global step's start (the first stage of its first step), with the
// global step as its step, and held through the stages -- as the engine holds a program (docs/proposals/integrators.md, Programs).
function emitCppStageProviderContribution(contribution, info) {
    const keys = Array.from(contribution.symbols.keys());
    const values = keys.map((key) => contribution.symbols.get(key).text).join(', ') || '0.0';
    const keyLiterals = keys.map((key) => `std::string_view("${key}")`).join(', ') || 'std::string_view("")';
    return [
        '        {',
        ...commentLines(contribution.symbols, '            ', '//'),
        '            if (stageStep == 0 && stageIndex == 0) {',
        `                const double inputValues[] = { ${values} };`,
        `                const std::string_view inputKeys[] = { ${keyLiterals} };`,
        '                konjugate::sdk::v1::OutputCollector outputCollector;',
        `                ${info.instanceVariable}->evaluate({stepTime, globalTimeStep, konjugate::sdk::v1::InputView(inputValues, inputKeys)}, outputCollector);`,
        '                double contributionValue = outputCollector.gradient();',
        contribution.negate ? '                contributionValue = -contributionValue;' : '',
        '                if (!std::isfinite(contributionValue)) throw std::runtime_error("A contribution produced a non-finite derivative.");',
        `                heldValue[${info.index}] = contributionValue;`,
        '            }',
        `            derivative[${contribution.outputLocalIndex}] += heldValue[${info.index}];`,
        '        }'
    ].filter(Boolean).join('\n');
}

// Each node's rates at a stage, from the stage's states: its own read as `state`, the others' as `snapshot`, both the same stage values.
function cppStageLambdas(model, providerInfo) {
    return model.nodePlans.map((plan, nodeIndex) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const contributionLines = plan.contributions.map((contribution) => (
            contribution.implementation ? emitCppStageProviderContribution(contribution, providerInfo.get(contribution)) : emitCppRegularContribution(contribution)
        )).join('\n');
        const rateLines = integratedLocalIndexes(plan).map((local) => (
            `        rates[${model.stateRecord.get(plan.node.states[local].id).globalIndex}] = derivative[${local}];`
        )).join('\n');
        return [
            `    // Node: ${plan.node.name}`,
            `    const auto stageNode${nodeIndex} = [&]() {`,
            '        [[maybe_unused]] const std::vector<double>& snapshot = *stageStates;',
            '        [[maybe_unused]] std::vector<double>& rates = *stageRates;',
            `        [[maybe_unused]] double state[${stateCount}] = { ${seed} };`,
            '        [[maybe_unused]] const double nodeTimeStep = globalTimeStep / static_cast<double>(stepsPerGlobalStep);',
            `        [[maybe_unused]] double derivative[${stateCount}] = {};`,
            contributionLines,
            rateLines,
            '    };'
        ].filter(Boolean).join('\n');
    }).join('\n');
}

// After the method's steps, as after the engine's: each node's values set from the states it reached, at the step's end.
function cppWholeModelUpdateLines(model, providerInfo) {
    return model.nodePlans.filter((plan) => plan.algebraic.length).map((plan) => [
        `        // Updates: ${plan.node.name}`,
        '        {',
        `            double state[${plan.node.states.length}] = { ${plan.node.states.map((state) => `globalState[${model.stateRecord.get(state.id).globalIndex}]`).join(', ')} };`,
        '            [[maybe_unused]] const double nodeTimeStep = globalTimeStep / static_cast<double>(stepsPerGlobalStep);',
        cppAlgebraicLines(plan, providerInfo).split('\n').map((line) => `    ${line}`).join('\n'),
        ...plan.node.states.map((state, index) => `            globalState[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`),
        '        }'
    ].join('\n'));
}

// Every state's absolute tolerance under Adaptive, in the program's state order: its own (numerics.absoluteTolerance) or the run's.
function absoluteTolerancesOf(model, runAbsolute) {
    const tolerances = new Array(model.globalStateCount).fill(runAbsolute);
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) {
            const own = state.numerics?.absoluteTolerance;
            if (own !== undefined) tolerances[model.stateRecord.get(state.id).globalIndex] = own;
        }
    }
    return tolerances;
}

// Under Stiff, per state of the model, the states its derivative reads at a stage, as the engine works them out (stageReads in
// engine/src/wholeModelIntegration.cpp): every state an equation into it uses. A program is held through the stages (a version 1
// program is never known to be pure), so it reads none. The Jacobian's pattern is built from these.
function stageReadsOf(model) {
    const reads = Array.from({ length: model.globalStateCount }, () => []);
    for (const plan of model.nodePlans) {
        for (const contribution of plan.contributions) {
            if (contribution.implementation) continue;
            const output = model.stateRecord.get(plan.node.states[contribution.outputLocalIndex].id).globalIndex;
            for (const stateId of contribution.boundStateIds) reads[output].push(model.stateRecord.get(stateId).globalIndex);
        }
    }
    return reads.map((list) => [...new Set(list)].sort((left, right) => left - right));
}

// The stiff methods' exact Jacobian (docs/proposals/integrators.md, Jacobians for Rodas4 and BDF), as compileJacobianPlan in
// engine/src/jacobianAssembly.cpp works it out: every equation into an integrated state differentiated (src/expressionDerivative.mjs)
// with respect to each state it binds and the time, node by node, each node's terms in order, each term's bindings in order, each
// derivative added into its entry of the Jacobian (laid out as makeStiffSystem lays it out) or of df/dt. A program is held through the
// stages here, so no column is left to finite differences. df/dt is exact unless a parameter that follows a stored schedule is
// differentiated through. Null when the run asks for finite differences.
function exactJacobianOf(model, stageReads, jacobianMethod) {
    if (jacobianMethod === 'finiteDifference') return null;
    const integrated = integratedFlags(model);
    const position = [];
    let count = 0;
    integrated.forEach((flag, index) => { position[index] = flag ? count++ : -1; });
    const rows = [];
    integrated.forEach((flag, index) => {
        if (!flag) return;
        const columns = new Set([position[index]]);
        for (const read of stageReads[index] ?? []) if (position[read] >= 0) columns.add(position[read]);
        rows.push([...columns].sort((left, right) => left - right));
    });
    const rowStart = [0];
    rows.forEach((columns) => rowStart.push(rowStart.at(-1) + columns.length));
    const entryOf = (row, column) => {
        const found = rows[row].indexOf(column);
        if (found < 0) throw new Error('A derivative falls outside the Jacobian\'s pattern.');
        return rowStart[row] + found;
    };
    let scheduled = false;
    const nodes = model.nodePlans.map((plan) => {
        const terms = [];
        const timeTerms = [];
        for (const contribution of plan.contributions) {
            if (contribution.implementation) continue;
            const row = position[model.stateRecord.get(plan.node.states[contribution.outputLocalIndex].id).globalIndex];
            if (!(row >= 0)) continue;
            const compiled = compileExpressionNode(contribution.mathJson);
            for (const [key, symbol] of contribution.symbols) {
                if (symbol.parameter) {
                    if (symbol.schedule !== undefined && differentiateNode(compiled, key)) scheduled = true;
                    continue;
                }
                const time = symbol.time !== undefined;
                if (!time && !(position[symbol.globalIndex] >= 0)) continue;
                const derivative = differentiateNode(compiled, key);
                if (!derivative) continue;
                (time ? timeTerms : terms).push({ contribution, expression: derivative, negate: contribution.negate,
                    target: time ? row : entryOf(row, position[symbol.globalIndex]) });
            }
        }
        return { plan, terms, timeTerms };
    });
    return { nodes, exactTime: !scheduled };
}

// The exact Jacobian in C++: a lambda per node adding its terms' derivatives, read from the node's states as its stage reads them, and
// the system told to take its columns from them (stiffSystem.hpp's exact). Each derivative is a statement of its own, then added, as the
// engine adds it, so no compiler fuses the two.
function cppExactJacobianLines(model, exactJacobian) {
    if (!exactJacobian) return [];
    const lambdas = [];
    const calls = [];
    exactJacobian.nodes.forEach(({ plan, terms, timeTerms }, nodeIndex) => {
        if (!terms.length && !timeTerms.length) return;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const termLines = (list, into, indent) => list.flatMap((term) => [
            `${indent}{`,
            `${indent}    const double value = ${emitExpression(term.expression, symbolTexts(term.contribution.symbols, 'cpp'), cppOperators)};`,
            `${indent}    ${into}[${term.target}] += ${term.negate ? '-value' : 'value'};`,
            `${indent}}`
        ]);
        lambdas.push([
            `    // Node: ${plan.node.name}`,
            `    const auto jacobianNode${nodeIndex} = [&]() {`,
            '        [[maybe_unused]] const std::vector<double>& snapshot = *stageStates;',
            `        [[maybe_unused]] double state[${plan.node.states.length}] = { ${seed} };`,
            '        [[maybe_unused]] const double nodeTimeStep = globalTimeStep / static_cast<double>(stepsPerGlobalStep);',
            ...termLines(terms, '(*jacobianEntries)', '        '),
            ...(timeTerms.length ? ['        if (jacobianTime) {', ...termLines(timeTerms, '(*jacobianTime)', '            '), '        }'] : []),
            '    };'
        ].join('\n'));
        calls.push(`        jacobianNode${nodeIndex}();`);
    });
    return [
        '    // The Jacobian exactly, from every equation\'s derivatives, as the engine works it out (docs/proposals/integrators.md, Jacobians',
        '    // for Rodas4 and BDF): no column is left to finite differences.',
        '    std::vector<double>* jacobianEntries = nullptr;',
        '    std::vector<double>* jacobianTime = nullptr;',
        ...lambdas,
        '    konjugate::integrators::useExactColumns(system, std::vector<unsigned char>(system.integratedStates.size(), 1));',
        `    system.exactTime = ${exactJacobian.exactTime};`,
        '    system.exact = [&](double time, const std::vector<double>& states, std::vector<double>& jacobian, std::vector<double>* dT) {',
        '        stepTime = time;',
        '        stageStates = &states;',
        '        jacobianEntries = &jacobian;',
        '        jacobianTime = dT;',
        '        std::fill(jacobian.begin(), jacobian.end(), 0.0);',
        '        if (dT) std::fill(dT->begin(), dT->end(), 0.0);',
        ...calls,
        '    };'
    ];
}

// The same in Python: one function adding every node's terms.
function pythonExactJacobianLines(model, exactJacobian) {
    if (!exactJacobian) return [];
    const body = [];
    exactJacobian.nodes.forEach(({ plan, terms, timeTerms }) => {
        if (!terms.length && !timeTerms.length) return;
        body.push(`        # Node: ${plan.node.name}`, `        state = [${plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ')}]`);
        for (const term of terms) {
            body.push(`        value = ${emitExpression(term.expression, symbolTexts(term.contribution.symbols, 'python'), pythonOperators)}`,
                `        jacobian[${term.target}] += ${term.negate ? '-value' : 'value'}`);
        }
        if (timeTerms.length) {
            body.push('        if d_t is not None:');
            for (const term of timeTerms) {
                body.push(`            value = ${emitExpression(term.expression, symbolTexts(term.contribution.symbols, 'python'), pythonOperators)}`,
                    `            d_t[${term.target}] += ${term.negate ? '-value' : 'value'}`);
            }
        }
    });
    return [
        "    # The Jacobian exactly, from every equation's derivatives, as the engine works it out: no column is left to finite differences.",
        '    def exact_jacobian(step_time, snapshot, jacobian, d_t):',
        '        node_time_step = global_time_step / steps_per_global_step',
        '        for index in range(len(jacobian)):',
        '            jacobian[index] = 0.0',
        '        if d_t is not None:',
        '            for index in range(len(d_t)):',
        '                d_t[index] = 0.0',
        ...body,
        '',
        '    use_exact_columns(system, [1] * len(system.integrated_states))',
        `    system.exact_time = ${exactJacobian.exactTime ? 'True' : 'False'}`,
        '    system.exact = exact_jacobian'
    ];
}

// Whether an equation evaluated at stages uses the time, or a parameter that follows a stored schedule: then Stiff works out df/dt.
function stagesReadTime(model) {
    return model.nodePlans.some((plan) => plan.contributions.some((contribution) => {
        if (contribution.implementation) return false;
        const used = mathJsonSymbols(contribution.mathJson);
        return [...contribution.symbols].some(([key, symbol]) => used.has(key) && (symbol.time !== undefined || symbol.schedule !== undefined));
    }));
}

// The integrated states node by node, each node's in its order: the order the engine sums Adaptive's error norm in.
function errorGroupsOf(model) {
    return model.nodePlans.map((plan) => integratedLocalIndexes(plan).map((local) => model.stateRecord.get(plan.node.states[local].id).globalIndex));
}

// Every stage dispatched to the nodes as a step is under Euler, in each parallelism mode; under MPI each rank works out its own nodes'
// rates and the ranks gather them, so every rank combines the same stages.
function cppStageDispatchLines(parallelism) {
    if (parallelism === 'mpi') {
        return [
            '        for (int nodeIndex = myNodeStart; nodeIndex < myNodeEnd; ++nodeIndex) nodeIntegrators[static_cast<std::size_t>(nodeIndex)]();',
            '        MPI_Allgatherv(MPI_IN_PLACE, 0, MPI_DATATYPE_NULL, rates.data(), recvCounts.data(), displacements.data(), MPI_DOUBLE, MPI_COMM_WORLD);'
        ];
    }
    return cppDispatchLines(parallelism);
}

// The switching functions, node by node, each g = left - right from its term's symbols at (time, states), and the conditions' latches
// with the events located (events.hpp's Switching), for the stage terms to read.
function cppSwitchingLines(model, functions) {
    if (!functions.length) return [];
    const byNode = new Map();
    functions.forEach((fn, index) => {
        if (!byNode.has(fn.nodeIndex)) byNode.set(fn.nodeIndex, []);
        byNode.get(fn.nodeIndex).push([fn, index]);
    });
    const blocks = [...byNode].map(([nodeIndex, entries]) => {
        const plan = model.nodePlans[nodeIndex];
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        return [
            `        {   // Node: ${plan.node.name}`,
            `            [[maybe_unused]] double state[${plan.node.states.length}] = { ${seed} };`,
            ...entries.map(([fn, index]) => {
                const texts = symbolTexts(fn.symbols, 'cpp');
                return `            values[${index}] = ${emitExpression(compileExpressionNode(fn.left), texts, cppOperators)} - ${emitExpression(compileExpressionNode(fn.right), texts, cppOperators)};`;
            }),
            '        }'
        ].join('\n');
    });
    return [
        '    // Event location (docs/proposals/integrators.md): each comparison of a condition in a Rate equation, g = a - b, watched; the',
        '    // terms read the condition latched through each step, and a step that crosses a switch is retaken to end on it.',
        '    const auto evaluateSwitching = [&](double time, const std::vector<double>& snapshot, std::vector<double>& values) {',
        '        [[maybe_unused]] const double stepTime = time;',
        ...blocks,
        '    };',
        `    konjugate::integrators::Switching<std::function<void(double, const std::vector<double>&, std::vector<double>&)>> switching(evaluateSwitching, { ${functions.map((fn) => fn.comparison).join(', ')} });`
    ];
}

// FMU export under Stiff (src/fmiCodeGen.mjs): what fmi2DoStep needs to take one global step as the engine takes it, Rodas4 or BDF,
// with the same stages, Jacobian, event location and Updates as the plain C++ export. The solver's memory between steps -- Rodas4's
// controller, BDF's table, the conditions' latches -- lives in the model's members; everything else is set up again at each step.
// Returns the integrator headers to paste in, the members, and the body of doStep(currentTime, globalTimeStep).
export function cppStiffFmuPieces(model, providers, providerInfo, runConfiguration) {
    const method = methodOf(runConfiguration);
    const bdf = method === 'bdf';
    const fixedSteps = bdf ? 0 : runConfiguration?.stepsPerGlobalStep ?? 0;
    const switching = bdf || !fixedSteps ? latchConditions(model) : [];
    const located = switching.length > 0;
    const tolerance = toleranceOf(runConfiguration);
    const absoluteTolerances = absoluteTolerancesOf(model, tolerance.absolute);
    const stageReads = stageReadsOf(model);
    const exactJacobian = exactJacobianOf(model, stageReads, runConfiguration?.jacobian);
    const headers = [
        `${linearSolveCpp.replace(/^#pragma once\n/m, '')}\n`,
        `${stiffSystemCpp.replace(/^#pragma once\n/m, '').replace(/^#include "linearSolve\.hpp"\n/m, '')}\n`,
        `${(bdf ? bdfCpp : rodas4Cpp).replace(/^#pragma once\n/m, '').replace(/^#include "linearSolve\.hpp"\n/m, '').replace(/^#include "stiffSystem\.hpp"\n/m, '')}\n`,
        located ? `${eventsCpp.replace(/^#pragma once\n/m, '')}\n` : ''
    ].join('');
    const members = [
        `    // ${bdf ? 'BDF' : 'Stiff'}: the solver's memory, carried from one global step to the next as the engine carries it.`,
        ...(bdf ? [
            '    konjugate::integrators::BdfHistory history_;',
            '    konjugate::integrators::BdfStatistics statistics_;',
            // The inputs the table was built under: a host that sets one between steps starts it again, as the engine does when a live
            // parameter changes.
            '    std::vector<double> bdfInputs_;'
        ] : [
            '    konjugate::integrators::Rodas4Controller controller_;',
            '    konjugate::integrators::Rodas4Statistics statistics_;'
        ]),
        ...(located ? [
            '    std::vector<double> latches_;',
            '    std::vector<unsigned char> armed_;',
            '    std::vector<double> scales_;',
            '    bool established_ = false;',
            ...(bdf ? ['    std::vector<double> bdfLatches_;'] : [])
        ] : [])
    ];
    const nodeIntegratorList = model.nodePlans.map((_plan, nodeIndex) => `stageNode${nodeIndex}`).join(', ');
    const body = [
        '        auto& globalState = state_;',
        '        constexpr std::size_t stepsPerGlobalStep = 1;',
        `        const std::vector<unsigned char> integrated = { ${integratedFlags(model).join(', ')} };`,
        providers.length ? `        double heldValue[${providers.length}] = {};` : null,
        '        const std::vector<double>* stageStates = nullptr;',
        '        std::vector<double>* stageRates = nullptr;',
        '        [[maybe_unused]] std::size_t stageStep = 0;',
        '        [[maybe_unused]] std::size_t stageIndex = 0;',
        '        double stepTime = 0;',
        ...cppSwitchingLines(model, switching).map((line) => `    ${line}`),
        ...(located ? [
            '        if (established_) {',
            '            switching.latches = latches_;',
            '            switching.armed = armed_;',
            '            switching.scales = scales_;',
            '            switching.established = true;',
            '        }'
        ] : []),
        ...cppStageLambdas(model, providerInfo).split('\n').map((line) => `    ${line}`),
        `        std::vector<std::function<void()>> nodeIntegrators = { ${nodeIntegratorList} };`,
        '        const auto evaluateStage = [&](std::size_t internalStep, std::size_t stage, double time, const std::vector<double>& states, std::vector<double>& rates) {',
        '            stageStep = internalStep;',
        '            stageIndex = stage;',
        '            stepTime = time;',
        '            stageStates = &states;',
        '            stageRates = &rates;',
        '            for (auto& integrateNode : nodeIntegrators) integrateNode();',
        '        };',
        `        const std::vector<std::vector<std::size_t>> errorGroups = { ${errorGroupsOf(model).map((group) => `{ ${group.join(', ')} }`).join(', ')} };`,
        `        const konjugate::integrators::${bdf ? 'BdfTolerance' : 'Rodas4Tolerance'} tolerance{ ${doubleLiteral(tolerance.relative)}, { ${absoluteTolerances.map(doubleLiteral).join(', ')} } };`,
        `        const std::vector<std::vector<std::size_t>> stageReads = { ${stageReads.map((reads) => `{ ${reads.join(', ')} }`).join(', ')} };`,
        '        auto system = konjugate::integrators::makeStiffSystem(integrated, stageReads, errorGroups);',
        ...cppExactJacobianLines(model, exactJacobian).map((line) => `    ${line}`),
        '        const auto evaluateAdaptive = [&](std::size_t evaluation, double time, const std::vector<double>& states, std::vector<double>& rates) {',
        '            evaluateStage(0, evaluation, time, states, rates);',
        '        };',
        '        const auto breakpointsWithin = [&](double from, double to) {',
        '            std::vector<double> times;',
        ...(model.schedules.length ? [
            '            for (const auto& schedule : parameterSchedules) {',
            '                for (std::size_t index = 0; index < schedule.count; ++index) {',
            '                    if (schedule.times[index] > from && schedule.times[index] < to) times.push_back(schedule.times[index]);',
            '                }',
            '            }'
        ] : []),
        '            std::sort(times.begin(), times.end());',
        '            const double gap = std::max(1e-9 * (to - from), 1e3 * std::numeric_limits<double>::epsilon() * std::max(std::abs(from), std::abs(to)));',
        '            std::vector<double> kept;',
        '            for (const double time : times) {',
        '                if (time - from <= gap || to - time <= gap) continue;',
        '                if (!kept.empty() && time - kept.back() <= gap) continue;',
        '                kept.push_back(time);',
        '            }',
        '            return kept;',
        '        };',
        '        const double endTime = currentTime + globalTimeStep;',
        located ? '        switching.beginGlobalStep(currentTime, globalState);' : null,
        ...(bdf ? [
            '        // The table starts again where a schedule turns a corner at this very instant, where a host set an input since the last',
            '        // step, and where a condition changed between steps, as the engine starts it.',
            '        const auto around = breakpointsWithin(currentTime - globalTimeStep, currentTime + globalTimeStep);',
            '        const std::vector<double> inputs = currentInputs();',
            '        const bool restart = std::any_of(around.begin(), around.end(), [&](double time) {',
            '            return std::abs(time - currentTime) <= std::max(1e-9 * globalTimeStep, 1e3 * std::numeric_limits<double>::epsilon() * std::abs(currentTime));',
            `        }) || inputs != bdfInputs_${located ? ' || (established_ && switching.latches != bdfLatches_)' : ''};`,
            `        konjugate::integrators::bdfGlobalStep${located ? 'WithEvents' : ''}(currentTime, endTime, globalState, system, tolerance, breakpointsWithin(currentTime, endTime), {}, restart,`,
            `            history_, statistics_,${located ? ' switching,' : ''} evaluateAdaptive, [](double, const std::vector<double>&) {});`,
            '        bdfInputs_ = inputs;',
            ...(located ? ['        bdfLatches_ = switching.latches;'] : [])
        ] : [
            `        constexpr std::size_t fixedSteps = ${fixedSteps};`,
            `        constexpr bool readsTime = ${stagesReadTime(model)};`,
            `        konjugate::integrators::rodas4GlobalStep${located ? 'WithEvents' : ''}(currentTime, endTime, globalState, system, tolerance,`,
            `            fixedSteps ? std::vector<double>{} : breakpointsWithin(currentTime, endTime), {}, fixedSteps, readsTime, controller_, statistics_,${located ? ' switching,' : ''}`,
            '            evaluateAdaptive, [](double, const std::vector<double>&) {});'
        ]),
        ...(located ? [
            '        latches_ = switching.latches;',
            '        armed_ = switching.armed;',
            '        scales_ = switching.scales;',
            '        established_ = true;'
        ] : []),
        ...cppWholeModelUpdateLines(model, providerInfo)
    ].filter((line) => line !== null);
    return { headers, members, body, bdf };
}

function cppWholeModelLoopLines(model, providers, providerInfo, meta) {
    const located = meta.switching?.length > 0;
    const nodeIntegratorList = model.nodePlans.map((_plan, nodeIndex) => `stageNode${nodeIndex}`).join(', ');
    const adaptive = meta.method === 'dormandPrince54';
    const bdf = meta.method === 'bdf';
    const stiff = meta.method === 'rodas4' || bdf;
    return [
        `    // ${integrationMethod(meta.method).summaryName}, the whole model at once: every node evaluated at each stage from every node's`,
        '    // stage values. Values set from other states (Updates) hold through the stages and are set at each global step\'s end.',
        // Under Adaptive and Stiff a program evaluated at stages is given the global step, as the engine gives it.
        `    constexpr std::size_t stepsPerGlobalStep = ${adaptive || stiff ? 1 : meta.stepsPerGlobalStep};`,
        `    const std::vector<unsigned char> integrated = { ${integratedFlags(model).join(', ')} };`,
        providers.length ? `    double heldValue[${providers.length}] = {};` : null,
        '    const std::vector<double>* stageStates = nullptr;',
        '    std::vector<double>* stageRates = nullptr;',
        '    [[maybe_unused]] std::size_t stageStep = 0;',
        '    [[maybe_unused]] std::size_t stageIndex = 0;',
        '    double stepTime = 0;',
        ...cppSwitchingLines(model, meta.switching ?? []),
        cppStageLambdas(model, providerInfo),
        `    std::vector<std::function<void()>> nodeIntegrators = { ${nodeIntegratorList} };`,
        '    const auto evaluateStage = [&](std::size_t internalStep, std::size_t stage, double time, const std::vector<double>& states, std::vector<double>& rates) {',
        '        stageStep = internalStep;',
        '        stageIndex = stage;',
        '        stepTime = time;',
        '        stageStates = &states;',
        '        stageRates = &rates;',
        cppStageDispatchLines(meta.parallelism).join('\n'),
        '    };',
        ...(adaptive || stiff ? [
            `    // ${adaptive ? 'Adaptive' : bdf ? 'BDF' : 'Stiff'}: its error norm summed node by node, in the engine's order; its tolerances; and ${bdf ? 'its table of differences' : 'the controller\'s memory'}, carried`,
            '    // from one global step to the next. Its first evaluation of a global step is at its start, where held programs are evaluated.',
            `    const std::vector<std::vector<std::size_t>> errorGroups = { ${errorGroupsOf(model).map((group) => `{ ${group.join(', ')} }`).join(', ')} };`,
            ...(adaptive ? [
                `    const konjugate::integrators::DormandPrince54Tolerance tolerance{ ${doubleLiteral(meta.tolerance.relative)}, { ${meta.absoluteTolerances.map(doubleLiteral).join(', ')} } };`,
                `    constexpr std::size_t fixedSteps = ${meta.fixedSteps};`,
                '    konjugate::integrators::DormandPrince54Controller controller;',
                '    konjugate::integrators::DormandPrince54Stiffness stiffness;',
                '    konjugate::integrators::DormandPrince54Statistics statistics;'
            ] : bdf ? [
                `    const konjugate::integrators::BdfTolerance tolerance{ ${doubleLiteral(meta.tolerance.relative)}, { ${meta.absoluteTolerances.map(doubleLiteral).join(', ')} } };`,
                '    // The Jacobian\'s structure from the model\'s graph: the states each state\'s derivative reads.',
                `    const std::vector<std::vector<std::size_t>> stageReads = { ${meta.stageReads.map((reads) => `{ ${reads.join(', ')} }`).join(', ')} };`,
                `    auto system = konjugate::integrators::makeStiffSystem(integrated, stageReads, errorGroups);`,
                ...cppExactJacobianLines(model, meta.exactJacobian),
                '    konjugate::integrators::BdfHistory history;',
                '    konjugate::integrators::BdfStatistics statistics;',
                // The conditions' latches the table was built under: one that flips at a global step's start starts it again, as in the engine.
                ...(meta.switching?.length ? ['    std::vector<double> bdfLatches = switching.latches;'] : [])
            ] : [
                `    const konjugate::integrators::Rodas4Tolerance tolerance{ ${doubleLiteral(meta.tolerance.relative)}, { ${meta.absoluteTolerances.map(doubleLiteral).join(', ')} } };`,
                `    constexpr std::size_t fixedSteps = ${meta.fixedSteps};`,
                '    // The Jacobian\'s structure from the model\'s graph: the states each state\'s derivative reads at a stage.',
                `    const std::vector<std::vector<std::size_t>> stageReads = { ${meta.stageReads.map((reads) => `{ ${reads.join(', ')} }`).join(', ')} };`,
                `    auto system = konjugate::integrators::makeRodas4System(integrated, stageReads, errorGroups);`,
                ...cppExactJacobianLines(model, meta.exactJacobian),
                `    constexpr bool readsTime = ${meta.stagesReadTime};`,
                '    konjugate::integrators::Rodas4Controller controller;',
                '    konjugate::integrators::Rodas4Statistics statistics;'
            ]),
            '    const auto evaluateAdaptive = [&](std::size_t evaluation, double time, const std::vector<double>& states, std::vector<double>& rates) {',
            '        evaluateStage(0, evaluation, time, states, rates);',
            '    };',
            // Where a stored schedule jumps or turns, as the engine finds them (scheduleBreakpoints): every step lands there.
            '    const auto breakpointsWithin = [&](double from, double to) {',
            '        std::vector<double> times;',
            ...(model.schedules.length ? [
                '        for (const auto& schedule : parameterSchedules) {',
                '            for (std::size_t index = 0; index < schedule.count; ++index) {',
                '                if (schedule.times[index] > from && schedule.times[index] < to) times.push_back(schedule.times[index]);',
                '            }',
                '        }'
            ] : []),
            '        std::sort(times.begin(), times.end());',
            '        const double gap = std::max(1e-9 * (to - from), 1e3 * std::numeric_limits<double>::epsilon() * std::max(std::abs(from), std::abs(to)));',
            '        std::vector<double> kept;',
            '        for (const double time : times) {',
            '            if (time - from <= gap || to - time <= gap) continue;',
            '            if (!kept.empty() && time - kept.back() <= gap) continue;',
            '            kept.push_back(time);',
            '        }',
            '        return kept;',
            '    };'
        ] : []),
        '    const auto steps = static_cast<std::size_t>(std::ceil(targetTime / globalTimeStep - 1e-9));',
        '    for (std::size_t step = 0; step < steps; ++step) {',
        '        const double currentTime = step * globalTimeStep;',
        located ? '        switching.beginGlobalStep(currentTime, globalState);' : null,
        adaptive
            ? ['        const double endTime = std::min(targetTime, (step + 1) * globalTimeStep);',
                `        konjugate::integrators::dormandPrince54GlobalStep${located ? 'WithEvents' : ''}(currentTime, endTime, globalState, integrated, errorGroups, tolerance,`,
                `            fixedSteps ? std::vector<double>{} : breakpointsWithin(currentTime, endTime), {}, fixedSteps, controller, stiffness, statistics,${located ? ' switching,' : ''}`,
                '            evaluateAdaptive, [](double, const std::vector<double>&) {});'].join('\n')
            : bdf
            ? ['        const double endTime = std::min(targetTime, (step + 1) * globalTimeStep);',
                '        // The table starts again at order 1 where a schedule turns a corner at this very instant, as the engine starts it.',
                '        const auto around = breakpointsWithin(currentTime - globalTimeStep, currentTime + globalTimeStep);',
                '        const bool restart = std::any_of(around.begin(), around.end(), [&](double time) {',
                '            return std::abs(time - currentTime) <= std::max(1e-9 * globalTimeStep, 1e3 * std::numeric_limits<double>::epsilon() * std::abs(currentTime));',
                `        })${located ? ' || switching.latches != bdfLatches' : ''};`,
                `        konjugate::integrators::bdfGlobalStep${located ? 'WithEvents' : ''}(currentTime, endTime, globalState, system, tolerance, breakpointsWithin(currentTime, endTime), {}, restart,`,
                `            history, statistics,${located ? ' switching,' : ''} evaluateAdaptive, [](double, const std::vector<double>&) {});`,
                ...(located ? ['        bdfLatches = switching.latches;'] : [])].join('\n')
            : stiff
            ? ['        const double endTime = std::min(targetTime, (step + 1) * globalTimeStep);',
                `        konjugate::integrators::rodas4GlobalStep${located ? 'WithEvents' : ''}(currentTime, endTime, globalState, system, tolerance,`,
                `            fixedSteps ? std::vector<double>{} : breakpointsWithin(currentTime, endTime), {}, fixedSteps, readsTime, controller, statistics,${located ? ' switching,' : ''}`,
                '            evaluateAdaptive, [](double, const std::vector<double>&) {});'].join('\n')
            : located
                ? '        konjugate::integrators::rungeKutta4GlobalStepWithEvents(currentTime, globalTimeStep, stepsPerGlobalStep, globalState, integrated, switching, evaluateStage);'
                : '        konjugate::integrators::rungeKutta4GlobalStep(currentTime, globalTimeStep, stepsPerGlobalStep, globalState, integrated, evaluateStage);',
        ...cppWholeModelUpdateLines(model, providerInfo),
        '        if ((step + 1) % outputEveryStep == 0) writeRow((step + 1) * globalTimeStep);',
        '    }'
    ].filter((line) => line !== null);
}

function generateCpp(model, providers, meta, document) {
    // collectProviders already rejects any node-level computational provider before this function
    // is ever reached (there is no C++ equivalent in the engine), so every entry here is an
    // ordinary single-output relationship/source-term provider.
    let providerIndex = 0;
    const providerInfo = new Map();
    const providerBlocks = providers.map((provider) => {
        const namespaceName = `provider${providerIndex}`;
        providerIndex += 1;
        providerInfo.set(provider, { namespaceName, instanceVariable: `${namespaceName}Instance`, index: providerIndex - 1 });
        const source = provider.program
            ? provider.implementation.source.replace(/^#include\s*<konjugate\/sdk\/v2\/program\.hpp>\s*\n/m, '') : stripLeadingCppInclude(provider.implementation.source);
        return `namespace ${namespaceName} {\n${source}\n}\n`;
    });

    const isMpi = meta.parallelism === 'mpi';
    const nodeCount = model.nodePlans.length;
    const nodeLambdas = cppNodeIntegratorLambdas(model, providerInfo);
    const nodeIntegratorList = model.nodePlans.map((_plan, nodeIndex) => `integrateNode${nodeIndex}`).join(', ');
    const dispatchLines = cppDispatchLines(meta.parallelism);

    const providerDeclarations = providers.map((provider) => {
        const info = providerInfo.get(provider);
        if (provider.program) return `    auto ${info.instanceVariable} = ${info.namespaceName}::createProgram();`;
        return `    auto ${info.instanceVariable} = ${info.namespaceName}::createRelationshipProvider();\n    ${info.instanceVariable}->initialize({});`;
    }).join('\n');

    const includes = [
        '#include <algorithm>',
        '#include <cmath>',
        '#include <cstddef>',
        '#include <fstream>',
        '#include <functional>',
        '#include <iomanip>',
        '#include <iostream>',
        meta.parallelism === 'mpi' ? '#include <mpi.h>' : '',
        '#include <memory>',
        providers.length ? '#include <span>' : '',
        '#include <stdexcept>',
        '#include <string>',
        '#include <string_view>',
        meta.parallelism === 'stdThread' ? '#include <thread>' : '',
        '#include <vector>'
    ].filter(Boolean).join('\n');

    const header = `// Generated by Konjugate's "Export simulation code" feature from "${document.metadata?.projectName ?? 'this project'}".\n`
        + ownershipNotice(document, '// ')
        + `// Reproduces one ${meta.method === 'nodeByNode' ? 'Explicit Euler' : integrationMethod(meta.method).name} run of the model as it was when exported. See docs/codeExport.md\n`
        + `// for exactly what is (and is not) reproduced.\n//\n`
        + `${runInstructions('cpp', meta, '// ')}\n//\n${stateIndexComment(model, '// ')}\n`;

    const escapedHeader = csvHeader(model).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const outputSetupLines = isMpi ? [
        '    std::ofstream output;',
        '    if (worldRank == 0) {',
        '        output.open(outputPath);',
        '        output << std::setprecision(15);',
        `        output << "${escapedHeader}\\n";`,
        '    }',
        '    const auto writeRow = [&](double time) {',
        '        if (worldRank != 0) return;',
        '        output << time;',
        '        for (double value : globalState) output << \',\' << value;',
        '        output << \'\\n\';',
        '    };'
    ] : [
        '    std::ofstream output(outputPath);',
        '    output << std::setprecision(15);',
        `    output << "${escapedHeader}\\n";`,
        '    const auto writeRow = [&](double time) {',
        '        output << time;',
        '        for (double value : globalState) output << \',\' << value;',
        '        output << \'\\n\';',
        '    };'
    ];

    return [
        header,
        includes,
        '',
        providers.some((provider) => !provider.program) ? `${cppSdkNamespace}\n` : '',
        // The program SDK (version 2) as it is, for the programs in the current format.
        providers.some((provider) => provider.program) ? `${programSdkCpp.replace(/^#pragma once\n/m, '')}\n` : '',
        providerBlocks.join('\n'),
        cppScheduleLines(model),
        meta.method === 'rungeKutta4' ? `${rungeKutta4Cpp.replace(/^#pragma once\n/m, '')}\n` : null,
        meta.method === 'dormandPrince54' ? `${dormandPrince54Cpp.replace(/^#pragma once\n/m, '')}\n` : null,
        // Stiff: Konjugate's own linear algebra, then the method, which includes it.
        // The stiff methods: Konjugate's own linear algebra and their shared machinery, then the method, each less its own includes.
        meta.method === 'rodas4' || meta.method === 'bdf' ? `${linearSolveCpp.replace(/^#pragma once\n/m, '')}\n` : null,
        meta.method === 'rodas4' || meta.method === 'bdf' ? `${stiffSystemCpp.replace(/^#pragma once\n/m, '').replace(/^#include "linearSolve\.hpp"\n/m, '')}\n` : null,
        meta.method === 'rodas4' ? `${rodas4Cpp.replace(/^#pragma once\n/m, '').replace(/^#include "stiffSystem\.hpp"\n/m, '')}\n` : null,
        meta.method === 'bdf' ? `${bdfCpp.replace(/^#pragma once\n/m, '').replace(/^#include "stiffSystem\.hpp"\n/m, '')}\n` : null,
        meta.switching?.length ? `${eventsCpp.replace(/^#pragma once\n/m, '')}\n` : null,
        'int main(int argc, char** argv) {',
        isMpi ? '    MPI_Init(&argc, &argv);' : null,
        `    double targetTime = ${doubleLiteral(meta.defaultTargetTime)};`,
        '    std::string outputPath = "results.csv";',
        '    for (int index = 1; index < argc; ++index) {',
        '        const std::string argument = argv[index];',
        '        if (argument == "--target-time" && index + 1 < argc) targetTime = std::stod(argv[++index]);',
        '        else if (argument == "--output" && index + 1 < argc) outputPath = argv[++index];',
        '    }',
        `    constexpr double globalTimeStep = ${doubleLiteral(meta.globalTimeStep)};`,
        `    constexpr double outputInterval = ${doubleLiteral(meta.outputInterval)};`,
        '    const std::size_t outputEveryStep = static_cast<std::size_t>(outputInterval / globalTimeStep + 0.5);',
        `    constexpr int nodeCount = ${nodeCount};`,
        isMpi ? mpiSetupLines(model) : null,
        providerDeclarations,
        `    std::vector<double> globalState = { ${initialStateLiterals(model)} };`,
        cppSettleLines(model, providerInfo),
        outputSetupLines.join('\n'),
        '    writeRow(0);',
        ...(meta.method !== 'nodeByNode' ? cppWholeModelLoopLines(model, providers, providerInfo, meta) : [
            '    const auto steps = static_cast<std::size_t>(std::ceil(targetTime / globalTimeStep - 1e-9));',
            '    for (std::size_t step = 0; step < steps; ++step) {',
            '        const std::vector<double> snapshot = globalState;',
            '        const double currentTime = step * globalTimeStep;',
            nodeLambdas.split('\n').map((line) => `    ${line}`).join('\n'),
            `        std::vector<std::function<void()>> nodeIntegrators = { ${nodeIntegratorList} };`,
            dispatchLines.join('\n'),
            '        if ((step + 1) % outputEveryStep == 0) writeRow((step + 1) * globalTimeStep);',
            '    }'
        ]),
        isMpi ? '    if (worldRank == 0) std::cerr << "Wrote " << outputPath << "\\n";' : '    std::cerr << "Wrote " << outputPath << "\\n";',
        isMpi ? '    MPI_Finalize();' : null,
        '    return 0;',
        '}',
        ''
    ].filter((line) => line !== null).join('\n');
}

export const cppSdkNamespace = `namespace konjugate::sdk::v1 {

struct ScalarPort { std::string key; std::string name; std::string unit; };
struct RelationshipDescription { std::string providerId; std::string name; std::vector<ScalarPort> inputs; ScalarPort output; };
struct InitializationContext { std::uint64_t instanceId = 0; };

class InputView {
public:
    InputView(std::span<const double> values, std::span<const std::string_view> keys) noexcept : values_(values), keys_(keys) {}
    [[nodiscard]] std::size_t size() const noexcept { return values_.size(); }
    [[nodiscard]] double at(std::size_t index) const {
        if (index >= values_.size()) throw std::out_of_range("Relationship-provider input index is out of range.");
        return values_[index];
    }
    [[nodiscard]] double at(std::string_view key) const {
        for (std::size_t index = 0; index < keys_.size(); ++index) if (keys_[index] == key) return values_[index];
        throw std::out_of_range("Unknown relationship-provider input key.");
    }
private:
    std::span<const double> values_;
    std::span<const std::string_view> keys_;
};

struct EvaluationContext { double simulationTime = 0; double stepSize = 0; InputView inputs; };

class OutputCollector {
public:
    void addGradient(double value) noexcept { gradient_ += value; }
    [[nodiscard]] double gradient() const noexcept { return gradient_; }
private:
    double gradient_ = 0;
};

class RelationshipProvider {
public:
    virtual ~RelationshipProvider() = default;
    [[nodiscard]] virtual RelationshipDescription describe() const = 0;
    virtual void initialize(const InitializationContext&) {}
    virtual void evaluate(const EvaluationContext&, OutputCollector&) = 0;
    virtual void shutdown() noexcept {}
};

} // namespace konjugate::sdk::v1

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider();
`;

// ---- Python ----

function pythonSymbolsDict(symbols) {
    return `{${Array.from(symbols, ([key, value]) => `"${key}": ${symbolText(value, 'python')}`).join(', ')}}`;
}

function emitPythonRegularContribution(contribution) {
    const expression = emitExpression(compileExpressionNode(contribution.mathJson), symbolTexts(contribution.symbols, 'python'), pythonOperators);
    return [
        ...commentLines(contribution.symbols, '        ', '#'),
        `        contribution_value = ${expression}`,
        contribution.negate ? '        contribution_value = -contribution_value' : '',
        '        if not math.isfinite(contribution_value): raise RuntimeError("A contribution produced a non-finite derivative.")',
        `        derivative[${contribution.outputLocalIndex}] += contribution_value`
    ].filter(Boolean).join('\n');
}

// A version 2 program's call in Python, as cppProgramCall's.
function pythonProgramCall(task, info, timeName, valueName, rate) {
    const { values, output } = programCall(task, task.program, 'python', task.outputUnit, rate);
    return [
        `        ${valueName} = float(${info.instanceVariable}.evaluate(${timeName}, describe(type(${info.instanceVariable})).view([${values.join(', ')}], {})))`,
        output ? `        ${valueName} = ${valueName} * ${output.scale} + ${output.offset}` : ''
    ].filter(Boolean);
}

function emitPythonProviderContribution(contribution, info) {
    if (contribution.program) {
        return [
            ...commentLines(contribution.symbols, '        ', '#'),
            ...pythonProgramCall(contribution, info, 'step_time', 'contribution_value', true),
            contribution.negate ? '        contribution_value = -contribution_value' : '',
            '        if not math.isfinite(contribution_value): raise RuntimeError("A contribution produced a non-finite derivative.")',
            `        derivative[${contribution.outputLocalIndex}] += contribution_value`
        ].filter(Boolean).join('\n');
    }
    return [
        ...commentLines(contribution.symbols, '        ', '#'),
        '        outputs = OutputCollector()',
        `        ${info.instanceVariable}.evaluate(EvaluationContext(step_time, node_time_step), InputView(${pythonSymbolsDict(contribution.symbols)}), outputs)`,
        '        contribution_value = outputs.gradient',
        contribution.negate ? '        contribution_value = -contribution_value' : '',
        '        if not math.isfinite(contribution_value): raise RuntimeError("A contribution produced a non-finite derivative.")',
        `        derivative[${contribution.outputLocalIndex}] += contribution_value`
    ].filter(Boolean).join('\n');
}

function emitPythonAlgebraicTask(task, info) {
    const lines = [...commentLines(task.symbols, '        ', '#')];
    if (task.program) {
        lines.push(...pythonProgramCall(task, info, 'algebraic_time', 'algebraic_value', false));
    } else if (task.implementation) {
        lines.push(
            '        outputs = OutputCollector()',
            `        ${info.instanceVariable}.evaluate(EvaluationContext(algebraic_time, node_time_step), InputView(${pythonSymbolsDict(task.symbols)}), outputs)`,
            '        algebraic_value = outputs.gradient'
        );
    } else {
        lines.push(`        algebraic_value = ${emitExpression(compileExpressionNode(task.mathJson), symbolTexts(task.symbols, 'python'), pythonOperators)}`);
    }
    lines.push(
        '        if not math.isfinite(algebraic_value): raise RuntimeError("An algebraic source term produced a non-finite value.")',
        `        state[${task.outputLocalIndex}] = algebraic_value`
    );
    return lines.join('\n');
}

// Mirrors cppSettleLines: algebraic states computed once from the initial states before step 0.
function pythonSettleLines(model, providerInfo) {
    const blocks = model.nodePlans.filter((plan) => plan.algebraic.length).map((plan) => {
        const seed = plan.node.states.map((state) => `global_state[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const commitLines = plan.node.states.map((state, index) => (
            `    global_state[${model.stateRecord.get(state.id).globalIndex}] = state[${index}]`
        )).join('\n');
        const tasks = plan.algebraic.map((task) => emitPythonAlgebraicTask(task, providerInfo.get(task)))
            .join('\n').split('\n').map((line) => line.replace(/^    /, '')).join('\n');
        return [
            `    # Settle algebraic states: ${plan.node.name}`,
            '    snapshot = global_state',
            `    state = [${seed}]`,
            `    node_time_step = global_time_step / ${plan.substeps}`,
            '    algebraic_time = 0.0',
            tasks,
            commitLines
        ].join('\n');
    });
    return blocks.join('\n');
}

function emitPythonNodeProvider(nodeProvider, info) {
    // setsValue outputs are written after every contribution has been evaluated, as the engine
    // does, so no contribution in this substep sees them early.
    const outputLines = nodeProvider.outputs.map((output) => (output.setsValue
        ? `        pending_algebraic.append((${output.localIndex}, node_outputs.gradients.get("${output.key}", 0.0)))`
        : `        derivative[${output.localIndex}] += node_outputs.gradients.get("${output.key}", 0.0)`
    ));
    return [
        ...commentLines(nodeProvider.symbols, '        ', '#'),
        '        node_outputs = NodeOutputCollector()',
        `        ${info.instanceVariable}.evaluate(EvaluationContext(step_time, node_time_step), InputView(${pythonSymbolsDict(nodeProvider.symbols)}), node_outputs)`,
        ...outputLines
    ].join('\n');
}

// Only used for parallelism 'mpi': wraps a node's block in a guard so each rank executes only the
// nodes in its own contiguous block (see mpiSetupLines's C++ counterpart / nodeStateOffsetLiterals
// for why a contiguous-by-node-order partition is what makes the later single comm.allgather()
// sufficient to reconcile the full state list).
function pythonNodeBlockLines(model, providerInfo, isMpi) {
    return model.nodePlans.map((plan, nodeIndex) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const emitContribution = (contribution) => (contribution.implementation
            ? emitPythonProviderContribution(contribution, providerInfo.get(contribution))
            : emitPythonRegularContribution(contribution));
        const contributionLines = plan.contributions.map(emitContribution).join('\n');
        const nodeProviderLines = plan.nodeProvider ? emitPythonNodeProvider(plan.nodeProvider, providerInfo.get(plan.nodeProvider)) : '';
        // Once, after the last update, as the engine does (see cppAlgebraicLines).
        const algebraicLines = plan.algebraic.map((task) => emitPythonAlgebraicTask(task, providerInfo.get(task))).join('\n');
        const algebraicAtEnd = algebraicLines && ['    algebraic_time = current_time + global_time_step', algebraicLines.split('\n').map((line) => line.replace(/^    /, '')).join('\n')].join('\n');
        const hasPendingAlgebraic = plan.nodeProvider?.outputs.some((output) => output.setsValue);
        const commitLines = plan.node.states.map((state, index) => (
            `    global_state[${model.stateRecord.get(state.id).globalIndex}] = state[${index}]`
        )).join('\n');
        const body = plan.verletKicked ? [
            `    # Node: ${plan.node.name}`,
            `    state = [${seed}]`,
            pythonNodeSubstepLines(plan, emitContribution),
            algebraicAtEnd,
            commitLines
        ].filter(Boolean).join('\n') : [
            `    # Node: ${plan.node.name}`,
            `    state = [${seed}]`,
            `    node_time_step = global_time_step / ${plan.substeps}`,
            `    for substep in range(${plan.substeps}):`,
            '        step_time = current_time + substep * node_time_step',
            `        derivative = [0.0] * ${stateCount}`,
            hasPendingAlgebraic ? '        pending_algebraic = []' : '',
            contributionLines,
            nodeProviderLines,
            hasPendingAlgebraic ? '        for index, value in pending_algebraic:\n            if not math.isfinite(value): raise RuntimeError("An algebraic output produced a non-finite value.")\n            state[index] = value' : '',
            `        for index in range(${stateCount}):`,
            '            state[index] += node_time_step * derivative[index]',
            algebraicAtEnd,
            commitLines
        ].filter(Boolean).join('\n');
        if (!isMpi) return body;
        return [`    if my_node_start <= ${nodeIndex} < my_node_end:`, body.split('\n').map((line) => `    ${line}`).join('\n')].join('\n');
    }).join('\n');
}

// See generateCpp's mpiSetupLines for the identical partition scheme (contiguous node blocks by
// node count, computed at runtime from the rank count). mpi4py initializes/finalizes MPI on
// import/interpreter-exit automatically, so unlike C++ there is no explicit Init/Finalize here.
function pythonMpiSetupLines(model) {
    return [
        '    comm = MPI.COMM_WORLD',
        '    world_rank = comm.Get_rank()',
        '    world_size = comm.Get_size()',
        `    node_state_offsets = [${nodeStateOffsetLiterals(model)}]`,
        '    nodes_per_rank = -(-node_count // world_size)  # ceiling division',
        '    my_node_start = min(world_rank * nodes_per_rank, node_count)',
        '    my_node_end = min(my_node_start + nodes_per_rank, node_count)',
        '    my_state_start = node_state_offsets[my_node_start]',
        '    my_state_end = node_state_offsets[my_node_end]'
    ].join('\n');
}

// As emitCppStageProviderContribution: a program once a global step, at its start, and held through the stages.
function emitPythonStageProviderContribution(contribution, info) {
    return [
        ...commentLines(contribution.symbols, '        ', '#'),
        '        if internal_step == 0 and stage == 0:',
        '            outputs = OutputCollector()',
        `            ${info.instanceVariable}.evaluate(EvaluationContext(step_time, global_time_step), InputView(${pythonSymbolsDict(contribution.symbols)}), outputs)`,
        '            contribution_value = outputs.gradient',
        contribution.negate ? '            contribution_value = -contribution_value' : '',
        '            if not math.isfinite(contribution_value): raise RuntimeError("A contribution produced a non-finite derivative.")',
        `            held_value[${info.index}] = contribution_value`,
        `        derivative[${contribution.outputLocalIndex}] += held_value[${info.index}]`
    ].filter(Boolean).join('\n');
}

// As cppSwitchingLines, in Python.
function pythonSwitchingLines(model, functions) {
    if (!functions.length) return [];
    const lines = [
        '    # Event location (docs/proposals/integrators.md): each comparison of a condition in a Rate equation, g = a - b, watched; the',
        '    # terms read the condition latched through each step, and a step that crosses a switch is retaken to end on it.',
        '    def evaluate_switching(time, snapshot, values):',
        '        step_time = time'
    ];
    let node = -1;
    functions.forEach((fn, index) => {
        if (fn.nodeIndex !== node) {
            node = fn.nodeIndex;
            const plan = model.nodePlans[node];
            lines.push(`        # Node: ${plan.node.name}`);
            lines.push(`        state = [${plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ')}]`);
        }
        const texts = symbolTexts(fn.symbols, 'python');
        lines.push(`        values[${index}] = ${emitExpression(compileExpressionNode(fn.left), texts, pythonOperators)} - ${emitExpression(compileExpressionNode(fn.right), texts, pythonOperators)}`);
    });
    lines.push('');
    lines.push(`    switching = Switching(evaluate_switching, [${functions.map((fn) => fn.comparison).join(', ')}])`);
    return lines;
}

function pythonWholeModelLoopLines(model, providers, providerInfo, meta, isMpi) {
    const located = meta.switching?.length > 0;
    const stageBlocks = model.nodePlans.map((plan, nodeIndex) => {
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const body = [
            `        # Node: ${plan.node.name}`,
            `        state = [${seed}]`,
            `        derivative = [0.0] * ${plan.node.states.length}`,
            ...plan.contributions.map((contribution) => (
                contribution.implementation ? emitPythonStageProviderContribution(contribution, providerInfo.get(contribution)) : emitPythonRegularContribution(contribution)
            )),
            ...integratedLocalIndexes(plan).map((local) => `        rates[${model.stateRecord.get(plan.node.states[local].id).globalIndex}] = derivative[${local}]`)
        ].join('\n');
        if (!isMpi) return body;
        return [`        if my_node_start <= ${nodeIndex} < my_node_end:`, body.split('\n').map((line) => `    ${line}`).join('\n')].join('\n');
    }).join('\n');
    const updateBlocks = model.nodePlans.filter((plan) => plan.algebraic.length).map((plan) => [
        `        # Updates: ${plan.node.name}`,
        `        state = [${plan.node.states.map((state) => `global_state[${model.stateRecord.get(state.id).globalIndex}]`).join(', ')}]`,
        '        node_time_step = global_time_step / steps_per_global_step',
        '        algebraic_time = current_time + global_time_step',
        plan.algebraic.map((task) => emitPythonAlgebraicTask(task, providerInfo.get(task))).join('\n'),
        ...plan.node.states.map((state, index) => `        global_state[${model.stateRecord.get(state.id).globalIndex}] = state[${index}]`)
    ].join('\n'));
    const adaptive = meta.method === 'dormandPrince54';
    const bdf = meta.method === 'bdf';
    const stiff = meta.method === 'rodas4' || bdf;
    const schedulesBreakpoints = model.schedules.length
        ? ['        times = sorted(time for _hold, schedule_times, _values in PARAMETER_SCHEDULES for time in schedule_times if from_time < time < to_time)']
        : ['        times = []'];
    return [
        `    # ${integrationMethod(meta.method).summaryName}, the whole model at once: every node evaluated at each stage from every node's`,
        "    # stage values. Values set from other states (Updates) hold through the stages and are set at each global step's end.",
        `    steps_per_global_step = ${adaptive || stiff ? 1 : meta.stepsPerGlobalStep}`,
        `    integrated = [${integratedFlags(model).map((flag) => (flag ? 'True' : 'False')).join(', ')}]`,
        providers.length ? `    held_value = [0.0] * ${providers.length}` : '',
        ...pythonSwitchingLines(model, meta.switching ?? []),
        '',
        '    def evaluate_stage(internal_step, stage, step_time, snapshot, rates):',
        '        node_time_step = global_time_step / steps_per_global_step',
        stageBlocks,
        ...(isMpi ? [
            '        gathered_chunks = comm.allgather(rates[my_state_start:my_state_end])',
            '        rates[:] = [value for chunk in gathered_chunks for value in chunk]'
        ] : []),
        '',
        ...(adaptive || stiff ? [
            `    # ${adaptive ? 'Adaptive' : bdf ? 'BDF' : 'Stiff'}: its error norm summed node by node, in the engine's order; its tolerances; and ${bdf ? 'its table of differences' : "the controller's memory"}, carried`,
            '    # from one global step to the next. Its first evaluation of a global step is at its start, where held programs are evaluated.',
            `    error_groups = [${errorGroupsOf(model).map((group) => `[${group.join(', ')}]`).join(', ')}]`,
            `    relative_tolerance = ${doubleLiteral(meta.tolerance.relative)}`,
            `    absolute_tolerance = [${meta.absoluteTolerances.map(doubleLiteral).join(', ')}]`,
            `    fixed_steps = ${meta.fixedSteps}`,
            ...(adaptive ? ['    controller = DormandPrince54Controller()'] : bdf ? [
                "    # The Jacobian's structure from the model's graph: the states each state's derivative reads.",
                `    stage_reads = [${meta.stageReads.map((reads) => `[${reads.join(', ')}]`).join(', ')}]`,
                '    system = make_stiff_system(integrated, stage_reads, error_groups)',
                ...pythonExactJacobianLines(model, meta.exactJacobian),
                '    history = BdfHistory()',
                ...(meta.switching?.length ? ['    bdf_latches = list(switching.latches)'] : [])
            ] : [
                "    # The Jacobian's structure from the model's graph: the states each state's derivative reads at a stage.",
                `    stage_reads = [${meta.stageReads.map((reads) => `[${reads.join(', ')}]`).join(', ')}]`,
                '    system = make_rodas_4_system(integrated, stage_reads, error_groups)',
                ...pythonExactJacobianLines(model, meta.exactJacobian),
                `    reads_time = ${meta.stagesReadTime ? 'True' : 'False'}`,
                '    controller = Rodas4Controller()'
            ]),
            '',
            '    def evaluate_adaptive(evaluation, step_time, snapshot, rates):',
            '        evaluate_stage(0, evaluation, step_time, snapshot, rates)',
            '',
            '    # Where a stored schedule jumps or turns, as the engine finds them: every step lands there.',
            '    def breakpoints_within(from_time, to_time):',
            ...schedulesBreakpoints,
            `        gap = max(1e-9 * (to_time - from_time), 1e3 * ${adaptive ? 'DP_EPSILON' : 'STIFF_EPSILON'} * max(abs(from_time), abs(to_time)))`,
            '        kept = []',
            '        for time in times:',
            '            if time - from_time <= gap or to_time - time <= gap:',
            '                continue',
            '            if kept and time - kept[-1] <= gap:',
            '                continue',
            '            kept.append(time)',
            '        return kept',
            ''
        ] : []),
        '    steps = math.ceil(target_time / global_time_step - 1e-9)',
        '    for step in range(steps):',
        '        current_time = step * global_time_step',
        located ? '        switching.begin_global_step(current_time, global_state)' : '',
        adaptive
            ? ['        end_time = min(target_time, (step + 1) * global_time_step)',
                '        dormand_prince_54_global_step(current_time, end_time, global_state, integrated, error_groups, relative_tolerance, absolute_tolerance,',
                '                                      [] if fixed_steps else breakpoints_within(current_time, end_time), [], fixed_steps, controller, evaluate_adaptive,',
                `                                      lambda _time, _values: None${located ? ', switching' : ''})`].join('\n')
            : bdf
            ? ['        end_time = min(target_time, (step + 1) * global_time_step)',
                '        # The table starts again at order 1 where a schedule turns a corner at this very instant, as the engine starts it.',
                '        around = breakpoints_within(current_time - global_time_step, current_time + global_time_step)',
                `        restart = any(abs(time - current_time) <= max(1e-9 * global_time_step, 1e3 * STIFF_EPSILON * abs(current_time)) for time in around)${located ? ' or switching.latches != bdf_latches' : ''}`,
                '        bdf_global_step(current_time, end_time, global_state, system, relative_tolerance, absolute_tolerance, breakpoints_within(current_time, end_time), [],',
                `                        restart, history, evaluate_adaptive, lambda _time, _values: None${located ? ', switching' : ''})`,
                ...(located ? ['        bdf_latches = list(switching.latches)'] : [])].join('\n')
            : stiff
            ? ['        end_time = min(target_time, (step + 1) * global_time_step)',
                '        rodas_4_global_step(current_time, end_time, global_state, system, relative_tolerance, absolute_tolerance,',
                '                            [] if fixed_steps else breakpoints_within(current_time, end_time), [], fixed_steps, reads_time, controller, evaluate_adaptive,',
                `                            lambda _time, _values: None${located ? ', switching' : ''})`].join('\n')
            : located
                ? '        runge_kutta_4_global_step_with_events(current_time, global_time_step, steps_per_global_step, global_state, integrated, switching, evaluate_stage)'
                : '        runge_kutta_4_global_step(current_time, global_time_step, steps_per_global_step, global_state, integrated, evaluate_stage)',
        ...updateBlocks
    ];
}

function generatePython(model, providers, meta, document) {
    let providerIndex = 0;
    const providerInfo = new Map();
    const providerBlocks = providers.map((provider) => {
        if (provider.program) {
            // A program in the current format: its class renamed as the older ones are, its import from konjugate.v2 left out (the SDK is
            // pasted in once).
            const match = provider.implementation.source.match(/^class\s+(\w+)\s*\(\s*(?:Relationship|Node)\s*\)\s*:/m);
            if (!match) throw new Error(`Could not find the program's class in the source for the ${provider.entityLabel}.`);
            const uniqueName = `${match[1]}Program${providerIndex}`;
            providerIndex += 1;
            providerInfo.set(provider, { className: uniqueName, instanceVariable: `${uniqueName.charAt(0).toLowerCase()}${uniqueName.slice(1)}`, index: providerIndex - 1 });
            return provider.implementation.source.replace(/^from konjugate\.v2 import\s*(\([^)]*\)|[^\n]*)\n?/m, '')
                .replace(new RegExp(`\\bclass\\s+${match[1]}\\s*\\(`), `class ${uniqueName}(`);
        }
        const { className, pattern } = pythonProviderClassName(provider.implementation.source, provider.entityLabel);
        const uniqueName = `${className}Provider${providerIndex}`;
        providerIndex += 1;
        providerInfo.set(provider, { className: uniqueName, instanceVariable: `${uniqueName.charAt(0).toLowerCase()}${uniqueName.slice(1)}`, index: providerIndex - 1 });
        const withoutImport = provider.implementation.source.replace(/^from konjugate import\s*(\([^)]*\)|[^\n]*)\n?/m, '');
        return withoutImport.replace(pattern, `class ${uniqueName}(`);
    });

    const isMpi = meta.parallelism === 'mpi';
    const nodeCount = model.nodePlans.length;
    const nodeBlocks = pythonNodeBlockLines(model, providerInfo, isMpi);

    const providerInstances = providers.map((provider) => {
        const info = providerInfo.get(provider);
        if (provider.program) return `    ${info.instanceVariable} = ${info.className}()`;
        return [
            `    ${info.instanceVariable} = ${info.className}()`,
            `    ${info.instanceVariable}.initialize(InitializationContext(0))`
        ].join('\n');
    }).join('\n');

    const header = `# Generated by Konjugate's "Export simulation code" feature from "${document.metadata?.projectName ?? 'this project'}".\n`
        + ownershipNotice(document, '# ')
        + `# Reproduces one ${meta.method === 'nodeByNode' ? 'Explicit Euler' : integrationMethod(meta.method).name} run of the model as it was when exported. See docs/codeExport.md\n`
        + `# for exactly what is (and is not) reproduced.\n#\n`
        + `${runInstructions('python', meta, '# ')}\n#\n${stateIndexComment(model, '# ')}\n`;

    const escapedHeader = pythonStringContents(csvHeader(model));

    const outputSetupLines = isMpi ? [
        "    output = open(output_path, 'w') if world_rank == 0 else None",
        '    if output:',
        `        output.write("${escapedHeader}\\n")`,
        '    def write_row(time):',
        '        if output is None:',
        '            return',
        '        output.write(",".join(f"{value:.10g}" for value in [time, *global_state]) + "\\n")'
    ] : [
        "    output = open(output_path, 'w')",
        `    output.write("${escapedHeader}\\n")`,
        '    def write_row(time):',
        '        output.write(",".join(f"{value:.10g}" for value in [time, *global_state]) + "\\n")'
    ];

    const gatherLines = isMpi ? [
        '        gathered_chunks = comm.allgather(global_state[my_state_start:my_state_end])',
        '        global_state = [value for chunk in gathered_chunks for value in chunk]'
    ] : [];

    return [
        header,
        'import argparse',
        model.schedules.length ? 'import bisect' : '',
        'import math',
        isMpi ? 'from mpi4py import MPI' : '',
        '',
        providers.some((provider) => !provider.program) ? `${pythonSdkModule}\n` : '',
        // The program SDK (version 2) as it is, for the programs in the current format.
        providers.some((provider) => provider.program) ? `# --- vendored from engine/sdk/python/konjugate/v2 (the program SDK) ---\n${programSdkPython}\n# --- end of the program SDK ---\n` : '',
        providerBlocks.join('\n\n\n'),
        '',
        pythonScheduleLines(model),
        meta.method === 'rungeKutta4' ? `${rungeKutta4Python}\n` : '',
        meta.method === 'dormandPrince54' ? `${dormandPrince54Python}\n` : '',
        meta.method === 'rodas4' || meta.method === 'bdf' ? `${stiffSystemPython}\n` : '',
        meta.method === 'rodas4' ? `${rodas4Python}\n` : '',
        meta.switching?.length ? `${eventsPython}\n` : '',
        meta.method === 'bdf' ? `${bdfPython}\n` : '',
        'def run(target_time, output_path):',
        `    global_time_step = ${doubleLiteral(meta.globalTimeStep)}`,
        `    output_interval = ${doubleLiteral(meta.outputInterval)}`,
        '    output_every_step = round(output_interval / global_time_step)',
        `    node_count = ${nodeCount}`,
        isMpi ? pythonMpiSetupLines(model) : '',
        providerInstances,
        `    global_state = [${initialStateLiterals(model)}]`,
        pythonSettleLines(model, providerInfo),
        outputSetupLines.join('\n'),
        '    write_row(0)',
        ...(meta.method !== 'nodeByNode' ? pythonWholeModelLoopLines(model, providers, providerInfo, meta, isMpi) : [
            '    steps = math.ceil(target_time / global_time_step - 1e-9)',
            '    for step in range(steps):',
            '        snapshot = list(global_state)',
            '        current_time = step * global_time_step',
            nodeBlocks.split('\n').map((line) => `    ${line}`).join('\n'),
            ...gatherLines
        ]),
        '        if (step + 1) % output_every_step == 0:',
        '            write_row((step + 1) * global_time_step)',
        '    if output:',
        '        output.close()',
        '        print(f"Wrote {output_path}")',
        '',
        '',
        'if __name__ == "__main__":',
        '    parser = argparse.ArgumentParser()',
        `    parser.add_argument("--target-time", type=float, default=${doubleLiteral(meta.defaultTargetTime)})`,
        '    parser.add_argument("--output", type=str, default="results.csv")',
        '    arguments = parser.parse_args()',
        '    run(arguments.target_time, arguments.output)',
        ''
    ].join('\n');
}

const pythonSdkModule = `# --- vendored from engine/sdk/python/konjugate (author-facing provider SDK types) ---
from abc import ABC, abstractmethod
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Sequence


@dataclass(frozen=True)
class ScalarPort:
    key: str
    name: str
    unit: str = ""


@dataclass(frozen=True)
class RelationshipDescription:
    provider_id: str
    name: str
    inputs: Sequence[ScalarPort]
    output: ScalarPort


@dataclass(frozen=True)
class InitializationContext:
    instance_id: int


@dataclass(frozen=True)
class EvaluationContext:
    simulation_time: float
    step_size: float


class InputView:
    def __init__(self, values: Mapping[str, float]):
        self._values = MappingProxyType(dict(values))

    def __getitem__(self, key: str) -> float:
        return self._values[key]

    def __len__(self) -> int:
        return len(self._values)


class OutputCollector:
    def __init__(self):
        self._gradient = 0.0

    def add_gradient(self, value: float) -> None:
        self._gradient += float(value)

    @property
    def gradient(self) -> float:
        return self._gradient


class RelationshipProvider(ABC):
    @abstractmethod
    def describe(self) -> RelationshipDescription:
        raise NotImplementedError

    def initialize(self, context: InitializationContext) -> None:
        del context

    @abstractmethod
    def evaluate(self, context: EvaluationContext, inputs: InputView, outputs: OutputCollector) -> None:
        raise NotImplementedError

    def shutdown(self) -> None:
        pass


@dataclass(frozen=True)
class NodeProviderDescription:
    provider_id: str
    name: str
    inputs: Sequence[ScalarPort]
    outputs: Sequence[ScalarPort]


class NodeOutputCollector:
    def __init__(self):
        self._gradients = {}

    def add_gradient(self, key: str, value: float) -> None:
        self._gradients[key] = self._gradients.get(key, 0.0) + float(value)

    @property
    def gradients(self) -> Mapping[str, float]:
        return MappingProxyType(dict(self._gradients))


class NodeProvider(ABC):
    @abstractmethod
    def describe(self) -> NodeProviderDescription:
        raise NotImplementedError

    def initialize(self, context: InitializationContext) -> None:
        del context

    @abstractmethod
    def evaluate(self, context: EvaluationContext, inputs: InputView, outputs: NodeOutputCollector) -> None:
        raise NotImplementedError

    def shutdown(self) -> None:
        pass
# --- end vendored SDK types ---`;

// ---- Programs in the current format (version 2 of the program SDK; docs/proposals/programSdkV2.md, Export parity) ----------------
// What a program declares, read from its source as the SDK's declarations are written: its inputs in declaration order (each key, unit
// and default), its outputs, and whether it keeps memory, has a clock or an initialize() of its own, which code export does not write yet.
const programKey = (attribute) => attribute.replace(/_([a-z0-9])/g, (_match, letter) => letter.toUpperCase());

export function programDeclarations(kind, source) {
    const text = String(source ?? '');
    const declared = { inputs: [], outputs: [], node: false, keepsMemory: false, ownInitialize: false };
    if (kind === 'cpp') {
        declared.node = /:\s*public\s+(?:k|konjugate::sdk::v2)::Node\b/.test(text);
        const ns = '(?:k|konjugate::sdk::v2)::';
        for (const match of text.matchAll(new RegExp(`${ns}(Input|Parameter|Constant|Output)\\s+\\w+\\s*\\{\\s*this\\s*,\\s*"([^"]+)"(?:\\s*,\\s*"([^"]*)")?(?:\\s*,\\s*${ns}optional\\(\\s*([^)]+?)\\s*\\))?`, 'g'))) {
            const port = { key: match[2], unit: match[3] ?? '', ...(match[4] !== undefined ? { default: Number(match[4]) } : {}) };
            (match[1] === 'Output' ? declared.outputs : declared.inputs).push(port);
        }
        declared.keepsMemory = new RegExp(`${ns}(Memory|Clock)\\b`).test(text);
        declared.ownInitialize = /\bvoid\s+initialize\s*\(/.test(text);
    } else {
        declared.node = /^class\s+\w+\s*\(\s*(?:\w+\.)?Node\s*\)/m.test(text);
        for (const match of text.matchAll(/^[ \t]+(\w+)\s*=\s*(Input|Parameter|Constant|Output)\(([^)]*)\)/gm)) {
            const argumentsText = match[3];
            const unit = /^\s*(["'])(.*?)\1/.exec(argumentsText)?.[2] ?? /\bunit\s*=\s*(["'])(.*?)\1/.exec(argumentsText)?.[2] ?? '';
            const name = /\bname\s*=\s*(["'])(.*?)\1/.exec(argumentsText)?.[2];
            const fallback = /\bdefault\s*=\s*([-+0-9.eE]+)/.exec(argumentsText)?.[1];
            const port = { key: name ?? programKey(match[1]), unit, ...(fallback !== undefined ? { default: Number(fallback) } : {}) };
            (match[2] === 'Output' ? declared.outputs : declared.inputs).push(port);
        }
        declared.keepsMemory = /=\s*(Memory|Random|Clock)\(/.test(text);
        declared.ownInitialize = /^\s+def\s+initialize\s*\(/m.test(text);
    }
    return declared;
}

// The conversion at a port, exactly as the engine works it out (engine/src/programUnits.cpp): value in `to` = value in `from` x scale +
// offset; a rate never takes an offset. Null when either side has no unit (not checked) or it is the identity; an error when the two are
// different kinds of quantity.
function portConversion(from, to, rate, what) {
    if (!from || !to) return null;
    const source = parseUnit(from);
    const target = parseUnit(to);
    if (!source || !target) throw new Error(`${what}: "${!source ? from : to}" is not a unit Konjugate knows.`);
    const angle = 7;
    const time = 2;
    const onlyAngle = Math.abs(Math.abs(source.dimensions[angle] - target.dimensions[angle]) - 1) < 1e-12
        && source.dimensions.every((value, index) => index === angle || value === target.dimensions[index]);
    const same = source.dimensions.every((value, index) => value === target.dimensions[index]);
    if (!same && !onlyAngle) throw new Error(`${what}: ${from} and ${to} measure different kinds of quantity -- export blocked.`);
    const cycle = onlyAngle && source.dimensions[time] < 0 ? (source.dimensions[angle] > target.dimensions[angle] ? 1 / (2 * Math.PI) : 2 * Math.PI) : 1;
    const tidy = (value) => (Math.abs(value - Math.round(value)) < 1e-12 * Math.max(1, Math.abs(value)) ? Math.round(value) : value);
    const scale = tidy(source.scale * cycle / target.scale);
    const offset = rate ? 0 : tidy((source.offset - target.offset) / target.scale);
    return scale === 1 && offset === 0 ? null : { scale, offset };
}

const perSecondUnit = (unit) => (!unit ? 'Hz' : /[/*· ]/.test(unit) ? `(${unit})/s` : `${unit}/s`);

// A version 2 program's inputs, in its declaration order, as expressions of the language: each bound one's value converted at the port,
// an unbound one its default; and its output's conversion into the state's unit.
function programCall(task, declared, language, stateUnit, rate) {
    const texts = symbolTexts(task.symbols, language);
    const literal = (value) => doubleLiteral(value);
    const values = declared.inputs.map((port) => {
        if (!task.symbols.has(port.key)) {
            if (port.default === undefined) throw new Error(`Input ‘${port.key}’ of the program of the ${task.entityLabel} is not bound to anything and has no default -- export blocked.`);
            return literal(port.default);
        }
        const conversion = portConversion(task.symbols.get(port.key).unit, port.unit, false, `Input ‘${port.key}’ of the program of the ${task.entityLabel}`);
        const text = texts.get(port.key);
        return conversion ? `(${text}) * ${literal(conversion.scale)} + ${literal(conversion.offset)}` : text;
    });
    const output = portConversion(declared.outputs[0]?.unit, rate ? perSecondUnit(stateUnit) : stateUnit, rate, `The output of the program of the ${task.entityLabel}`);
    return { values, output: output ? { scale: literal(output.scale), offset: literal(output.offset) } : null };
}
