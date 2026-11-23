/* Copyright © 2026 Zenin Easa Panthakkalakath */

// npm run benchmark:combine: the timing sessions of one version on one computer combined into one report (benchmarks/README.md, Reproduce
// these results). npm run benchmark:performance calls it at the end of every session; run it alone to combine again, or a choice of sessions:
//
//   node benchmarks/combine.mjs [<results directory>] [--sessions <name,name>]
//
// The results directory is benchmarks/results/<version>/<machine>/ (by default this version's, for this computer), holding sessions/<name>/
// with the parts each session ran (problems/, scaling/, comparisons/, and openmodelica/ from npm run benchmark:openmodelica). For every
// measurement: the minimum over every session's runs, the headline (noise only adds time); the median and interquartile range over all the
// runs; the spread between sessions, (largest − smallest) / smallest of the sessions' minimums; and a flag where any session's own runs
// spread more than 5 % (interquartile range over median). Written beside sessions/: report.html, combined.json, timings.csv and comparisons/
// (comparisons.json, comparisons.csv, plots/, performance.html).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { noisyWithinRun, writeComparisonReport } from './comparisons/report.mjs';
import { repositoryRoot } from './lib/engine.mjs';
import { describeEngineBuild, machineDetails, machineSlug } from './lib/machine.mjs';
import { timingStatistics } from './lib/metrics.mjs';
import { darkTheme, formatNumber, lightTheme } from './lib/plots.mjs';

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const percent = (value) => (value === null || value === undefined ? '–' : `${(100 * value).toFixed(1)} %`);

// One measurement across sessions: per session its runs, combined as the header says.
function combineRuns(perSession) {
    const all = perSession.flatMap((entry) => entry.values);
    const stats = timingStatistics(all);
    const sessionMinimums = perSession.map((entry) => Math.min(...entry.values));
    const within = perSession.map((entry) => {
        const own = timingStatistics(entry.values);
        return own.count >= 3 && own.median > 0 ? own.interquartileRange / own.median : null;
    }).filter((value) => value !== null);
    const withinRunSpread = within.length ? Math.max(...within) : null;
    return {
        minimum: stats.minimum, median: stats.median, interquartileRange: stats.interquartileRange, minimumOverMedian: stats.minimumOverMedian, runs: stats.count,
        sessions: perSession.length, sessionMinimums,
        betweenSessionSpread: sessionMinimums.length > 1 ? (Math.max(...sessionMinimums) - Math.min(...sessionMinimums)) / Math.min(...sessionMinimums) : null,
        withinRunSpread, noisy: withinRunSpread !== null && withinRunSpread > noisyWithinRun
    };
}

function sessionList(machineDirectory, chosen) {
    const directory = join(machineDirectory, 'sessions');
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => statSync(join(directory, name)).isDirectory() && (!chosen || chosen.includes(name))).sort()
        .map((name) => ({ name, directory: join(directory, name) }));
}

function combineSuite(sessions, part) {
    const byKey = new Map();
    const sessionsWithPart = [];
    for (const session of sessions) {
        const summary = readJson(join(session.directory, part, 'summary.json'));
        if (!summary?.timings) continue;
        sessionsWithPart.push({ session: session.name, conditions: summary.timing?.conditions ?? null, quietGate: summary.timing?.quietGate ?? null, machine: summary.machine, run: summary.run });
        for (const timing of summary.timings) {
            const key = `${timing.problem}|${timing.label}`;
            if (!byKey.has(key)) byKey.set(key, { timing, wall: [], compute: [], memory: [] });
            const entry = byKey.get(key);
            const values = (stats) => stats.values ?? [stats.minimum];
            entry.wall.push({ session: session.name, values: values(timing.wall) });
            entry.compute.push({ session: session.name, values: values(timing.engineCompute ?? timing.solve) });
            if (timing.peakResidentBytes) entry.memory.push(timing.peakResidentBytes);
        }
    }
    const rows = [...byKey.values()].map(({ timing, wall, compute, memory }) => {
        const combinedCompute = combineRuns(compute);
        const nodeSteps = timing.nodes ? timing.nodes * timing.work.globalSteps : null;
        return {
            problem: timing.problem, label: timing.label, family: timing.family ?? null, nodes: timing.nodes ?? null, method: timing.method ?? null, backend: timing.backend ?? null, workers: timing.workers ?? null,
            wall: combineRuns(wall), compute: combinedCompute, peakResidentBytes: memory.length ? Math.max(...memory) : null,
            substepsPerSecond: timing.work.substeps / (combinedCompute.minimum / 1000), nodeStepsPerSecond: nodeSteps ? nodeSteps / (combinedCompute.minimum / 1000) : null
        };
    });
    // Speed-up and efficiency from the combined minimums, each parallel backend against serial on the same graph and method.
    for (const row of rows) {
        if (!row.backend) continue;
        const serial = rows.find((candidate) => candidate.family === row.family && candidate.nodes === row.nodes && candidate.method === row.method && candidate.backend === 'serial');
        if (serial) { row.speedUp = serial.compute.minimum / row.compute.minimum; row.efficiency = row.speedUp / (row.workers || 1); }
    }
    return { rows, sessions: sessionsWithPart };
}

