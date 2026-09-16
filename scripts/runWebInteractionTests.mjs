// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs the same tests/interactionRunner.mjs scenario definitions scripts/runInteractionTests.mjs
// runs against the desktop Electron app, but against the web edition in a real headless Chromium
// (via Playwright) instead -- see tests/drivers/playwrightWebDriver.mjs and interactionRunner.mjs's
// own top-of-file comment for the shared driver contract that makes this possible. Scenarios that
// exercise a genuinely desktop-only capability (multi-window, native file dialogs, FMU export, the
// AI-provider credential vault, provider-toolchain execution-mode selection, add-on windows, C++
// providers) skip themselves under this driver rather than failing -- see each scenario's own
// `skip:` reason in interactionRunner.mjs.
//
// Targets out/webShellThreads specifically, not the default out/webShell -- the pthread-enabled
// build is what makes live pause/resume runs (scenario "Run invokes the C++ simulation...") and
// SharedArrayBuffer-dependent C++-provider tooling meaningful; the default build's Run is a
// batch-only fallback (docs/proposals/webEdition.md). Run `npm run build:web:threads && npm run
// build:webShell:threads` first (or use `npm run test:interaction:web`, which does that for you).

import { spawn } from 'node:child_process';
import { rootDirectory } from './developmentEnvironment.mjs';

// A fixed high port, not the server script's own 4173 default -- this project's own development
// sessions routinely already have a webShell dev server running on 4173 (confirmed directly: a
// stale server from an earlier session held that port during this very refactor's own testing),
// and this script owns the lifecycle of the server it spawns, so it should not gamble on the
// default port being free.
const port = Number(process.env.KONJUGATE_WEB_INTERACTION_PORT) || 4799;

function waitForServerReady(child) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const onData = (chunk) => {
            if (settled) return;
            const text = chunk.toString();
            process.stdout.write(text);
            if (text.includes('Web shell served at')) {
                settled = true;
                child.stdout.off('data', onData);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', (chunk) => process.stderr.write(chunk));
        child.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
        child.once('exit', (code) => {
            if (!settled) { settled = true; reject(new Error(`serveWebShell.mjs exited early with code ${code}.`)); }
        });
        setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('Timed out waiting for the web shell server to start.')); }
        }, 15000);
    });
}

const serverEnvironment = { ...process.env, PORT: String(port) };
const server = spawn(process.execPath, ['scripts/serveWebShell.mjs', 'threads'], {
    cwd: rootDirectory,
    env: serverEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
});

let exitCode = 1;
try {
    await waitForServerReady(server);

    // Playwright is a real devDependency (see package.json) -- imported dynamically anyway so
    // that every other script in this file (none of which need it) never pays for resolving it.
    const { chromium } = await import('playwright');
    const { runInteractionTests } = await import('../tests/interactionRunner.mjs');
    const { createPlaywrightWebDriver } = await import('../tests/drivers/playwrightWebDriver.mjs');

    // --disable-popup-blocking: Chromium's real popup blocker requires a trusted user gesture for
    // window.open() -- confirmed directly, not assumed: a scripted `element.click()` (what every
    // evaluate()-driven click in this suite does, on both drivers) does not count as one on a real
    // Chromium tab the way Electron's own window.open()/setWindowOpenHandler path apparently does,
    // so the companion-guide-window scenario silently failed to open anything without this flag.
    const browser = await chromium.launch({ args: ['--disable-popup-blocking'] });
    try {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();
        page.on('pageerror', (error) => console.error('[browser:pageerror]', error));
        await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 30000 });
        // The same readiness signal the suite already trusts elsewhere for a second Electron
        // window's own load (see interactionRunner.mjs's "Results Analysis timeline seek..." and
        // the three diagnostic-window scenarios) -- not a new convention.
        await page.waitForSelector('.documentTitle', { timeout: 30000 });

        const driver = createPlaywrightWebDriver(context, page);
        try {
            await runInteractionTests(driver);
            exitCode = 0;
        } finally {
            await driver.dispose();
        }
    } finally {
        await browser.close();
    }
} catch (error) {
    console.error(error);
    exitCode = 1;
} finally {
    server.kill();
    process.exitCode = exitCode;
}
