/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeProjectBundle, decodeProjectFile, encodeProjectFile, inspectProjectFile } from '../src/projectFile.mjs';

const content = JSON.stringify({ format: 'konjugate', version: 1, nodes: [], edges: [] });
const testCost = 2 ** 14;

test('compresses and restores a project', async () => {
    const encoded = await encodeProjectFile(content);
    assert.deepEqual(inspectProjectFile(encoded), { format: 'kjt', encrypted: false, version: 1 });
    assert.equal(await decodeProjectFile(encoded), content);
});

test('embeds an optional binary result without converting it to JSON', async () => {
    const result = Buffer.from([0x4b, 0x4a, 0x52, 0x02, 0, 1, 2, 255]);
    const encoded = await encodeProjectFile(content, { result });
    const decoded = await decodeProjectBundle(encoded);
    assert.equal(decoded.content, content);
    assert.deepEqual(decoded.result, result);
});

test('encrypts the embedded result together with the model', async () => {
    const result = Buffer.from('private result bytes');
    const encoded = await encodeProjectFile(content, {
        result,
        password: 'correct horse battery staple',
        scryptCost: testCost
    });
    const decoded = await decodeProjectBundle(encoded, { password: 'correct horse battery staple' });
    assert.equal(decoded.content, content);
    assert.deepEqual(decoded.result, result);
    assert.equal(encoded.includes(result), false);
});

test('encrypts and restores a project with AES-256-GCM', async () => {
    const encoded = await encodeProjectFile(content, { password: 'correct horse battery staple', scryptCost: testCost });
    assert.equal(inspectProjectFile(encoded).encrypted, true);
    assert.equal(await decodeProjectFile(encoded, { password: 'correct horse battery staple' }), content);
});

test('uses fresh cryptographic material for every save', async () => {
    const first = await encodeProjectFile(content, { password: 'same password', scryptCost: testCost });
    const second = await encodeProjectFile(content, { password: 'same password', scryptCost: testCost });
    assert.notDeepEqual(first, second);
});

test('rejects an incorrect password', async () => {
    const encoded = await encodeProjectFile(content, { password: 'correct password', scryptCost: testCost });
    await assert.rejects(
        decodeProjectFile(encoded, { password: 'incorrect password' }),
        (error) => error.code === 'DECRYPTION_FAILED'
    );
});

test('requires a password for an encrypted project', async () => {
    const encoded = await encodeProjectFile(content, { password: 'correct password', scryptCost: testCost });
    await assert.rejects(
        decodeProjectFile(encoded),
        (error) => error.code === 'PASSWORD_REQUIRED'
    );
});

test('detects encrypted payload tampering', async () => {
    const encoded = await encodeProjectFile(content, { password: 'correct password', scryptCost: testCost });
    encoded[encoded.length - 1] ^= 1;
    await assert.rejects(
        decodeProjectFile(encoded, { password: 'correct password' }),
        (error) => error.code === 'DECRYPTION_FAILED'
    );
});

test('supports changing an encrypted project password', async () => {
    const original = await encodeProjectFile(content, { password: 'original password', scryptCost: testCost });
    const decoded = await decodeProjectFile(original, { password: 'original password' });
    const changed = await encodeProjectFile(decoded, { password: 'replacement password', scryptCost: testCost });
    await assert.rejects(decodeProjectFile(changed, { password: 'original password' }));
    assert.equal(await decodeProjectFile(changed, { password: 'replacement password' }), content);
});

test('supports removing encryption while retaining the project container', async () => {
    const encrypted = await encodeProjectFile(content, { password: 'original password', scryptCost: testCost });
    const decoded = await decodeProjectFile(encrypted, { password: 'original password' });
    const unencrypted = await encodeProjectFile(decoded);
    assert.deepEqual(inspectProjectFile(unencrypted), { format: 'kjt', encrypted: false, version: 1 });
    assert.equal(await decodeProjectFile(unencrypted), content);
});

test('rejects data that is not a KJT container', async () => {
    const unsupported = Buffer.from('unsupported project data');
    assert.throws(
        () => inspectProjectFile(unsupported),
        (error) => error.code === 'INVALID_FORMAT'
    );
    await assert.rejects(
        decodeProjectFile(unsupported),
        (error) => error.code === 'INVALID_FORMAT'
    );
});

