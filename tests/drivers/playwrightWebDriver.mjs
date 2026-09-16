/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The browser half of the interaction-test suite's driver split (see electronWindowDriver.mjs's
// own header comment for the other half, and tests/interactionRunner.mjs's own top-of-file
// comment for the shared "handle" contract both drivers implement). Unlike the Electron driver,
// this one is genuinely new code, not a lift of existing logic -- Playwright's Page/mouse/keyboard
// API shape differs from Electron's webContents.sendInputEvent in real ways (no modifiers array on
// mouse events; downloads arrive as events, not a stubbed native save dialog), documented inline
// below where the two diverge.

import { readFile } from 'node:fs/promises';

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
        async close() {
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

export function createPlaywrightWebDriver(context, initialPage) {
    const trackedPages = new Set([initialPage]);
    context.on('page', (page) => trackedPages.add(page));

    const mainHandle = wrapPage(initialPage);

    return {
        kind: 'playwright',
        mainHandle,
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
            const downloadPromise = page.waitForEvent('download', { timeout: maxAttempts * intervalMs });
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
            // src/renderer/webShims/projectFiles.mjs's openExampleGuide() opens the raw .md file
            // directly rather than a rendered guide page -- a real, separate gap (see
            // docs/proposals/webEdition.md), not a driver limitation like the others above.
            renderedExampleGuide: false,
            // misc.mjs's aiProviders.generateProposal always throws -- unconditionally, even for
            // the local, non-credentialed demonstration provider that has no real technical need
            // for window.aiProviders' credential-vault machinery at all (confirmed: renderer.mjs
            // has exactly one call site, gating every assistant request the same way regardless
            // of provider). A real, separate gap, not a driver limitation.
            aiAssistant: false
        },
        async dispose() {
            await context.close().catch(() => {});
        }
    };
}
