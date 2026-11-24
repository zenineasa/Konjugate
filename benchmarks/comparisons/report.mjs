/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Draws the comparisons (compare.mjs, openmodelica/runOpenModelica.mjs) as work–precision diagrams and writes the Performance section:
//
//   node benchmarks/comparisons/report.mjs <directory>        a directory holding comparisons.json, or a results directory holding comparisons/
//
// Reads <results>/comparisons/comparisons.json and writes, beside it, comparisons.csv, plots/<problem>-<family>.svg and .csv and
// performance.html, a self-contained page; and puts the same section, with the plots inline, into <results>/report.html when there is
// one, in place of any it had. A work–precision diagram is one problem and one family of methods: the error each run reached against the
// time it took to solve, both logarithmic, one point per tolerance from 1e-3 to 1e-10, so a curve lower and further left is cheaper for
// the same accuracy. Colour is the tool, the marker the method; every point names itself on hover, and every plot has its data table.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeEngineBuild } from '../lib/machine.mjs';
import { spread, timingStatistics } from '../lib/metrics.mjs';
import { darkTheme, formatNumber, lightTheme } from '../lib/plots.mjs';

const tools = [
    { name: 'Konjugate', colour: 'var(--series-1)' },
    { name: 'Konjugate C++ export', colour: 'var(--series-2)' },
    { name: 'SciPy', colour: 'var(--series-3)' },
    { name: 'Julia', colour: 'var(--series-4)' },
    { name: 'OpenModelica', colour: 'var(--series-7)', caveat: ' (Linux container, background services running, not timing-comparable)' }
];
const extraTheme = { light: '--series-7: #6250d6;', dark: '--series-7: #9085e9;' };
const methodNames = { dormandPrince54: 'Adaptive (Dormand–Prince 5(4))', rodas4: 'Stiff (Rodas4)', bdf: 'BDF' };
const shapes = ['circle', 'square', 'triangle', 'diamond', 'cross'];

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const median = (values) => spread(values).median;
const minimum = (values) => Math.min(...values);
// Above this, the interquartile range of a measurement's runs over their median, the measurement is flagged as noisy.
export const noisyWithinRun = 0.05;

// A record's timing: its minimum (the headline), median, interquartile range and minimum over median; across sessions (combine.mjs), the
// spread of the sessions' minimums, (largest − smallest) / smallest; and whether the runs within a session spread more than 5 %.
export function timingOf(record) {
    const stats = timingStatistics(record.solveSeconds);
    const within = record.withinRunSpread ?? (stats.count >= 3 && stats.median > 0 ? stats.interquartileRange / stats.median : null);
    const sessions = record.sessionMinimums ?? null;
    const between = sessions && sessions.length > 1 ? (Math.max(...sessions) - Math.min(...sessions)) / Math.min(...sessions) : null;
    return { ...stats, within, between, sessions: sessions?.length ?? 1, noisy: within !== null && within > noisyWithinRun };
}
const percent = (value) => (value === null || value === undefined ? '–' : `${(100 * value).toFixed(1)} %`);
const seconds = (value) => (value >= 1 ? `${formatNumber(value)} s` : value >= 1e-3 ? `${formatNumber(value * 1e3)} ms` : `${formatNumber(value * 1e6)} µs`);

function seriesKey(record) {
    const method = methodNames[record.method] ?? record.method;
    const caveat = tools.find((tool) => tool.name === record.tool)?.caveat ?? '';
    return `${record.tool} · ${method}${record.switching === 'given' ? ' (switching instants given)' : ''}${caveat}`;
}

