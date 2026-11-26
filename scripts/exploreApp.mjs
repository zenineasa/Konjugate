/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Drives the desktop app from a script, for exploring it as a person would (docs/drivingTheApp.md):
//
//     node scripts/exploreApp.mjs path/to/script.mjs [--out <folder>] [--minutes <n>] [--keep-profile]
//
// The script exports `async function explore(driver, context)`. It runs inside the app's main process, launched as the interaction
// tests launch it: a scratch profile (the first-model tour already taken), Chromium's mock keychain, the engine in out/engine, and
// every native dialog answered by the driver (tests/drivers/electronWindowDriver.mjs) rather than left on the screen. See
// tests/explore/openExampleOverChanges.mjs for an example. Nobody should need a wrapper of their own.
//
// Before it starts it refuses to run while the screen is locked or another driven run (an interaction suite, another exploration)
// is using the desktop: only one may run on a computer at a time. While it runs the computer is kept awake, and the run is stopped,
// saying so, if the app's main process stops answering for 30 seconds or the run takes longer than --minutes (15 by default).

import electronPath from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWelcomeStateStore, withTourCompleted } from '../src/welcomeStateStore.mjs';
import { installInteractionAddons } from './interactionAddons.mjs';

const usage = 'Usage: node scripts/exploreApp.mjs <script.mjs> [--out <folder>] [--minutes <n>] [--keep-profile]';

export function parseArguments(argv) {
    const options = { script: null, out: null, minutes: 15, keepProfile: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--out') options.out = argv[++index];
        else if (argument === '--minutes') options.minutes = Number(argv[++index]);
        else if (argument === '--keep-profile') options.keepProfile = true;
        else if (argument === '--help' || argument === '-h') return { help: true };
        else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}.\n${usage}`);
        else if (options.script) throw new Error(`One script at a time.\n${usage}`);
        else options.script = argument;
    }
    if (!options.script) throw new Error(usage);
    if (!(options.minutes > 0)) throw new Error('--minutes takes a number of minutes above 0.');
    if (options.out === undefined) throw new Error('--out takes a folder.');
    return options;
}

const run = (command, args) => new Promise((resolveRun) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolveRun(error ? null : stdout));
});

// The app in front, on macOS: the login window when the screen is locked, when nothing a run does reaches the screen (a window does
// not draw, and the run fails in ways that look like bugs).
export const lockedScreen = (frontAppInfo) => /loginwindow/i.test(frontAppInfo ?? '');
async function screenIsLocked() {
    if (process.platform !== 'darwin') return false;
    const front = (await run('lsappinfo', ['front']))?.trim();
    if (!front) return false;
    return lockedScreen(await run('lsappinfo', ['info', '-only', 'name', front]));
}

// Other driven runs of the app on this computer: Electron started with --interaction-test, by the suite or by this script.
export function otherDrivenRuns(psOutput, ownPid = process.pid) {
    return (psOutput ?? '').split('\n').map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
        .map(([, pid, command]) => ({ pid: Number(pid), command }))
        .filter(({ pid, command }) => pid !== ownPid && /--interaction-test/.test(command) && /electron/i.test(command) && !/exploreApp\.mjs|runInteractionTests\.mjs|\bgrep\b|\bpgrep\b/.test(command));
}

async function main() {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exit(2);
    }
    if (options.help) { console.log(usage); return; }
    const script = resolve(options.script);
    if (!existsSync(script)) { console.error(`No script at ${script}.`); process.exit(2); }

    if (await screenIsLocked()) {
        console.error('The screen is locked (the login window is in front): nothing a run does would reach the screen. Unlock it and try again.');
        process.exit(3);
    }
    const others = otherDrivenRuns(await run('ps', ['-axo', 'pid=,command=']));
    if (others.length) {
        console.error(`Another driven run of the app is using the desktop (only one may run at a time):\n${others.map(({ pid, command }) => `  ${pid} ${command.slice(0, 160)}`).join('\n')}\nWait for it to finish.`);
        process.exit(3);
    }
    const root = process.cwd();
    const engine = join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
    if (!existsSync(engine)) console.warn(`No engine at ${engine}: anything that runs a model will fail. Build it with npm run build:engine.`);

    const userData = await mkdtemp(join(tmpdir(), 'konjugate-explore-'));
    const outputDirectory = resolve(options.out ?? await mkdtemp(join(tmpdir(), 'konjugate-explore-output-')));
    const heartbeatFile = join(userData, 'heartbeat');
    // Someone who has taken the first-model tour: it would otherwise start in place of what the script opens.
    await createWelcomeStateStore({ directory: userData }).update(withTourCompleted);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    Object.assign(environment, {
        KONJUGATE_INTERACTION_USER_DATA: userData,
        KONJUGATE_INTERACTION_INSTALLED_ADDONS: (await installInteractionAddons(root, userData)).join(','),
        KONJUGATE_EXPLORE_SCRIPT: script,
        KONJUGATE_EXPLORE_OUTPUT: outputDirectory,
        KONJUGATE_EXPLORE_HEARTBEAT: heartbeatFile
    });
    console.log(`Exploring with ${script}\n  output: ${outputDirectory}\n  profile: ${userData}${options.keepProfile ? ' (kept)' : ''}`);

    // As scripts/runInteractionTests.mjs launches the app (--use-mock-keychain: no Keychain prompt for model configurations).
    const child = spawn(electronPath, ['.', '--interaction-test', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-mock-keychain'], { cwd: root, env: environment, stdio: 'inherit' });
    // Kept awake while it runs: an idle sleep in the middle stalls it in ways that look like bugs.
    const awake = process.platform === 'darwin' ? spawn('caffeinate', ['-dimsu', '-w', String(child.pid)], { stdio: 'ignore' }) : null;
    awake?.on('error', () => {});

    let stopped = null;
    const stop = (reason) => {
        if (stopped || child.exitCode !== null) return;
        stopped = reason;
        console.error(`\nStopped: ${reason}`);
        child.kill('SIGKILL');
    };
    const startedAt = Date.now();
    const watchdog = setInterval(async () => {
        if (Date.now() - startedAt > options.minutes * 60_000) { stop(`the run took longer than ${options.minutes} minutes (--minutes).`); return; }
        // The heartbeat starts once the app has loaded its first window; until then the start-up is given a minute.
        const beat = await readFile(heartbeatFile, 'utf8').then(Number, () => null);
        const silentFor = Date.now() - (beat ?? startedAt);
        if (silentFor > (beat ? 30_000 : 60_000)) stop(`the app's main process did not answer for ${Math.round(silentFor / 1000)} s (a synchronous wait or a busy loop${beat ? '' : '; it may not have started'}).`);
    }, 2000);

    const code = await new Promise((resolveExit) => {
        child.once('error', (error) => { console.error(error); resolveExit(1); });
        child.once('close', (exitCode, signal) => resolveExit(stopped ? 1 : exitCode ?? (signal ? 1 : 0)));
    });
    clearInterval(watchdog);
    awake?.kill();
    if (!options.keepProfile) await rm(userData, { recursive: true, force: true });
    console.log(`Output in ${outputDirectory}`);
    console.log(code === 0 ? 'The exploration finished.' : `The exploration failed (exit code ${code}).`);
    process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
