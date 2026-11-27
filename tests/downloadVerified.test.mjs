/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The checks' download of the FMI Reference FMUs (tests/engine/fixtures/downloadVerified.mjs): tried again on a network failure, a 5xx
// and a body cut short, never on another status, and never more than its tries; with a fetch and waits of the test's own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { downloadVerified } from './engine/fixtures/downloadVerified.mjs';

const body = Buffer.from('the release zip');
const digest = createHash('sha256').update(body).digest('hex');
const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
// A fetch answering, in turn, with each of `answers`: an Error is thrown, a number is that HTTP status, a Buffer the body.
const server = (answers) => {
    const calls = [];
    return {
        calls,
        fetch: async (url, options) => {
            calls.push({ url, signal: options?.signal });
            const answer = answers.shift();
            if (answer instanceof Error) throw answer;
            if (typeof answer === 'number') return { ok: false, status: answer, arrayBuffer: async () => new ArrayBuffer(0) };
            return { ok: true, status: 200, arrayBuffer: async () => answer.buffer.slice(answer.byteOffset, answer.byteOffset + answer.byteLength) };
        }
    };
};

test('a connection that times out, a 503 and a body cut short are tried again, the wait doubling, until the file arrives whole', async () => {
    const waits = [];
    const { calls, fetch } = server([connectTimeout(), 503, body.subarray(0, 4), body]);
    const bytes = await downloadVerified('https://example.org/zip', digest, { fetch, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(bytes, body);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [2000, 4000, 8000]);
    assert.ok(calls.every((call) => call.signal instanceof AbortSignal), 'Each try has a time limit of its own.');
});

test('it gives up after its tries, saying what each was, and does not try again a status that will not change', async () => {
    const tries = server([connectTimeout(), connectTimeout(), connectTimeout(), connectTimeout(), body]);
    await assert.rejects(downloadVerified('https://example.org/zip', digest, { what: 'the FMI Reference FMUs 0.0.42', fetch: tries.fetch, wait: async () => {} }),
        /^Error: Downloading the FMI Reference FMUs 0\.0\.42 from https:\/\/example\.org\/zip failed: try 1: fetch failed \(UND_ERR_CONNECT_TIMEOUT\); .*try 4: fetch failed \(UND_ERR_CONNECT_TIMEOUT\)\.$/);
    assert.equal(tries.calls.length, 4, 'Four tries, not five.');
    const missing = server([404, body]);
    await assert.rejects(downloadVerified('https://example.org/zip', digest, { fetch: missing.fetch, wait: async () => {} }), /try 1: HTTP 404\.$/);
    assert.equal(missing.calls.length, 1);
    const wrong = server([Buffer.from('another file'), Buffer.from('another file'), Buffer.from('another file'), Buffer.from('another file')]);
    await assert.rejects(downloadVerified('https://example.org/zip', digest, { fetch: wrong.fetch, wait: async () => {} }), /without the expected SHA-256/);
});
