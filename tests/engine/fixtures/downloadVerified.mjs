/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A file the checks download once (the FMI Reference FMUs' release zip), fetched until it arrives whole: a network failure, a time
// out, a server's 5xx or 429 and a body without the expected SHA-256 (cut short) are tried again, `attempts` tries in all, the wait
// doubling from `delayMs`; any other HTTP status is thrown at once. Each try is given `timeoutMs` in all. On a runner whose connection
// to GitHub stalled, 2.1.3's release checks failed on a single try ("fetch failed ... ConnectTimeoutError"). `fetch` and `wait` are
// tests' seams.

import { createHash } from 'node:crypto';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function downloadVerified(url, expectedSha256, {
    what = url, attempts = 4, delayMs = 2000, timeoutMs = 5 * 60 * 1000, fetch: fetchUrl = globalThis.fetch,
    wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
} = {}) {
    const failures = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let retry = true;
        try {
            const response = await fetchUrl(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) {
                retry = response.status >= 500 || response.status === 429;
                throw new Error(`HTTP ${response.status}`);
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            const digest = sha256(bytes);
            if (digest === expectedSha256) return bytes;
            throw new Error(`${bytes.length} bytes without the expected SHA-256 ${expectedSha256} (got ${digest})`);
        } catch (error) {
            const cause = error.cause?.code ?? error.cause?.message;
            failures.push(`try ${attempt}: ${error.message}${cause ? ` (${cause})` : ''}`);
            if (!retry || attempt === attempts) break;
            await wait(delayMs * 2 ** (attempt - 1));
        }
    }
    throw new Error(`Downloading ${what} from ${url} failed: ${failures.join('; ')}.`);
}
