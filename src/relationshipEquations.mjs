/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A relationship with several equations, as the canvas edits it: `equationModel: { bindings, definitions, outputs }`
// (see docs/projectSchema.md). Each output sets a state of one of the relationship's two nodes; each definition is a
// named intermediate value reading the bindings and the definitions before it. The canvas keeps every equation's LaTeX
// and works out its MathJSON, and keeps in `bindings` only the states, parameters and time the equations read, so a
// relationship a toolbox wrote stays as it was until the user edits it. Pure functions of their arguments.

import { mathJsonToLatex, reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

export const definitionSymbolPattern = /^[a-z][A-Za-z0-9]*$/;

export const isSeveralEquations = (equationModel) => Array.isArray(equationModel?.outputs);

// Every state of either node, every parameter and time: what an equation may read, each with a stable symbol (one the
// relationship already uses for it is kept).
export function equationCandidates(equationModel, sourceNode, targetNode, parameters = []) {
    return reconcileEquationBindings(equationModel?.bindings ?? [], sourceNode, targetNode, parameters);
}

// An equation's LaTeX: as written, or worked out from its MathJSON when a toolbox wrote only that.
export function equationLatex(item) {
    if (typeof item?.latex === 'string' && item.latex.trim()) return item.latex;
    if (item?.mathJson === undefined || item?.mathJson === null) return '';
    try {
        return mathJsonToLatex(item.mathJson);
    } catch {
        return '';
    }
}

// Reads an item's LaTeX against what it may read. An item a toolbox wrote carries its MathJSON, and its LaTeX may be
// only for show: when that LaTeX does not read back, the item is read from LaTeX written from its MathJSON instead.
// The canvas drops an item's MathJSON when the user types into it, so a typing error is never covered up this way.
function readItem(item, readable) {
    const latex = equationLatex(item);
    const validation = validateEquationLatex(latex, readable);
    if (validation.valid || item.mathJson === undefined || item.mathJson === null) return { latex, validation };
    try {
        const written = mathJsonToLatex(item.mathJson);
        const rewritten = validateEquationLatex(written, readable);
        if (rewritten.valid) return { latex: written, validation: rewritten };
    } catch { /* fall through to the item's own LaTeX */ }
    return { latex, validation };
}

function symbolsOf(expression, found = new Set()) {
    if (typeof expression === 'string') found.add(expression);
    else if (Array.isArray(expression)) expression.slice(1).forEach((operand) => symbolsOf(operand, found));
    return found;
}

// Checks every definition and equation: { definitions: [{ errors, mathJson }], outputs: [{ errors, mathJson }], valid }.
// A definition's symbol must be new (not a state, parameter or time symbol, nor another definition's), and an equation
// may set each state of the two nodes once.
export function checkSeveralEquations(equationModel, candidates, sourceNode, targetNode) {
    const candidateSymbols = new Set(candidates.map((binding) => binding.symbol));
    const definitionSymbols = [];
    const definitions = (equationModel.definitions ?? []).map((definition) => {
        const errors = [];
        if (!definitionSymbolPattern.test(definition.symbol ?? '')) {
            errors.push(`"${definition.symbol ?? ''}" is not a valid name: start with a lowercase letter and use only letters and digits.`);
        } else if (candidateSymbols.has(definition.symbol)) {
            errors.push(`"${definition.symbol}" is already the name of a state, a parameter or time here; choose another.`);
        } else if (definitionSymbols.includes(definition.symbol)) {
            errors.push(`"${definition.symbol}" is defined twice.`);
        }
        const readable = [...candidates, ...definitionSymbols.map((symbol) => ({ symbol }))];
        const { latex, validation } = readItem(definition, readable);
        errors.push(...validation.errors);
        definitionSymbols.push(definition.symbol);
        return { errors, latex, mathJson: validation.valid ? validation.mathJson : null };
    });
    const readable = [...candidates, ...definitionSymbols.map((symbol) => ({ symbol }))];
    const seen = new Set();
    const outputs = (equationModel.outputs ?? []).map((output) => {
        const errors = [];
        const node = output.role === 'source' ? sourceNode : targetNode;
        const state = node?.states.find((candidate) => candidate.id === output.stateId);
        if (!state) errors.push('Choose the state this equation sets.');
        else if (seen.has(`${output.role}:${output.stateId}`)) errors.push(`${output.role}.${state.symbol} is set by another equation of this relationship.`);
        seen.add(`${output.role}:${output.stateId}`);
        const { latex, validation } = readItem(output, readable);
        errors.push(...validation.errors);
        return { errors, latex, mathJson: validation.valid ? validation.mathJson : null };
    });
    if (!outputs.length) return { definitions, outputs, valid: false, errors: ['Add an equation.'] };
    const valid = [...definitions, ...outputs].every((item) => !item.errors.length);
    return { definitions, outputs, valid, errors: [] };
}

// The equation model as saved: each definition and equation with its LaTeX and its MathJSON (null while it does not
// read as an expression), and the bindings it reads. An item that still has its MathJSON (the canvas drops it from an
// item the user types into) is kept exactly as it was, and so is a binding the relationship already had: editing one
// equation never rewrites the others.
export function compileSeveralEquations(equationModel, candidates, sourceNode, targetNode) {
    const check = checkSeveralEquations(equationModel, candidates, sourceNode, targetNode);
    const kept = (item) => item.mathJson !== undefined && item.mathJson !== null;
    const read = (item, result) => (kept(item)
        ? { ...(typeof item.latex === 'string' ? { latex: item.latex } : {}), mathJson: item.mathJson }
        : { latex: result.latex, mathJson: result.mathJson });
    const definitions = (equationModel.definitions ?? []).map((definition, index) => ({
        symbol: definition.symbol, ...read(definition, check.definitions[index])
    }));
    const outputs = (equationModel.outputs ?? []).map((output, index) => ({
        role: output.role, stateId: output.stateId, ...read(output, check.outputs[index]), setsValue: true
    }));
    const used = new Set();
    for (const item of [...definitions, ...outputs]) symbolsOf(item.mathJson, used);
    const existing = new Map((equationModel.bindings ?? []).map((binding) => [binding.symbol, binding]));
    const bindings = candidates.filter((candidate) => used.has(candidate.symbol))
        .map((candidate) => existing.get(candidate.symbol) ?? candidate);
    return { bindings, definitions, outputs };
}

// A single equation (it adds a rate to one state) as a relationship with several equations: the one equation now
// sets its state.
export function severalFromSingle(single, candidates, sourceNode, targetNode) {
    const output = single?.output ?? { role: 'target', stateId: targetNode?.states[0]?.id ?? null };
    const latex = single?.latex?.trim() ? single.latex : '0';
    return compileSeveralEquations({ bindings: single?.bindings ?? [], definitions: [], outputs: [{ ...output, latex }] },
        candidates, sourceNode, targetNode);
}

// The first equation of a relationship with several equations, as a single equation adding a rate to its state, with
// any definitions it reads written into it. The others are dropped.
export function singleFromSeveral(equationModel) {
    const first = equationModel.outputs?.[0];
    if (!first) return { latex: '', output: { role: 'target', stateId: null }, bindings: equationModel.bindings ?? [], mathJson: null };
    const definitions = new Map((equationModel.definitions ?? []).map((definition) => [definition.symbol, definition.mathJson]));
    const inline = (expression) => {
        if (typeof expression === 'string' && definitions.has(expression)) return inline(definitions.get(expression));
        return Array.isArray(expression) ? [expression[0], ...expression.slice(1).map(inline)] : expression;
    };
    const mathJson = first.mathJson === null || first.mathJson === undefined ? null : inline(first.mathJson);
    let latex = equationLatex(first);
    if (mathJson !== null && definitions.size) {
        try { latex = mathJsonToLatex(mathJson); } catch { /* keep the equation's own LaTeX */ }
    }
    return { latex, output: { role: first.role, stateId: first.stateId }, bindings: equationModel.bindings ?? [], mathJson };
}

// A name for a new definition, not yet used here.
export function newDefinitionSymbol(equationModel, candidates) {
    const taken = new Set([...candidates.map((binding) => binding.symbol), ...(equationModel.definitions ?? []).map((definition) => definition.symbol)]);
    for (let index = 1; ; index += 1) if (!taken.has(`q${index}`)) return `q${index}`;
}

// The first state of either node (target first) no equation of the relationship sets yet, for a new equation.
export function nextFreeOutput(equationModel, sourceNode, targetNode) {
    const set = new Set((equationModel.outputs ?? []).map((output) => `${output.role}:${output.stateId}`));
    for (const [role, node] of [['target', targetNode], ['source', sourceNode]]) {
        const state = node?.states.find((candidate) => !set.has(`${role}:${candidate.id}`));
        if (state) return { role, stateId: state.id };
    }
    return { role: 'target', stateId: targetNode?.states[0]?.id ?? null };
}

// Moves item `index` of `list` by `offset` places, returning a new list, or the same list when it cannot move.
export function moved(list, index, offset) {
    const to = index + offset;
    if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    return next;
}

