/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Parameter tuning card needs to let a person write an objective (docs/proposals/parameterTuningObjectives.md): the names
// the expression may use, worked out from the project, and the small text edits the summary buttons make. The engine reads the
// expression (engine/include/fittingObjective.hpp); this only decides what the names are and what they stand for. Pure functions.

export const summaryFunctions = Object.freeze([
    { name: 'final', hint: 'the value at the end of the run' },
    { name: 'max', hint: 'the highest value reached' },
    { name: 'min', hint: 'the lowest value reached' },
    { name: 'mean', hint: 'the average over the run' },
    { name: 'integral', hint: 'the total over the run: the value added up over time, in its unit times seconds' }
]);

const camel = (text) => {
    const words = String(text ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    const joined = words.map((word, index) => (index === 0 ? word[0].toLowerCase() : word[0].toUpperCase()) + word.slice(1)).join('');
    return /^[A-Za-z]/.test(joined) ? joined : `n${joined}`;
};

// Names are made unique by adding a number, so two nodes with the same name never share one.
const uniqueNames = () => {
    const taken = new Set();
    return (wanted) => {
        let name = wanted;
        for (let attempt = 2; taken.has(name); attempt += 1) name = `${wanted}${attempt}`;
        taken.add(name);
        return name;
    };
};

// The project's states, parameters and (when a CSV has been chosen) measured columns, each with the name an objective uses for it.
// `variables` is what is sent to the engine; the rest is for the buttons. A parameter linked to a shared one is left out (the shared
// one stands for it). Tunable parameters come first, since they are what the objective is usually about.
export function objectiveVocabulary(document, measuredColumns = []) {
    const unique = uniqueNames();
    const variables = [];
    const states = [];
    for (const node of document.nodes ?? []) {
        for (const state of node.states ?? []) {
            const name = unique(`${camel(node.name)}_${state.symbol || camel(state.name)}`);
            variables.push({ name, kind: 'state', id: state.id });
            states.push({ name, label: `${node.name} · ${state.name}` });
        }
    }

    const owned = [];
    for (const shared of document.sharedParameters ?? []) owned.push({ owner: null, parameter: shared, label: shared.name });
    for (const edge of document.edges ?? []) {
        for (const parameter of edge.parameters ?? []) if (!parameter.sharedParameterId) owned.push({ owner: edge.name, parameter, label: `${edge.name} · ${parameter.name}` });
    }
    for (const node of document.nodes ?? []) {
        for (const term of node.sourceTerms ?? []) {
            for (const parameter of term.parameters ?? []) if (!parameter.sharedParameterId) owned.push({ owner: node.name, parameter, label: `${node.name} · ${parameter.name}` });
        }
    }
    const numeric = owned.filter(({ parameter }) => Number.isFinite(Number(parameter.value)) && parameter.symbol);
    const symbolCounts = new Map();
    for (const { parameter } of numeric) symbolCounts.set(parameter.symbol, (symbolCounts.get(parameter.symbol) ?? 0) + 1);
    const parameters = [];
    for (const { owner, parameter, label } of [...numeric.filter(({ parameter }) => parameter.tuning), ...numeric.filter(({ parameter }) => !parameter.tuning)]) {
        const name = unique(owner && symbolCounts.get(parameter.symbol) > 1 ? `${camel(owner)}_${parameter.symbol}` : parameter.symbol);
        variables.push({ name, kind: 'parameter', id: parameter.id, value: Number(parameter.value) });
        parameters.push({ name, label, tunable: Boolean(parameter.tuning) });
    }

    const measured = [];
    for (const column of measuredColumns) {
        const name = unique(`measured_${camel(column)}`);
        variables.push({ name, kind: 'measured', column });
        measured.push({ name, label: column });
    }
    return { variables, states, parameters, measured };
}

// Puts `functionName(` … `)` around the selected text, or around the whole expression when nothing is selected and it is not empty,
// or inserts `functionName()` with the cursor inside it for an empty one. Returns the new text and where the selection goes.
export function wrapInSummary(text, selectionStart, selectionEnd, functionName) {
    const hasSelection = selectionEnd > selectionStart;
    const start = hasSelection ? selectionStart : 0;
    const end = hasSelection ? selectionEnd : text.length;
    const inner = text.slice(start, end);
    if (!inner.trim()) {
        const insertion = `${functionName}()`;
        return { text: `${text.slice(0, selectionStart)}${insertion}${text.slice(selectionEnd)}`, selectionStart: selectionStart + functionName.length + 1, selectionEnd: selectionStart + functionName.length + 1 };
    }
    const wrapped = `${functionName}(${inner})`;
    return { text: `${text.slice(0, start)}${wrapped}${text.slice(end)}`, selectionStart: start, selectionEnd: start + wrapped.length };
}

// Inserts a name at the cursor, replacing a selection, with a cursor just after it.
export function insertName(text, selectionStart, selectionEnd, name) {
    const caret = selectionStart + name.length;
    return { text: `${text.slice(0, selectionStart)}${name}${text.slice(selectionEnd)}`, selectionStart: caret, selectionEnd: caret };
}

// What `window.engine.fit` is given as `config.objective` (see fitWithEngine in src/engineAdapter.mjs).
export function objectivePayload({ expression, direction, targetTime, timeStep, variables, constraints = [] }) {
    return {
        expression: expression.trim(), direction: direction === 'maximise' ? 'maximise' : 'minimise', targetTime, timeStep, variables,
        constraints: constraints.map(({ expression: limited, relation, limit }) => ({ expression: limited.trim(), relation: relation === '>=' ? '>=' : '<=', limit: Number(limit) }))
    };
}

// The limit rows a person has filled in, or why one is not usable. A row left entirely empty is just ignored.
export function constraintRows(rows) {
    const constraints = [];
    for (const [index, row] of rows.entries()) {
        const expression = String(row.expression ?? '').trim();
        const limit = String(row.limit ?? '').trim();
        if (!expression && !limit) continue;
        if (!expression) return { error: `Limit ${index + 1} needs something to limit, for example max(…) of a state.`, constraints: [] };
        if (!limit || !Number.isFinite(Number(limit))) return { error: `Limit ${index + 1} needs a number to stay within.`, constraints: [] };
        constraints.push({ expression, relation: row.relation === '>=' ? '>=' : '<=', limit: Number(limit) });
    }
    return { error: '', constraints };
}

// Why a run length and step cannot be used, or '' when they can.
export function runSettingsError(targetTime, timeStep) {
    if (!(targetTime > 0) || !Number.isFinite(targetTime)) return 'Enter how long each simulation runs, in seconds, above zero.';
    if (!(timeStep > 0) || !Number.isFinite(timeStep)) return 'Enter a time step above zero, in seconds.';
    if (timeStep > targetTime) return 'The time step is longer than the run.';
    return '';
}
