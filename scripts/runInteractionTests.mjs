/* Copyright © 2026 Zenin Easa Panthakkalakath */

import electronPath from 'electron';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInteractionAddons } from './interactionAddons.mjs';

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const userDataDirectory = await mkdtemp(join(tmpdir(), 'konjugate-interaction-'));
// Coverage (scripts/coverageReport.mjs): the main process through Node's own NODE_V8_COVERAGE, the project window through the
// driver (tests/drivers/electronWindowDriver.mjs).
if (environment.KONJUGATE_INTERACTION_COVERAGE) environment.NODE_V8_COVERAGE = join(environment.KONJUGATE_INTERACTION_COVERAGE, 'main');
environment.KONJUGATE_INTERACTION_USER_DATA = userDataDirectory;
environment.KONJUGATE_INTERACTION_INSTALLED_ADDONS = (await installInteractionAddons(process.cwd(), userDataDirectory)).join(',');
// --use-mock-keychain: listing model configurations asks Electron's safeStorage whether encryption is
// available, which on macOS looks up (or creates) an item in the login Keychain and prompts for access.
// The tests do not need the real Keychain, so Chromium's mock one keeps them from asking.
const child = spawn(electronPath, ['.', '--interaction-test', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-mock-keychain'], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit'
});

// A watchdog on the app's memory: every process of it (the main process, its windows, its engines) is looked at every two seconds, and
// one past the limit stops the run at once, saying which, rather than leaving a leak to grow until the computer swaps and freezes.
// KONJUGATE_INTERACTION_MEMORY_LIMIT_MB sets the limit (2500 MB a process by default); KONJUGATE_INTERACTION_MEMORY_LOG=1 also prints
// the app's memory every fifteen seconds, between the scenarios' own lines, to see which one it grows in.
const memoryLimitMegabytes = Number(environment.KONJUGATE_INTERACTION_MEMORY_LIMIT_MB) > 0 ? Number(environment.KONJUGATE_INTERACTION_MEMORY_LIMIT_MB) : 2500;
const logMemory = environment.KONJUGATE_INTERACTION_MEMORY_LOG === '1';
let stoppedForMemory = null;
let reportAsked = false;
let lastLogged = 0;
const appProcesses = () => new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (error, output) => {
        if (error) { resolve([]); return; }
        const rows = output.trim().split('\n').map((line) => {
            const [pid, ppid, rss, ...name] = line.trim().split(/\s+/);
            return { pid: Number(pid), ppid: Number(ppid), megabytes: Number(rss) / 1024, name: name.join(' ').split('/').pop() };
        });
        const ours = new Set([child.pid]);
        for (let grew = true; grew;) {
            grew = false;
            for (const row of rows) if (!ours.has(row.pid) && ours.has(row.ppid)) { ours.add(row.pid); grew = true; }
        }
        resolve(rows.filter((row) => ours.has(row.pid)));
    });
});
const watchdog = setInterval(async () => {
    if (stoppedForMemory || child.exitCode !== null) return;
    const processes = await appProcesses();
    if (!processes.length) return;
    const largest = processes.reduce((top, row) => (row.megabytes > top.megabytes ? row : top));
    if (logMemory && Date.now() - lastLogged >= 15000) {
        lastLogged = Date.now();
        const main = processes.find((row) => row.pid === child.pid);
        const total = processes.reduce((sum, row) => sum + row.megabytes, 0);
        console.error(`  [memory] main ${Math.round(main?.megabytes ?? 0)} MB · largest ${largest.name} ${Math.round(largest.megabytes)} MB · ${processes.length} processes ${Math.round(total)} MB`);
    }
    // Past most of the limit, the main process is asked for Node's report of itself (with the JavaScript stack: what it is doing), once,
    // when KONJUGATE_INTERACTION_REPORTS names a folder for it.
    const main = processes.find((row) => row.pid === child.pid);
    if (!reportAsked && environment.KONJUGATE_INTERACTION_REPORTS && main && main.megabytes > memoryLimitMegabytes * 0.7) {
        reportAsked = Date.now();
        console.error(`  [memory] the main process is at ${Math.round(main.megabytes)} MB: asked for a report in ${environment.KONJUGATE_INTERACTION_REPORTS}`);
        try { process.kill(child.pid, 'SIGUSR2'); } catch { /* gone */ }
    }
    // Stopped past the limit; a report asked for is given a few seconds to be written first.
    if (largest.megabytes > memoryLimitMegabytes && (!reportAsked || Date.now() - reportAsked > 5000)) {
        stoppedForMemory = largest;
        console.error(`\nStopped: ${largest.name} (pid ${largest.pid}${largest.pid === child.pid ? ', the main process' : ''}) used ${Math.round(largest.megabytes)} MB, past the ${memoryLimitMegabytes} MB limit.`);
        for (const row of processes.reverse()) { try { process.kill(row.pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
}, 2000);

child.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => {
    clearInterval(watchdog);
    rm(userDataDirectory, { recursive: true, force: true }).finally(() => {
        process.exitCode = stoppedForMemory ? 1 : code ?? (signal ? 1 : 0);
    });
});