function combineComparisons(sessions) {
    const byKey = new Map();
    let latest = null;
    const included = [];
    for (const session of sessions) {
        for (const part of ['comparisons', 'openmodelica']) {
            const summary = readJson(join(session.directory, part, 'comparisons.json'));
            if (!summary) continue;
            latest = { ...(latest ?? {}), ...summary, versions: { ...(latest?.versions ?? {}), ...summary.versions }, startup: { ...(latest?.startup ?? {}), ...summary.startup },
                references: { ...(latest?.references ?? {}), ...summary.references }, openModelicaTranslation: { ...(latest?.openModelicaTranslation ?? {}), ...summary.openModelicaTranslation } };
            included.push({ session: session.name, part, conditions: summary.conditions, quietGate: summary.quietGate, rounds: summary.rounds });
            for (const record of summary.records) {
                const key = [record.problem, record.tool, record.method, record.switching ?? '', record.tolerance].join('|');
                if (!byKey.has(key)) byKey.set(key, { first: record, perSession: [], errors: new Set() });
                const entry = byKey.get(key);
                if (record.ok) {
                    entry.perSession.push({ session: session.name, values: record.solveSeconds });
                    if (record.relativeError !== undefined) entry.errors.add(Number(record.relativeError));
                }
                if (!entry.first.ok && record.ok) entry.first = record;
            }
        }
    }
    if (!latest) return null;
    const records = [...byKey.values()].map(({ first, perSession, errors }) => {
        if (!perSession.length) return first;
        const combined = combineRuns(perSession);
        return {
            ...first, solveSeconds: perSession.flatMap((entry) => entry.values), sessionMinimums: combined.sessionMinimums, withinRunSpread: combined.withinRunSpread,
            ...(errors.size > 1 ? { errorDiffersBetweenSessions: [...errors] } : {})
        };
    });
    return { ...latest, records, sessions: included, combined: true };
}

