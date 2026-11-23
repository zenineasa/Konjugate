/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The benchmark report: one self-contained HTML file (no network, no external scripts or fonts) holding every problem's checks, results
// and plots, and for a --full run the timings and the machine they were measured on.

import { darkTheme, escapeXml, formatNumber, layout, lightTheme, renderLegend, renderSvg } from './plots.mjs';

const resultColumns = [
    ['case', 'Case'], ['method', 'Method'], ['globalTimeStep', 'h (s)'], ['substeps', 'Substeps'], ['targetTime', 'Horizon (s)'],
    ['maxAbsError', 'Max abs error'], ['rmse', 'RMSE'], ['relativeError', 'Relative error'], ['conservationError', 'Conservation error'],
    ['steadyStateError', 'Steady-state error'], ['observedOrder', 'Observed order'], ['globalSteps', 'Steps'], ['substepsExecuted', 'Substeps run'],
    ['evaluations', 'Evaluations'], ['note', 'Note']
];

function limitText(limit) {
    if (limit.min !== undefined && limit.max !== undefined) return `${formatNumber(limit.min)} to ${formatNumber(limit.max)}`;
    if (limit.max !== undefined) return `≤ ${formatNumber(limit.max)}`;
    return `≥ ${formatNumber(limit.min)}`;
}

const status = (pass) => (pass ? '<span class="status good">✓ Pass</span>' : '<span class="status critical">✕ Fail</span>');

function checksTable(checks) {
    return `<table class="checks"><thead><tr><th>Check</th><th>What it measures</th><th class="number">Value</th><th class="number">Threshold</th><th>Result</th></tr></thead><tbody>${checks.map((check) => `
        <tr><td><code>${escapeXml(check.name)}</code></td><td>${escapeXml(check.description)}</td><td class="number">${formatNumber(check.value)}</td><td class="number">${escapeXml(limitText(check.limit))}</td><td>${status(check.pass)}</td></tr>`).join('')}</tbody></table>`;
}

