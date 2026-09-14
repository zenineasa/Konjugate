// Copyright © 2026 Zenin Easa Panthakkalakath

// Serves out/webShell/ over local HTTP -- for testing, and as a stand-in for what a static host
// (e.g. GitHub Pages) would serve. See docs/proposals/webEdition.md, phase 3.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pathExists, rootDirectory } from './developmentEnvironment.mjs';

const rootDir = join(rootDirectory, 'out', 'webShell');
if (!await pathExists(join(rootDir, 'renderer', 'index.html'))) {
    throw new Error('The web shell is not built. Run npm run build:webShell first.');
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
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
        response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
        response.end(body);
    } catch {
        response.writeHead(404).end('Not found');
    }
});

const port = Number(process.env.PORT) || 4173;
server.listen(port, () => console.log(`Web shell served at http://localhost:${port}/`));
