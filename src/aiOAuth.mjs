/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Signing in to a model provider in the person's own browser (docs/proposals/assistantSignIn.md). What every provider's
// flow shares lives here: a PKCE verifier and challenge, a `state`, a listener on this computer's loopback address that
// the provider's page sends the browser back to, and an end (the code, a refusal, a cancel or a time limit). The browser
// is the person's own, opened by `openExternal`, never a window of the app's: the provider's page asks for their
// password, and the app never sees it. A provider supplies its page's address and turns the code into a credential.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { AssistantProviderError } from './assistantProviders.mjs';

const base64Url = (bytes) => Buffer.from(bytes).toString('base64url');

// RFC 7636: a verifier of 43 to 128 unreserved characters (32 random bytes give 43), and its S256 challenge.
export function pkcePair() {
    const verifier = base64Url(randomBytes(32));
    return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) };
}

const page = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#222}main{max-width:28rem;padding:2rem;text-align:center}@media (prefers-color-scheme:dark){body{background:#1d1d1f;color:#eee}}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
const signedInPage = page('Signed in', 'You can close this tab and return to Konjugate.');
const refusedPage = page('Not signed in', 'Konjugate was not given access. You can close this tab and try again from Konjugate.');

const defaultTimeoutMilliseconds = 5 * 60_000;

// Waits for the provider's page to send the browser back with a code. `authorizationUrl(redirectUri, { challenge, state })`
// gives the page's address. `host` is the loopback name the redirect uses: '127.0.0.1', or 'localhost', which is listened
// for on both 127.0.0.1 and ::1 because a browser may resolve it to either. A request that is not the callback, or whose
// `state` differs from the one sent, is answered and ignored (another page on this computer could send one); a callback
// without `state` is accepted only when `requireState` is false, which is safe where the code is useless without the PKCE
// verifier that never leaves this process. Resolves to { code, verifier, redirectUri }.
export async function loopbackAuthorization({
    authorizationUrl, openExternal, signal, host = '127.0.0.1', path = '/callback',
    requireState = true, timeoutMilliseconds = defaultTimeoutMilliseconds
}) {
    if (typeof authorizationUrl !== 'function' || typeof openExternal !== 'function') throw new Error('Signing in needs an authorization address and a way to open the browser.');
    if (signal?.aborted) throw new DOMException('Signing in was cancelled.', 'AbortError');
    const { verifier, challenge } = pkcePair();
    const state = base64Url(randomBytes(16));
    const servers = [];
    let settle;
    const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // Awaited below; this keeps a cancel that comes while the browser is still opening from being reported as unhandled.
    finished.catch(() => {});

    const handle = (request, response) => {
        const url = new URL(request.url, 'http://loopback');
        const answer = (status, body) => {
            response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
            response.end(body);
        };
        if (request.method !== 'GET' || url.pathname !== path) return answer(404, page('Not found', 'This address is only used while signing in.'));
        const returnedState = url.searchParams.get('state');
        if (returnedState !== null ? returnedState !== state : requireState) return answer(400, page('Not signed in', 'This sign-in link is not the one Konjugate started.'));
        const error = url.searchParams.get('error');
        if (error) {
            answer(200, refusedPage);
            const description = (url.searchParams.get('error_description') ?? '').slice(0, 300);
            settle.reject(new AssistantProviderError(
                error === 'access_denied' ? 'Signing in was declined in the browser.' : `The provider did not sign you in: ${description || error.slice(0, 100)}`,
                error === 'access_denied' ? 'signInDenied' : 'signInFailed'));
            return undefined;
        }
        const code = url.searchParams.get('code');
        if (!code) return answer(400, page('Not signed in', 'The provider sent no sign-in code.'));
        answer(200, signedInPage);
        settle.resolve(code);
        return undefined;
    };

    const listen = (address, port) => new Promise((resolve, reject) => {
        const server = createServer(handle);
        server.once('error', reject);
        server.listen({ host: address, port, exclusive: true }, () => {
            server.off('error', reject);
            servers.push(server);
            resolve(server.address().port);
        });
    });
    const close = () => {
        for (const server of servers) {
            server.close();
            server.closeAllConnections?.();
        }
    };

    let timer;
    const onAbort = () => settle.reject(new DOMException('Signing in was cancelled.', 'AbortError'));
    try {
        const port = await listen('127.0.0.1', 0);
        // The same port on IPv6 loopback when the redirect says "localhost"; a computer without IPv6 has only the first.
        if (host === 'localhost') await listen('::1', port).catch(() => {});
        const redirectUri = `http://${host}:${port}${path}`;
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => settle.reject(new AssistantProviderError(
            `Signing in was not finished within ${Math.round(timeoutMilliseconds / 60_000)} minutes. Try again when you are ready.`, 'signInTimedOut')), timeoutMilliseconds);
        await openExternal(authorizationUrl(redirectUri, { challenge, state }));
        const code = await finished;
        return { code, verifier, redirectUri };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        close();
    }
}
