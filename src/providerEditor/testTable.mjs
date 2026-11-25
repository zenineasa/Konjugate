/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's Test (docs/proposals/codeEditor.md, "Test: run it where you write it"), as data: the inputs it runs at, the checks it
// passed, its problems with their lines, and the engine's trace (testProgram) as a table and a small plot. Pure: the Test panel draws
// these, and a unit test reads them.

const checkLabels = { ports: 'ports', outputs: 'outputs', purity: 'purity', memory: 'memory round trip', jacobian: 'Jacobian against differences' };

// The inputs Test runs at: every input, parameter and constant the program declares, each at its value in the model now, else its
// default, else 0. declared: [{ key, kind, unit, default }] (the engine's description, or the source's). modelValues: { key: value }.
export function testInputs(declared, modelValues = {}) {
    return (declared ?? []).map((port) => {
        const fromModel = modelValues[port.key];
        const value = Number.isFinite(Number(fromModel)) && fromModel !== null && fromModel !== undefined
            ? Number(fromModel)
            : Number.isFinite(Number(port.default)) && port.default !== null && port.default !== undefined ? Number(port.default) : 0;
        return { key: port.key, kind: port.kind ?? 'input', unit: port.unit ?? '', value, fromModel: fromModel !== undefined && fromModel !== null };
    });
}

// What Test found: whether it passed, each standard check as a line (one that did not run left out), and each problem with where it is.
export function testSummary(answer) {
    const checks = (answer?.checks ?? [])
        .filter((check) => check.passed !== null && check.passed !== undefined)
        .map((check) => ({ name: check.name, label: checkLabels[check.name] ?? check.name, passed: Boolean(check.passed) }));
    const details = answer?.problemDetails ?? [];
    const problems = (answer?.problems ?? []).map((message, index) => {
        const detail = details[index] ?? {};
        return { message: detail.message ?? message, line: Number.isInteger(detail.line) ? detail.line : null,
            step: Number.isInteger(detail.step) ? detail.step : null, time: Number.isFinite(detail.time) ? detail.time : null };
    });
    return { passed: Boolean(answer?.ok) && !problems.length, checks, problems };
}

// The trace as a table: step, time, every output, then every memory value (a value with several entries as one column each); memory that
// is not a number the person reads (a random stream's state) is left out by name.
export function traceTable(trace, { hiddenMemory = [] } = {}) {
    const rows = trace?.rows ?? [];
    const hidden = new Set(hiddenMemory);
    const outputKeys = [];
    const memoryColumns = [];
    for (const row of rows) {
        for (const key of Object.keys(row.outputs ?? {})) if (!outputKeys.includes(key)) outputKeys.push(key);
        for (const [name, values] of Object.entries(row.memory ?? {})) {
            if (hidden.has(name)) continue;
            const count = Array.isArray(values) ? values.length : 1;
            for (let index = 0; index < count; index += 1) {
                const key = count > 1 ? `${name}[${index}]` : name;
                if (!memoryColumns.some((column) => column.key === key)) memoryColumns.push({ key, name, index: count > 1 ? index : null });
            }
        }
    }
    const columns = [
        { key: 'step', label: 'step', kind: 'step' },
        { key: 'time', label: 't', kind: 'time' },
        ...outputKeys.map((key) => ({ key, label: key, kind: 'output' })),
        ...memoryColumns.map(({ key }) => ({ key, label: key, kind: 'memory' }))
    ];
    const memoryValue = (row, column) => {
        const values = row.memory?.[column.name];
        if (Array.isArray(values)) return values[column.index ?? 0] ?? null;
        return values ?? null;
    };
    return {
        columns,
        rows: rows.map((row) => [row.step, row.time, ...outputKeys.map((key) => row.outputs?.[key] ?? null), ...memoryColumns.map((column) => memoryValue(row, column))])
    };
}

// A cell as the table shows it: six significant figures (copying the table gives every digit).
export function formatCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return String(Number(number.toPrecision(6)));
}

// The table as tab-separated text, every number at full precision.
export function tableText(table) {
    const cell = (value) => (value === null || value === undefined ? '' : String(value));
    return [table.columns.map((column) => column.label).join('\t'), ...table.rows.map((row) => row.map(cell).join('\t'))].join('\n');
}

// The small plot's line through one column: an SVG path in a width × height box, the column's range filling the height (a flat line
// across the middle when it does not change); a value that is not a finite number breaks the line.
export function plotPath(values, width = 240, height = 48, padding = 3) {
    const finite = values.map(Number).filter(Number.isFinite);
    if (!finite.length) return '';
    const low = Math.min(...finite);
    const high = Math.max(...finite);
    const span = high - low;
    const x = (index) => (values.length === 1 ? width / 2 : padding + (index * (width - 2 * padding)) / (values.length - 1));
    const y = (value) => (span === 0 ? height / 2 : height - padding - ((value - low) / span) * (height - 2 * padding));
    let path = '';
    let drawing = false;
    values.forEach((raw, index) => {
        const value = Number(raw);
        if (!Number.isFinite(value) || raw === null) { drawing = false; return; }
        path += `${drawing ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)} `;
        drawing = true;
    });
    if (values.length === 1 || finite.length === 1) {
        const index = values.findIndex((raw) => Number.isFinite(Number(raw)) && raw !== null);
        path = `M${(x(index) - 2).toFixed(1)} ${y(finite[0]).toFixed(1)} L${(x(index) + 2).toFixed(1)} ${y(finite[0]).toFixed(1)}`;
    }
    return path.trim();
}

// The hint after a passing Test (an input whose change moves no output over the steps): how an input is changed, a little and never
// to the same value, and whether the outputs moved, compared exactly, step by step.
export function nudgedValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return 1;
    return number * 1.1 + Math.sign(number) * 1e-3;
}

export function outputsUnmoved(baselineRows, probeRows) {
    const outputsOf = (rows) => JSON.stringify((rows ?? []).map((row) => row.outputs ?? {}));
    return (baselineRows ?? []).length > 0 && outputsOf(baselineRows) === outputsOf(probeRows);
}
