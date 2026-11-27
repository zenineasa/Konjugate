/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loopbackAuthorization, pkcePair } from '../src/aiOAuth.mjs';

// A provider page that the "browser" visits: it reads where to send the browser back from the authorization address and
// goes there with whatever `answer(url)` adds.
const providerPage = (answer) => async (address) => {
    const url = new URL(address);
    const back = new URL(url.searchParams.get('redirect'));
    for (const [key, value] of Object.entries(answer(url))) back.searchParams.set(key, value);
    setImmediate(() => fetch(back).then((response) => response.text()).catch(() => {}));
};
const authorizationUrl = (redirectUri, { challenge, state }) => `https://provider.example/auth?${new URLSearchParams({ redirect: redirectUri, challenge, state })}`;

test('A PKCE challenge is the S256 hash of its verifier', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.notEqual(pkcePair().verifier, verifier);
});

test('The browser coming back with the code and the same state ends the sign-in', async () => {
    let challenge;
    const result = await loopbackAuthorization({
        authorizationUrl,
        openExternal: providerPage((url) => { challenge = url.searchParams.get('challenge'); return { code: 'the-code', state: url.searchParams.get('state') }; })
    });
    assert.equal(result.code, 'the-code');
    assert.match(result.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(challenge, createHash('sha256').update(result.verifier).digest('base64url'));
});

test('A callback with another state is ignored, and the real one still ends the sign-in', async () => {
    const result = await loopbackAuthorization({
        authorizationUrl,
        openExternal: async (address) => {
            const url = new URL(address);
            const back = url.searchParams.get('redirect');
            const forged = await fetch(`${back}?code=forged&state=not-the-one`);
            assert.equal(forged.status, 400);
            const elsewhere = await fetch(back.replace('/callback', '/other'));
            assert.equal(elsewhere.status, 404);
            setImmediate(() => fetch(`${back}?code=real&state=${url.searchParams.get('state')}`).catch(() => {}));
        }
    });
    assert.equal(result.code, 'real');
});

test('A callback without state is accepted only where the provider may leave it out', async () => {
    const result = await loopbackAuthorization({ authorizationUrl, requireState: false, openExternal: providerPage(() => ({ code: 'plain' })) });
    assert.equal(result.code, 'plain');
    await assert.rejects(loopbackAuthorization({
        authorizationUrl, timeoutMilliseconds: 300, openExternal: providerPage(() => ({ code: 'plain' }))
    }), { code: 'signInTimedOut' });
});

test('A refusal in the browser is reported as declined', async () => {
    await assert.rejects(loopbackAuthorization({
        authorizationUrl, openExternal: providerPage((url) => ({ error: 'access_denied', state: url.searchParams.get('state') }))
    }), { code: 'signInDenied' });
});

test('Cancelling ends the sign-in and closes the listener', async () => {
    const controller = new AbortController();
    let redirect;
    const pending = loopbackAuthorization({
        authorizationUrl, signal: controller.signal,
        openExternal: async (address) => { redirect = new URL(address).searchParams.get('redirect'); }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(fetch(redirect));
});

test('A "localhost" redirect is answered on IPv4 loopback', async () => {
    const result = await loopbackAuthorization({
        authorizationUrl, host: 'localhost',
        openExternal: async (address) => {
            const url = new URL(address);
            const back = new URL(url.searchParams.get('redirect'));
            assert.equal(back.hostname, 'localhost');
            setImmediate(() => fetch(`http://127.0.0.1:${back.port}/callback?code=v4&state=${url.searchParams.get('state')}`).catch(() => {}));
        }
    });
    assert.equal(result.code, 'v4');
});

test('A preferred port is used where it is free, and any free port where it is not', async () => {
    const { createServer } = await import('node:net');
    const blocker = createServer();
    const taken = await new Promise((resolve) => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));
    try {
        const result = await loopbackAuthorization({ authorizationUrl, preferredPort: taken, openExternal: providerPage((url) => ({ code: 'c', state: url.searchParams.get('state') })) });
        assert.notEqual(new URL(result.redirectUri).port, String(taken));
    } finally { blocker.close(); }
    const free = await new Promise((resolve) => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
    const result = await loopbackAuthorization({ authorizationUrl, preferredPort: free, openExternal: providerPage((url) => ({ code: 'c', state: url.searchParams.get('state') })) });
    assert.equal(new URL(result.redirectUri).port, String(free));
});
