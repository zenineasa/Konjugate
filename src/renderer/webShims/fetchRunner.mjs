/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The transport for webFetch.mjs's fetchAllowedFromPage: one request made by a sandboxed frame (fetchFrame.html) made for it and removed
// when it answers, so a launcher's fetch is not made by the application's page, whose policy lets it talk only to its own server.

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
