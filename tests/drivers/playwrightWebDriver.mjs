/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The browser half of the interaction-test suite's driver split (see electronWindowDriver.mjs's
// own header comment for the other half, and tests/interactionRunner.mjs's own top-of-file
// comment for the shared "handle" contract both drivers implement). Unlike the Electron driver,
// this one is genuinely new code, not a lift of existing logic -- Playwright's Page/mouse/keyboard
// API shape differs from Electron's webContents.sendInputEvent in real ways (no modifiers array on
// mouse events; downloads arrive as events, not a stubbed native save dialog), documented inline
// below where the two diverge.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

// With KONJUGATE_INTERACTION_COVERAGE set to a folder, each page's code is measured while the scenarios run (Chromium's precise
// coverage, through Playwright) and written there as web-<n>.json, in the same form as the desktop's, for
// scripts/coverageReport.mjs. The web shell serves src/ files unchanged at the same paths (scripts/buildWebShell.mjs), so a script
// is counted against its file under src/ when, and only when, its text is that file's: a shell built from older sources is left
// out, not miscounted. A page is measured from when it opens; its counts are taken when the driver closes it and from every page
// still open when the scenarios finish. Workers (the web engine's) are not measured.
function createPageCoverage(directory) {
    const measured = new Set();
    const hadScripts = new WeakSet();
    let written = 0;
    let leftOut = 0;
    async function begin(page) {
        if (measured.has(page)) return;
        measured.add(page);
        await page.coverage.startJSCoverage({ resetOnNavigation: false }).catch(() => measured.delete(page));
    }
    // `after`: the scenario that just ran, said when a page that was measured gives back nothing, which means its counts were
    // lost (the browser swapped the page's process, say) rather than that nothing ran.
    async function take(page, after = null) {
        if (!measured.has(page) || page.isClosed()) return;
        measured.delete(page);
        let entries;
        try { entries = await page.coverage.stopJSCoverage(); } catch { return; }
        if (entries.length) hadScripts.add(page);
        else if (after && hadScripts.has(page)) console.warn(`Coverage: ${page.url()} gave back no scripts after "${after}".`);
        const result = [];
        for (const entry of entries) {
            let path;
            try { path = join(sourceRoot, decodeURIComponent(new URL(entry.url).pathname)); } catch { continue; }
            if (!path.startsWith(sourceRoot + '/')) continue;
            const text = await readFile(path, 'utf8').catch(() => null);
            if (text === null) continue;
            if (text !== entry.source) { leftOut += 1; continue; }
            result.push({ url: pathToFileURL(path).href, functions: entry.functions });
        }
        written += 1;
        const file = join(directory, `web-${written}.json`);
        await mkdir(directory, { recursive: true });
        await writeFile(file, JSON.stringify({ result }));
    }
    return {
        begin, take,
        // Each open page's counts so far, then measured again from here: a page whose counts are lost loses one scenario's.
        async afterScenario(pages, name) {
            for (const page of pages) {
                await take(page, name);
                if (!page.isClosed()) await begin(page);
            }
        },
        async finish(pages) {
            for (const page of pages) await take(page);
            if (leftOut) console.warn(`Coverage: ${leftOut} script${leftOut === 1 ? '' : 's'} left out, served from older sources than src/ (rebuild the web shell).`);
        }
    };
}
let pageCoverage = null;

// Electron's sendInputEvent modifiers are lowercase ('shift'); Playwright's keyboard API expects
// its own key names ('Shift'). Only 'shift' is used anywhere in interactionRunner.mjs today, but
// the rest are mapped too since they're the standard modifier set and cost nothing to include.
const modifierKeyNames = { shift: 'Shift', control: 'Control', ctrl: 'Control', alt: 'Alt', meta: 'Meta', cmd: 'Meta' };

// Electron keyCode strings mostly already match Playwright key names; this table exists for the
// handful of common ones that could plausibly appear later, not because today's single user
// ('Backspace') needs translating.
const keyCodeNames = {
    Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter', Escape: 'Escape',
    Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight'
};

async function withModifiers(page, modifiers, action) {
    const keys = modifiers.map((modifier) => modifierKeyNames[modifier] ?? modifier);
    for (const key of keys) await page.keyboard.down(key);
    try {
        await action();
    } finally {
        for (const key of keys.toReversed()) await page.keyboard.up(key);
    }
}

const handlesByPage = new WeakMap();

function wrapPage(page) {
    let handle = handlesByPage.get(page);
    if (handle) return handle;
    handle = {
        async evaluate(expression) {
            // Passing a string (rather than a function) to page.evaluate() evaluates it directly
            // in the page context, the same "expression string in, value out" shape
            // executeJavaScript(expression, true) has on the Electron side -- every expression
            // string already in this suite is a self-contained JS expression (many already
            // wrapped in IIFEs), so no per-call-site translation is needed here.
            return page.evaluate(expression);
        },
        async mouseMove(point, { modifiers = [] } = {}) {
            await withModifiers(page, modifiers, () => page.mouse.move(point.x, point.y));
        },
        async mouseDown(point, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
            await withModifiers(page, modifiers, () => page.mouse.down({ button, clickCount }));
        },
        async mouseUp(point, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
            await withModifiers(page, modifiers, () => page.mouse.up({ button, clickCount }));
        },
        async click(point, { modifiers = [] } = {}) {
            await handle.mouseMove(point, { modifiers });
            await handle.mouseDown(point, { button: 'left', clickCount: 1, modifiers });
            await handle.mouseUp(point, { button: 'left', clickCount: 1, modifiers });
        },
        async rightClick(point, { modifiers = [] } = {}) {
            await handle.mouseMove(point, { modifiers });
            await handle.mouseDown(point, { button: 'right', clickCount: 1, modifiers });
            await handle.mouseUp(point, { button: 'right', clickCount: 1, modifiers });
        },
        async keyDown(keyCode) {
            await page.keyboard.down(keyCodeNames[keyCode] ?? keyCode);
        },
        async keyUp(keyCode) {
            await page.keyboard.up(keyCodeNames[keyCode] ?? keyCode);
        },
        onConsoleMessage(listener) {
            const wrapped = (message) => listener(message.text());
            page.on('console', wrapped);
            return () => page.off('console', wrapped);
        },
        async title() {
            return page.title();
        },
        async focus() {
            await page.bringToFront();
        },
        async close() {
            await pageCoverage?.take(page);
            await page.close();
        },
        async isDestroyed() {
            return page.isClosed();
        },
        parent() {
            // Playwright has no BrowserWindow.getParentWindow() equivalent exposed on Page. Only
            // called from scenarios that are desktop-only-gated in practice under this driver.
            return null;
        },
        _raw: page
    };
    handlesByPage.set(page, handle);
    return handle;
}

