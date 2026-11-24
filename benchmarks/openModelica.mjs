/* Copyright © 2026 Zenin Easa Panthakkalakath */

// npm run benchmark:openmodelica: OpenModelica on the comparison problems, after npm run benchmark:performance and apart from it
// (benchmarks/README.md, Reproduce these results). OpenModelica has no macOS build, so it runs in its Linux image under Docker (pinned by
// digest in comparisons/tools.mjs): its errors are compared with the other tools', and its times are reported only as "Linux container,
// background services running, not timing-comparable". Start Docker first; quit Docker Desktop afterwards. Nothing else is timed meanwhile.
//
// It writes a session of its own, sessions/<date and time>-openmodelica/openmodelica/, and combines the sessions again (combine.mjs).
// Every run is logged with its load and Docker state, as the other tools' are, but nothing waits for quiet: these times are caveated. A
// dry run neither logs nor waits.
//
// At its end, in a terminal, it offers to quit Docker Desktop (or reminds you to). Docker Desktop may start other containers of yours when it
// starts; they are named, and never touched.
//
// Options: --dry-run (one round, the smaller problems, into out/benchmarks/performance-dry-run/), --rounds <n> (default 3).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { combineSessions } from './combine.mjs';
import { image } from './comparisons/openmodelica/openmodelica.mjs';
import { repositoryRoot } from './lib/engine.mjs';
import { resultsDirectory } from './lib/results.mjs';

const { values: options } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, rounds: { type: 'string', default: '3' } } });
const dryRun = options['dry-run'];

function node(args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { stdio: 'inherit', env, cwd: repositoryRoot });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} failed (exit ${code}).`))));
    });
}

// Docker Desktop holds memory and processor time in the background, so it should not be left running before the next timing session: in a
// terminal, offer to quit it (docker desktop stop, which stops every container it runs, the user's own included, as quitting it does);
// otherwise say so plainly.
async function offerToQuitDocker() {
    const reminder = 'Quit Docker Desktop now if you started it for this, before any other timing session: its virtual machine, and any containers it started, use memory and processor time.';
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.platform !== 'darwin') {
        console.log(reminder);
        return;
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question('Quit Docker Desktop now? It stops every container Docker runs, yours included. [y/N] ')).trim().toLowerCase();
    prompt.close();
    if (answer !== 'y' && answer !== 'yes') {
        console.log(reminder);
        return;
    }
    const stopped = spawnSync('docker', ['desktop', 'stop'], { stdio: 'inherit' });
    console.log(stopped.status === 0 ? 'Docker Desktop quit.' : `Docker Desktop did not quit (exit ${stopped.status}): quit it from its menu.`);
}

async function main() {
    if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
        console.error('Docker is not running. Start Docker (Docker Desktop on a Mac), wait until it is ready, and run this again; quit Docker Desktop afterwards.');
        return 2;
    }
    const machineDirectory = dryRun ? join(repositoryRoot, 'out', 'benchmarks', 'performance-dry-run') : resultsDirectory();
    if (!existsSync(join(machineDirectory, 'sessions'))) {
        console.error(`Run npm run benchmark:performance${dryRun ? ' -- --dry-run' : ''} first: ${join(machineDirectory, 'sessions')} is missing.`);
        return 2;
    }
    // Docker Desktop restarts the containers whose restart policy says so when it starts: say which are running. This command never
    // touches them; it starts and removes only its own container.
    const others = spawnSync('docker', ['ps', '--format', '{{.Names}} ({{.Image}})'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    if (others.length) console.log(`Note: Docker is also running other containers, which Docker Desktop may have started by itself (they are left alone, but they share the computer with OpenModelica): ${others.join(', ')}.`);
    const session = `${new Date().toISOString().replace(/\.\d+Z$/, '').replaceAll(':', '-')}-openmodelica`;
    const output = join(machineDirectory, 'sessions', session, 'openmodelica');
    mkdirSync(output, { recursive: true });
    console.log(`OpenModelica (${image}) in Docker, session ${session}: its errors are comparable with the other tools', its times are not.`);
    const env = { ...process.env, KONJUGATE_QUIET_ALLOW_DOCKER: '1', KONJUGATE_QUIET_LOAD_LIMIT: '1000', KONJUGATE_QUIET_CORE_LIMIT: '1000', KONJUGATE_QUIET_HOLD_SECONDS: '0' };
    await node([join(repositoryRoot, 'benchmarks', 'comparisons', 'compare.mjs'), '--tools', 'openmodelica', '--rounds', dryRun ? '1' : options.rounds, ...(dryRun ? [] : ['--wait-for-quiet']), '--output', output,
        ...(dryRun ? ['--only', 'robertson,vanDerPol,lorenz,rcNetwork,stiffGrid256,buck'] : [])], env);
    const report = await combineSessions(machineDirectory);
    console.log(`\nDone. Report: ${report}.`);
    await offerToQuitDocker();
    return 0;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
}