function resultsTable(rows) {
    const used = resultColumns.filter(([key]) => rows.some((row) => row[key] !== null && row[key] !== '' && row[key] !== undefined));
    return `<div class="scroll"><table class="results"><thead><tr>${used.map(([key, label]) => `<th${key === 'note' || key === 'case' || key === 'method' ? '' : ' class="number"'}>${escapeXml(label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `
        <tr>${used.map(([key]) => {
            const value = row[key];
            if (key === 'note' || key === 'case' || key === 'method') return `<td>${escapeXml(value ?? '')}</td>`;
            return `<td class="number">${formatNumber(value)}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function plotData(plot) {
    const { px, py, visible } = layout(plot);
    const monotonic = plot.series.every((entry) => entry.points.every(([x], index) => index === 0 || x >= entry.points[index - 1][0]));
    return {
        monotonic,
        xLabel: plot.xLabel,
        yLabel: plot.yLabel,
        series: plot.series.map((entry) => ({
            name: entry.name, role: entry.role,
            points: entry.points.filter(([x, y]) => visible(x, y)).map(([x, y]) => [Number(px(x).toFixed(1)), Number(py(y).toFixed(1)), x, y])
        }))
    };
}

function dataTable(plot, csvPath) {
    const length = Math.max(...plot.series.map((entry) => entry.points.length));
    const stride = Math.max(1, Math.ceil(length / 40));
    const shared = plot.series.every((entry) => entry.points.length === plot.series[0].points.length && entry.points.every(([x], index) => x === plot.series[0].points[index][0]));
    const header = shared
        ? `<th class="number">${escapeXml(plot.xLabel)}</th>${plot.series.map((entry) => `<th class="number">${escapeXml(entry.name)}</th>`).join('')}`
        : plot.series.map((entry) => `<th class="number">${escapeXml(entry.name)}: ${escapeXml(plot.xLabel)}</th><th class="number">${escapeXml(plot.yLabel)}</th>`).join('');
    const rows = [];
    for (let index = 0; index < length; index += stride) {
        rows.push(shared
            ? `<tr><td class="number">${formatNumber(plot.series[0].points[index][0])}</td>${plot.series.map((entry) => `<td class="number">${formatNumber(entry.points[index]?.[1])}</td>`).join('')}</tr>`
            : `<tr>${plot.series.map((entry) => `<td class="number">${formatNumber(entry.points[index]?.[0])}</td><td class="number">${formatNumber(entry.points[index]?.[1])}</td>`).join('')}</tr>`);
    }
    return `<details class="data"><summary>Data table${stride > 1 ? ` (every ${stride}th point; all ${length} are in <code>${escapeXml(csvPath)}</code>)` : ''}</summary><div class="scroll"><table><thead><tr>${header}</tr></thead><tbody>${rows.join('')}</tbody></table></div></details>`;
}

function figure(plot) {
    return `<figure class="chart" id="plot-${escapeXml(plot.id)}">
        <figcaption><strong>${escapeXml(plot.title)}</strong>${plot.subtitle ? `<span>${escapeXml(plot.subtitle)}</span>` : ''}</figcaption>
        ${renderLegend(plot)}
        <div class="frame">${renderSvg(plot)}<div class="tooltip" hidden></div></div>
        <script type="application/json" class="plot-data">${JSON.stringify(plotData(plot)).replaceAll('<', '\\u003c')}</script>
        ${dataTable(plot, `plots/${plot.id}.csv`)}
    </figure>`;
}

function timingTable(timings) {
    return `<div class="scroll"><table class="results"><thead><tr><th>Problem</th><th>Case</th><th class="number">Runs</th><th class="number">Median wall (ms)</th><th class="number">Min – max (ms)</th><th class="number">MAD (ms)</th><th class="number">Median engine compute (ms)</th><th class="number">Substeps per second</th><th class="number">Peak memory (MiB)</th></tr></thead><tbody>${timings.map((timing) => `
        <tr><td>${escapeXml(timing.problem)}</td><td>${escapeXml(timing.label)}</td><td class="number">${timing.wall.count}</td><td class="number">${formatNumber(timing.wall.median)}</td><td class="number">${formatNumber(timing.wall.minimum)} – ${formatNumber(timing.wall.maximum)}</td><td class="number">${formatNumber(timing.wall.medianAbsoluteDeviation)}</td><td class="number">${formatNumber(timing.engineCompute.median)}</td><td class="number">${formatNumber(timing.substepsPerSecond)}</td><td class="number">${timing.peakResidentBytes ? formatNumber(timing.peakResidentBytes / 2 ** 20) : '–'}</td></tr>`).join('')}</tbody></table></div>`;
}

function machineList(machine) {
    const power = machine.power ?? {};
    const items = [
        ['Model', [machine.model, machine.modelIdentifier].filter(Boolean).join(', ')],
        ['Processor', [machine.chip, machine.cpu].filter((value, index, all) => value && all.indexOf(value) === index).join(', ')],
        ['Cores', `${machine.logicalProcessors} logical${machine.performanceCores ? ` (${machine.performanceCores} performance, ${machine.efficiencyCores ?? 0} efficiency)` : ''}`],
        ['Memory', `${(machine.memoryBytes / 2 ** 30).toFixed(0)} GiB`],
        ['Operating system', `${machine.operatingSystem} · ${machine.architecture}`],
        ['Power', [power.source, power.batteryPercent ? `${power.batteryPercent} % battery` : null, power.lowPowerMode === null || power.lowPowerMode === undefined ? null : `Low Power Mode ${power.lowPowerMode ? 'on' : 'off'}`, power.governor ? `governor ${power.governor}` : null].filter(Boolean).join(' · ') || 'unknown'],
        ['Load average at start', machine.loadAverage.join(' / ')],
        ['Node.js', machine.node]
    ];
    return `<dl class="machine">${items.map(([term, value]) => `<dt>${escapeXml(term)}</dt><dd>${escapeXml(value)}</dd>`).join('')}</dl>`;
}

const styles = `
.viz-root { color-scheme: light; ${lightTheme} }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root { color-scheme: dark; ${darkTheme} } }
:root[data-theme="dark"] .viz-root { color-scheme: dark; ${darkTheme} }
* { box-sizing: border-box; }
body { margin: 0; }
.viz-root { background: var(--page); color: var(--text-primary); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 20px; margin: 40px 0 8px; padding-top: 16px; border-top: 1px solid var(--grid); } h3 { font-size: 16px; margin: 24px 0 8px; }
p, li, dd { color: var(--text-secondary); } .lede { color: var(--text-primary); max-width: 860px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; }
table { border-collapse: collapse; width: 100%; font-size: 13px; background: var(--surface-1); }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--text-secondary); font-weight: 600; } td { color: var(--text-primary); }
.number { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.scroll { overflow-x: auto; }
.status { font-weight: 600; white-space: nowrap; } .status.good { color: var(--good); } .status.critical { color: var(--critical); }
.tiles { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
.tile { background: var(--surface-1); border: 1px solid var(--grid); border-radius: 8px; padding: 12px 16px; min-width: 160px; }
.tile .value { font-size: 26px; font-weight: 600; color: var(--text-primary); } .tile .label { color: var(--text-secondary); font-size: 13px; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); gap: 20px; }
figure.chart { margin: 0; background: var(--surface-1); border: 1px solid var(--grid); border-radius: 8px; padding: 14px; }
figcaption { display: flex; flex-direction: column; margin-bottom: 6px; } figcaption span { color: var(--text-secondary); font-size: 13px; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 0 0 6px; font-size: 13px; }
.legend li { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); }
.frame { position: relative; } .frame svg.plot { width: 100%; height: auto; display: block; }
.tooltip { position: absolute; pointer-events: none; background: var(--surface-1); border: 1px solid var(--axis); border-radius: 6px; padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); white-space: nowrap; z-index: 2; }
.tooltip .row { display: flex; align-items: center; gap: 6px; } .tooltip strong { font-variant-numeric: tabular-nums; } .tooltip .name { color: var(--text-secondary); }
details.data { margin-top: 8px; font-size: 13px; } details.data summary, details.rows summary { cursor: pointer; color: var(--text-secondary); }
dl.machine { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; } dl.machine dt { color: var(--text-secondary); } dl.machine dd { margin: 0; color: var(--text-primary); }
.theme { float: right; background: var(--surface-1); color: var(--text-secondary); border: 1px solid var(--axis); border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.notes li { margin: 4px 0; }
`;

// Hover: a crosshair that snaps to the nearest sample (or, for a plot whose x is not ordered, the nearest point) and a tooltip listing
// every series' value there, value first. Names are inserted as text, never as HTML.
const script = `
for (const figure of document.querySelectorAll('figure.chart')) {
    const data = JSON.parse(figure.querySelector('.plot-data').textContent);
    const svg = figure.querySelector('svg.plot');
    const tip = figure.querySelector('.tooltip');
    const NS = 'http://www.w3.org/2000/svg';
    const cross = document.createElementNS(NS, 'line');
    cross.setAttribute('stroke', 'var(--axis)'); cross.setAttribute('stroke-width', '1'); cross.style.display = 'none';
    svg.appendChild(cross);
    const dots = data.series.map(() => { const dot = document.createElementNS(NS, 'circle'); dot.setAttribute('r', '4'); dot.setAttribute('stroke', 'var(--surface-1)'); dot.setAttribute('stroke-width', '2'); dot.style.display = 'none'; svg.appendChild(dot); return dot; });
    const colours = { reference: 'var(--series-1)', explicit: 'var(--series-2)', semiImplicit: 'var(--series-3)', verlet: 'var(--series-3)', extra: 'var(--series-4)', rungeKutta4: 'var(--series-4)', slot1: 'var(--series-1)', slot2: 'var(--series-2)', slot3: 'var(--series-3)', slot4: 'var(--series-4)', guide: 'var(--text-muted)' };
    const format = (value) => { if (!isFinite(value)) return String(value); const a = Math.abs(value); return a !== 0 && (a >= 1e5 || a < 1e-3) ? value.toExponential(3) : String(Number(value.toPrecision(5))); };
    function hide() { cross.style.display = 'none'; dots.forEach((dot) => { dot.style.display = 'none'; }); tip.hidden = true; }
    function show(event) {
        const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
        const local = point.matrixTransform(svg.getScreenCTM().inverse());
        const hits = [];
        if (data.monotonic) {
            data.series.forEach((series, index) => {
                let best = null;
                for (const candidate of series.points) if (!best || Math.abs(candidate[0] - local.x) < Math.abs(best[0] - local.x)) best = candidate;
                if (best) hits.push([index, best]);
            });
        } else {
            let best = null;
            data.series.forEach((series, index) => { for (const candidate of series.points) { const distance = Math.hypot(candidate[0] - local.x, candidate[1] - local.y); if (!best || distance < best[2]) best = [index, candidate, distance]; } });
            if (best && best[2] < 40) hits.push([best[0], best[1]]);
        }
        if (!hits.length) { hide(); return; }
        dots.forEach((dot) => { dot.style.display = 'none'; });
        const x = hits[0][1][0];
        if (data.monotonic) { cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('y1', 16); cross.setAttribute('y2', 294); cross.style.display = ''; }
        tip.replaceChildren();
        const heading = document.createElement('div'); heading.className = 'name'; heading.textContent = data.xLabel + ': ' + format(hits[0][1][2]); tip.appendChild(heading);
        for (const [index, hit] of hits) {
            const series = data.series[index];
            dots[index].setAttribute('cx', hit[0]); dots[index].setAttribute('cy', hit[1]); dots[index].setAttribute('fill', colours[series.role] || 'var(--series-1)'); dots[index].style.display = '';
            const row = document.createElement('div'); row.className = 'row';
            const key = document.createElementNS(NS, 'svg'); key.setAttribute('width', '14'); key.setAttribute('height', '4');
            const stroke = document.createElementNS(NS, 'line'); stroke.setAttribute('x1', '0'); stroke.setAttribute('x2', '14'); stroke.setAttribute('y1', '2'); stroke.setAttribute('y2', '2'); stroke.setAttribute('stroke', colours[series.role] || 'var(--series-1)'); stroke.setAttribute('stroke-width', '3'); key.appendChild(stroke);
            const value = document.createElement('strong'); value.textContent = format(hit[3]);
            const name = document.createElement('span'); name.className = 'name'; name.textContent = series.name;
            row.append(key, value, name); tip.appendChild(row);
        }
        const box = svg.getBoundingClientRect(); const scale = box.width / 640;
        tip.hidden = false;
        const left = hits[0][1][0] * scale + 12;
        tip.style.left = Math.min(left, box.width - tip.offsetWidth - 4) + 'px';
        tip.style.top = Math.max(0, hits[0][1][1] * scale - tip.offsetHeight - 8) + 'px';
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', hide);
}
document.querySelector('.theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
});
`;

export function renderReport({ summary, problems, timings }) {
    const checks = problems.flatMap((problem) => problem.checks);
    const passed = checks.filter((check) => check.pass).length;
    const run = summary.run;
    const sections = problems.map((problem) => `
    <section id="${escapeXml(problem.id)}">
        <h2>${escapeXml(problem.title)}</h2>
        <p class="lede">${escapeXml(problem.summary)}</p>
        <p>Directory <code>benchmarks/${escapeXml(problem.id)}/</code> · models ${problem.models.map((model) => `<code>${escapeXml(model)}</code>`).join(', ') || '(shared with the problems it studies)'}${problem.referenceProvenance ? ` · numerical reference <code>reference.json</code>: ${escapeXml(problem.referenceProvenance.method)} (SciPy ${escapeXml(problem.referenceProvenance.scipy)}, NumPy ${escapeXml(problem.referenceProvenance.numpy)}${problem.referenceProvenance.rtol ? `, rtol ${problem.referenceProvenance.rtol}` : ''})` : ''}</p>
        ${problem.error ? `<p class="status critical">✕ The problem could not be evaluated: ${escapeXml(problem.error)}</p>` : ''}
        ${problem.plots.length ? `<div class="charts">${problem.plots.map(figure).join('')}</div>` : ''}
        ${problem.checks.length ? `<h3>Checks</h3>${checksTable(problem.checks)}` : ''}
        ${problem.notes.length ? `<ul class="notes">${problem.notes.map((note) => `<li>${escapeXml(note)}</li>`).join('')}</ul>` : ''}
        ${problem.rows.length ? `<details class="rows"><summary>All ${problem.rows.length} result rows</summary>${resultsTable(problem.rows)}</details>` : ''}
    </section>`).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Konjugate benchmark report · ${escapeXml(run.konjugateVersion)} · ${escapeXml(run.mode)}</title>
<style>${styles}</style>
</head>
<body class="viz-root">
<main>
    <button class="theme" type="button">Light / dark</button>
    <h1>Konjugate benchmark report</h1>
    <p>Konjugate ${escapeXml(run.konjugateVersion)} · engine ${escapeXml(run.engineVersion)} · commit <code>${escapeXml(run.gitCommit)}</code>${run.workingTreeChanges ? ' (with uncommitted changes)' : ''} · <code>--${escapeXml(run.mode)}</code> · ${escapeXml(run.startedAt)}</p>
    <p class="lede">Konjugate is evaluated against established numerical and engineering benchmarks, with reproducible reference comparisons, conservation checks and performance measurements. Each problem below is run headless by the native engine from a committed model and compared with an analytic solution or an independent high-accuracy numerical reference. Konjugate integrates with fixed-step explicit or semi-implicit Euler node by node, both first order, or with Runge–Kutta 4 applied to the whole model at once, fourth order and as accurate across the coupling between nodes as within them; the results show where each is accurate and where it is not. How the numbers are made, and how to reproduce them, is in <code>benchmarks/README.md</code>.</p>
    <div class="tiles">
        <div class="tile"><div class="value">${passed} / ${checks.length}</div><div class="label">checks within their thresholds</div></div>
        <div class="tile"><div class="value">${problems.length}</div><div class="label">problems</div></div>
        <div class="tile"><div class="value">${summary.totals.engineRuns}</div><div class="label">engine runs</div></div>
        <div class="tile"><div class="value">${formatNumber(summary.totals.substeps)}</div><div class="label">node substeps integrated</div></div>
    </div>
    ${checks.some((check) => !check.pass) ? `<p class="status critical">✕ Failing: ${checks.filter((check) => !check.pass).map((check) => escapeXml(check.name)).join(', ')}</p>` : '<p class="status good">✓ Every check is within its threshold.</p>'}
    <nav><p>${problems.map((problem) => `<a href="#${escapeXml(problem.id)}">${escapeXml(problem.title)}</a>`).join(' · ')}${timings ? ' · <a href="#timing">Timing</a>' : ''}</p></nav>
    ${sections}
    ${timings ? `<section id="timing"><h2>Timing and memory</h2><p class="lede">Measured on this computer only: after ${summary.timing.warmupRuns} warm-up run${summary.timing.warmupRuns === 1 ? '' : 's'}, ${summary.timing.repeats} timed runs of each case, one at a time${summary.timing.caffeinated ? ', under caffeinate' : ''}. Wall time is the whole engine process (start, reading the model, integrating, writing the result); engine compute is the integration alone, as the engine reports it. Peak memory is the engine process's maximum resident set size.</p>${summary.timing.busyProcesses?.length ? `<p class="status critical">✕ Other heavy processes were running: ${escapeXml(summary.timing.busyProcesses.join(', '))}. These timings may be disturbed.</p>` : ''}${timingTable(timings)}<h3>Machine</h3>${machineList(summary.machine)}</section>` : ''}
</main>
<script>${script}</script>
</body>
</html>
`;
}
