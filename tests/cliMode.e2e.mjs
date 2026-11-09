/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The command line (konjugate --cli, src/main.mjs's runCliMode), run as a person or a script runs it: the app itself, started
// with --cli, its exit code and what it prints. It needs the native engine built (npm run build:engine), so it is not part of
// `npm test`: `npm run test:cli` runs it, and so do `npm run test:all` and `npm run coverage`. Each
// run has a profile folder of its own, so nothing here reads or writes the person's own.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import electronPath from 'electron';
import { decodeProjectBundle, encodeProjectFile } from '../src/projectFile.mjs';

const root = join(import.meta.dirname, '..');
// A bundled example that keeps no run configuration of its own, as most do.
const example = join(root, 'examples', 'thermalEquilibrium.kjt');
let folder;

before(async () => { folder = await mkdtemp(join(tmpdir(), 'konjugate-cli-')); });
after(async () => { await rm(folder, { recursive: true, force: true }); });

function konjugate(args, { password } = {}) {
    const environment = { ...process.env, KONJUGATE_INTERACTION_USER_DATA: join(folder, 'profile') };
    delete environment.ELECTRON_RUN_AS_NODE;
    delete environment.KONJUGATE_PASSWORD;
    if (password !== undefined) environment.KONJUGATE_PASSWORD = password;
    return new Promise((resolve, reject) => {
        const child = spawn(electronPath, ['.', '--cli', ...args], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`konjugate --cli ${args.join(' ')} did not finish.\n${stdout}\n${stderr}`)); }, 60000);
        child.once('error', reject);
        child.once('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
}

// The example as a document, changed by `change`, written as a project of its own.
async function projectFrom(name, change, options = {}) {
    const document = JSON.parse((await decodeProjectBundle(await readFile(example))).content);
    change(document);
    const path = join(folder, name);
    await writeFile(path, await encodeProjectFile(JSON.stringify(document), options));
    return path;
}

test('with nothing to do, it says how it is used, and exits 2', async () => {
    const { code, stderr } = await konjugate([]);
    assert.equal(code, 2);
    assert.match(stderr, /Usage: konjugate --cli run <project\.kjt> --target-time <seconds>/);
    assert.equal((await konjugate(['simulate', example])).code, 2, 'An unknown command is refused the same way.');
});

test('validate prints the engine\'s report, and exits 0 for a sound model', async () => {
    const { code, stdout } = await konjugate(['validate', example]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.valid, true);
});

test('validate exits 2 for a model that is not sound, with the reason in the report', async () => {
    const broken = await projectFrom('broken.kjt', (document) => {
        document.edges[0].equation = String.raw`\mathrm{noSuchState}`;
        delete document.edges[0].equationModel;
    });
    const { code, stdout } = await konjugate(['validate', broken]);
    assert.equal(code, 2);
    const report = JSON.parse(stdout);
    assert.equal(report.valid, false);
    assert.ok(JSON.stringify(report).includes('noSuchState'), 'The report should name what is wrong.');
});

test('a file that cannot be read is said so, and exits 1', async () => {
    const missing = await konjugate(['validate', join(folder, 'nothing.kjt')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Could not read or decode/);
    const notAProject = join(folder, 'notes.kjt');
    await writeFile(notAProject, 'not a project');
    assert.equal((await konjugate(['validate', notAProject])).code, 1);
});

test('a project with a password is read with KONJUGATE_PASSWORD, never a flag', async () => {
    const locked = await projectFrom('locked.kjt', () => {}, { password: 'correct horse' });
    const without = await konjugate(['validate', locked]);
    assert.equal(without.code, 1);
    assert.match(without.stderr, /password is required/);
    assert.equal((await konjugate(['validate', locked], { password: 'wrong' })).code, 1);
    assert.equal((await konjugate(['validate', locked], { password: 'correct horse' })).code, 0);
});

test('run needs a positive --target-time, and a --configuration the project has', async () => {
    const noTime = await konjugate(['run', example]);
    assert.equal(noTime.code, 2);
    assert.match(noTime.stderr, /--target-time/);
    assert.equal((await konjugate(['run', example, '--target-time', '-1'])).code, 2);
    const unknown = await konjugate(['run', example, '--target-time', '1', '--configuration', 'Nonexistent']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /No run configuration named or numbered "Nonexistent"/);
});

test('run simulates a project that keeps no run configuration, as the app does, and writes the results asked for', async () => {
    const csvPath = join(folder, 'result.csv');
    const kjtPath = join(folder, 'result.kjt');
    const { code, stdout, stderr } = await konjugate(['run', example, '--target-time', '2', '--output-csv', csvPath, '--output-kjt', kjtPath]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /with configuration "Default" for 2s of simulated time/);
    const [header, ...rows] = (await readFile(csvPath, 'utf8')).trim().split('\n');
    assert.match(header, /^time\b/);
    assert.ok(rows.length > 2, 'The CSV should hold the run\'s samples.');
    assert.equal(Number(rows.at(-1).split(',')[0]), 2, 'The run should reach its target time.');
    const saved = await decodeProjectBundle(await readFile(kjtPath));
    assert.ok(saved.result?.length > 0, 'The project written should carry the result.');
    assert.equal(JSON.parse(saved.content).nodes.length, JSON.parse((await decodeProjectBundle(await readFile(example))).content).nodes.length);
});

test('run with a configuration named on the command line uses it', async () => {
    const configured = await projectFrom('configured.kjt', (document) => {
        document.runConfigurations = [
            // Ids of their own: every id in a model is unique across nodes, states, edges and configurations.
            { id: 9001, name: 'Coarse', globalTimeStep: 0.1, outputInterval: 0.5 },
            { id: 9002, name: 'Fine', globalTimeStep: 0.01, outputInterval: 0.1 }
        ];
        document.activeRunConfigurationId = 9002;
    });
    const csvPath = join(folder, 'coarse.csv');
    const { code, stdout, stderr } = await konjugate(['run', configured, '--target-time', '2', '--configuration', 'Coarse', '--output-csv', csvPath]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /with configuration "Coarse"/);
    const rows = (await readFile(csvPath, 'utf8')).trim().split('\n').slice(1);
    assert.ok(rows.length <= 6, `A 0.5 s output interval over 2 s gives a handful of samples (got ${rows.length}).`);
    const byId = await konjugate(['run', configured, '--target-time', '1']);
    assert.equal(byId.code, 0, byId.stderr);
    assert.match(byId.stdout, /with configuration "Fine"/, 'With none named, the project\'s own active configuration is used.');
    assert.match(byId.stdout, /Pass --output-kjt and\/or --output-csv/);
});
