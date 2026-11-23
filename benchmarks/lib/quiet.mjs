/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Waits for a quiet computer before timing (benchmarks/README.md, Timing). Two checks:
//
//   the full gate, before a timing phase starts: on mains power, none of the processes below running (Docker among them), and the one-minute load average
//   below 2 for two minutes on end;
//   the quick check, before every timed run: on mains power, none of the processes below running, and the processor time of every process
//   outside this run's own process tree below two cores' worth. The load average cannot be used here: it counts the benchmark's own runs,
//   which a moment before were timed on up to eight threads. When the quick check fails, the full gate is waited for again.
//
// The processes that disturb a timing run: a compiler, CMake or a build tool; Konjugate's own Electron (the development build or the
// installed app) and its interaction test runners; browsers driven by tests (lib/machine.mjs, busyPatterns); and Docker. Other Electron-based
// applications the computer happens to have open (an editor, the agent host) are not counted: their load, if any, is in the load average.
// Every wait is written to the console and counted, and the counts are kept with the results, with every timed run's instant, one-minute
// load average and whether Docker was up (timing-conditions.csv).

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import { busyProcesses } from './machine.mjs';

const compilerPattern = /^(clang|clang\+\+|cc1|cc1plus|c\+\+|cc|g\+\+|gcc|ld|ld64|ld64\.lld|cmake|ctest|ninja|make|gmake|swift-frontend|swiftc|rustc|cargo|emcc|em\+\+|wasm-ld|xcodebuild)$/;
// The limits, 2 by default; KONJUGATE_QUIET_LOAD_LIMIT and KONJUGATE_QUIET_CORE_LIMIT set others (an idle baseline plus a margin, say, on
// a computer whose own background is steady), and the limits used are recorded with the results.
const loadLimit = Number(process.env.KONJUGATE_QUIET_LOAD_LIMIT ?? 2);
const quietSeconds = Number(process.env.KONJUGATE_QUIET_HOLD_SECONDS ?? 120);
const sampleSeconds = 10;
const externalCoreLimit = Number(process.env.KONJUGATE_QUIET_CORE_LIMIT ?? 2);

const sleep = (seconds) => new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });

function processTable() {
    try {
        return execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
            .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)).filter(Boolean)
            .map(([, pid, ppid, cpu, command]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), command }));
    } catch {
        return [];
    }
}

function powerSource() {
    if (process.platform !== 'darwin') return 'AC Power';
    try {
        return /'(AC Power|Battery Power)'/.exec(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }))?.[1] ?? null;
    } catch {
        return null;
    }
}

// This process, its ancestors (the shell, caffeinate) and its descendants (the engine runs): their load is the benchmark's own.
function ownTree(table) {
    const parentOf = new Map(table.map((entry) => [entry.pid, entry.ppid]));
    const own = new Set([process.pid]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const entry of table) if (!own.has(entry.pid) && own.has(entry.ppid)) { own.add(entry.pid); grew = true; }
    }
    // The ancestors themselves (a shell, caffeinate, the runner that started this one), but not their other children.
    for (let pid = parentOf.get(process.pid); pid > 1 && !own.has(pid); pid = parentOf.get(pid) ?? 1) own.add(pid);
    return own;
}

// Docker Desktop's virtual machine, or Docker itself, running: it takes processor time and memory in the background. Timing waits for it to
// be quit, except where KONJUGATE_QUIET_ALLOW_DOCKER=1 says the run is the one that needs it (OpenModelica, timed apart).
const dockerPattern = /^\/Applications\/Docker\.app\/|^\S*com\.apple\.Virtualization\.VirtualMachine|^\S*\/(dockerd|colima|limactl|podman)(\s|$)/;
export function dockerRunning(table = processTable()) {
    const own = ownTree(table);
    return table.some((entry) => !own.has(entry.pid) && dockerPattern.test(entry.command));
}

