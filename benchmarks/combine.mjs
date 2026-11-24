/* Copyright © 2026 Zenin Easa Panthakkalakath */

// npm run benchmark:combine: the timing sessions of one engine on one computer combined into one report (benchmarks/README.md, Reproduce
// these results). npm run benchmark:performance calls it at the end of every session; run it alone to combine again, or a choice of sessions:
//
//   node benchmarks/combine.mjs [<results directory>] [--sessions <name,name>]
//
// The results directory is benchmarks/results/<machine>/ (by default this computer's), holding sessions/<name>/ with the parts each session
// ran (problems/, scaling/, comparisons/, and openmodelica/ from npm run benchmark:openmodelica). Each part records the source it timed: the
// Konjugate version, the commit and whether the checkout had uncommitted changes (lib/results.mjs). Only the parts timed from the newest
// source are combined, the commit of the latest part that timed Konjugate; the others are kept in sessions/ and listed in the report as
// superseded, never mixed into the numbers. A part that recorded no commit counts as the newest source's only if its session started after
// that commit was made. For every measurement: the minimum over every session's runs, the headline (noise only adds time); the median and interquartile range over all the
// runs; the spread between sessions, (largest − smallest) / smallest of the sessions' minimums; and a flag where any session's own runs
// spread more than 5 % (interquartile range over median). Written beside sessions/: report.html, combined.json, timings.csv and comparisons/
// (comparisons.json, comparisons.csv, plots/, performance.html).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { noisyWithinRun, writeComparisonReport } from './comparisons/report.mjs';
import { repositoryRoot } from './lib/engine.mjs';
import { describeEngineBuild } from './lib/machine.mjs';
import { resultsDirectory } from './lib/results.mjs';
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

// A session folder counts only if a part in it wrote its results: a session stopped before any part finished (its preflight refused, or it was
// interrupted) leaves an empty folder, which is not a session.
const sessionParts = { problems: 'summary.json', scaling: 'summary.json', comparisons: 'comparisons.json', openmodelica: 'comparisons.json' };

// The source a part timed, as it recorded it, and whether it timed Konjugate at all (an OpenModelica session times only OpenModelica).
function partSource(directory, part) {
    const summary = readJson(join(directory, part, sessionParts[part]));
    if (!summary) return null;
    if (summary.run) return { startedAt: summary.run.startedAt ?? null, konjugateVersion: summary.run.konjugateVersion ?? null, gitCommit: summary.run.gitCommit ?? null, workingTreeChanges: summary.run.workingTreeChanges ?? null, uncommittedSources: summary.run.uncommittedSources, timesKonjugate: true };
    const konjugate = summary.versions?.konjugate;
    const conditions = summary.conditions?.start ? summary.conditions : Object.values(summary.conditions ?? {})[0] ?? null;
    return {
        startedAt: conditions?.start?.at ?? null, konjugateVersion: konjugate?.version ?? null, gitCommit: konjugate?.commit ?? null, workingTreeChanges: konjugate?.workingTreeChanges ?? null, uncommittedSources: konjugate?.uncommittedSources,
        timesKonjugate: (summary.records ?? []).some((record) => String(record.tool).startsWith('Konjugate'))
    };
}

const known = (commit) => Boolean(commit) && commit !== 'unknown';

// Session folders are named by when they started, in UTC: 2026-11-24T14-56-45, or with a suffix such as -openmodelica.
function sessionStart(name) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
    return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : null;
}

