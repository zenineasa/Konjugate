// Copyright © 2026 Zenin Easa Panthakkalakath

// Serves out/webShell/ over local HTTP -- for testing, and as a stand-in for what a static host
// (e.g. GitHub Pages) would serve. See docs/proposals/webEdition.md, phase 3.
//
// Pass "threads" as the first CLI argument (matching npm run serve:webShell -- run with `node
// scripts/serveWebShell.mjs threads`) to serve out/webShellThreads/ instead. Always sends
// Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy response headers: harmless for the
// default build, but required for SharedArrayBuffer to exist at all (phase 6's threadPool/
// partitioned execution backends) -- GitHub Pages cannot send these, which is exactly why phase
// 6's own hosting note recommends a COOP/COEP-capable host over a service-worker shim for that
// variant specifically. This script is a local stand-in either way, not a deployment. Set KONJUGATE_NO_ISOLATION=1 to leave the headers off.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pathExists, rootDirectory } from './developmentEnvironment.mjs';

const threads = process.argv[2] === 'threads';
const rootDir = join(rootDirectory, 'out', threads ? 'webShellThreads' : 'webShell');
if (!await pathExists(join(rootDir, 'renderer', 'index.html'))) {
    throw new Error(`The web shell is not built. Run npm run build:webShell${threads ? ':threads' : ''} first.`);
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.kjt': 'application/octet-stream',
    '.md': 'text/markdown; charset=utf-8'
};

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
        const requestPath = decodeURIComponent(url.pathname);
        // index.html's own relative paths (styles.css, webShims/index.mjs, ../node_modules/...)
        // assume it is actually served AT renderer/index.html, not transparently mapped onto "/"
        // -- a real redirect keeps the browser's resolution base (and so every relative URL on
        // the page) consistent with the on-disk layout, instead of one directory level too
        // shallow. Caught directly by testing this in a real renderer: dynamic imports resolved
        // against "/" instead of "/renderer/" and failed to fetch.
        if (requestPath === '/') {
            response.writeHead(302, { Location: '/renderer/index.html' }).end();
            return;
        }
        const resolved = normalize(join(rootDir, requestPath));
        if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const info = await stat(resolved).catch(() => null);
        const filePath = info?.isDirectory() ? join(resolved, 'index.html') : resolved;
        const body = await readFile(filePath);
        const headers = {
            'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
            // KONJUGATE_NO_ISOLATION=1 leaves them off, as GitHub Pages does, to test the page that is not cross-origin isolated.
            ...(process.env.KONJUGATE_NO_ISOLATION ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }),
            // What a static host sends, so that a copy fetched in pieces (scripts/webServiceWorker.js) can be tested here.
            'Accept-Ranges': 'bytes',
            ETag: `"${body.length.toString(16)}-${Math.floor((await stat(filePath)).mtimeMs).toString(16)}"`
        };
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
        const unchanged = !request.headers['if-range'] || request.headers['if-range'] === headers.ETag;
        if (range && unchanged && (range[1] || range[2])) {
            const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
            const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
            if (start > end || start >= body.length) {
                response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
                return;
            }
            response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
            response.end(body.subarray(start, end + 1));
            return;
        }
        response.writeHead(200, headers);
        response.end(body);
    } catch {
        response.writeHead(404).end('Not found');
    }
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, () => console.log(`Web shell served at http://localhost:${port}/`));