test('detects damage in an unencrypted compressed payload', async () => {
    const encoded = await encodeProjectFile(content);
    encoded[encoded.length - 1] ^= 1;
    await assert.rejects(
        decodeProjectFile(encoded),
        (error) => error.code === 'CORRUPT_PAYLOAD'
    );
});

test('saves and restores an entire branch tree, keeping .result as the first branch for old callers', async () => {
    const baseline = Buffer.from('baseline result bytes');
    const forkA = Buffer.from('fork A result bytes');
    const forkB = Buffer.from('fork B result bytes');
    const encoded = await encodeProjectFile(content, {
        resultBranches: [
            { buffer: baseline, branchUuid: 'root', parentBranchUuid: null, forkTime: null, label: 'Baseline' },
            { buffer: forkA, branchUuid: 'a', parentBranchUuid: 'root', forkTime: 2, label: 'Fork at 2 s' },
            { buffer: forkB, branchUuid: 'b', parentBranchUuid: 'a', forkTime: 4, label: 'Fork at 4 s' }
        ]
    });
    const decoded = await decodeProjectBundle(encoded);
    assert.equal(decoded.content, content);
    assert.deepEqual(decoded.result, baseline);
    assert.equal(decoded.resultBranches.length, 3);
    assert.deepEqual(decoded.resultBranches.map((branch) => branch.buffer), [baseline, forkA, forkB]);
    assert.deepEqual(decoded.resultBranches.map(({ branchUuid, parentBranchUuid, forkTime, label }) =>
        ({ branchUuid, parentBranchUuid, forkTime, label })), [
        { branchUuid: 'root', parentBranchUuid: null, forkTime: null, label: 'Baseline' },
        { branchUuid: 'a', parentBranchUuid: 'root', forkTime: 2, label: 'Fork at 2 s' },
        { branchUuid: 'b', parentBranchUuid: 'a', forkTime: 4, label: 'Fork at 4 s' }
    ]);
});

test('a single-branch save is byte-shape-identical to a plain result save (resultBranches is not required for the common case)', async () => {
    const result = Buffer.from('single branch bytes');
    const viaResult = await encodeProjectFile(content, { result });
    const viaBranches = await encodeProjectFile(content, { resultBranches: [{ buffer: result }] });
    const decodedViaResult = await decodeProjectBundle(viaResult);
    const decodedViaBranches = await decodeProjectBundle(viaBranches);
    // Both encode to the identical legacy (no resultSections) shape, and both decode with a
    // one-entry resultBranches -- a uniform shape the load path can always reconstruct branches
    // from, whether the file predates branching entirely or was saved with exactly one branch.
    assert.deepEqual(decodedViaResult.resultBranches, [{ length: result.length, buffer: result }]);
    assert.deepEqual(decodedViaBranches.resultBranches, [{ length: result.length, buffer: result }]);
    assert.deepEqual(decodedViaResult.result, result);
    assert.deepEqual(decodedViaBranches.result, result);
});

test('an old build\'s single-result shape decodes as one unlabeled branch, with no branch metadata invented', async () => {
    const result = Buffer.from('legacy single result');
    const encoded = await encodeProjectFile(content, { result });
    const decoded = await decodeProjectBundle(encoded);
    assert.equal(decoded.resultBranches.length, 1);
    assert.equal('branchUuid' in decoded.resultBranches[0], false);
    assert.deepEqual(decoded.result, result);
});

test('a project with no embedded result at all has neither .result nor .resultBranches', async () => {
    const encoded = await encodeProjectFile(content);
    const decoded = await decodeProjectBundle(encoded);
    assert.equal(decoded.result, null);
    assert.equal(decoded.resultBranches, null);
});

test('rejects unsupported container versions', async () => {
    const encoded = await encodeProjectFile(content);
    encoded[4] = 99;
    assert.throws(
        () => inspectProjectFile(encoded),
        (error) => error.code === 'UNSUPPORTED_VERSION'
    );
});
