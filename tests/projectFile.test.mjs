/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeProjectBundle, decodeProjectFile, encodeProjectFile, inspectProjectFile, sha256Hex } from '../src/projectFile.mjs';
import { decodeProjectContent, encodeProjectContent } from '../src/browserProjectCodec.mjs';

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

// Attachments (docs/proposals/fmuImportWorkflow.md, stage 8): an FMU's archive kept in the project, after the results.
const fmuArchive = Buffer.from('PK fake fmu archive bytes');

test('a project with attachments is container version 2, keeps them after the results, and gives them back checked by SHA-256', async () => {
    const result = Buffer.from([1, 2, 3, 4]);
    const encoded = await encodeProjectFile(content, { result, attachments: [{ kind: 'fmu', name: 'springMassDamper.fmu', buffer: fmuArchive }] });
    assert.equal(encoded[4], 2, 'Version 2, so a Konjugate that predates attachments refuses it by its version.');
    assert.deepEqual(inspectProjectFile(encoded), { format: 'kjt', encrypted: false, version: 2 });
    const header = JSON.parse(encoded.subarray(10, 10 + encoded.readUInt32BE(6)).toString('utf8'));
    assert.deepEqual(header.attachments, [{ kind: 'fmu', name: 'springMassDamper.fmu', length: fmuArchive.length, sha256: sha256Hex(fmuArchive) }]);
    const bundle = await decodeProjectBundle(encoded);
    assert.equal(bundle.content, content);
    assert.deepEqual(bundle.result, result);
    assert.equal(bundle.attachments.length, 1);
    assert.deepEqual(bundle.attachments[0].buffer, fmuArchive);
    assert.equal(bundle.attachments[0].sha256, sha256Hex(fmuArchive));
    // Encrypted, the attachments are inside the encryption.
    const encrypted = await encodeProjectFile(content, { password: 'secret', scryptCost: testCost, attachments: [{ kind: 'fmu', name: 'a.fmu', buffer: fmuArchive }] });
    assert.equal(encrypted.includes(fmuArchive), false, 'Not readable without the password.');
    assert.deepEqual((await decodeProjectBundle(encrypted, { password: 'secret' })).attachments[0].buffer, fmuArchive);
});

test('a project with no attachments is version 1 byte for byte as before, and has none', async () => {
    const plain = await encodeProjectFile(content);
    assert.equal(plain[4], 1);
    assert.equal(JSON.parse(plain.subarray(10, 10 + plain.readUInt32BE(6)).toString('utf8')).attachments, undefined);
    assert.deepEqual(plain, await encodeProjectFile(content, { attachments: [] }));
    assert.deepEqual((await decodeProjectBundle(plain)).attachments, []);
});

test('an attachment that does not match its SHA-256, or a length that does not add up, is damage', async () => {
    const encoded = await encodeProjectFile(content, { attachments: [{ kind: 'fmu', name: 'a.fmu', buffer: fmuArchive }] });
    const tampered = Buffer.from(encoded);
    tampered[tampered.length - 1] ^= 0xff;
    await assert.rejects(decodeProjectBundle(tampered), (error) => error.code === 'CORRUPT_PAYLOAD' && /attachment a\.fmu is damaged/.test(error.message));
    await assert.rejects(decodeProjectBundle(encoded.subarray(0, encoded.length - 1)), (error) => error.code === 'CORRUPT_PAYLOAD');
});

test('the web edition reads and writes the same attachments, so a project saved in a browser keeps its FMUs', async () => {
    const fromDesktop = await encodeProjectFile(content, { attachments: [{ kind: 'fmu', name: 'a.fmu', buffer: fmuArchive }] });
    const read = await decodeProjectContent(new Uint8Array(fromDesktop));
    assert.equal(read.content, content);
    assert.deepEqual(Buffer.from(read.attachments[0].buffer), fmuArchive);
    const fromBrowser = await encodeProjectContent(content, { attachments: read.attachments });
    assert.equal(fromBrowser[4], 2);
    assert.deepEqual((await decodeProjectBundle(Buffer.from(fromBrowser))).attachments[0].buffer, fmuArchive);
    assert.equal((await encodeProjectContent(content))[4], 1, 'None, version 1.');
});