// currentEngine: the shell carries a web engine built from the current engine sources (scripts/engineFreshness.mjs), so what needs one
// (waveform schedules, the startPaused run setting and the changes it records) can be tested.
export function createPlaywrightWebDriver(context, initialPage, { currentEngine = false } = {}) {
    const trackedPages = new Set([initialPage]);
    pageCoverage = process.env.KONJUGATE_INTERACTION_COVERAGE ? createPageCoverage(process.env.KONJUGATE_INTERACTION_COVERAGE) : null;
    context.on('page', (page) => { trackedPages.add(page); pageCoverage?.begin(page); });

    const mainHandle = wrapPage(initialPage);

    return {
        kind: 'playwright',
        mainHandle,
        // Before the first scenario, and after the last: the first page is loaded again once measuring has started, so its
        // modules' top-level code counts.
        async prepare() {
            if (!pageCoverage) return;
            await pageCoverage.begin(initialPage);
            await initialPage.reload({ waitUntil: 'load' });
            await initialPage.waitForSelector('.documentTitle', { timeout: 30000 });
        },
        async afterScenario(name) {
            await pageCoverage?.afterScenario([...trackedPages].filter((page) => !page.isClosed()), name);
        },
        async finish() {
            await pageCoverage?.finish([...trackedPages].filter((page) => !page.isClosed()));
        },
        allHandles() {
            return [...trackedPages].map(wrapPage);
        },
        async waitForNewHandle(existingHandles, { titleIncludes, excluding = [] } = {}, timeoutMs = 5000) {
            const excludedRaws = new Set([...existingHandles, ...excluding].map((handle) => handle._raw));
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                const candidates = [...trackedPages].filter((page) => !excludedRaws.has(page));
                for (const page of candidates) {
                    if (titleIncludes) {
                        const title = await page.title().catch(() => '');
                        if (!title.includes(titleIncludes)) continue;
                    }
                    return wrapPage(page);
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error(`No new window appeared${titleIncludes ? ` with a title including "${titleIncludes}"` : ''} within ${timeoutMs}ms.`);
        },
        async captureExport(trigger, { maxAttempts = 100, intervalMs = 25 } = {}) {
            const page = initialPage;
            // No download in time is said the way the desktop driver says no file written, so a test can tell "nothing was
            // exported" from a failure the same way in both editions.
            const downloadPromise = page.waitForEvent('download', { timeout: maxAttempts * intervalMs })
                .catch(() => { throw new Error('Export did not write a file: no download started.'); });
            await trigger();
            const download = await downloadPromise;
            const path = await download.path();
            if (!path) throw new Error('Export did not produce a downloaded file.');
            const bytes = await readFile(path);
            return { path, bytes };
        },
        async simulateOsFileOpen() {
            throw new Error('The web edition has no OS file-open equivalent; this driver never reaches this call in practice.');
        },
        capabilities: {
            multiWindow: false,
            osFileOpen: false,
            addons: false,
            fmuExport: false,
            aiProviderCredentials: false,
            providerExecutionModeSelector: false,
            cppProviders: false,
            // Need a web engine built after waveform schedules, and the `startPaused` run setting, were added: on only when the
            // shell carries one built from the current engine sources.
            parameterWaveforms: currentEngine,
            startPausedRuns: currentEngine,
            // A web engine that holds a command until a time (EngineCommand.apply_at), which repeating a run from its record needs.
            heldCommands: currentEngine,
            // The web engine keeps no checkpoints to read back, so a result cannot be forked (nor repeated from its record, a fork from its start).
            forks: false,
            // The web engine reports a fit only when it ends (webShims/engine.mjs), with no progress to show and no way to stop one part way.
            fitProgress: false,
            // src/renderer/webShims/projectFiles.mjs's openExampleGuide() opens the raw .md file
            // directly rather than a rendered guide page -- a real, separate gap (see
            // docs/proposals/webEdition.md), not a driver limitation like the others above.
            renderedExampleGuide: false,
            // misc.mjs's aiProviders.generateProposal always throws -- unconditionally, even for
            // the local, non-credentialed demonstration provider that has no real technical need
            // for window.aiProviders' credential-vault machinery at all (confirmed: renderer.mjs
            // has exactly one call site, gating every assistant request the same way regardless
            // of provider). A real, separate gap, not a driver limitation.
            aiAssistant: false,
            // The web engine validates in-process and cannot abort a validation it has started.
            cancellableValidation: false
        },
        async dispose() {
            await context.close().catch(() => {});
        }
    };
}