// Under KONJUGATE_QUIET_STRICT=1 (npm run benchmark:performance) any Electron-based application, Agent Orchestrator among them, an editor
// with a terminal or a chat app, also stands in the way: the published timings are taken with everything else closed.
const electronPattern = /Electron Framework\.framework|\/Agent Orchestrator\.app\/|node_modules\/electron\/dist\//;
function electronApplications(table, own) {
    return [...new Set(table.filter((entry) => !own.has(entry.pid) && electronPattern.test(entry.command))
        .map((entry) => /\/([^/]+)\.app\/Contents\//.exec(entry.command)?.[1] ?? 'Electron'))];
}

// What stands in the way of timing now, as plain reasons; empty when nothing does.
export function obstacles({ quick }) {
    const reasons = [];
    const power = powerSource();
    if (power !== 'AC Power') reasons.push(`on ${power ?? 'unknown power'}, not AC Power`);
    const table = processTable();
    const own = ownTree(table);
    const compilers = table.filter((entry) => !own.has(entry.pid) && compilerPattern.test(entry.command.split(/\s+/)[0].split('/').at(-1)));
    if (compilers.length) reasons.push(`compiler or build tool running: ${[...new Set(compilers.map((entry) => entry.command.split(/\s+/)[0].split('/').at(-1)))].join(', ')}`);
    if (process.env.KONJUGATE_QUIET_ALLOW_DOCKER !== '1' && dockerRunning(table)) reasons.push('Docker is running');
    if (process.env.KONJUGATE_QUIET_STRICT === '1') {
        const applications = electronApplications(table, own);
        if (applications.length) reasons.push(`Electron applications running: ${applications.join(', ')}`);
    }
    const busy = busyProcesses().filter((entry) => !own.has(entry.pid));
    if (busy.length) reasons.push(`${[...new Set(busy.map((entry) => entry.kind))].join(', ')} running`);
    if (quick) {
        const external = table.filter((entry) => !own.has(entry.pid)).reduce((total, entry) => total + entry.cpu, 0) / 100;
        if (external >= externalCoreLimit) reasons.push(`other processes using ${external.toFixed(2)} cores (limit ${externalCoreLimit})`);
    } else {
        const load = os.loadavg()[0];
        if (load >= loadLimit) reasons.push(`1-minute load average ${load.toFixed(2)} (limit ${loadLimit})`);
    }
    return reasons;
}

// Before anything is timed: what must be put right first, as plain reasons, with no waiting (npm run benchmark:performance refuses to start
// on any): mains power, Docker quit, no compiler, build tool, Electron application, Agent Orchestrator or test running.
export function preflight() {
    const previous = process.env.KONJUGATE_QUIET_STRICT;
    process.env.KONJUGATE_QUIET_STRICT = '1';
    try {
        return obstacles({ quick: true }).filter((reason) => !reason.startsWith('other processes using'));
    } finally {
        if (previous === undefined) delete process.env.KONJUGATE_QUIET_STRICT; else process.env.KONJUGATE_QUIET_STRICT = previous;
    }
}

export function createQuietGate({ log = console.log } = {}) {
    const stats = { fullGates: 0, quickChecks: 0, quickFailures: 0, waitedSeconds: 0, loadAtTimedRuns: [], timedRuns: [] };

    async function full(label = '') {
        stats.fullGates += 1;
        const started = Date.now();
        let quietSince = null;
        let lastSaid = '';
        for (;;) {
            const reasons = obstacles({ quick: false });
            if (reasons.length) {
                quietSince = null;
                const said = reasons.join('; ');
                if (said !== lastSaid) log(`[quiet] waiting${label ? ` before ${label}` : ''}: ${said}`);
                lastSaid = said;
            } else {
                quietSince ??= Date.now();
                if ((Date.now() - quietSince) / 1000 >= quietSeconds) break;
                if (lastSaid !== 'holding') log(`[quiet] quiet; holding for ${quietSeconds} s (load ${os.loadavg()[0].toFixed(2)})`);
                lastSaid = 'holding';
            }
            await sleep(sampleSeconds);
        }
        const waited = (Date.now() - started) / 1000;
        stats.waitedSeconds += waited;
        log(`[quiet] ready${label ? ` for ${label}` : ''} after ${waited.toFixed(0)} s (load ${os.loadavg().map((value) => value.toFixed(2)).join(' ')})`);
    }

    async function beforeTimedRun(label = '') {
        stats.quickChecks += 1;
        const reasons = obstacles({ quick: true });
        if (reasons.length) {
            stats.quickFailures += 1;
            log(`[quiet] not quiet before a timed run${label ? ` (${label})` : ''}: ${reasons.join('; ')}`);
            await full(label);
        }
        const entry = { at: new Date().toISOString(), label, load1: Number(os.loadavg()[0].toFixed(2)), docker: dockerRunning(), waitedAgain: reasons.length > 0 };
        stats.loadAtTimedRuns.push(entry.load1);
        stats.timedRuns.push(entry);
        // A runner in another process (the comparisons' SciPy and Julia) logs to the file its driver names.
        if (process.env.KONJUGATE_QUIET_LOG) appendFileSync(process.env.KONJUGATE_QUIET_LOG, `${JSON.stringify(entry)}\n`);
    }

    function summary() {
        const loads = stats.loadAtTimedRuns.slice().sort((a, b) => a - b);
        return {
            rule: `${process.env.KONJUGATE_QUIET_BASELINE ? 'limits an idle baseline plus 1.0; ' : ''}full gate: AC power, no compiler, build tool, Konjugate Electron, interaction test or Docker, 1-minute load below ${loadLimit} for ${quietSeconds} s; before every timed run: AC power, none of those, other processes below ${externalCoreLimit} cores`,
            fullGates: stats.fullGates, quickChecks: stats.quickChecks, quickFailures: stats.quickFailures, waitedSeconds: Math.round(stats.waitedSeconds),
            loadAverageAtTimedRuns: loads.length ? { median: loads[Math.floor(loads.length / 2)], maximum: loads.at(-1) } : null,
            timedRunsWithDockerUp: stats.timedRuns.filter((entry) => entry.docker).length,
            limits: { load: loadLimit, otherCores: externalCoreLimit },
            baseline: process.env.KONJUGATE_QUIET_BASELINE ? JSON.parse(process.env.KONJUGATE_QUIET_BASELINE) : null
        };
    }

    // Every timed run's instant, label, one-minute load average and whether Docker was up, as CSV.
    const csv = (extra = []) => ['at,label,load1,docker,waitedAgain', ...[...stats.timedRuns, ...extra].sort((a, b) => a.at.localeCompare(b.at)).map((entry) => [entry.at, `"${String(entry.label).replaceAll('"', '""')}"`, entry.load1, entry.docker, entry.waitedAgain].join(','))].join('\n') + '\n';
    return { full, beforeTimedRun, summary, csv };
}

// node benchmarks/lib/quiet.mjs [--quick]: says what stands in the way of timing now (exit 1), or that nothing does (exit 0).
// node benchmarks/lib/quiet.mjs --wait: the check before a timed run, waiting for the full gate when it fails (the comparisons' SciPy and
// Julia runners call it before each of theirs; its own process tree includes the runner that called it).
// node benchmarks/lib/quiet.mjs --baseline <seconds>: the computer's idle background, sampled every 10 s with nothing timed: the median
// one-minute load average and the median processor time of every other process, in cores, as JSON.
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--baseline')) {
    const seconds = Number(process.argv[process.argv.indexOf('--baseline') + 1] ?? 300);
    const loads = [];
    const cores = [];
    const startedAt = new Date().toISOString();
    for (let elapsed = 0; elapsed < seconds; elapsed += sampleSeconds) {
        const table = processTable();
        const own = ownTree(table);
        loads.push(os.loadavg()[0]);
        cores.push(table.filter((entry) => !own.has(entry.pid)).reduce((total, entry) => total + entry.cpu, 0) / 100);
        await sleep(sampleSeconds);
    }
    const middle = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ startedAt, seconds, samples: loads.length, loadMedian: Number(middle(loads).toFixed(2)), loadMaximum: Number(Math.max(...loads).toFixed(2)),
        otherCoresMedian: Number(middle(cores).toFixed(2)), otherCoresMaximum: Number(Math.max(...cores).toFixed(2)), docker: dockerRunning() }));
} else if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--wait')) {
    await createQuietGate().beforeTimedRun();
} else if (import.meta.url === `file://${process.argv[1]}`) {
    const reasons = obstacles({ quick: process.argv.includes('--quick') });
    console.log(reasons.length ? `Not quiet: ${reasons.join('; ')}` : 'Quiet.');
    process.exitCode = reasons.length ? 1 : 0;
}