function git(args) {
    try {
        return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

function commitTime(commit) {
    const time = git(['show', '-s', '--format=%cI', commit]);
    return time ? Date.parse(time) : null;
}

// The repository's commit pages, from package.json's repository: https://github.com/<owner>/<name>/commit/<full hash>.
const repositoryUrl = (() => {
    const repository = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).repository;
    const url = typeof repository === 'string' ? repository : repository?.url;
    return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null;
})();

// A part as the report and combined.json describe it: when it started (UTC), the version, and the commit the timed engine was built
// from, short and full with its page, whether the checkout had uncommitted changes then, and the session's provenance note, if any.
function describePart(session, part, source, note = null) {
    const fullCommit = known(source.gitCommit) ? git(['rev-parse', '--verify', '--quiet', `${source.gitCommit}^{commit}`]) || null : null;
    const provenance = note && (!note.parts || note.parts.includes(part)) ? describeProvenance(session, note, source) : null;
    return {
        session, part, startedAt: source.startedAt ?? (sessionStart(session) !== null ? new Date(sessionStart(session)).toISOString() : null), konjugateVersion: source.konjugateVersion,
        gitCommit: source.gitCommit, fullCommit, commitUrl: fullCommit && repositoryUrl ? `${repositoryUrl}/commit/${fullCommit}` : null, workingTreeChanges: source.workingTreeChanges,
        ...(source.uncommittedSources !== undefined ? { uncommittedSources: source.uncommittedSources } : {}), ...(provenance ? { provenance } : {})
    };
}

// A session's provenance note, sessions/<name>/provenance.json, written after it ran when what a part recorded is not the whole story: for a
// part timed with uncommitted changes, the commit they were built on (builtFrom) and the commit they were later committed as
// (uncommittedChangesCommittedAs), each a full hash, with how that was established (established, notEstablished). It never changes the
// recorded results or which sessions are combined; the report shows it beside the recorded commit. A note about another commit than the
// one its session recorded is refused.
function readProvenance(directory) {
    const path = join(directory, 'provenance.json');
    const note = readJson(path);
    if (!note) return null;
    if (!/^[0-9a-f]{40}$/.test(note.builtFrom ?? '') || (note.uncommittedChangesCommittedAs !== undefined && !/^[0-9a-f]{40}$/.test(note.uncommittedChangesCommittedAs)) || !note.recorded?.gitCommit) {
        throw new Error(`${path}: builtFrom and uncommittedChangesCommittedAs must be full commit hashes, and recorded.gitCommit the commit the session recorded.`);
    }
    return note;
}

const commitLink = (fullCommit) => ({ gitCommit: fullCommit.slice(0, 7), fullCommit, commitUrl: repositoryUrl ? `${repositoryUrl}/commit/${fullCommit}` : null });

function describeProvenance(session, note, source) {
    if (!note.builtFrom.startsWith(note.recorded.gitCommit) || note.recorded.gitCommit !== source.gitCommit) {
        throw new Error(`sessions/${session}/provenance.json is about commit ${note.recorded.gitCommit}, but the session recorded ${source.gitCommit}.`);
    }
    return {
        summary: note.summary ?? null, builtFrom: commitLink(note.builtFrom),
        committedAs: note.uncommittedChangesCommittedAs ? commitLink(note.uncommittedChangesCommittedAs) : null, file: `sessions/${session}/provenance.json`
    };
}

// Every session with results, each part marked as timed from the newest source (combined) or not (superseded). A session folder counts only
// if a part in it wrote its results: a session stopped before any part finished (its preflight refused, or it was interrupted) leaves an
// empty folder, which is not a session.
export function selectSessions(machineDirectory, chosen = null) {
    const directory = join(machineDirectory, 'sessions');
    if (!existsSync(directory)) return { sessions: [], source: null, superseded: [] };
    const all = readdirSync(directory).filter((name) => statSync(join(directory, name)).isDirectory() && (!chosen || chosen.includes(name))).sort()
        .map((name) => ({ name, directory: join(directory, name), parts: Object.keys(sessionParts).map((part) => ({ part, source: partSource(join(directory, name), part) })).filter((entry) => entry.source) }))
        .filter((session) => session.parts.length)
        .map((session) => ({ ...session, note: readProvenance(session.directory) }));
    const newestEntry = all.flatMap((session) => session.parts.map((entry) => ({ ...entry, session }))).filter((entry) => entry.source.timesKonjugate && known(entry.source.gitCommit)).at(-1) ?? null;
    const newest = newestEntry?.source ?? null;
    const newestTime = newest ? commitTime(newest.gitCommit) : null;
    const current = (session, source) => !newest || (known(source.gitCommit) ? source.gitCommit === newest.gitCommit : newestTime !== null && sessionStart(session.name) !== null && sessionStart(session.name) > newestTime);
    const superseded = [];
    const sessions = all.map((session) => {
        const parts = new Set();
        for (const { part, source } of session.parts) {
            if (current(session, source)) parts.add(part);
            else superseded.push(describePart(session.name, part, source, session.note));
        }
        return { name: session.name, directory: session.directory, parts, details: Object.fromEntries(session.parts.map(({ part, source }) => [part, describePart(session.name, part, source, session.note)])) };
    }).filter((session) => session.parts.size);
    const newestPart = newest && describePart(newestEntry.session.name, newestEntry.part, newest, newestEntry.session.note);
    const source = newest ? { konjugateVersion: newest.konjugateVersion, gitCommit: newest.gitCommit, fullCommit: newestPart.fullCommit, commitUrl: newestPart.commitUrl, ...(newestPart.provenance ? { provenance: newestPart.provenance } : {}) } : null;
    return { sessions, source, superseded };
}

function combineSuite(sessions, part) {
    const byKey = new Map();
    const sessionsWithPart = [];
    for (const session of sessions) {
        if (!session.parts.has(part)) continue;
        const summary = readJson(join(session.directory, part, 'summary.json'));
        if (!summary?.timings) continue;
        sessionsWithPart.push({ ...session.details[part], conditions: summary.timing?.conditions ?? null, quietGate: summary.timing?.quietGate ?? null, machine: summary.machine, run: summary.run });
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
            if (!session.parts.has(part)) continue;
            const summary = readJson(join(session.directory, part, 'comparisons.json'));
            if (!summary) continue;
            latest = { ...(latest ?? {}), ...summary, versions: { ...(latest?.versions ?? {}), ...summary.versions }, startup: { ...(latest?.startup ?? {}), ...summary.startup },
                references: { ...(latest?.references ?? {}), ...summary.references }, openModelicaTranslation: { ...(latest?.openModelicaTranslation ?? {}), ...summary.openModelicaTranslation } };
            const provenance = session.details[part].provenance;
            if (provenance && summary.versions?.konjugate) {
                latest.versions.konjugate = { ...summary.versions.konjugate, provenance: { summary: provenance.summary, builtFrom: provenance.builtFrom.gitCommit, committedAs: provenance.committedAs?.gitCommit ?? null } };
            }
            included.push({ ...session.details[part], conditions: summary.conditions, quietGate: summary.quietGate, rounds: summary.rounds });
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

const utc = (iso) => (iso ? `${iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '')} UTC` : 'not recorded');
const commitLinkHtml = (entry) => (entry.commitUrl ? `<a href="${escapeXml(entry.commitUrl)}"><code>${escapeXml(entry.gitCommit)}</code></a>` : `<code>${escapeXml(entry.gitCommit ?? 'not recorded')}</code>`);
// The commit a part timed; with a provenance note, what the note established instead of only "dirty".
const commitHtml = (entry) => (entry.provenance
    ? `built from ${commitLinkHtml(entry.provenance.builtFrom)} with uncommitted changes${entry.provenance.committedAs ? `, committed as ${commitLinkHtml(entry.provenance.committedAs)}` : ''} (<a href="${escapeXml(entry.provenance.file)}">provenance</a>)`
    : `${commitLinkHtml(entry)}${entry.workingTreeChanges ? (timedUncommitted(entry) ? ' (dirty: uncommitted changes)' : ' (uncommitted changes, none to what the engine and harness are built from)') : entry.workingTreeChanges === null || entry.workingTreeChanges === undefined ? (entry.part ? ' (uncommitted changes not recorded)' : '') : ''}`);
const sourceHtml = (source) => (source.provenance ? commitHtml(source) : `built from commit ${commitHtml(source)}`);

// Whether a part was timed with uncommitted changes to what the engine or the harness is built from: a part that recorded which
// (uncommittedSources, lib/sourceGuard.mjs) and found none had changes elsewhere only; an older part that did not record them counts.
const timedUncommitted = (entry) => Boolean(entry.workingTreeChanges) && !(Array.isArray(entry.uncommittedSources) && !entry.uncommittedSources.length);

// Shown at the top of the report whenever a combined part was timed with uncommitted changes: with a provenance note, what it established;
// without one, that the numbers cannot be traced to a commit.
function uncommittedNotice(parts) {
    const dirty = parts.filter(timedUncommitted);
    if (!dirty.length) return '';
    const explained = dirty.filter((entry) => entry.provenance);
    const unexplained = dirty.filter((entry) => !entry.provenance);
    // Each session once, with its parts: "session 2026-11-24T21-11-16 (problems, scaling, comparisons)".
    const names = (entries) => [...new Set(entries.map((entry) => entry.session))].map((session) => `session ${escapeXml(session)} (${entries.filter((entry) => entry.session === session).map((entry) => escapeXml(entry.part)).join(', ')})`).join('; ');
    const notes = [...new Map(explained.map((entry) => [entry.provenance.file, entry.provenance])).values()];
    return `${notes.map((note) => `<p class="notice"><strong>Timed with uncommitted changes, committed since.</strong> ${names(explained.filter((entry) => entry.provenance.file === note.file))}: ${escapeXml(note.summary ?? `the engine was ${note.builtFrom.gitCommit} with uncommitted changes.`)} <a href="${escapeXml(note.file)}">How this was established, and what was not</a>.</p>\n`).join('')}${unexplained.length ? `<p class="notice"><strong>Timed with uncommitted changes.</strong> ${names(unexplained)} ran from a checkout with uncommitted changes${unexplained.some((entry) => entry.uncommittedSources?.length) ? ` to what the engine or the harness is built from (<code>--allow-uncommitted</code>; the files are listed in combined.json)` : ''}, so what was timed is not a commit, and these numbers cannot be reproduced from the repository.</p>\n` : ''}`;
}

function sessionsTable(entries) {
    const condition = (value) => (value ? `load ${value.loadAverage?.join(' / ')}; ${value.power ?? ''}; ${value.thermal ?? ''}` : '–');
    const gate = (value) => {
        const gates = value && !value.rule ? Object.values(value).filter(Boolean) : [value].filter(Boolean);
        return gates.map((entry) => `${entry.quickChecks} timed runs checked, ${entry.quickFailures} waited again, ${entry.waitedSeconds} s waited; limits load ${entry.limits?.load ?? 2}, other processes ${entry.limits?.otherCores ?? 2} cores${entry.baseline ? ` (idle baseline ${entry.baseline.loadMedian} / ${entry.baseline.otherCoresMedian})` : ''}; Docker up at ${(entry.timedRunsWithDockerUp ?? 0) + (entry.runnerTimedRunsWithDockerUp ?? 0)} timed runs`).join(' · ') || '–';
    };
    const rows = entries.map((entry) => {
        const conditions = entry.conditions?.start ? entry.conditions : Object.values(entry.conditions ?? {})[0] ?? null;
        return `<tr><td>${escapeXml(entry.session)}</td><td>${escapeXml(entry.part)}</td><td>${escapeXml(utc(entry.startedAt))}</td><td>${escapeXml(entry.konjugateVersion ?? 'not recorded')}, ${commitHtml(entry)}</td><td>${escapeXml(condition(conditions?.start))}</td><td>${escapeXml(condition(conditions?.end))}</td><td>${escapeXml(gate(entry.quietGate))}</td></tr>`;
    }).join('');
    return `<div class="scroll"><table><thead><tr><th>Session</th><th>Part</th><th>Started</th><th>Konjugate, commit</th><th>At the start</th><th>At the end</th><th>Quiet gate</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function supersededTable(entries) {
    const rows = entries.map((entry) => `<tr><td>${escapeXml(entry.session)}</td><td>${escapeXml(entry.part)}</td><td>${escapeXml(utc(entry.startedAt))}</td><td>${escapeXml(entry.konjugateVersion ?? 'not recorded')}</td><td>${commitHtml(entry)}</td></tr>`).join('');
    return `<div class="scroll"><table><thead><tr><th>Session</th><th>Part</th><th>Started</th><th>Version</th><th>Commit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
    const { sessions, source, superseded } = selectSessions(machineDirectory, chosen);
    if (!sessions.length) throw new Error(`No sessions under ${join(machineDirectory, 'sessions')}: run npm run benchmark:performance first.`);
    const problems = combineSuite(sessions, 'problems');
    const scaling = combineSuite(sessions, 'scaling');
    const comparisons = combineComparisons(sessions);
    const machine = [...problems.sessions, ...scaling.sessions].at(-1)?.machine ?? comparisons?.machine ?? null;
    const combinedParts = sessions.flatMap((session) => [...session.parts].map((part) => session.details[part]));
    const combined = { machine, source, sessions: sessions.map((session) => session.name), sessionParts: combinedParts, supersededSessions: superseded, problems: problems.rows, scaling: scaling.rows, statistic: 'minimum over all runs of all combined sessions (those timed from the source commit); median and interquartile range over all runs; between-session spread of the session minimums; flagged noisy when a session\'s interquartile range exceeds 5 % of its median' };
    writeFileSync(join(machineDirectory, 'combined.json'), `${JSON.stringify(combined, null, 1)}\n`);
    writeFileSync(join(machineDirectory, 'timings.csv'), csv([...problems.rows.map((row) => ({ part: 'problems', row })), ...scaling.rows.map((row) => ({ part: 'scaling', row }))]));
    const latestProblems = [...sessions].reverse().find((session) => session.parts.has('problems') && existsSync(join(session.directory, 'problems', 'report.html')));
    const latestScaling = [...sessions].reverse().find((session) => session.parts.has('scaling') && existsSync(join(session.directory, 'scaling', 'report.html')));
    const supersededSessions = [...new Set(superseded.map((entry) => entry.session))];
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
.scroll { overflow-x: auto; } a { color: var(--series-1); } .notice { color: var(--text-primary); background: var(--surface-1); border-left: 4px solid var(--series-4); padding: 8px 12px; } dl.machine { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; } dt { font-weight: 600; }
</style></head>
<body class="viz-root"><main>
<h1>Konjugate performance report</h1>
<p>${escapeXml(machineText)}</p>
${source ? `<p>Timed from Konjugate ${escapeXml(source.konjugateVersion ?? 'version not recorded')}, the engine ${sourceHtml(source)}: ${combinedParts.map((entry) => `${escapeXml(entry.part)} started ${escapeXml(utc(entry.startedAt))}${timedUncommitted(entry) && !entry.provenance ? ' (dirty: uncommitted changes)' : ''}`).join('; ')}.</p>\n` : ''}${uncommittedNotice(combinedParts)}<p class="lede">Konjugate evaluated against established tools, reproducibly, on this computer: ${sessions.length} timing session${sessions.length === 1 ? '' : 's'} combined${superseded.length ? `, all timed from that commit; ${supersededSessions.length} earlier session${supersededSessions.length === 1 ? '' : 's'}, timed from an older source, ${supersededSessions.length === 1 ? 'is' : 'are'} kept but not combined (<a href="#superseded">Superseded sessions</a>)` : ''}. Every timing's headline is its minimum over all runs of the combined sessions, since noise on a computer only adds time; beside it are the median and interquartile range over all runs, the spread between the sessions' minimums, and a flag where a session's runs spread more than 5 %. The accuracy checks are in each session's own report${latestProblems ? ` (<a href="sessions/${latestProblems.name}/problems/report.html">the latest</a>)` : ''}; the methods are in benchmarks/README.md.</p>
<nav><p><a href="#sessions">Sessions</a> · <a href="#problems">Problem timings</a> · <a href="#scaling">Graph scalability</a>${superseded.length ? ' · <a href="#superseded">Superseded sessions</a>' : ''}</p></nav>
<section id="sessions"><h2>Sessions and their conditions</h2>${sessionsTable(sessionEntries)}</section>
<section id="problems"><h2>Problem timings</h2><p>Each problem's timing cases: the engine process's wall time and its own integration time.</p>${problems.rows.length ? suiteTable(problems.rows, { scaling: false }) : '<p>Not run in these sessions.</p>'}</section>
<section id="scaling"><h2>Graph scalability</h2><p>Generated thermal graphs on the serial, thread-pool and partitioned backends: the engine's integration time, node steps per second and each parallel backend's speed-up over serial, all from the minimums.${latestScaling ? ` The plots are in <a href="sessions/${latestScaling.name}/scaling/report.html">the latest session's report</a>.` : ''}</p>${scaling.rows.length ? suiteTable(scaling.rows, { scaling: true }) : '<p>Not run in these sessions.</p>'}</section>
${superseded.length ? `<section id="superseded"><h2>Superseded sessions</h2><p>Timed from an older source than the engine ${sourceHtml(source)}, so not combined: their results stay in sessions/ for the record, and none of their numbers are above.</p>${supersededTable(superseded)}</section>\n` : ''}</main></body></html>
`);
    if (comparisons) {
        const directory = join(machineDirectory, 'comparisons');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'comparisons.json'), `${JSON.stringify(comparisons, (_key, value) => (typeof value === 'number' && !Number.isFinite(value) ? String(value) : value), 1)}\n`);
        await writeComparisonReport(directory, reportPath);
    }
    console.log(`Combined ${sessions.length} session${sessions.length === 1 ? '' : 's'}${source ? ` timed from commit ${source.gitCommit}${source.provenance?.committedAs ? ` with uncommitted changes, committed as ${source.provenance.committedAs.gitCommit} (provenance note)` : ''}` : ''}${superseded.length ? `; superseded, not combined: ${supersededSessions.join(', ')}` : ''}: ${reportPath}`);
    return reportPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values: options, positionals } = parseArgs({ options: { sessions: { type: 'string' } }, allowPositionals: true });
    const machineDirectory = positionals[0] ?? resultsDirectory();
    try {
        await combineSessions(machineDirectory, { sessions: options.sessions?.split(',') ?? null });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
