/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Hand-rolled CSV reader, symmetric with resultExport.mjs's csvField() writer. Deliberately
// minimal -- no quoted-field/embedded-newline/BOM handling -- malformed input is rejected with a
// clear message rather than repaired, matching the "require complete, regularly sampled input"
// v1 decision in docs/proposals/causalInference.md.

function splitLine(line) {
    return line.split(',');
}

// Column 0 is a numeric time column, consumed only for the caller's own use (this module does
// not validate spacing -- the engine's parseInferenceCsv() is the source of truth for that,
// since this parser's job is just turning file text into a shape the column-mapping UI can show
// before anything is sent to the engine).
export function parseCsv(content) {
    const lines = content.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
    if (lines.length < 2) throw new Error('The CSV must contain a header row and at least one data row.');
    const header = splitLine(lines[0]);
    if (header.length < 2) throw new Error('The CSV must contain a time column and at least one variable column.');
    const columnNames = header.slice(1).map((name) => name.trim());
    const rows = [];
    for (let index = 1; index < lines.length; index += 1) {
        const fields = splitLine(lines[index]);
        if (fields.length !== header.length) {
            throw new Error(`Row ${index + 1} has ${fields.length} fields, expected ${header.length}.`);
        }
        const time = Number(fields[0]);
        if (!Number.isFinite(time)) throw new Error(`Row ${index + 1}, column 1 ("${fields[0]}") is not a valid number.`);
        const values = fields.slice(1).map((field, columnIndex) => {
            const value = Number(field);
            if (!Number.isFinite(value)) {
                throw new Error(`Row ${index + 1}, column ${columnIndex + 2} ("${field}") is not a valid number.`);
            }
            return value;
        });
        rows.push({ time, values });
    }
    return { columnNames, rows };
}

const symbolPattern = /^[a-z][A-Za-z0-9]*$/;

// Derives a lower-camel-case candidate symbol from a CSV column header, matching the identifier
// shape assistantOperations.mjs's addState operation requires. Falls back to "value" for a
// header with no usable characters at all (e.g. one that is only punctuation) rather than
// producing an invalid symbol.
export function suggestSymbol(columnName) {
    const cleaned = columnName.replace(/[^A-Za-z0-9]+/g, ' ').trim();
    if (!cleaned) return 'value';
    const words = cleaned.split(/\s+/);
    const symbol = words
        .map((word, index) => (index === 0
            ? word.charAt(0).toLowerCase() + word.slice(1)
            : word.charAt(0).toUpperCase() + word.slice(1)))
        .join('');
    return symbolPattern.test(symbol) ? symbol : 'value';
}

// Maps each CSV column to an existing node/state by an exact (case-insensitive) match on state
// symbol or name -- deliberately no fuzzy/ranked suggestion, mirroring the Component Library's
// binary match-or-unbound auto-binding (docs/proposals/componentLibrary.md): a picker offering
// "close" candidates would reintroduce the exact wrong-guess risk that design avoids. A column
// with no match is reported as needing a new node, not silently skipped or guessed at.
//
// existingNodes: [{ id, states: [{ id, symbol, name }] }], a plain-data projection of the live
// model -- this function has no dependency on the renderer's Three.js-backed model shape, so it
// stays reusable by the future digital-twin CSV importer (docs/proposals/causalInference.md).
export function mapColumnsToNodes(columnNames, existingNodes) {
    return columnNames.map((columnName) => {
        const normalized = columnName.trim().toLowerCase();
        for (const node of existingNodes) {
            const state = node.states.find((candidate) =>
                candidate.symbol.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized);
            if (state) return { columnName, nodeId: node.id, stateId: state.id, createNew: false };
        }
        return { columnName, nodeId: null, stateId: null, createNew: true, suggestedSymbol: suggestSymbol(columnName) };
    });
}
