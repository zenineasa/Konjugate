/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The transport for webFetch.mjs's fetchAllowedFromPage: one request made by a sandboxed frame (fetchFrame.html) made for it and removed
// when it answers, so a launcher's fetch is not made by the application's page, whose policy lets it talk only to its own server.

import { transportFailure } from '../../webFetch.mjs';

const frameAddress = new URL('../fetchFrame.html', import.meta.url).href;

export function fetchInFrame({ url, hosts, maximumBytes, timeoutMilliseconds }) {
    return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('aria-hidden', 'true');
        frame.hidden = true;
        let finished = false;
        const id = globalThis.crypto.randomUUID();
        const finish = (answer) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            frame.remove();
            resolve(answer);
        };
        // The frame times its own request; this is for a frame that never answers at all.
        const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMilliseconds + 5000);
        function onMessage(event) {
            if (event.source !== frame.contentWindow) return;
            const message = event.data;
            if (message?.konjugate === 'fetch-shell') frame.contentWindow.postMessage({ fetch: { id, url, hosts, maximumBytes, timeoutMilliseconds } }, '*');
            else if (message?.konjugate === 'fetched' && message.id === id) {
                const { konjugate, id: ignored, ...answer } = message;
                finish(answer);
            }
        }
        window.addEventListener('message', onMessage);
        frame.src = frameAddress;
        document.body.append(frame);
    });
}

// A download in pieces, for the stored files (webFileStore.mjs): resolves once the server has answered, with its status, the address it answered
// from, the headers a page may read and the body as something to iterate; the frame sends no more than eight pieces ahead of what the page has
// taken. Rejects, saying why, if the frame could not make the request. `cancel()` ends it, and so does reaching the end of the body.
export function streamInFrame({ url, hosts, headers = {}, method = 'GET', signal = null, timeoutMilliseconds }) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('aria-hidden', 'true');
        frame.hidden = true;
        const id = globalThis.crypto.randomUUID();
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        const queue = [];
        let waiting = null;
        let ended = null;
        let answered = false;
        const post = (message) => frame.contentWindow?.postMessage(message, '*');
        const close = () => { window.removeEventListener('message', onMessage); signal?.removeEventListener('abort', onAbort); frame.remove(); };
        const wake = () => { const resume = waiting; waiting = null; resume?.(); };
        const end = (reason) => { if (ended) return; ended = reason; close(); wake(); };
        const onAbort = () => { post({ cancel: id }); if (!answered) { answered = true; close(); reject(new Error('The download was cancelled.')); } else end({ error: 'cancelled' }); };
        const cancel = async () => { post({ cancel: id }); end({ end: true }); };
        async function* body() {
            try {
                for (;;) {
                    if (queue.length) { post({ ack: id }); yield queue.shift(); continue; }
                    if (ended) {
                        if (ended.error) throw transportFailure(ended, { host, allowed: new Set(hosts), timeoutMilliseconds });
                        return;
                    }
                    await new Promise((resume) => { waiting = resume; });
                }
            } finally {
                // A reader that stops before the end gives the request up.
                if (!ended) cancel();
            }
        }
        function onMessage(event) {
            if (event.source !== frame.contentWindow) return;
            const message = event.data;
            if (message?.konjugate === 'fetch-shell') { post({ stream: { id, url, hosts, headers, method, timeoutMilliseconds } }); return; }
            if (message?.konjugate !== 'stream' || message.id !== id) return;
            if (message.head) {
                answered = true;
                resolve({ status: message.head.status, url: message.head.url, headers: new Map(Object.entries(message.head.headers)), body: body(), cancel });
            } else if (message.error) {
                if (!answered) { answered = true; close(); reject(transportFailure(message, { host, allowed: new Set(hosts), timeoutMilliseconds })); } else end(message);
            } else if (message.chunk) {
                queue.push(new Uint8Array(message.chunk));
                wake();
            } else if (message.end) {
                end({ end: true });
            }
        }
        window.addEventListener('message', onMessage);
        signal?.addEventListener('abort', onAbort);
        frame.src = frameAddress;
        document.body.append(frame);
    });
}
