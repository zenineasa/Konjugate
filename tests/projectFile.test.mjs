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

test('rejects unsupported container versions', async () => {
    const encoded = await encodeProjectFile(content);
    encoded[4] = 99;
    assert.throws(
        () => inspectProjectFile(encoded),
        (error) => error.code === 'UNSUPPORTED_VERSION'
    );
});
