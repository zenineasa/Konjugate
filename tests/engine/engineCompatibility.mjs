/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { validateWithEngine } from '../../src/engineAdapter.mjs';

function run(executable, args, environment = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { env: { ...process.env, ...environment }, stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
    });
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateEngineTest-'));
const input = join(directory, 'model.kjt');
const report = join(directory, 'validation.json');
const project = JSON.stringify({
    format: 'konjugate', version: 1, nodes: [{
        id: '11111111-1111-4111-8111-111111111111', name: 'Node', states: [{
            id: '22222222-2222-4222-8222-222222222222', name: 'State', symbol: 'state', initialValue: 0, unit: ''
        }], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#34727a' }
    }], edges: []
});
await writeFile(input, await encodeProjectFile(project));
assert.equal(await run(executable, ['validate', input, '--report', report]), 0);
const validation = JSON.parse(await readFile(report, 'utf8'));
assert.equal(validation.valid, true);
assert.deepEqual(validation.summary, { nodes: 1, edges: 0 });

const exampleInput = join(directory, 'thermalManagement.kjt');
const exampleReport = join(directory, 'thermalValidation.json');
const example = await readFile(new URL('../../examples/thermalManagement.konjugate.json', import.meta.url), 'utf8');
await writeFile(exampleInput, await encodeProjectFile(example));
assert.equal(await run(executable, ['validate', exampleInput, '--report', exampleReport]), 0);
assert.equal(JSON.parse(await readFile(exampleReport, 'utf8')).valid, true);

const damaged = JSON.parse(project);
damaged.nodes[0].states[0].symbol = 'Not camel case';
await writeFile(input, await encodeProjectFile(JSON.stringify(damaged)));
assert.equal(await run(executable, ['validate', input, '--report', report]), 2);
const invalid = JSON.parse(await readFile(report, 'utf8'));
assert.equal(invalid.valid, false);
assert.ok(invalid.issues.some((issue) => issue.code === 'stateSymbolInvalid'));

const invalidEquation = JSON.parse(example);
invalidEquation.edges[0].equation = '\\mathrm{unknownState}';
await writeFile(input, await encodeProjectFile(JSON.stringify(invalidEquation)));
assert.equal(await run(executable, ['validate', input, '--report', report]), 2);
assert.ok(JSON.parse(await readFile(report, 'utf8')).issues.some((issue) => issue.code === 'edgeEquationInvalid'));

const encryptedInput = join(directory, 'encrypted.kjt');
await writeFile(encryptedInput, await encodeProjectFile(project, { password: 'engine compatibility password', scryptCost: 2 ** 14 }));
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report]), 4);
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report], { KONJUGATE_PASSWORD: 'wrong password' }), 4);
assert.equal(await run(executable, ['validate', encryptedInput, '--report', report], { KONJUGATE_PASSWORD: 'engine compatibility password' }), 0);
const adapted = await validateWithEngine(project, {
    applicationPath: new URL('../..', import.meta.url).pathname,
    resourcesPath: '',
    packaged: false
});
assert.equal(adapted.available, true);
assert.equal(adapted.report.valid, true);

const unsupportedInput = join(directory, 'project.unsupported');
await writeFile(unsupportedInput, await encodeProjectFile(project));
assert.equal(await run(executable, ['validate', unsupportedInput, '--report', report]), 3);
console.log('C++/Electron container compatibility passed.');
