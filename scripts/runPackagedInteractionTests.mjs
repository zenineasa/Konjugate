// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs the same --interaction-test suite scripts/runInteractionTests.mjs runs, but against the
// packaged app binary instead of the dev Electron launch. main.mjs's resolveEnginePath() has a
// dedicated packaged-resource code path (packaged: app.isPackaged) that the dev-mode suite never
// exercises; likewise example/add-on discovery, icon loading, and anything else resolved
// relative to the app's on-disk layout differs between an unpackaged checkout and an asar/
// resources bundle. Requires a package built for the host platform with the test runner bundled in
// -- `make verifyPackagedInteraction` builds one and runs this; this does not build one itself.
//
// When a scenario fails, the whole suite is run once more (scripts/interactionRetry.mjs): a break in
// packaging fails both times and fails the run, while one that only passes the second time is reported
// as flaky (a warning on GitHub Actions) without failing it. All of it, not just what failed: many
// scenarios work on what the ones before them left (the nodes, a finished run), so one run alone is not
// a fair second try. KONJUGATE_INTERACTION_RETRY=0
// turns the second pass off, as when a failure itself is being looked at.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootDirectory } from './developmentEnvironment.mjs';
import { installInteractionAddons } from './interactionAddons.mjs';
import { combineOutcomes } from './interactionRetry.mjs';
import { packagedAppExecutable } from './packagedPaths.mjs';

const executable = packagedAppExecutable(rootDirectory);
if (!existsSync(executable)) {
    throw new Error(`No packaged app binary found at ${executable}. Run "make verifyPackagedInteraction", which packages the app with the test runner and runs this.`);
}

// One run of the suite in a fresh user-data folder, or of the scenarios `only` names. Returns how each scenario went,
// or null when the app ended without saying (it crashed, or never reached the end).
async function runPass(only) {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'konjugate-packaged-interaction-'));
    const resultsFile = join(userDataDirectory, 'interactionResults.json');
    environment.KONJUGATE_INTERACTION_USER_DATA = userDataDirectory;
    environment.KONJUGATE_INTERACTION_RESULTS = resultsFile;
    environment.KONJUGATE_INTERACTION_INSTALLED_ADDONS = (await installInteractionAddons(rootDirectory, userDataDirectory)).join(',');
    if (only) environment.KONJUGATE_INTERACTION_ONLY = only;
    try {
        // --use-mock-keychain: listing model configurations asks Electron's safeStorage whether encryption is
        // available, which on macOS looks up (or creates) an item in the login Keychain and prompts for access.
        // The tests do not need the real Keychain, so Chromium's mock one keeps them from asking.
        const child = spawn(executable, ['--interaction-test', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-mock-keychain'], {
            cwd: rootDirectory,
            env: environment,
            stdio: 'inherit'
        });
        await new Promise((resolve) => {
            child.once('error', (error) => {
                console.error(error);
                resolve();
            });
            child.once('exit', resolve);
        });
        try {
            return JSON.parse(await readFile(resultsFile, 'utf8')).outcomes;
        } catch {
            return null;
        }
    } finally {
        await rm(userDataDirectory, { recursive: true, force: true });
    }
}

const onGitHub = process.env.GITHUB_ACTIONS === 'true';
const annotate = (level, title, message) => {
    if (onGitHub) console.log(`::${level} title=${title.replaceAll(/[\n\r:,]/g, ' ')}::${message.replaceAll('\n', '%0A')}`);
};

async function summarize(lines) {
    console.log(`\n${lines.join('\n')}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

const firstPass = await runPass(process.env.KONJUGATE_INTERACTION_ONLY);
if (!firstPass) {
    annotate('error', 'Packaged interaction tests', 'The packaged app ended before the suite finished (see the log).');
    console.error('The packaged app ended before the suite finished.');
    process.exit(1);
}
const firstFailures = firstPass.filter(({ status }) => status === 'failed');
if (!firstFailures.length) process.exit(0);

if (process.env.KONJUGATE_INTERACTION_RETRY === '0') {
    await summarize([`### Packaged interaction tests`, `${firstFailures.length} failed (no second pass: KONJUGATE_INTERACTION_RETRY=0):`, ...firstFailures.map(({ name }) => `- ${name}`)]);
    process.exit(1);
}

console.log(`\n${firstFailures.length} scenario${firstFailures.length === 1 ? '' : 's'} failed; running the suite again:`);
for (const { name } of firstFailures) console.log(`  ${name}`);
const secondPass = await runPass(process.env.KONJUGATE_INTERACTION_ONLY);
if (!secondPass) {
    annotate('error', 'Packaged interaction tests', 'The packaged app ended before the second pass finished (see the log).');
    console.error('The packaged app ended before the second pass finished.');
    process.exit(1);
}

const { failed, flaky } = combineOutcomes(firstPass, secondPass);
for (const name of flaky) annotate('warning', 'Flaky interaction test', `Failed once and passed when run again (packaged app): ${name}`);
for (const name of failed) annotate('error', 'Interaction test failed twice', name);
await summarize([
    '### Packaged interaction tests',
    failed.length ? `**${failed.length} failed twice** (this fails the run):` : 'Every failure passed when run again.',
    ...failed.map((name) => `- ${name}`),
    ...(flaky.length ? ['', `${flaky.length} flaky (failed once, passed the second time; worth fixing its timing):`, ...flaky.map((name) => `- ${name}`)] : [])
]);
process.exit(failed.length ? 1 : 0);