function suiteTable(rows, { scaling }) {
    const head = scaling
        ? '<th>Case</th><th class="number">Minimum solve (ms)</th><th class="number">Median</th><th class="number">IQR</th><th class="number">Min / median</th><th class="number">Node steps per second</th><th class="number">Speed-up</th><th class="number">Efficiency</th><th class="number">Minimum wall (ms)</th><th class="number">Peak memory (MiB)</th><th class="number">Runs</th><th class="number">Between sessions</th><th>Within a run</th>'
        : '<th>Problem</th><th>Case</th><th class="number">Minimum wall (ms)</th><th class="number">Median</th><th class="number">IQR</th><th class="number">Min / median</th><th class="number">Minimum engine compute (ms)</th><th class="number">Peak memory (MiB)</th><th class="number">Runs</th><th class="number">Between sessions</th><th>Within a run</th>';
    const body = rows.map((row) => {
        const headline = scaling ? row.compute : row.wall;
        const flags = `<td class="number">${headline.runs}${headline.sessions > 1 ? ` in ${headline.sessions}` : ''}</td><td class="number">${percent(headline.betweenSessionSpread)}</td><td>${headline.noisy ? `noisy: ${percent(headline.withinRunSpread)}` : ''}</td>`;
        const memory = `<td class="number">${row.peakResidentBytes ? formatNumber(row.peakResidentBytes / 2 ** 20) : '–'}</td>`;
        return scaling
            ? `<tr><td>${escapeXml(row.label)}</td><td class="number"><strong>${formatNumber(row.compute.minimum)}</strong></td><td class="number">${formatNumber(row.compute.median)}</td><td class="number">${formatNumber(row.compute.interquartileRange)}</td><td class="number">${row.compute.minimumOverMedian?.toFixed(3) ?? '–'}</td><td class="number">${formatNumber(row.nodeStepsPerSecond)}</td><td class="number">${row.speedUp ? row.speedUp.toFixed(2) : '–'}</td><td class="number">${row.efficiency ? percent(row.efficiency) : '–'}</td><td class="number">${formatNumber(row.wall.minimum)}</td>${memory}${flags}</tr>`
            : `<tr><td>${escapeXml(row.problem)}</td><td>${escapeXml(row.label)}</td><td class="number"><strong>${formatNumber(row.wall.minimum)}</strong></td><td class="number">${formatNumber(row.wall.median)}</td><td class="number">${formatNumber(row.wall.interquartileRange)}</td><td class="number">${row.wall.minimumOverMedian?.toFixed(3) ?? '–'}</td><td class="number">${formatNumber(row.compute.minimum)}</td>${memory}${flags}</tr>`;
    }).join('');
    return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function sessionsTable(entries) {
    const condition = (value) => (value ? `load ${value.loadAverage?.join(' / ')}; ${value.power ?? ''}; ${value.thermal ?? ''}` : '–');
    const gate = (value) => {
        const gates = value && !value.rule ? Object.values(value).filter(Boolean) : [value].filter(Boolean);
        return gates.map((entry) => `${entry.quickChecks} timed runs checked, ${entry.quickFailures} waited again, ${entry.waitedSeconds} s waited; limits load ${entry.limits?.load ?? 2}, other processes ${entry.limits?.otherCores ?? 2} cores${entry.baseline ? ` (idle baseline ${entry.baseline.loadMedian} / ${entry.baseline.otherCoresMedian})` : ''}; Docker up at ${(entry.timedRunsWithDockerUp ?? 0) + (entry.runnerTimedRunsWithDockerUp ?? 0)} timed runs`).join(' · ') || '–';
    };
    const rows = entries.map((entry) => {
        const conditions = entry.conditions?.start ? entry.conditions : Object.values(entry.conditions ?? {})[0] ?? null;
        return `<tr><td>${escapeXml(entry.session)}</td><td>${escapeXml(entry.part)}</td><td>${escapeXml(condition(conditions?.start))}</td><td>${escapeXml(condition(conditions?.end))}</td><td>${escapeXml(gate(entry.quietGate))}</td></tr>`;
    }).join('');
    return `<div class="scroll"><table><thead><tr><th>Session</th><th>Part</th><th>At the start</th><th>At the end</th><th>Quiet gate</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function csv(rows) {
    const columns = ['part', 'problem', 'label', 'nodes', 'backend', 'workers', 'headline', 'minimumMs', 'medianMs', 'iqrMs', 'minimumOverMedian', 'runs', 'sessions', 'betweenSessionSpread', 'withinRunSpread', 'noisy', 'wallMinimumMs', 'computeMinimumMs', 'nodeStepsPerSecond', 'speedUp', 'efficiency', 'peakResidentBytes'];
    const quote = (value) => (value === undefined || value === null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));
    const lines = rows.map(({ part, row }) => {
        const headline = part === 'scaling' ? row.compute : row.wall;
        return [part, row.problem, row.label, row.nodes, row.backend, row.workers, part === 'scaling' ? 'engine compute' : 'wall', headline.minimum, headline.median, headline.interquartileRange, headline.minimumOverMedian, headline.runs, headline.sessions,
            headline.betweenSessionSpread, headline.withinRunSpread, headline.noisy, row.wall.minimum, row.compute.minimum, row.nodeStepsPerSecond, row.speedUp, row.efficiency, row.peakResidentBytes].map(quote).join(',');
    });
    return `${columns.join(',')}\n${lines.join('\n')}\n`;
}

export async function combineSessions(machineDirectory, { sessions: chosen = null } = {}) {
    const sessions = sessionList(machineDirectory, chosen);
    if (!sessions.length) throw new Error(`No sessions under ${join(machineDirectory, 'sessions')}: run npm run benchmark:performance first.`);
    const problems = combineSuite(sessions, 'problems');
    const scaling = combineSuite(sessions, 'scaling');
    const comparisons = combineComparisons(sessions);
    const machine = [...problems.sessions, ...scaling.sessions].at(-1)?.machine ?? comparisons?.machine ?? null;
    const combined = { machine, sessions: sessions.map((session) => session.name), problems: problems.rows, scaling: scaling.rows, statistic: 'minimum over all runs of all sessions; median and interquartile range over all runs; between-session spread of the session minimums; flagged noisy when a session\'s interquartile range exceeds 5 % of its median' };
    writeFileSync(join(machineDirectory, 'combined.json'), `${JSON.stringify(combined, null, 1)}\n`);
    writeFileSync(join(machineDirectory, 'timings.csv'), csv([...problems.rows.map((row) => ({ part: 'problems', row })), ...scaling.rows.map((row) => ({ part: 'scaling', row }))]));
    const latestProblems = [...sessions].reverse().find((session) => existsSync(join(session.directory, 'problems', 'report.html')));
    const latestScaling = [...sessions].reverse().find((session) => existsSync(join(session.directory, 'scaling', 'report.html')));
    const reportPath = join(machineDirectory, 'report.html');
    const machineText = machine ? [machine.model, machine.chip ?? machine.cpu, `${machine.logicalProcessors} cores`, `${Math.round(machine.memoryBytes / 2 ** 30)} GiB`, machine.operatingSystem, machine.engineBuild ? `engine ${describeEngineBuild(machine.engineBuild)}` : null].filter(Boolean).join(' · ') : '';
    const sessionEntries = [...problems.sessions.map((entry) => ({ ...entry, part: 'problems' })), ...scaling.sessions.map((entry) => ({ ...entry, part: 'scaling' })),
        ...(comparisons?.sessions ?? []).map((entry) => ({ ...entry, part: entry.part }))].sort((a, b) => a.session.localeCompare(b.session));
    writeFileSync(reportPath, `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Konjugate performance report</title>
<style>
.viz-root { color-scheme: light; ${lightTheme} }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root { color-scheme: dark; ${darkTheme} } }
body { margin: 0; } .viz-root { background: var(--page); color: var(--text-primary); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 24px; } p, dd, li { color: var(--text-secondary); } .lede { color: var(--text-primary); }
h2 { margin-top: 36px; padding-top: 12px; border-top: 1px solid var(--grid); } table { border-collapse: collapse; width: 100%; background: var(--surface-1); font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; } .number { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; } a { color: var(--series-1); } dl.machine { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; } dt { font-weight: 600; }
</style></head>
<body class="viz-root"><main>
<h1>Konjugate performance report</h1>
<p>${escapeXml(machineText)}</p>
<p class="lede">Konjugate evaluated against established tools, reproducibly, on this computer: ${sessions.length} timing session${sessions.length === 1 ? '' : 's'} combined. Every timing's headline is its minimum over all runs of all sessions, since noise on a computer only adds time; beside it are the median and interquartile range over all runs, the spread between the sessions' minimums, and a flag where a session's runs spread more than 5 %. The accuracy checks are in each session's own report${latestProblems ? ` (<a href="sessions/${latestProblems.name}/problems/report.html">the latest</a>)` : ''}; the methods are in benchmarks/README.md.</p>
<nav><p><a href="#sessions">Sessions</a> · <a href="#problems">Problem timings</a> · <a href="#scaling">Graph scalability</a></p></nav>
<section id="sessions"><h2>Sessions and their conditions</h2>${sessionsTable(sessionEntries)}</section>
<section id="problems"><h2>Problem timings</h2><p>Each problem's timing cases: the engine process's wall time and its own integration time.</p>${problems.rows.length ? suiteTable(problems.rows, { scaling: false }) : '<p>Not run in these sessions.</p>'}</section>
<section id="scaling"><h2>Graph scalability</h2><p>Generated thermal graphs on the serial, thread-pool and partitioned backends: the engine's integration time, node steps per second and each parallel backend's speed-up over serial, all from the minimums.${latestScaling ? ` The plots are in <a href="sessions/${latestScaling.name}/scaling/report.html">the latest session's report</a>.` : ''}</p>${scaling.rows.length ? suiteTable(scaling.rows, { scaling: true }) : '<p>Not run in these sessions.</p>'}</section>
</main></body></html>
`);
    if (comparisons) {
        const directory = join(machineDirectory, 'comparisons');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'comparisons.json'), `${JSON.stringify(comparisons, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value), 1)}\n`);
        await writeComparisonReport(directory, reportPath);
    }
    console.log(`Combined ${sessions.length} session${sessions.length === 1 ? '' : 's'}: ${reportPath}`);
    return reportPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values: options, positionals } = parseArgs({ options: { sessions: { type: 'string' } }, allowPositionals: true });
    const packageVersion = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version;
    const machineDirectory = positionals[0] ?? join(repositoryRoot, 'benchmarks', 'results', packageVersion, machineSlug(machineDetails()));
    try {
        await combineSessions(machineDirectory, { sessions: options.sessions?.split(',') ?? null });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
