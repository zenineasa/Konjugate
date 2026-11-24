// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs the same --interaction-test suite scripts/runInteractionTests.mjs runs, but against the
// packaged app binary instead of the dev Electron launch. main.mjs's resolveEnginePath() has a
// dedicated packaged-resource code path (packaged: app.isPackaged) that the dev-mode suite never
// exercises; likewise example/add-on discovery, icon loading, and anything else resolved
// relative to the app's on-disk layout differs between an unpackaged checkout and an asar/
// resources bundle. Requires a package built for the host platform with the test runner bundled in
// -- `make verifyPackagedInteraction` builds one and runs this; this does not build one itself.
//
// The scenarios that fail are run once more, each with the members of its group before it
// (scripts/interactionRetry.mjs; the groups are scenarioGroups in tests/interactionRunner.mjs, and every
// other scenario sets itself up): a break in packaging fails both times and fails the run, while one that
// only passes the second time is reported as flaky (a warning on GitHub Actions) without failing it. KONJUGATE_INTERACTION_RETRY=0
// turns the second pass off, as when a failure itself is being looked at. With KONJUGATE_INTERACTION_ARTIFACTS set, each pass's
// output is also logged there, with screenshots of its failures (scripts/interactionArtifacts.mjs).

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootDirectory } from './developmentEnvironment.mjs';
import { installInteractionAddons } from './interactionAddons.mjs';
import { artifactsDirectory, failureLine, spawnLogged, summarize } from './interactionArtifacts.mjs';
import { combineOutcomes, onlyFilter, scenariosToRetry } from './interactionRetry.mjs';
import { packagedAppExecutable } from './packagedPaths.mjs';

const executable = packagedAppExecutable(rootDirectory);
// A pass takes 10 to 25 minutes; one still going after this is stuck (a dialog nothing answers, a run that never
// ends), and is stopped rather than left to use up the CI job's six hours. KONJUGATE_INTERACTION_PASS_MINUTES changes it.
const passMinutes = Number(process.env.KONJUGATE_INTERACTION_PASS_MINUTES) || 60;
if (!existsSync(executable)) {
    throw new Error(`No packaged app binary found at ${executable}. Run "make verifyPackagedInteraction", which packages the app with the test runner and runs this.`);
}

// One run of the suite in a fresh user-data folder, or of the scenarios `only` names. Returns how each scenario went,
// or null when the app ended without saying (it crashed, or never reached the end).
async function runPass(only, passName) {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const userDataDirectory = await mkdtemp(join(tmpdir(), 'konjugate-packaged-interaction-'));
    const resultsFile = join(userDataDirectory, 'interactionResults.json');
    environment.KONJUGATE_INTERACTION_USER_DATA = userDataDirectory;
    environment.KONJUGATE_INTERACTION_RESULTS = resultsFile;
    environment.KONJUGATE_INTERACTION_INSTALLED_ADDONS = (await installInteractionAddons(rootDirectory, userDataDirectory)).join(',');
    if (only) environment.KONJUGATE_INTERACTION_ONLY = only;
    if (artifactsDirectory) environment.KONJUGATE_INTERACTION_ARTIFACTS = join(artifactsDirectory, passName);
    try {
        // --use-mock-keychain: listing model configurations asks Electron's safeStorage whether encryption is
        // available, which on macOS looks up (or creates) an item in the login Keychain and prompts for access.
        // The tests do not need the real Keychain, so Chromium's mock one keeps them from asking.
        const child = await spawnLogged(executable, ['--interaction-test', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-mock-keychain'], {
            cwd: rootDirectory,
            env: environment
        }, `${passName}.log`);
        const timer = setTimeout(() => {
            console.error(`\nThe packaged app was still running after ${passMinutes} minutes, so it was stopped. The last scenario above is where it stuck.`);
            child.kill('SIGKILL');
        }, passMinutes * 60_000);
        await new Promise((resolve) => {
            child.once('error', (error) => {
                console.error(error);
                resolve();
            });
            child.once('close', resolve);
        });
        clearTimeout(timer);
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

const firstPass = await runPass(process.env.KONJUGATE_INTERACTION_ONLY, 'pass1');
if (!firstPass) {
    annotate('error', 'Packaged interaction tests', 'The packaged app ended before the suite finished (see the log).');
    console.error('The packaged app ended before the suite finished.');
    await summarize(['### Packaged interaction tests', 'The packaged app ended before the suite finished (see the log).']);
    process.exit(1);
}
const firstFailures = firstPass.filter(({ status }) => status === 'failed');
if (!firstFailures.length) process.exit(0);

if (process.env.KONJUGATE_INTERACTION_RETRY === '0') {
    await summarize([`### Packaged interaction tests`, `${firstFailures.length} failed (no second pass: KONJUGATE_INTERACTION_RETRY=0):`, ...firstFailures.map(failureLine)]);
    process.exit(1);
}

const retry = scenariosToRetry(firstPass);
console.log(`\n${firstFailures.length} scenario${firstFailures.length === 1 ? '' : 's'} failed; running ${retry.length} again (each failure with the scenarios of its group before it):`);
for (const name of retry) console.log(`  ${name}`);
const secondPass = await runPass(onlyFilter(retry), 'pass2');
if (!secondPass) {
    annotate('error', 'Packaged interaction tests', 'The packaged app ended before the second pass finished (see the log).');
    console.error('The packaged app ended before the second pass finished.');
    await summarize(['### Packaged interaction tests', 'The packaged app ended before the second pass finished (see the log).']);
    process.exit(1);
}

const { failed, flaky } = combineOutcomes(firstPass, secondPass);
// Each with what it said: a failure as it failed the second time, a flaky one as it failed the first (or the second, for
// one run again only to set up a later failure).
const messageIn = (pass, name) => pass.find((outcome) => outcome.name === name && outcome.status === 'failed')?.message;
const said = (name) => ({ name, message: messageIn(secondPass, name) ?? messageIn(firstPass, name) });
const saidFirst = (name) => ({ name, message: messageIn(firstPass, name) ?? messageIn(secondPass, name) });
for (const name of flaky) annotate('warning', 'Flaky interaction test', `Failed once and passed when run again (packaged app): ${name}`);
for (const name of failed) annotate('error', 'Interaction test failed twice', name);
await summarize([
    '### Packaged interaction tests',
    failed.length ? `**${failed.length} failed twice** (this fails the run):` : 'Every failure passed when run again.',
    ...failed.map((name) => failureLine(said(name))),
    ...(flaky.length ? ['', `${flaky.length} flaky (failed once, passed the second time; worth fixing its timing):`, ...flaky.map((name) => failureLine(saidFirst(name)))] : [])
]);
process.exit(failed.length ? 1 : 0);