function marker(shape, x, y, colour) {
    const r = 4.5;
    const style = `fill="${colour}" stroke="var(--surface-1)" stroke-width="1.5"`;
    if (shape === 'square') return `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" ${style}/>`;
    if (shape === 'triangle') return `<path d="M${x},${y - r - 1} L${x + r + 1},${y + r} L${x - r - 1},${y + r} Z" ${style}/>`;
    if (shape === 'diamond') return `<path d="M${x},${y - r - 1} L${x + r + 1},${y} L${x},${y + r + 1} L${x - r - 1},${y} Z" ${style}/>`;
    if (shape === 'cross') return `<path d="M${x - r},${y - r} L${x + r},${y + r} M${x - r},${y + r} L${x + r},${y - r}" stroke="${colour}" stroke-width="2.5"/>`;
    return `<circle cx="${x}" cy="${y}" r="${r}" ${style}/>`;
}

// One work–precision panel: series [{ key, tool, shape, points: [{ error, time, tolerance }] }].
function workPrecisionSvg({ title, series }) {
    const width = 560;
    const height = 360;
    const margin = { left: 64, right: 16, top: 12, bottom: 44 };
    const points = series.flatMap((entry) => entry.points);
    const errorFloor = 1e-16;
    const xs = points.map((point) => Math.log10(Math.max(point.error, errorFloor)));
    const ys = points.map((point) => Math.log10(point.time));
    const range = (values) => [Math.floor(Math.min(...values)), Math.ceil(Math.max(...values))].map((value, index, all) => (all[0] === all[1] && index === 1 ? value + 1 : value));
    const [x0, x1] = range(xs);
    const [y0, y1] = range(ys);
    const px = (value) => margin.left + ((Math.log10(Math.max(value, errorFloor)) - x0) / (x1 - x0)) * (width - margin.left - margin.right);
    const py = (value) => height - margin.bottom - ((Math.log10(value) - y0) / (y1 - y0)) * (height - margin.top - margin.bottom);
    const grid = [];
    for (let exponent = x0; exponent <= x1; ++exponent) {
        const x = px(10 ** exponent);
        grid.push(`<line x1="${x}" x2="${x}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="var(--grid)" stroke-width="1"/>`);
        if ((x1 - x0) <= 10 || exponent % 2 === 0) grid.push(`<text x="${x}" y="${height - margin.bottom + 16}" text-anchor="middle" font-size="11" fill="var(--text-muted)">1e${exponent}</text>`);
    }
    for (let exponent = y0; exponent <= y1; ++exponent) {
        const y = py(10 ** exponent);
        grid.push(`<line x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`);
        grid.push(`<text x="${margin.left - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)">${seconds(10 ** exponent)}</text>`);
    }
    const marks = series.map((entry) => {
        const colour = tools.find((tool) => tool.name === entry.tool).colour;
        const sorted = entry.points.slice().sort((left, right) => right.tolerance - left.tolerance);
        const line = sorted.length > 1 ? `<polyline points="${sorted.map((point) => `${px(point.error).toFixed(1)},${py(point.time).toFixed(1)}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="2"${entry.dashed ? ' stroke-dasharray="6 4"' : ''}/>` : '';
        const dots = sorted.map((point) => `<g>${marker(entry.shape, px(point.error), py(point.time), colour)}<title>${escapeXml(`${entry.key}\nrtol ${point.tolerance.toExponential(0)}: error ${point.error.toExponential(2)}, solve ${seconds(point.time)} (minimum; median ${seconds(timingOf(point.record).median)})${timingOf(point.record).noisy ? ', noisy' : ''}`)}</title></g>`).join('');
        return `<g>${line}${dots}</g>`;
    }).join('');
    const axes = `<line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="var(--axis)"/>`
        + `<text x="${(margin.left + width - margin.right) / 2}" y="${height - 6}" text-anchor="middle" font-size="12" fill="var(--text-secondary)">Error, largest relative to each state's range (log)</text>`
        + `<text transform="translate(14 ${(margin.top + height - margin.bottom) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="var(--text-secondary)">Solve time (log)</text>`;
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, -apple-system, sans-serif">${grid.join('')}${axes}${marks}</svg>`;
}

function legend(series) {
    return `<ul class="legend">${series.map((entry) => {
        const colour = tools.find((tool) => tool.name === entry.tool).colour;
        return `<li><svg width="26" height="14" aria-hidden="true"><line x1="0" x2="26" y1="7" y2="7" stroke="${colour}" stroke-width="2"${entry.dashed ? ' stroke-dasharray="6 4"' : ''}/>${marker(entry.shape, 13, 7, colour)}</svg>${escapeXml(entry.key)}</li>`;
    }).join('')}</ul>`;
}

function panelSeries(records) {
    const byKey = new Map();
    for (const record of records) {
        if (!record.ok) continue;
        const key = seriesKey(record);
        if (!byKey.has(key)) byKey.set(key, { key, tool: record.tool, method: record.method, dashed: record.switching === 'given' || record.tool === 'OpenModelica', points: [] });
        byKey.get(key).points.push({ error: Number(record.relativeError), time: minimum(record.solveSeconds), tolerance: record.tolerance, record });
    }
    const series = [...byKey.values()].sort((left, right) => tools.findIndex((tool) => tool.name === left.tool) - tools.findIndex((tool) => tool.name === right.tool) || left.key.localeCompare(right.key));
    const methodsOf = new Map();
    for (const entry of series) {
        if (!methodsOf.has(entry.tool)) methodsOf.set(entry.tool, []);
        const methods = methodsOf.get(entry.tool);
        if (!methods.includes(entry.method)) methods.push(entry.method);
        entry.shape = shapes[methods.indexOf(entry.method) % shapes.length];
    }
    return series;
}

function panelCsv(series) {
    const lines = ['series,tool,method,switching,tolerance,relativeError,solveMinSeconds,solveMedianSeconds,solveIqrSeconds,solveMinOverMedian,runs,sessions,betweenSessionSpread,withinRunSpread,noisy,evaluations,jacobians,factorisations'];
    for (const entry of series) {
        for (const { record } of entry.points) {
            const t = timingOf(record);
            lines.push([`"${entry.key}"`, record.tool, record.method, record.switching ?? '', record.tolerance, record.relativeError, t.minimum, t.median, t.interquartileRange, t.minimumOverMedian, t.count, t.sessions,
                t.between ?? '', t.within ?? '', t.noisy, record.work?.nfev ?? '', record.work?.njev ?? '', record.work?.nlu ?? ''].join(','));
        }
    }
    return `${lines.join('\n')}\n`;
}

function dataTable(series) {
    const rows = series.flatMap((entry) => entry.points.slice().sort((left, right) => right.tolerance - left.tolerance).map(({ record, error }) => {
        const t = timingOf(record);
        return `<tr><td>${escapeXml(entry.key)}</td><td class="number">${record.tolerance.toExponential(0)}</td><td class="number">${error.toExponential(2)}</td><td class="number"><strong>${seconds(t.minimum)}</strong></td><td class="number">${seconds(t.median)}</td><td class="number">${seconds(t.interquartileRange)}</td><td class="number">${t.minimumOverMedian?.toFixed(3) ?? '–'}</td><td class="number">${t.count}${t.sessions > 1 ? ` in ${t.sessions} sessions` : ''}</td><td class="number">${percent(t.between)}</td><td>${t.noisy ? `noisy: ${percent(t.within)}` : ''}</td><td class="number">${record.work?.nfev ?? '–'}</td><td class="number">${record.work?.nlu ?? '–'}</td></tr>`;
    }));
    return `<details><summary>Data table</summary><div class="scroll"><table><thead><tr><th>Series</th><th class="number">rtol</th><th class="number">Error</th><th class="number">Minimum solve</th><th class="number">Median</th><th class="number">IQR</th><th class="number">Min / median</th><th class="number">Runs</th><th class="number">Between sessions</th><th>Within a run</th><th class="number">Evaluations</th><th class="number">Factorisations</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></details>`;
}

function failures(records) {
    const failed = records.filter((record) => !record.ok && !String(record.error).startsWith('not run'));
    const skipped = records.filter((record) => !record.ok && String(record.error).startsWith('not run'));
    const grouped = new Map();
    for (const record of failed) {
        const key = `${seriesKey(record)}: ${String(record.error).split('\n')[0].slice(0, 160)}`;
        grouped.set(key, [...(grouped.get(key) ?? []), record.tolerance]);
    }
    const items = [...grouped].map(([key, tolerancesFailed]) => `<li>Failed at rtol ${tolerancesFailed.filter(Boolean).map((value) => value.toExponential(0)).join(', ')}: ${escapeXml(key)}</li>`);
    const skippedSeries = [...new Set(skipped.map(seriesKey))];
    if (skippedSeries.length) items.push(`<li>Not run past a tolerance whose solve took longer than 120 s: ${escapeXml(skippedSeries.join('; '))}</li>`);
    return items.length ? `<ul class="notes">${items.join('')}</ul>` : '';
}

function startupTable(summary) {
    const records = summary.records.filter((record) => record.ok);
    const rows = [];
    const konjugate = records.filter((record) => record.tool === 'Konjugate');
    if (konjugate.length) {
        const overhead = konjugate.map((record) => minimum(record.wallSeconds) - minimum(record.solveSeconds) - minimum(record.planningSeconds));
        rows.push(['Konjugate engine', 'Process start, reading and validating the project, writing the result (wall less planning and solving, each its minimum), median over every configuration', seconds(median(overhead))]);
        rows.push(['Konjugate engine', 'Planning: compiling the model\'s equations into an execution plan (the engine\'s planningNanoseconds; minimum, median over every configuration)', seconds(median(konjugate.map((record) => minimum(record.planningSeconds))))]);
    }
    const exported = records.filter((record) => record.tool === 'Konjugate C++ export');
    for (const problem of [...new Set(exported.map((record) => record.problem))]) {
        const compile = exported.filter((record) => record.problem === problem).map((record) => record.compileSeconds);
        rows.push(['Konjugate C++ export', `Compiling the exported program of ${problem} (${exported[0].compileFlags}), median over its builds`, seconds(median(compile))]);
    }
    if (summary.startup?.scipy?.interpreterAndImport) rows.push(['SciPy', 'Starting Python and importing NumPy and scipy.integrate', seconds(summary.startup.scipy.interpreterAndImport.minimum)]);
    if (summary.startup?.julia?.bareStart) rows.push(['Julia', 'Starting Julia', seconds(summary.startup.julia.bareStart.minimum)]);
    if (summary.startup?.julia?.startAndLoad) rows.push(['Julia', 'Starting Julia and loading the (precompiled) solver packages', seconds(summary.startup.julia.startAndLoad.minimum)]);
    const julia = records.filter((record) => record.tool === 'Julia');
    for (const method of [...new Set(julia.map((record) => record.method))]) {
        // The first solve of a method on a problem compiles it: the first tolerance of each problem, less its own warm solve.
        const firsts = [...new Set(julia.map((record) => record.problem))].map((problem) => julia.find((record) => record.problem === problem && record.method === method)).filter(Boolean)
            .map((record) => record.firstSolveSeconds - minimum(record.solveSeconds));
        if (firsts.length) rows.push(['Julia', `First solve of ${method} on a problem: compiling it (JIT), less a warm solve; median over problems`, seconds(median(firsts))]);
    }
    for (const [label, entry] of Object.entries(summary.startup?.openmodelica ?? {})) rows.push(['OpenModelica (Linux container, background services running, not timing-comparable)', label, seconds(entry)]);
    return `<div class="scroll"><table><thead><tr><th>Tool</th><th>What</th><th class="number">Time</th></tr></thead><tbody>${rows.map(([tool, what, time]) => `<tr><td>${escapeXml(tool)}</td><td>${escapeXml(what)}</td><td class="number">${time}</td></tr>`).join('')}</tbody></table></div>`;
}

function versionsList(summary) {
    const v = summary.versions;
    const items = [
        v.konjugate && ['Konjugate', `${v.konjugate.version}, ${v.konjugate.provenance ? `built from commit ${v.konjugate.provenance.builtFrom} with uncommitted changes${v.konjugate.provenance.committedAs ? `, committed as ${v.konjugate.provenance.committedAs}` : ''} (the session's provenance note)` : `commit ${v.konjugate.commit}${v.konjugate.workingTreeChanges ? ' (with uncommitted changes)' : ''}`}; engine ${describeEngineBuild(v.konjugate.engineBuild) ?? 'build not recorded'}; code export compiled with ${v.konjugate.exportCompiler}`],
        v.scipy && ['SciPy', `SciPy ${v.scipy.scipy}, NumPy ${v.scipy.numpy}, Python ${v.scipy.python}`],
        v.julia && ['Julia', `Julia ${v.julia.julia}; ${Object.entries(v.julia.packages).map(([name, version]) => `${name} ${version}`).join(', ')}`],
        v.openmodelica && ['OpenModelica', v.openmodelica]
    ].filter(Boolean);
    return `<dl class="machine">${items.map(([term, value]) => `<dt>${escapeXml(term)}</dt><dd>${escapeXml(value)}</dd>`).join('')}</dl>`;
}

export function performanceSection(summary, plotsDirectoryName = 'comparisons/plots') {
    const problems = summary.problems.filter((problem) => summary.records.some((record) => record.problem === problem.id));
    const blocks = [];
    const files = [];
    for (const problem of problems) {
        const records = summary.records.filter((record) => record.problem === problem.id);
        const panels = [];
        for (const [familyKey, family] of Object.entries(summary.families)) {
            const series = panelSeries(records.filter((record) => record.family === familyKey || (record.tool === 'OpenModelica' && familyKey === 'multistep')));
            if (!series.length) continue;
            const id = `${problem.id}-${familyKey}`;
            const svg = workPrecisionSvg({ title: `${problem.title}: ${family.title}`, series });
            files.push({ id, svg, csv: panelCsv(series) });
            panels.push(`<figure><figcaption><strong>${escapeXml(family.title)}</strong> · lower and further left is less time for a smaller error · <a href="${plotsDirectoryName}/${id}.csv">data</a></figcaption>${svg}${legend(series)}${dataTable(series)}</figure>`);
        }
        const skipped = problem.skipped?.explicit ? `<p>Explicit methods are not run: ${escapeXml(problem.skipped.explicit)}</p>` : '';
        const reference = summary.references?.[problem.id];
        blocks.push(`<section id="performance-${escapeXml(problem.id)}"><h3>${escapeXml(problem.title)}</h3><p>${problem.states} states, ${problem.compared} compared at ${Math.round(problem.run.targetTime / problem.run.outputInterval) + 1} samples to t = ${formatNumber(problem.run.targetTime)}. Reference: ${escapeXml(reference?.source ?? '')}${reference?.radauBdfAgreement !== undefined ? ` (Radau and BDF agree to ${Number(reference.radauBdfAgreement).toExponential(1)} of each state's range; ${reference.checkpointsCompared} committed checkpoints within ${Number(reference.largestRelativeDifferenceFromCommittedCheckpoints).toExponential(1)})` : ''}.</p>${skipped}<div class="charts">${panels.join('')}</div>${failures(records)}</section>`);
    }
    const html = `<section id="performance"><h2>Performance</h2>
<p class="lede">Konjugate evaluated against established tools, reproducibly: the same equations, absolute tolerances and output samples under Konjugate's engine and its exported C++, SciPy's <code>solve_ivp</code>, Julia's DifferentialEquations.jl${summary.records.some((record) => record.tool === 'OpenModelica') ? ' and OpenModelica' : ''}, at relative tolerances from 1e-3 to 1e-10. Each point is one tolerance: the error it reached against the minimum of its timed solves (after a warm-up), on this computer only; the minimum is the headline for every tool, since noise on a computer only adds time, and each table gives the median, interquartile range and minimum over median beside it, the spread between sessions when several were combined, and flags a measurement whose runs spread more than 5 % (interquartile range over median). Solve time is the integration alone: for Konjugate the engine's own integration time, for the exported C++ the whole program's run (it has no timer of its own, so its few milliseconds of starting and writing its CSV are included), for SciPy and Julia the call to the solver; starting, loading and compiling are in the table below. Konjugate, its C++ export, SciPy and Julia were timed natively in one session, interleaved: each round ran every tool's configurations in turn, once untimed and once timed, and the rounds repeated, with Docker quit. ${summary.records.some((record) => record.tool === 'OpenModelica') ? 'OpenModelica has no macOS build, so it ran afterwards, on its own, in its arm64 Linux image under Docker, whose virtual machine and any background services Docker starts run beside it: its errors are comparable with the rest, its times (its own simulation timer, drawn dashed) are not.' : ''} The scripts are in <code>benchmarks/comparisons/</code>; the method is in <code>benchmarks/README.md</code>.</p>
<h3>Starting, loading and compiling, apart from solving</h3>${startupTable(summary)}
<h3>Versions</h3>${versionsList(summary)}
${blocks.join('\n')}
</section>`;
    return { html, files };
}

const styles = `
.viz-root { color-scheme: light; ${lightTheme} ${extraTheme.light} }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root { color-scheme: dark; ${darkTheme} ${extraTheme.dark} } }
:root[data-theme="dark"] .viz-root { color-scheme: dark; ${darkTheme} ${extraTheme.dark} }
#performance .charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(560px, 1fr)); gap: 16px; }
#performance figure { margin: 0; background: var(--surface-1); padding: 8px; border: 1px solid var(--grid); border-radius: 6px; }
#performance figure svg { max-width: 100%; height: auto; }
#performance .legend { list-style: none; padding: 0; margin: 4px 0; font-size: 12px; color: var(--text-secondary); columns: 2; }
#performance .legend li { display: flex; align-items: center; gap: 6px; break-inside: avoid; }
#performance table { font-size: 12px; } #performance .number { text-align: right; font-variant-numeric: tabular-nums; }
`;

function standalone(section, summary) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Konjugate · Performance against established tools</title>
<style>body { margin: 0; } .viz-root { background: var(--page); color: var(--text-primary); font: 15px/1.5 system-ui, -apple-system, sans-serif; } main { max-width: 1200px; margin: 0 auto; padding: 24px; } p, dd, li { color: var(--text-secondary); } .lede { color: var(--text-primary); } table { border-collapse: collapse; width: 100%; background: var(--surface-1); } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--grid); } dl.machine { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; } dt { font-weight: 600; } .scroll { overflow-x: auto; } a { color: var(--series-1); } ${styles}</style></head>
<body class="viz-root"><main><h1>Konjugate · Performance against established tools</h1><p>Measured on ${escapeXml([summary.machine.model, summary.machine.chip, `${summary.machine.logicalProcessors} cores`, `${Math.round(summary.machine.memoryBytes / 2 ** 30)} GiB`, summary.machine.operatingSystem].filter(Boolean).join(' · '))}, updated ${escapeXml(summary.updatedAt)}.</p>${section.replace('<section id="performance"><h2>Performance</h2>', '<section id="performance">')}</main></body></html>\n`;
}

// Writes, in a directory holding comparisons.json: comparisons.csv, plots/ and performance.html; and puts the Performance section into
// reportPath, when there is that report.
export async function writeComparisonReport(comparisons, reportPath = null) {
    const summary = JSON.parse(readFileSync(join(comparisons, 'comparisons.json'), 'utf8'));

    // The section in report.html links its data from beside report.html (comparisons/plots/); performance.html, inside comparisons/, from plots/.
    const { html, files } = performanceSection(summary);
    const standaloneHtml = performanceSection(summary, 'plots').html;
    await mkdir(join(comparisons, 'plots'), { recursive: true });
    for (const { id, svg, csv } of files) {
        await writeFile(join(comparisons, 'plots', `${id}.svg`), `<?xml version="1.0" encoding="UTF-8"?>\n${svg.replace('<svg ', `<svg style="${lightTheme.replace(/\s+/g, ' ')} ${extraTheme.light} --surface-1: #fcfcfb; background: #fcfcfb" `)}\n`);
        await writeFile(join(comparisons, 'plots', `${id}.csv`), csv);
    }
    const columns = ['problem', 'tool', 'method', 'family', 'switching', 'tolerance', 'ok', 'relativeError', 'solveMinSeconds', 'solveMedianSeconds', 'solveMaxSeconds', 'solveIqrSeconds', 'solveMinOverMedian', 'runs', 'sessions', 'betweenSessionSpread', 'withinRunSpread', 'noisy', 'firstSolveSeconds', 'wallMedianSeconds', 'planningMedianSeconds', 'compileSeconds', 'peakResidentBytes', 'evaluations', 'jacobians', 'factorisations', 'steps', 'rejected', 'error'];
    const quote = (value) => (value === undefined || value === null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));
    const rows = summary.records.map((record) => {
        const solve = record.solveSeconds?.length ? timingOf(record) : null;
        return [record.problem, record.tool, record.method, record.family, record.switching, record.tolerance, record.ok, record.relativeError, solve?.minimum, solve?.median, solve?.maximum, solve?.interquartileRange, solve?.minimumOverMedian, solve?.count, solve?.sessions, solve?.between, solve?.within, solve?.noisy,
            record.firstSolveSeconds, record.wallSeconds ? median(record.wallSeconds) : null, record.planningSeconds ? median(record.planningSeconds) : null, record.compileSeconds, record.peakResidentBytes,
            record.work?.nfev, record.work?.njev, record.work?.nlu, record.work?.steps, record.work?.rejected, record.error].map(quote).join(',');
    });
    await writeFile(join(comparisons, 'comparisons.csv'), `${columns.join(',')}\n${rows.join('\n')}\n`);
    await writeFile(join(comparisons, 'performance.html'), standalone(standaloneHtml, summary));
    if (reportPath && existsSync(reportPath)) {
        let report = readFileSync(reportPath, 'utf8').replace(/\n?<style id="performance-styles">[\s\S]*?<\/style>/, '').replace(/\n?<section id="performance">[\s\S]*?<\/section>\n<!-- end performance -->/, '');
        report = report.replace('</head>', `<style id="performance-styles">${styles}</style>\n</head>`).replace('\n</main>', `\n${html}\n<!-- end performance -->\n</main>`);
        if (!report.includes('href="#performance"')) report = report.replace(/(<nav><p>[\s\S]*?)(<\/p><\/nav>)/, '$1 · <a href="#performance">Performance</a>$2');
        await writeFile(reportPath, report);
    }
    console.log(`Wrote ${join(comparisons, 'performance.html')}${reportPath && existsSync(reportPath) ? ` and the Performance section of ${reportPath}` : ''}.`);
}

// node benchmarks/comparisons/report.mjs <directory>: a directory holding comparisons.json, or one holding comparisons/ (and report.html).
if (import.meta.url === `file://${process.argv[1]}`) {
    const directory = process.argv[2];
    if (!directory) throw new Error('Name the directory holding comparisons.json, or the results directory holding comparisons/.');
    if (existsSync(join(directory, 'comparisons.json'))) await writeComparisonReport(directory);
    else await writeComparisonReport(join(directory, 'comparisons'), join(directory, 'report.html'));
}
