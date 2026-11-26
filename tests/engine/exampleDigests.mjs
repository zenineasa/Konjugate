/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract: every bundled example gives the same numbers, to the bit, as the engine of the release the digests were recorded
// from (docs/proposals/unifiedEntityEditors.md, Compatibility tests). Each example is validated and run with one fixed
// configuration; the times and state values of every sample, as recorded, are hashed in order, and the hash must equal the
// one in expected/exampleDigests.json. A tolerance would let a change in arithmetic through unnoticed; a hash does not.
//
//   node tests/engine/exampleDigests.mjs <konjugateEngine>            compares
//   node tests/engine/exampleDigests.mjs <konjugateEngine> --write    records them from that engine (a released one)
//
// Each digest says which engine it came from: `recordedWith` for all of them, except the examples listed under `recordedLater`, each
// list with the engine it was recorded with (an example the released engine cannot run, added after it). --write records every digest
// from the one engine given, so it leaves no `recordedLater`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const expectedPath = fileURLToPath(new URL('./expected/exampleDigests.json', import.meta.url));
const configuration = { targetTime: 5, globalTimeStep: 0.01, outputInterval: 0.05 };

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        // A Python program finds the SDK as the app gives it (KONJUGATE_PYTHON_SDK names a released one when recording).
        const env = { ...process.env, PYTHONPATH: process.env.KONJUGATE_PYTHON_SDK ?? join(root, 'engine', 'sdk', 'python') };
        const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

async function examples(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await examples(path));
        else if (entry.name.endsWith('.kjt')) found.push(path);
    }
    return found.sort();
}

// The samples' times and values, as IEEE-754 doubles in the order recorded, hashed.
function digest(result) {
    const hash = createHash('sha256');
    for (const sample of result.samples) {
        const values = new Float64Array([sample.time, ...sample.states.map((state) => state.value)]);
        hash.update(Buffer.from(values.buffer));
        hash.update(Buffer.from(new BigUint64Array(sample.states.map((state) => BigInt(state.stateId))).buffer));
    }
    return hash.digest('hex');
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const write = process.argv.includes('--write');
const directory = await mkdtemp(join(tmpdir(), 'konjugateExampleDigests-'));
const digests = {};
try {
    for (const path of await examples(join(root, 'examples'))) {
        const name = relative(join(root, 'examples'), path);
        const safe = name.replace(/\W+/g, '_');
        const inputPath = join(directory, `${safe}.kjt`);
        const configurationPath = join(directory, `${safe}.json`);
        const outputPath = join(directory, `${safe}.kjr`);
        await writeFile(inputPath, await readFile(path));
        await writeFile(configurationPath, JSON.stringify({ name: safe, ...configuration }));
        const code = await execute(executable, ['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
        // An example that needs a live source (a data log, a broker) does not run alone: that it does not is recorded too.
        digests[name] = code === 0 ? digest(decodeResultFile(await readFile(outputPath))) : `does not run alone (exit ${code})`;
    }
    if (write) {
        await writeFile(expectedPath, `${JSON.stringify({
            copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
            recordedWith: process.argv[process.argv.indexOf('--write') + 1] ?? 'a released engine',
            configuration,
            digests
        }, null, 4)}\n`);
        console.log(`Recorded the digests of ${Object.keys(digests).length} examples.`);
    } else {
        const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
        assert.deepEqual(expected.configuration, configuration, 'The digests were recorded with another configuration.');
        const unrecorded = (expected.recordedLater ?? []).flatMap((entry) => entry.examples).filter((name) => !(name in expected.digests));
        assert.deepEqual(unrecorded, [], 'recordedLater names examples with no digest.');
        // The engine each example's digest came from.
        const recordedWith = (name) => (expected.recordedLater ?? []).find((entry) => entry.examples.includes(name))?.recordedWith ?? expected.recordedWith;
        const differing = Object.keys({ ...expected.digests, ...digests }).filter((name) => expected.digests[name] !== digests[name]);
        assert.deepEqual(differing, [], `These examples no longer give the numbers they were recorded with, to the bit: ${differing.map((name) => `${name} (${name in expected.digests ? recordedWith(name) : 'not recorded'})`).join(', ')}`);
        const bySource = new Map();
        for (const name of Object.keys(digests)) bySource.set(recordedWith(name), (bySource.get(recordedWith(name)) ?? 0) + 1);
        console.log(`Every bundled example (${Object.keys(digests).length}) gives the numbers it was recorded with, to the bit: ${[...bySource].map(([source, count]) => `${count} from ${source}`).join('; ')}.`);
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
