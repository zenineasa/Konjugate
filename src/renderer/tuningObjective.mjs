/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Parameter tuning card needs to let a person write an objective (docs/proposals/parameterTuningObjectives.md): the names
// the expression may use, worked out from the project, and the small text edits the summary buttons make. The engine reads the
// expression (engine/include/fittingObjective.hpp); this only decides what the names are and what they stand for. Pure functions.

const upperFirst = (text) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text);
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
            const name = unique(`${camel(node.name)}${upperFirst(state.symbol || camel(state.name))}`);
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
        const name = unique(owner && symbolCounts.get(parameter.symbol) > 1 ? `${camel(owner)}${upperFirst(parameter.symbol)}` : parameter.symbol);
        variables.push({ name, kind: 'parameter', id: parameter.id, value: Number(parameter.value) });
        parameters.push({ name, label, tunable: Boolean(parameter.tuning) });
    }

    const measured = [];
    for (const column of measuredColumns) {
        const name = unique(`measured${upperFirst(camel(column))}`);
        variables.push({ name, kind: 'measured', column });
        measured.push({ name, label: column });
    }
    return { variables, states, parameters, measured };
}

// "Match measured data" written as an objective (docs/proposals/tuningEditorsAndPrograms.md, step 3): for each column matched to a
// state, the mean over the run of the squared difference between the two, added up. The engine's own fit adds up the squared
// differences at every row instead; that is this times the number of rows, so the same values are best for both, and the mean is a
// number people can read (the mean squared error, in the state's unit squared). `matched` is [{ columnName, stateId }]; `vocabulary`
// is objectiveVocabulary's for the same document and columns. Returns the LaTeX, or null when nothing is matched.
export function measuredDataObjectiveLatex(matched, vocabulary, nameLatex) {
    const terms = matched.flatMap(({ columnName, stateId }) => {
        const state = vocabulary.variables.find((variable) => variable.kind === 'state' && variable.id === stateId);
        const column = vocabulary.variables.find((variable) => variable.kind === 'measured' && variable.column === columnName);
        return state && column ? [`\\operatorname{mean}\\left(\\left(${nameLatex(state.name)}-${nameLatex(column.name)}\\right)^{2}\\right)`] : [];
    });
    return terms.length ? terms.join('+') : null;
}

// What `window.engine.fit` is given as `config.objective` (see fitWithEngine in src/engineAdapter.mjs).
// `latex` is how the objective is written in the editor, kept so it can be shown again; the engine reads `expression`, its text form.
export function objectivePayload({ expression = '', latex = '', direction, targetTime, timeStep, variables, constraints = [], program = null }) {
    return {
        ...(program ? { program: { language: program.language, source: program.source, bindings: program.bindings.map((binding) => ({ ...binding })) } } : {}),
        expression: expression.trim(), latex, direction: direction === 'maximise' ? 'maximise' : 'minimise', targetTime, timeStep, variables,
        constraints: constraints.map(({ expression: limited = '', latex = '', report = '', relation, limit }) => ({
            ...(report ? { report } : { expression: limited.trim(), latex }), relation: relation === '>=' ? '>=' : '<=', limit: Number(limit)
        }))
    };
}

// The limit rows a person has filled in, or why one is not usable. A row is { expression, latex, relation, limit, problem }: `expression` is
// the objective editor's text for it (empty while the formula does not read) and `problem` what is wrong with it then. A row left entirely
// empty is just ignored. A row with `report` (a string, possibly empty) limits a number the objective program reports by that name.
export function constraintRows(rows) {
    const constraints = [];
    for (const [index, row] of rows.entries()) {
        if (typeof row.report === 'string') {
            const report = row.report.trim();
            const bound = String(row.limit ?? '').trim();
            if (!report && !bound) continue;
            if (!report) return { error: `Limit ${index + 1} needs the name of a number the program reports.`, constraints: [] };
            if (!bound || !Number.isFinite(Number(bound))) return { error: `Limit ${index + 1} needs a number to stay within.`, constraints: [] };
            constraints.push({ report, relation: row.relation === '>=' ? '>=' : '<=', limit: Number(bound) });
            continue;
        }
        const expression = String(row.expression ?? '').trim();
        const limit = String(row.limit ?? '').trim();
        const written = String(row.latex ?? '').trim() !== '' || expression !== '';
        if (!written && !limit) continue;
        if (!expression) {
            return { error: written ? `Limit ${index + 1}: ${row.problem || 'the formula cannot be read.'}` : `Limit ${index + 1} needs something to limit, for example the max of a state.`, constraints: [] };
        }
        if (!limit || !Number.isFinite(Number(limit))) return { error: `Limit ${index + 1} needs a number to stay within.`, constraints: [] };
        constraints.push({ expression, latex: String(row.latex ?? ''), relation: row.relation === '>=' ? '>=' : '<=', limit: Number(limit) });
    }
    return { error: '', constraints };
}

// The names a program reports numbers by, as its source writes them: run.report("peak", ...) in either language.
export function reportedNames(source) {
    return [...new Set([...String(source ?? '').matchAll(/\breport\(\s*["']([^"'\n]+)["']/g)].map((match) => match[1]))];
}

// Why a run length and step cannot be used, or '' when they can.
export function runSettingsError(targetTime, timeStep) {
    if (!(targetTime > 0) || !Number.isFinite(targetTime)) return 'Enter how long each simulation runs, in seconds, above zero.';
    if (!(timeStep > 0) || !Number.isFinite(timeStep)) return 'Enter a time step above zero, in seconds.';
    if (timeStep > targetTime) return 'The time step is longer than the run.';
    return '';
}
