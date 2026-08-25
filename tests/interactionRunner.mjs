/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

async function evaluate(window, expression) {
    return window.webContents.executeJavaScript(expression, true);
}

// A renderer-side exception thrown synchronously inside a DOM event listener (e.g. from a
// synthetic element.click()) never rejects executeJavaScript's promise -- the browser's event
// dispatch loop swallows it and only reports it to the console as "Uncaught ...". Any assertion
// checking DOM/JS state after such a call can't distinguish "ran correctly" from "the handler
// crashed before reaching that state" (a value it never got to update just looks unchanged).
// This captures renderer console output around a task so callers can assert nothing was logged.
async function captureConsoleMessages(window, task) {
    const messages = [];
    const listener = (event) => messages.push(event.message);
    window.webContents.on('console-message', listener);
    try {
        await task();
    } finally {
        window.webContents.off('console-message', listener);
    }
    return messages;
}

// Checks the rendered computed style rather than the `hidden` IDL property: a `hidden`
// element can still render if some other CSS rule sets `display` with equal or higher
// specificity than the UA stylesheet's `[hidden] { display: none }`, which the property
// alone would never reveal.
async function isRenderedVisible(window, selector) {
    return evaluate(window, `getComputedStyle(document.querySelector('${selector}')).display !== 'none'`);
}

async function waitFor(window, expression, message, timeout = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await evaluate(window, expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const visibleError = await evaluate(window, `document.querySelector('#assistantError:not([hidden])')?.textContent ?? ''`);
    const assistantStatus = await evaluate(window, `document.querySelector('#assistantProposalStatus')?.textContent ?? ''`);
    throw new Error(`${message}${visibleError ? ` ${visibleError}` : ''}${assistantStatus ? ` Status: ${assistantStatus}` : ''}`);
}

// A single requestAnimationFrame apart is not a reliable "stopped moving" signal here: the main
// render loop (renderer.mjs's render(), which repositions every CSS2D label and applies
// OrbitControls damping) is throttled to 30fps, so two rAF ticks can both land inside the same
// un-rendered ~33ms window and report "unchanged" even while a real position update -- e.g.
// OrbitControls damping (dampingFactor 0.07) still easing off a preceding pan/zoom/rotate test --
// is genuinely pending on the next actual render tick. Requiring several consecutive matches,
// each spaced further apart (50ms) than the render throttle, actually observes real render ticks
// instead of possibly sampling twice inside a gap between them.
async function waitForStableRect(window, expression, message, timeout = 3000) {
    const startedAt = Date.now();
    let previous = null;
    let stableStreak = 0;
    while (Date.now() - startedAt < timeout) {
        const current = await evaluate(window, expression);
        if (current && current === previous) {
            stableStreak += 1;
            if (stableStreak >= 3) return;
        } else {
            stableStreak = 0;
        }
        previous = current;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
}

async function clickElement(window, expression, modifiers = []) {
    const point = await evaluate(window, `(() => {
        const element = ${expression};
        const bounds = element.getBoundingClientRect();
        return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point, modifiers });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers });
}

// Re-resolves the element's screen position on every call rather than caching one set of
// coordinates -- a CSS2D label can shift by a pixel or two as selection/disabled styling changes
// its box (border, badge text), and a stale cached point can miss the element entirely on a
// later right-click in the same test.
async function rightClickElement(window, expression) {
    const point = await evaluate(window, `(() => {
        const element = ${expression};
        const bounds = element.getBoundingClientRect();
        return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 });
}

// A CSS2D overlay (a node/edge label) always wins DOM hit-testing over the WebGL canvas
// beneath it regardless of 3D depth, so a point that's a valid 3D raycast target can still be
// undeliverable to the canvas as a real click if a label happens to cover it there -- and
// exactly where that is can shift with accumulated camera state this deep into the suite, even
// when nothing occludes it on a fresh load. Spiral outward until landing on a pixel the canvas
// itself owns, rather than assume the originally-computed point is still clear.
async function findCanvasPoint(window, point, maxRadius = 40) {
    if (!point) return null;
    for (let radius = 0; radius <= maxRadius; radius += 4) {
        const offsets = radius === 0 ? [[0, 0]] : [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius], [radius, -radius], [-radius, radius]];
        for (const [dx, dy] of offsets) {
            const candidate = { x: point.x + dx, y: point.y + dy };
            const isCanvas = await evaluate(window, `document.elementFromPoint(${candidate.x}, ${candidate.y})?.classList.contains('webglSurface') ?? false`);
            if (isCanvas) return candidate;
        }
    }
    return point;
}

// A handful of raw, pixel-coordinate pointer gestures (as opposed to clicking a known DOM
// element) grow occasionally flaky this deep into the suite -- accumulated frame-timing
// variance across 50+ prior tests, not a bug in the gesture itself: the same sequence is
// reliable every time run in isolation. Retried a few times rather than treated as a hard
// failure, matching this suite's existing tolerance for a few other timing-sensitive
// interactions elsewhere. `perform` re-runs from scratch each attempt (re-reading any screen
// points fresh) since a prior attempt may have nudged state slightly.
async function retryGesture(window, perform, checkExpression, times = 5, settleMs = 200) {
    for (let attempt = 0; attempt < times; attempt += 1) {
        await perform();
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        if (await evaluate(window, checkExpression)) return true;
    }
    return false;
}

export async function runInteractionTests(window) {
    let passed = 0;
    const run = async (name, task) => {
        try {
            await task();
            passed += 1;
            console.log(`✓ ${name}`);
        } catch (error) {
            error.message = `${name}: ${error.message}`;
            throw error;
        }
    };

    await run('examples explorer loads a project copy', async () => {
        await evaluate(window, `document.querySelector('#exampleButton').click()`);
        await waitFor(window, `document.querySelector('#examplesExplorerDialog').open`, 'Examples explorer did not open.');
        await waitFor(window, `Boolean([...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management'))`, 'Examples explorer did not populate.');
        await evaluate(window, `[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === 'Thermal Management').click()`);
        await waitFor(window, `document.querySelector('#examplesExplorerDetailTitle').textContent === 'Thermal Management'`, 'Selecting the example did not populate the detail preview.');
        assert.equal(await evaluate(window, `document.querySelector('#examplesExplorerDetailContent').hidden`), false);
        assert.match(await evaluate(window, `document.querySelector('#examplesExplorerDetailDescription').textContent`), /enclosed-air volume/i);
        await evaluate(window, `document.querySelector('#examplesExplorerLoad').click()`);
        // loadExample()'s click handler isn't awaited by the caller, and closing the dialog
        // happens in its `finally` block after the (also awaited-inside-loadExample) guide
        // window IPC round trip -- so the dialog can still be open for a moment after the model
        // itself has already finished loading. Wait for the actual close rather than the model
        // load alone, to avoid a race against that same handler's own tail end.
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Thermal example did not load.');
        assert.equal(await evaluate(window, `document.querySelector('.documentTitle').textContent`), 'thermalManagement');
        await waitFor(window, `!document.querySelector('#examplesExplorerDialog').open`, 'Examples explorer did not close after loading the example.');
    });

    await run('example selection opens its companion guide', async () => {
        const initialStartedAt = Date.now();
        let guideWindow = null;
        while (Date.now() - initialStartedAt < 5000 && !guideWindow) {
            guideWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.getTitle().includes('Example Guide'));
            if (!guideWindow) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(guideWindow, 'Example guide window did not open.');
        await waitFor(guideWindow, `document.querySelector('#guideTitle').textContent.includes('Thermal Management')`, 'Example guide content did not render.');
        assert.match(await evaluate(guideWindow, `document.querySelector('#content').textContent`), /enclosed-air volume/i);
        assert.doesNotMatch(await evaluate(guideWindow, `document.querySelector('#content').textContent`), /Copyright/);
        await waitFor(guideWindow, `document.querySelectorAll('.equation .ML__latex').length > 0`, 'Example equations did not render with MathLive.');
        assert.equal(await evaluate(guideWindow, `document.querySelectorAll('math-field').length`), 0);
        assert.equal(await evaluate(guideWindow, `[...document.querySelectorAll('.equation [style]')].every((element) => element.style.length > 0)`), true);
        assert.equal(await evaluate(guideWindow, `document.querySelector('.equation').scrollWidth <= document.querySelector('.equation').clientWidth`), true);
        assert.equal(await evaluate(window, `document.querySelector('#exampleGuideButton').hidden`), false);
        guideWindow.close();
        await waitFor(window, `!document.querySelector('#exampleGuideButton').hidden`, 'Example guide reopen control disappeared.');
        await evaluate(window, `document.querySelector('#exampleGuideButton').click()`);
        const startedAt = Date.now();
        while (Date.now() - startedAt < 5000 && !BrowserWindow.getAllWindows().some((candidate) => candidate !== window && candidate.getTitle().includes('Example Guide'))) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(BrowserWindow.getAllWindows().some((candidate) => candidate !== window && candidate.getTitle().includes('Example Guide')), 'Example guide did not reopen.');
    });

    await run('a second project window opens independently and does not affect the first', async () => {
        const before = BrowserWindow.getAllWindows();
        await evaluate(window, `document.querySelector('#newWindowButton').click()`);
        let second = null;
        const openStartedAt = Date.now();
        while (Date.now() - openStartedAt < 5000 && !second) {
            second = BrowserWindow.getAllWindows().find((candidate) => !before.includes(candidate));
            if (!second) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(second, 'A new project window did not open.');
        await waitFor(second, `document.querySelector('.documentTitle')`, 'Second window did not finish loading.');

        // Independence: the new window starts blank regardless of what's loaded in the first
        // (the first window has an example loaded by this point in the suite).
        assert.equal(await evaluate(second, `document.querySelectorAll('.node-label-container').length`), 0);

        // An auxiliary window (About) opened from each project window stays scoped to its own
        // parent -- win.getParentWindow() is a free, exact check since auxiliaryWindowPresentation
        // already sets `parent:` on every auxiliary window.
        const findAboutWindowFor = async (parent) => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 5000) {
                const found = BrowserWindow.getAllWindows().find((candidate) => candidate.getParentWindow() === parent && candidate.getTitle().includes('About'));
                if (found) return found;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error('About window did not open for its project window.');
        };
        await evaluate(window, `window.applicationInfo.openAbout()`);
        await evaluate(second, `window.applicationInfo.openAbout()`);
        const aboutFromFirst = await findAboutWindowFor(window);
        const aboutFromSecond = await findAboutWindowFor(second);
        assert.notEqual(aboutFromFirst, aboutFromSecond, 'Each project window should get its own About window.');
        aboutFromFirst.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!aboutFromSecond.isDestroyed(), "Closing window A's About window must not affect window B's.");
        aboutFromSecond.close();

        // Closing a project window must not quit the app or affect the other window.
        second.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!window.isDestroyed(), 'Closing the second window destroyed the first.');
        assert.equal(await evaluate(window, `1 + 1`), 2, 'The first window is no longer responsive after the second closed.');
    });

    await run('an OS-initiated file open reuses an already-open window on the same file, otherwise opens a new one', async () => {
        // Simulates exactly what a real double-click (or a relaunch's second-instance argv, on
        // Windows/Linux) drives main.mjs's own app.on('open-file', ...) listener to do -- no OS
        // automation needed, since main.mjs never distinguishes a real 'open-file' from this one.
        const examplePath = join(process.cwd(), 'examples', 'pumpSuctionHydraulics.kjt');

        const beforeFirstOpen = BrowserWindow.getAllWindows();
        app.emit('open-file', { preventDefault() {} }, examplePath);
        let opened = null;
        const openStartedAt = Date.now();
        while (Date.now() - openStartedAt < 5000 && !opened) {
            opened = BrowserWindow.getAllWindows().find((candidate) => !beforeFirstOpen.includes(candidate));
            if (!opened) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(opened, 'An OS-initiated open of a valid .kjt file did not open a new window.');
        await waitFor(opened, `document.querySelectorAll('.node-label-container').length > 0`, 'The OS-opened file did not load into the new window.');
        assert.equal(await evaluate(opened, `document.querySelector('.documentTitle').textContent`), 'pumpSuctionHydraulics');
        // Give the new window's pathChanged push time to reach main before re-opening the same path.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const beforeSecondOpen = BrowserWindow.getAllWindows();
        app.emit('open-file', { preventDefault() {} }, examplePath);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(BrowserWindow.getAllWindows(), beforeSecondOpen, 'Opening the same file again should focus the existing window, not open a duplicate.');
        opened.close();

        const beforeBadOpen = BrowserWindow.getAllWindows();
        app.emit('open-file', { preventDefault() {} }, join(process.cwd(), 'examples', 'doesNotExist.kjt'));
        let failedWindow = null;
        const badOpenStartedAt = Date.now();
        while (Date.now() - badOpenStartedAt < 5000 && !failedWindow) {
            failedWindow = BrowserWindow.getAllWindows().find((candidate) => !beforeBadOpen.includes(candidate));
            if (!failedWindow) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(failedWindow, 'An OS-initiated open of a missing file did not open a window at all.');
        await waitFor(failedWindow, `document.querySelector('#statusText').textContent.startsWith('Load failed')`, 'A missing file did not surface a load-failed status instead of crashing.');
        failedWindow.close();
    });

    await run('validation summary reports and displays a valid model', async () => {
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'C++ validation report did not reach the UI.');
        assert.equal(await evaluate(window, `document.querySelector('#validationSummary').classList.contains('error')`), false);
        await evaluate(window, `document.querySelector('#validationSummary').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#validationPanel').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#validationPanelTitle').textContent`), 'No issues');
        await evaluate(window, `document.querySelector('#closeValidationPanel').click()`);
    });

    await run('local assistant prepares, validates and applies one undoable transaction', async () => {
        await evaluate(window, `window.dispatchEvent(new Event('resize')); document.querySelector('#assistantButton').click(); (() => {
            const prompt = document.querySelector('#assistantPrompt');
            prompt.value = 'Add an ambient boundary at 298 K and connect it to the battery with a conductance of 15 W/K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantButton').parentElement.classList.contains('windowControls')`), true);
        assert.ok(await evaluate(window, `Math.abs(document.querySelector('#assistantPanel').getBoundingClientRect().top - document.querySelector('#canvas').getBoundingClientRect().top - 10)`) < 2);
        assert.ok(await evaluate(window, `Math.abs(document.querySelector('#assistantPanel').getBoundingClientRect().right - (window.innerWidth - 10))`) < 2);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The local assistant proposal was not ready to apply.');
        await waitFor(window, `document.querySelector('#assistantConfiguration').options.length === 1`, 'Assistant configurations did not load through the main process.');
        assert.match(await evaluate(window, `document.querySelector('#assistantConfiguration').selectedOptions[0].textContent`), /Local demonstration · Local/);
        assert.equal(await evaluate(window, `typeof window.aiProviders.getCredential`), 'undefined');
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container').length`), 3);
        assert.equal(await evaluate(window, `!document.querySelector('#assistantPanel').hidden && !document.querySelector('#applyAssistantProposal').disabled`), true);
        assert.match(await evaluate(window, `document.querySelector('#assistantProposalStatus').textContent`), /Native validation passed/);
        assert.match(await evaluate(window, `document.querySelector('#assistantProposalSummary').textContent`), /Battery module/);
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Revise proposal');
        await evaluate(window, `document.querySelector('#collapseAssistantPanel').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantPanel').classList.contains('collapsed')`), true);
        assert.match(await evaluate(window, `document.querySelector('#assistantCollapsedStatus').textContent`), /Proposal ready/);
        await evaluate(window, `document.querySelector('#collapseAssistantPanel').click()`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#assistantPanel').hidden && !document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        await waitFor(window, `document.querySelector('#assistantPanel').getBoundingClientRect().right <= document.querySelector('#nodeEditor').getBoundingClientRect().left`, 'Assistant did not move beside the model inspector.');
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Ambient boundary'))`, 'Applied assistant node did not appear on the canvas.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Undo did not restore the original canvas.');
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 4`, 'Redo did not restore the assistant proposal.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Undo did not restore the model before testing an assistant update.');
        await evaluate(window, `document.querySelector('#assistantButton').click(); (() => {
            document.querySelector('#assistantPrompt').value = 'Set the battery initial temperature to 325 K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The assistant update proposal was not ready.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantChange.update').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantChange dd').textContent`), /353\.2 → 325/);
        await evaluate(window, `document.querySelector('.assistantChange button').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden') && !document.querySelector('#assistantPanel').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').value`), 'Battery module');
        await evaluate(window, `document.querySelector('#discardAssistantProposal').click(); document.querySelector('#nodeEditor [data-close-card]').click(); document.querySelector('#closeAssistantPanel').click()`);
    });

    await run('local assistant can disable and enable a node and a relationship', async () => {
        const nodeLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy'))`;
        await evaluate(window, `document.querySelector('#assistantButton').click(); (() => {
            document.querySelector('#assistantPrompt').value = 'Disable the battery module.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The disable-node proposal was not ready.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantChange.update').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantChange dd').textContent`), /true → false/);
        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        // `?.` throughout: a plain top-level thrown exception during a polled evaluate() (not one
        // swallowed inside a click listener) surfaces from Electron as an opaque "Script failed to
        // execute" IPC error with no message, so a transient re-render leaving .find() briefly
        // unmatched would otherwise crash the whole test run rather than just failing one waitFor.
        await waitFor(window, `${nodeLabel}?.closest('.node-label-container').classList.contains('disabled')`, 'The assistant-applied node disable did not render.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `${nodeLabel}?.closest('.node-label-container').classList.contains('disabled') === false`, 'Undo did not restore the assistant-applied node disable.');

        await evaluate(window, `document.querySelector('#assistantButton').click(); (() => {
            document.querySelector('#assistantPrompt').value = 'Disable the Heat source relationship.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The disable-edge proposal was not ready.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantChange.update').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantChange dd').textContent`), /true → false/);
        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        await waitFor(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Electrical losses'))?.textContent.includes('Disabled')`, 'The assistant-applied edge disable did not render.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `![...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Electrical losses'))?.textContent.includes('Disabled')`, 'Undo did not restore the assistant-applied edge disable.');
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    });

    await run('local assistant asks a clarifying question for an ambiguous request and resolves it from a suggestion', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click()`);
        // Reset first: earlier assistant tests in this suite already left turns in the bounded
        // conversation history (it deliberately survives an apply/discard/panel close, only an
        // explicit reset clears it), and this test wants a known, empty starting transcript.
        await evaluate(window, `window.konjugateAssistant.resetConversation()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantTranscript').hidden`), true);

        const temperatureNodeNames = await evaluate(window, `window.konjugateAssistant.getModelSummary().nodes
            .filter((node) => node.states.some((state) => state.symbol === 'temperature' || state.name.toLowerCase().includes('temperature')))
            .map((node) => node.name)`);
        assert.ok(temperatureNodeNames.length >= 2, `Expected at least two temperature-bearing nodes, found: ${temperatureNodeNames.join(', ')}`);

        await evaluate(window, `(() => {
            document.querySelector('#assistantPrompt').value = 'Set the temperature to 310 K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#assistantClarification').hidden`, 'The assistant did not ask a clarifying question for an ambiguous request.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').value`), '', 'The prompt should be cleared once a response has arrived.');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#assistantEmpty')).display`), 'none', "The empty-state placeholder must not render behind the clarification (regression: .assistantEmpty's own display:grid was overriding [hidden]).");
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Answer');
        assert.match(await evaluate(window, `document.querySelector('#assistantClarificationQuestion').textContent`), /which node/i);
        const suggestionTexts = await evaluate(window, `[...document.querySelectorAll('.assistantClarificationOption')].map((button) => button.textContent)`);
        assert.deepEqual([...suggestionTexts].sort(), [...temperatureNodeNames].sort());
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantTranscriptTurn').length`), 1);
        assert.match(await evaluate(window, `document.querySelector('.assistantTranscriptOutcome').textContent`), /Asked:/);

        // Clicking a suggestion must only prefill the prompt, never submit it on its own.
        const firstSuggestion = await evaluate(window, `document.querySelector('.assistantClarificationOption').textContent`);
        await evaluate(window, `document.querySelector('.assistantClarificationOption').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').value`), firstSuggestion);
        assert.equal(await evaluate(window, `document.querySelector('#assistantClarification').hidden`), false);

        await evaluate(window, `(() => {
            document.querySelector('#assistantPrompt').value = ${JSON.stringify(`${firstSuggestion}, 310 K`)};
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#applyAssistantProposal').disabled`, 'The clarification reply did not resolve into an appliable proposal.');
        assert.match(await evaluate(window, `document.querySelector('#assistantProposalSummary').textContent`), new RegExp(firstSuggestion));
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantTranscriptTurn').length`), 2);
        assert.match(await evaluate(window, `document.querySelectorAll('.assistantTranscriptOutcome')[1].textContent`), /Proposed:/);

        assert.equal(await evaluate(window, `window.konjugateAssistant.applyProposal()`), true);
        await waitFor(window, `document.querySelectorAll('.assistantTranscriptOutcome')[1]?.textContent.includes('Applied:')`, 'Applying did not update the transcript turn in place.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.assistantTranscriptTurn').length`), 2, 'Applying should update the existing turn, not add a new one.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    });

    await run('dismissing a clarification and starting a new conversation both clear it without submitting', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click()`);
        await evaluate(window, `window.konjugateAssistant.resetConversation()`);
        const temperatureNodeNames = await evaluate(window, `window.konjugateAssistant.getModelSummary().nodes
            .filter((node) => node.states.some((state) => state.symbol === 'temperature' || state.name.toLowerCase().includes('temperature')))
            .map((node) => node.name)`);
        assert.ok(temperatureNodeNames.length >= 2, `Expected at least two temperature-bearing nodes, found: ${temperatureNodeNames.join(', ')}`);

        await evaluate(window, `(() => {
            document.querySelector('#assistantPrompt').value = 'Set the temperature to 310 K.';
            document.querySelector('#assistantPromptForm').requestSubmit();
        })()`);
        await waitFor(window, `!document.querySelector('#assistantClarification').hidden`, 'The assistant did not ask a clarifying question.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantPrompt').value`), '', 'The prompt should be cleared once a response (a clarifying question) has arrived.');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#assistantEmpty')).display`), 'none', "The empty-state placeholder must not render behind the clarification (regression: .assistantEmpty's own display:grid was overriding [hidden]).");
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Answer');
        await evaluate(window, `document.querySelector('#dismissAssistantClarification').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantClarification').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#assistantEmpty').hidden`), false);
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#assistantEmpty')).display`), 'grid');
        assert.equal(await evaluate(window, `document.querySelector('#generateAssistantProposal').textContent`), 'Generate proposal');
        assert.match(await evaluate(window, `document.querySelector('.assistantTranscriptOutcome').textContent`), /did not answer/i);
        assert.equal(await evaluate(window, `window.konjugateAssistant.getTurnHistory().length`), 1);

        // There's a turn in history to lose, so this must ask for confirmation first.
        await evaluate(window, `window.confirm = () => true; document.querySelector('#newAssistantConversation').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantTranscript').hidden`), true);
        assert.equal(await evaluate(window, `window.konjugateAssistant.getTurnHistory().length`), 0);

        // Nothing left to lose now -- clicking it again must not block on a confirmation dialog
        // (this call deliberately does not stub window.confirm, so it would hang/timeout if the
        // implementation asked for confirmation here).
        await evaluate(window, `document.querySelector('#newAssistantConversation').click()`);
        await evaluate(window, `document.querySelector('#closeAssistantPanel').click()`);
    });

    await run('model configurations expose all provider adapters without renderer credential access', async () => {
        await evaluate(window, `document.querySelector('#assistantButton').click(); document.querySelector('#manageAssistantConfigurations').click()`);
        assert.deepEqual(await evaluate(window, `[...document.querySelector('#assistantConfigurationProvider').options].map((option) => option.value)`), [
            'localDemonstration', 'ollama', 'openAi', 'nvidia', 'huggingFace', 'gemini'
        ]);
        await evaluate(window, `document.querySelector('#newAssistantConfiguration').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#assistantCredentialField').hidden`), true);
        await evaluate(window, `(() => {
            document.querySelector('#assistantConfigurationName').value = 'Interaction Ollama';
            document.querySelector('#assistantConfigurationModel').value = '__custom__';
            document.querySelector('#assistantCustomModel').value = 'test-model';
            document.querySelector('#assistantConfigurationDialog').querySelector('form').requestSubmit();
        })()`);
        await waitFor(window, `[...document.querySelectorAll('#assistantConfiguration option')].some((option) => option.textContent.includes('Interaction Ollama'))`, 'Saved Ollama configuration did not appear.');
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfigurationDialog').open`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('#assistantConfigurationList button')].some((button) => button.textContent.includes('Interaction Ollama'))`), true);
        assert.equal(await evaluate(window, `document.querySelector('#assistantConfigurationUuid').value.length > 0`), true);
        await evaluate(window, `window.confirm = () => true; document.querySelector('#deleteAssistantConfiguration').click()`);
        await waitFor(window, `document.querySelectorAll('#assistantConfiguration option').length === 1`, 'Deleted configuration remained available.');
        await evaluate(window, `document.querySelector('#cancelAssistantConfiguration').click(); document.querySelector('#closeAssistantPanel').click()`);
    });

    await run('run configuration and node substeps are editable', async () => {
        await evaluate(window, `document.querySelector('#runConfigurationButton').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#runExecutionBackend').value`), 'automatic');
        assert.equal(await evaluate(window, `document.querySelector('#runExecutionAdvanced').open`), false);
        await evaluate(window, `(() => {
            document.querySelector('#runConfigurationName').value = 'Fast response';
            document.querySelector('#runGlobalTimeStep').value = '0.02';
            document.querySelector('#runOutputInterval').value = '0.1';
            document.querySelector('#runWorkerThreads').value = '2';
            document.querySelector('#runPartitionAlgorithm').value = 'automatic';
            document.querySelector('#runPartitionCount').value = '2';
            document.querySelector('#runPartitionCommunicationBias').value = '4';
            document.querySelector('#applyRunConfiguration').click();
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#runConfigurationDialog').open`), false);
        assert.equal(await evaluate(window, `document.querySelectorAll('#runPartitionAlgorithm option').length`), 3);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-node-tab="numerics"]').click()`);
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeSubsteps'); input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeSubsteps').value`), '2');
        assert.match(await evaluate(window, `document.querySelector('#nodeEffectiveTimeStep').textContent`), /0\.01/);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'Updated numerical settings were not validated.');
    });

    await run('advanced provider execution mode selector persists a choice and warns for in-process', async () => {
        // Opening/saving this dialog awaits real IPC round trips before flipping dialog.open,
        // so each step below waits for that observable state change rather than assuming a
        // click's synchronous return means the async handler it triggered has finished.
        await evaluate(window, `document.querySelector('#providerToolchainsButton').click()`);
        await waitFor(window, `document.querySelector('#providerToolchainsDialog').open`, 'Provider Toolchains dialog did not open.');
        assert.equal(await evaluate(window, `document.querySelector('#providerExecutionMode').value`), '');
        assert.equal(await isRenderedVisible(window, '#providerExecutionModeWarning'), false);

        await evaluate(window, `(() => {
            const select = document.querySelector('#providerExecutionMode');
            select.value = 'inProcess';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#providerExecutionModeWarning'), true);

        await evaluate(window, `(() => {
            const select = document.querySelector('#providerExecutionMode');
            select.value = 'sharedMemoryWorker';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#providerExecutionModeWarning'), false);
        await evaluate(window, `document.querySelector('#providerToolchainsSave').click()`);
        await waitFor(window, `!document.querySelector('#providerToolchainsDialog').open`, 'Provider Toolchains dialog did not close after saving.');

        await evaluate(window, `document.querySelector('#providerToolchainsButton').click()`);
        await waitFor(window, `document.querySelector('#providerToolchainsDialog').open`, 'Provider Toolchains dialog did not reopen.');
        assert.equal(await evaluate(window, `document.querySelector('#providerExecutionMode').value`), 'sharedMemoryWorker');

        // Reset to Automatic so this machine-global (not project-scoped) preference does not
        // leak into later tests in this same run.
        await evaluate(window, `document.querySelector('#providerExecutionMode').value = ''`);
        await evaluate(window, `document.querySelector('#providerToolchainsSave').click()`);
        await waitFor(window, `!document.querySelector('#providerToolchainsDialog').open`, 'Provider Toolchains dialog did not close after resetting.');
    });

    await run('Run invokes the C++ simulation and displays state results', async () => {
        assert.equal(await evaluate(window, `document.querySelector('#runButton').disabled`), false);
        const before = await evaluate(window, `document.querySelector('.node-label-container dd').textContent`);
        await evaluate(window, `document.querySelector('#runButton').click()`);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '1.5'; document.querySelector('#runOnlineMode').checked = true; document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#runPacingMode').value = 'realTime'; document.querySelector('#startRun').click(); })()`);
        await waitFor(window, `!document.querySelector('#resultTransport').hidden && document.querySelector('.resultMode small').textContent === 'Running · model locked'`, 'C++ simulation did not enter its running state.', 10000);
        assert.equal(await evaluate(window, `!document.querySelector('#simulationPacing').hidden && document.querySelector('#resultPlaybackRate').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#resultPlaybackControls').hidden && !document.querySelector('#simulationExecutionControls').hidden`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.reviewControl')].every((control) => control.hidden) && document.querySelector('#continueRun').hidden`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.reviewControl, #continueRun')].every((control) => getComputedStyle(control).display === 'none')`), true);
        assert.equal(await evaluate(window, `document.querySelector('.resultMode b').textContent`), 'Simulation');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#simulationProgress')).display !== 'none' && document.querySelector('#simulationProgress').value.includes('/')`), true);
        assert.equal(await evaluate(window, `document.querySelector('.resultMode small').textContent`), 'Running · model locked');
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Paused · model locked'`, 'Simulation did not pause at a synchronization boundary.', 3000);
        assert.equal(await evaluate(window, `document.querySelector('#closeResults').hidden`), true);
        await evaluate(window, `document.querySelector('#simulationPauseResume').click()`);
        await waitFor(window, `document.querySelector('.resultMode small').textContent === 'Model locked'`, 'Live simulation did not complete.', 5000);
        assert.equal(await evaluate(window, `document.querySelector('#simulationPacing').hidden && !document.querySelector('#resultPlaybackRate').hidden`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#resultPlaybackControls').hidden && document.querySelector('#simulationExecutionControls').hidden`), true);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.reviewControl')].every((control) => !control.hidden) && !document.querySelector('#continueRun').hidden`), true);
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#continueRun')).display !== 'none' && document.querySelector('#continueRun').textContent === 'Extend simulation' && getComputedStyle(document.querySelector('#resultTimeline')).display !== 'none'`), true);
        assert.equal(await evaluate(window, `document.querySelector('.resultMode b').textContent`), 'Results');
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('#simulationProgress')).display === 'none'`), true);
        assert.equal(await evaluate(window, `document.querySelector('#executionSummaryButton').hidden`), false);
        assert.equal(await evaluate(window, `!document.querySelector('#saveResults').hidden && getComputedStyle(document.querySelector('#saveResults')).display !== 'none'`), true);
        await evaluate(window, `document.querySelector('#executionSummaryButton').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#executionSummaryCard').classList.contains('hidden')`), true);
        assert.match(await evaluate(window, `document.querySelector('#executionSummaryTitle').textContent`), /(Serial|Thread pool|Partitioned) · \d+ workers?/);
        assert.ok(await evaluate(window, `document.querySelectorAll('#executionSummaryMetrics dt').length`) >= 8);
        assert.match(await evaluate(window, `document.querySelector('#executionSummaryMetrics').textContent`), /Partitioner.*Communication cut/);
        await evaluate(window, `document.querySelector('#closeExecutionSummary').click()`);
        assert.equal(await evaluate(window, `document.querySelector('[data-detail="nodes"]').classList.contains('active')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('showNodesDetails')`), true);
        const finalValue = await evaluate(window, `document.querySelector('.node-label-container dd').textContent`);
        assert.notEqual(finalValue, before);
        assert.ok(Number(await evaluate(window, `document.querySelector('#resultTimeline').max`)) > 0);
        assert.equal(await evaluate(window, `Number(document.querySelector('#resultTimeline').value)`), 1.5);
        assert.equal(await evaluate(window, `Number(document.querySelector('#resultTimeline').max)`), 1.5);
        assert.equal(await evaluate(window, `document.querySelector('#resultPlaybackRate').value`), '1');
        await evaluate(window, `(() => { const timeline = document.querySelector('#resultTimeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#resultCurrentTime').value`), '0 s');
        assert.notEqual(await evaluate(window, `document.querySelector('.node-label-container dd').textContent`), finalValue);
        await evaluate(window, `document.querySelector('#resultPlayPause').click()`);
        await waitFor(window, `Number(document.querySelector('#resultTimeline').value) > 0`, 'Result playback did not advance the timeline.', 3000);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        await waitFor(window, `document.querySelector('.nodeResultsPanel').classList.contains('hasResults')`, 'Selected-node result plot did not render.', 5000);
        assert.equal(await evaluate(window, `document.querySelector('[data-node-tab="results"]').classList.contains('active')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('resultModeLocked')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#addButton').disabled && document.querySelector('[data-tool="move"]').disabled && document.querySelector('[data-action="delete"]').disabled`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor [data-result-readonly]').hidden`), true);
        assert.ok(await evaluate(window, `document.querySelector('#nodeResultPlot').data.length`) > 0);
        assert.ok(await evaluate(window, `document.querySelector('#nodeResultPlot').layout.shapes.length`) > 0);
        assert.equal(await evaluate(window, `document.querySelector('#openResultsAnalysis')`), null);
        await waitFor(window, `Boolean(document.querySelector('.addonTool[data-addon-id="konjugate.resultPlotViewer"][data-command-id="openAnalysis"]:not([hidden])'))`, 'Manifest-declared add-on toolstrip command did not appear.');
        assert.equal(await evaluate(window, `document.querySelector('#addonToolstripSeparator').hidden`), false);
        await evaluate(window, `document.querySelector('.addonTool[data-addon-id="konjugate.resultPlotViewer"][data-command-id="openAnalysis"]').click()`);
        const analysisWindow = await (async () => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 5000) {
                const candidate = BrowserWindow.getAllWindows().find((item) => item !== window && !item.isDestroyed());
                if (candidate) return candidate;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error('Results Analysis add-on window did not open.');
        })();
        await waitFor(analysisWindow, `Boolean(document.querySelector('.konjugateAddonTitlebar'))`, 'Host titlebar was not added to the add-on window.');
        assert.equal(await evaluate(analysisWindow, `document.querySelector('.konjugateAddonIdentity b').textContent`), 'Results Analysis');
        assert.equal(await evaluate(analysisWindow, `document.querySelectorAll('.konjugateAddonWindowControls button').length`), 3);
        await waitFor(analysisWindow, `getComputedStyle(document.querySelector('.konjugateAddonTitlebar')).position === 'fixed'`, 'Host titlebar styles did not load.');
        await waitFor(analysisWindow, `document.querySelectorAll('.signalOption').length > 0 && document.querySelector('.plotWorkspace').classList.contains('hasSignals')`, 'Results Analysis did not load signals.', 5000);
        assert.equal(await evaluate(analysisWindow, `document.querySelector('.readOnlyBadge').textContent`), 'Completed');
        assert.equal(await evaluate(analysisWindow, `typeof require === 'undefined'`), true);
        assert.ok(await evaluate(analysisWindow, `document.querySelector('#analysisPlot').data.length`) > 0);
        await evaluate(analysisWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await waitFor(window, `document.querySelector('#resultCurrentTime').value === '0 s'`, 'Visualizer seek did not synchronize to the project window.');
        await evaluate(window, `document.querySelector('[data-node-tab="model"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').disabled`), true);
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeName'); input.value = 'Changed during results'; input.dispatchEvent(new Event('change', { bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); })()`);
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Battery module'))`), true);
        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        assert.match(await evaluate(window, `document.querySelector('#closeResultsMessage').textContent`), /save the project with simulation results.*removed from this session/i);
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        for (let attempt = 0; attempt < 100 && !analysisWindow.isDestroyed(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(analysisWindow.isDestroyed(), true);
        assert.equal(await evaluate(window, `document.querySelector('#resultTransport').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('[data-detail="nodes"]').classList.contains('active')`), false);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeName').disabled || document.querySelector('#nodeModelActions').hidden`), false);
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('resultModeLocked')`), false);
        assert.equal(await evaluate(window, `document.querySelector('#addonToolstripSeparator').hidden`), true);
    });

    await run('multi-selection copies, pastes and deletes a connected graph fragment transactionally', async () => {
        const before = await evaluate(window, `({
            nodes: [...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length,
            relationships: document.querySelectorAll('.modelStatus span')[1].textContent
        })`);
        await clickElement(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module'))`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await clickElement(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air'))`, ['shift']);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Real Shift-click did not add the second node.');
        // Give the CSS2DRenderer a frame to reposition the bundle label after the selection
        // change before reading its bounding rect for the click below — under SwiftShader
        // software rendering (used in headless/CI test runs) this can otherwise still be
        // mid-transition, sending the click past the label onto the canvas underneath.
        // SwiftShader frames have been observed stalling well past 250ms, so wait for it to
        // actually settle rather than a single fixed delay.
        await waitForStableRect(window,
            `(() => { const rect = document.querySelector('.bundleLabel')?.getBoundingClientRect(); return rect && JSON.stringify(rect); })()`,
            'The bundle label did not settle into a stable position.');
        await clickElement(window, `document.querySelector('.bundleLabel')`, ['shift']);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        const emptyPoint = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + 20), y: Math.round(bounds.top + 20) }; })()`);
        window.webContents.sendInputEvent({ type: 'mouseDown', ...emptyPoint, button: 'left', clickCount: 1, modifiers: ['shift'] });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...emptyPoint, button: 'left', clickCount: 1, modifiers: ['shift'] });
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await evaluate(window, `document.querySelector('#copySelection').disabled`), false);
        await evaluate(window, `document.querySelector('#copySelection').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#pasteSelection').disabled`), false);
        await evaluate(window, `document.querySelector('#pasteSelection').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Battery module copy')) && [...document.querySelectorAll('.objectLabel')].some((label) => label.textContent.includes('Enclosed air copy'))`, 'The copied graph fragment was not pasted.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length`), before.nodes + 2);
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), before.relationships);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === ${before.nodes}`, 'Deleting the pasted multi-selection did not hide every copied node.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === ${before.nodes + 2}`, 'Undo did not restore the pasted multi-selection.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === ${before.nodes}`, 'Undoing paste did not remove the copied graph fragment.');
    });

    await run('Cmd/Ctrl+V pastes a single copied node', async () => {
        // Regression test: same root cause as the multi-selection test above (modelClipboard.read()
        // in src/preload.mjs used to decode the clipboard buffer with a bare `bytes.toString('utf8')`,
        // but `bytes` crosses the IPC boundary as a plain Uint8Array rather than a Node Buffer, so
        // the 'utf8' argument was silently ignored and JSON.parse always threw), isolated to the
        // keyboard-shortcut path (Cmd/Ctrl+C / Cmd/Ctrl+V) and a single node rather than a group.
        // Fixed by wrapping the read in Buffer.from(bytes) before .toString('utf8').
        const visibleNodeCount = () => `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length`;
        const before = await evaluate(window, visibleNodeCount());
        // Excludes "... copy" labels: a soft-deleted "Battery module copy" from an earlier test
        // can still be present (hidden) in the DOM, and a plain .includes('Battery module')
        // would match it too.
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy')).click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 1`, 'Node selection did not register before the copy shortcut.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, ctrlKey: true, bubbles: true }))`);
        // Wait on the actual visible count rather than the "... copy" label text existing: a
        // stale, soft-deleted (hidden) copy from an earlier test would satisfy a text-only wait
        // immediately, before this test's own paste has actually landed.
        await waitFor(window, `${visibleNodeCount()} === ${before} + 1`, 'The Cmd/Ctrl+V shortcut did not paste the copied node.');
        assert.equal(await evaluate(window, visibleNodeCount()), before + 1);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `${visibleNodeCount()} === ${before}`, 'Undo did not remove the pasted node.');
    });

    await run('rectangle tool selects visible nodes without opening an inspector', async () => {
        await evaluate(window, `document.querySelector('[data-tool="rectangleSelect"]').click()`);
        // The preceding paste/undo tests leave the CSS2DRenderer mid-reposition (same cause as the
        // bundle-label wait in the multi-selection test above); under SwiftShader software rendering
        // this can still be settling when we read the label rects below, silently skewing the
        // computed drag rectangle. Wait for it to actually settle, like that test does.
        const labelRectsSelector = `[...document.querySelectorAll('.node-label-container')]
            .filter((label) => (label.textContent.includes('Battery module') || label.textContent.includes('Enclosed air')) && !label.textContent.includes('copy'))
            .map((label) => label.getBoundingClientRect())`;
        await waitForStableRect(window, `JSON.stringify(${labelRectsSelector})`, 'The node labels did not settle into a stable position.');
        const bounds = await evaluate(window, `(() => {
            // Excludes "... copy" labels: a soft-deleted "Battery module copy" from the preceding
            // paste-undo test can still be present (hidden) in the DOM, and getBoundingClientRect()
            // on a display:none element returns all zeros, which would wreck these bounds.
            const labels = [...document.querySelectorAll('.node-label-container')];
            const battery = labels.find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy')).getBoundingClientRect();
            const air = labels.find((label) => label.textContent.includes('Enclosed air') && !label.textContent.includes('copy')).getBoundingClientRect();
            return {
                start: { x: Math.round(Math.min(battery.left, air.left) - 220), y: Math.round(Math.min(battery.top, air.top) - 100) },
                end: { x: Math.round(Math.max(battery.right, air.right) + 20), y: Math.round(Math.max(battery.bottom, air.bottom) + 100) }
            };
        })()`);
        window.webContents.sendInputEvent({ type: 'mouseMove', ...bounds.start });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...bounds.start, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseMove', ...bounds.end });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...bounds.end, button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Rectangle selection did not select the two enclosed nodes.');
        const selected = await evaluate(window, `[...document.querySelectorAll('.node-label-container.selected')].map((label) => label.textContent)`);
        assert.ok(selected.some((label) => label.includes('Battery module')));
        assert.ok(selected.some((label) => label.includes('Enclosed air')));
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('[data-tool="rectangleSelect"]').classList.contains('active')`), true);
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
    });

    await run('selected nodes become a navigable undoable subsystem', async () => {
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await evaluate(window, `document.querySelector('#createSubsystem').disabled`), false);
        await evaluate(window, `document.querySelector('#createSubsystem').click()`);
        await waitFor(window, `document.querySelector('#subsystemDialog').open`, 'Subsystem dialog did not open.');
        await evaluate(window, `(() => { document.querySelector('#subsystemName').value = 'Thermal enclosure'; document.querySelector('#subsystemCreate').click(); })()`);
        await waitFor(window, `[...document.querySelectorAll('.subsystemLabel')].some((label) => label.textContent.includes('Thermal enclosure'))`, 'Subsystem proxy did not appear.');
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => /Battery module|Enclosed air/.test(label.textContent) && !label.textContent.includes('copy')).every((label) => getComputedStyle(label).display === 'none')`, 'Wrapped nodes remained visible outside the subsystem.');
        await clickElement(window, `[...document.querySelectorAll('.subsystemLabel')].find((label) => label.textContent.includes('Thermal enclosure'))`);
        await waitFor(window, `!document.querySelector('#subsystemBreadcrumb').hidden`, 'Subsystem navigation did not enter the subsystem.');
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => /Battery module|Enclosed air/.test(label.textContent) && !label.textContent.includes('copy')).every((label) => getComputedStyle(label).display !== 'none')`, 'Subsystem members did not appear after entering.');
        await evaluate(window, `document.querySelector('[data-subsystem-parent]').click()`);
        await waitFor(window, `document.querySelector('#subsystemBreadcrumb').hidden`, 'Subsystem navigation did not return to the model.');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `[...document.querySelectorAll('.node-label-container')].filter((label) => getComputedStyle(label).display !== 'none').length === 3`, 'Undo did not unwrap the subsystem.');
    });

    await run('icon-only toolstrip controls expose custom accessible tooltips', async () => {
        const controls = await evaluate(window, `[...document.querySelectorAll('.toolstrip .squareTool')].map((button) => ({
            label: button.getAttribute('aria-label'),
            tooltip: button.dataset.tooltip,
            nativeTitle: button.getAttribute('title')
        }))`);
        assert.ok(controls.length >= 5);
        assert.ok(controls.every((control) => control.label && control.tooltip && control.nativeTitle === null));
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.toolstrip .toolGroup')].map((group) => group.getAttribute('aria-label'))`), [
            'Create', 'History', 'Selection tools', 'Selection actions'
        ]);
    });

    await run('canvas help reflects left-click inspection and right-click action controls', async () => {
        const help = await evaluate(window, `document.querySelector('.canvasHelp').textContent.replace(/\\s+/g, ' ').trim()`);
        assert.match(help, /Left click inspect/);
        assert.match(help, /Right click actions/);
        assert.match(help, /Drag move or orbit/);
        assert.match(help, /Shift-drag pan/);
        assert.match(help, /Scroll or −\/\+ zoom/);
    });

    await run('left-click opens node and relationship inspectors', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorTitle').textContent`), 'Battery module');
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor .doneButton') === null`), true);
    });

    await run('live parameters expose labelled slider bounds with validation', async () => {
        const labels = await evaluate(window, `[...document.querySelectorAll('.editorParameterRow:first-child .parameterField > span')].map((label) => label.textContent)`);
        assert.deepEqual(labels.slice(0, 5), ['Name', 'Symbol', 'Initial value', 'Unit', 'Mode']);
        await evaluate(window, `(() => {
            const mode = document.querySelector('.editorParameterRow:first-child [data-field="mode"]');
            mode.value = 'live';
            mode.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `!document.querySelector('.editorParameterRow:first-child .parameterControlFields').hidden`), true);
        const controlLabels = await evaluate(window, `[...document.querySelectorAll('.editorParameterRow:first-child .parameterControlFields .parameterField > span')].map((label) => label.textContent)`);
        assert.deepEqual(controlLabels, ['Slider minimum', 'Slider maximum', 'Slider step']);
        await evaluate(window, `(() => {
            const minimum = document.querySelector('.editorParameterRow:first-child [data-control-field="minimum"]');
            minimum.value = '30';
            minimum.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.match(await evaluate(window, `document.querySelector('.editorParameterRow:first-child .parameterControlError').textContent`), /Minimum must be less than maximum/);
    });

    await run('equation editor switches between visual and LaTeX modes', async () => {
        await evaluate(window, `document.querySelector('[data-equation-mode="latex"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#editEdgeMathField').hidden && document.querySelector('#editEdgeEquation').hidden`), false);
        await evaluate(window, `document.querySelector('[data-equation-mode="visual"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#editEdgeMathField').hidden && document.querySelector('#editEdgeEquation').hidden`), true);
    });

    await run('relationship editor authors an inline C++ provider implementation', async () => {
        const kindSelect = `document.querySelector('#editEdgeImplementationKind')`;
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'cpp';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#editEdgeProviderSection'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeEquationHeading'), false);
        assert.equal(await isRenderedVisible(window, '#editEdgeMathField'), false);
        assert.match(await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`), /#include <konjugate\/relationshipProvider\.hpp>/);

        const source = 'int main() {}';
        await evaluate(window, `(() => {
            const textarea = document.querySelector('#editEdgeProviderSource');
            textarea.value = ${JSON.stringify(source)};
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`), source);

        const bindingCountBefore = await evaluate(window, `document.querySelectorAll('.providerBindingRow').length`);
        await evaluate(window, `document.querySelector('#editAddProviderBinding').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.providerBindingRow').length`), bindingCountBefore + 1);

        await evaluate(window, `(() => {
            const key = document.querySelector('.providerBindingRow:last-child [data-field="key"]');
            key.value = 'delta';
            key.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('.providerBindingRow:last-child [data-field="key"]').value`), 'delta');

        await evaluate(window, `(() => {
            const outputKey = document.querySelector('#editProviderOutputKey');
            outputKey.value = 'gradient';
            outputKey.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editProviderOutputKey').value`), 'gradient');

        await evaluate(window, `(() => {
            window.confirm = () => true;
            document.querySelector('#editInsertProviderTemplate').click();
        })()`);
        const regeneratedSource = await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`);
        assert.match(regeneratedSource, /ScalarPort\{"delta", "delta", ""\}/);
        assert.match(regeneratedSource, /ScalarPort\{"gradient", "gradient", ""\}/);

        // Switch back to Equation so the following equation-editor tests see their expected state.
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'equation';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#editEdgeEquationHeading'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeMathField'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeProviderSection'), false);
    });

    await run('provider editor window syntax-highlights, validates and applies C++ source', async () => {
        const kindSelect = `document.querySelector('#editEdgeImplementationKind')`;
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'cpp';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        const validCpp = await evaluate(window, `document.querySelector('#editEdgeProviderSource').value`);
        await evaluate(window, `document.querySelector('#editOpenProviderEditor').click()`);

        const startedAt = Date.now();
        let editorWindow = null;
        while (Date.now() - startedAt < 5000 && !editorWindow) {
            editorWindow = BrowserWindow.getAllWindows().find((candidate) => candidate !== window && candidate.getTitle().includes('Provider source'));
            if (!editorWindow) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(editorWindow, 'The provider editor window did not open.');
        await waitFor(editorWindow, `document.querySelector('.cm-editor') !== null`, 'CodeMirror did not mount in the provider editor window.');
        assert.equal(await evaluate(editorWindow, `document.querySelector('#editorKindLabel').textContent`), 'C++');

        // These checks wait on a real clang invocation (plus the linter's own debounce),
        // which is far more variable than a DOM/JS operation, so give it real headroom
        // rather than the default timeout tuned for in-process checks.
        const compileCheckTimeout = 20000;
        await waitFor(editorWindow, `document.querySelector('#editorStatus').classList.contains('valid')`,
            'The starter template was not reported valid by the C++ syntax check.', compileCheckTimeout);

        await evaluate(editorWindow, `(() => {
            const view = window.__providerEditorView;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'this is not valid c plus plus' } });
        })()`);
        await waitFor(editorWindow, `document.querySelector('#editorStatus').classList.contains('invalid')`,
            'Invalid C++ source was not flagged by the syntax check.', compileCheckTimeout);

        await evaluate(editorWindow, `(() => {
            const view = window.__providerEditorView;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(validCpp)} } });
        })()`);
        await waitFor(editorWindow, `document.querySelector('#editorStatus').classList.contains('valid')`,
            'Restoring valid C++ source did not clear the invalid status.', compileCheckTimeout);

        await evaluate(editorWindow, `document.querySelector('#applyButton').click()`);
        await waitFor(window, `document.querySelector('#editEdgeProviderSource').value === ${JSON.stringify(validCpp)}`,
            'Applying from the provider editor window did not update the relationship editor.');

        await evaluate(editorWindow, `document.querySelector('#close').click()`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(!BrowserWindow.getAllWindows().includes(editorWindow), 'The provider editor window did not close.');

        // Switch back to Equation so the following equation-editor tests see their expected state.
        await evaluate(window, `(() => {
            const select = ${kindSelect};
            select.value = 'equation';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#editEdgeEquationHeading'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeMathField'), true);
        assert.equal(await isRenderedVisible(window, '#editEdgeProviderSection'), false);
    });

    await run('C++ validation rejects unknown equation symbols while typing', async () => {
        const originalEquation = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue('randomCharacters');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && document.querySelector('#validationSummary').classList.contains('error')`, 'Unknown equation symbols were not rejected by the C++ validator.');
        assert.match(await evaluate(window, `document.querySelector('#validationIssues').textContent`), /randomCharacters/);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(originalEquation)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#validationSummary').classList.contains('error')`, 'Restoring the valid equation did not clear its validation error.');
    });

    await run('C++ validation accepts \\operatorname{} LaTeX for named functions like Max', async () => {
        // Regression test: an AI-generated equation once used \operatorname{Max}(...) --
        // standard LaTeX for an unfamiliar function name, and a reasonable thing for a model to
        // write even after being steered toward the shorter \max(...) form -- which the engine's
        // validator rejected as both an unsupported command and (since only the backslash+word
        // token was stripped, leaving "{Max}" behind) an unknown symbol.
        const originalEquation = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify('\\operatorname{Max}(1, 2)')});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'Engine validation did not run.');
        assert.equal(await evaluate(window, `document.querySelector('#validationSummary').classList.contains('error')`), false, '\\operatorname{Max}(...) should be accepted the same as \\max(...).');

        // A name \operatorname{} doesn't recognize must still be rejected clearly, so this isn't
        // just papering over the shape of the LaTeX regardless of what it actually names.
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify('\\operatorname{Bogus}(1, 2)')});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && document.querySelector('#validationSummary').classList.contains('error')`, 'An unrecognized \\operatorname{} name was not rejected.');
        assert.match(await evaluate(window, `document.querySelector('#validationIssues').textContent`), /Bogus/);

        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(originalEquation)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine' && !document.querySelector('#validationSummary').classList.contains('error')`, 'Restoring the valid equation did not clear its validation error.');
    });

    await run('Backspace edits MathLive without deleting the relationship', async () => {
        const equationBefore = await evaluate(window, `document.querySelector('#editEdgeMathField').value`);
        // A real pointer click (rather than a bare .focus() call) reliably restores keyboard
        // routing into MathLive's custom element, matching how an actual user would interact
        // with it after switching this relationship away from and back to Equation mode.
        await clickElement(window, `document.querySelector('#editEdgeMathField')`);
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.focus();
            field.executeCommand('selectAll');
        })()`);
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        await waitFor(window, `document.querySelector('#editEdgeMathField').value !== ${JSON.stringify(equationBefore)}`, 'Backspace did not edit the equation.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(equationBefore)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#edgeEditor [data-close-card]').click();
        })()`);
    });

    await run('node editor authors a source term with a programmable C++ implementation', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air')).click()`);
        await evaluate(window, `document.querySelector('#editAddSourceTerm').click()`);
        await evaluate(window, `[...document.querySelectorAll('.sourceTermOpen')].pop().click()`);
        assert.equal(await isRenderedVisible(window, '#sourceTermEditor'), true);

        await evaluate(window, `(() => {
            const select = document.querySelector('#termImplementationKind');
            select.value = 'cpp';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#termProviderSection'), true);
        assert.equal(await isRenderedVisible(window, '#termEquationHeading'), false);
        assert.match(await evaluate(window, `document.querySelector('#termProviderSource').value`), /#include <konjugate\/relationshipProvider\.hpp>/);

        await evaluate(window, `(() => {
            document.querySelector('#termAddProviderBinding').click();
            const key = document.querySelector('#termProviderBindings .providerBindingRow [data-field="key"]');
            key.value = 'temperature';
            key.dispatchEvent(new Event('change', { bubbles: true }));
            const outputKey = document.querySelector('#termProviderOutputKey');
            outputKey.value = 'heatRate';
            outputKey.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);

        await evaluate(window, `(() => {
            window.confirm = () => true;
            document.querySelector('#termInsertProviderTemplate').click();
        })()`);
        const regenerated = await evaluate(window, `document.querySelector('#termProviderSource').value`);
        assert.match(regenerated, /ScalarPort\{"temperature", "temperature", ""\}/);
        assert.match(regenerated, /ScalarPort\{"heatRate", "heatRate", ""\}/);

        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`,
            'The programmable source term did not reach native validation.');
        assert.doesNotMatch(await evaluate(window, `document.querySelector('#validationIssues')?.textContent ?? ''`), /provider|programmable/i);

        // Clean up: remove the source term so later tests see the original model state.
        await evaluate(window, `document.querySelector('[data-delete-source-term]').click()`);
        assert.equal(await isRenderedVisible(window, '#sourceTermEditor'), false);
        assert.equal(await isRenderedVisible(window, '#nodeEditor'), true);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
    });

    await run('node appearance changes and participates in undo', async () => {
        const reopenAppearanceTab = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-node-tab="appearance"]').click()`;
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), false);
        await evaluate(window, `document.querySelector('[data-node-tab="appearance"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), true);
        const originalColor = await evaluate(window, `document.querySelector('#editNodeColor').value`);

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `(() => { const field = document.querySelector('#editNodeShape'); field.value = 'sphere'; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'sphere');
            await evaluate(window, reopenAppearanceTab);
            assert.equal(await evaluate(window, `document.querySelector('#editNodeColor').value`), originalColor);
            await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
            await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open.');
            await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"]').click()`);
            await waitFor(window, `!document.querySelector('#shapeLibraryDetailContent').hidden && document.querySelector('#shapeLibraryDetailTitle').textContent === 'Spur Gear'`, 'The shape preview did not populate.');
            await evaluate(window, `document.querySelector('#shapeLibraryApply').click()`);
            await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
            await evaluate(window, reopenAppearanceTab);
            assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), '');
            assert.equal(await evaluate(window, `document.querySelector('#editNodeColor').value`), originalColor);
        });
        // Regression: switching the primitive shape (or applying a file/library shape) used to
        // build its appearance patch without a colour field, which wiped definition.color to
        // undefined outright (no fallback to the existing value). That failure doesn't reject
        // any of the assertions above -- it throws later, inside the click handler that reopens
        // the editor and reads definition.color.toString(16), and a synthetic element.click()
        // swallows an exception thrown inside its own listener rather than propagating it, so
        // only the console (captured here) actually catches it.
        assert.deepEqual(consoleMessages.filter((message) => /color|toString/i.test(message)), []);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, reopenAppearanceTab);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'box');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeColor').value`), originalColor);
    });

    await run('shape library searches, filters by domain and previews and applies a shape', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-node-tab="appearance"]').click()`);
        const statusBeforeSelect = await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`);
        await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open.');
        const shapeCount = await evaluate(window, `document.querySelectorAll('.shapeLibraryItem').length`);
        assert.ok(shapeCount > 0, 'Shape library did not list any shapes.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].map((button) => button.textContent)`),
            ['All', 'Mechanical', 'Structural', 'Electrical', 'Fluid']);
        assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryDetailEmpty').hidden`), false, 'The detail pane should start with nothing selected.');
        assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryDetailContent').hidden`), true);

        // Cards get a static thumbnail passively -- without clicking anything -- generated by a
        // single reused offscreen renderer and cached, distinct from the live rotating preview.
        await waitFor(window,
            `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"] img.examplesExplorerThumb')?.getAttribute('src')`,
            'The Spur Gear card did not get a thumbnail.');
        assert.ok((await evaluate(window,
            `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"] img.examplesExplorerThumb').src`)).startsWith('data:image/png'),
            'The thumbnail src was not a PNG data URL.');

        const searchMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = 'gear'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem b')].map((element) => element.textContent)`), ['Spur Gear']);
            assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryEmpty').hidden`), true);

            await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = 'no such shape'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            assert.equal(await evaluate(window, `document.querySelectorAll('.shapeLibraryItem').length`), 0);
            assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryEmpty').hidden`), false);

            await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].find((button) => button.textContent === 'Fluid').click()`);
        });
        // Regression: a thumbnail queued for a shape that then got filtered/searched away must
        // not throw trying to write into its now-detached card -- only the console (captured
        // here) would catch that, since it happens asynchronously well after these calls return.
        assert.deepEqual(searchMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);
        const fluidShapes = await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem')].map((item) => item.dataset.shapeId)`);
        assert.ok(fluidShapes.length > 0 && fluidShapes.every((id) => id.startsWith('fluid/')));

        // Switching back to "All" must show the Spur Gear thumbnail immediately from cache,
        // rather than a blank tile that gets refilled -- proving it wasn't regenerated.
        await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].find((button) => button.textContent === 'All').click()`);
        assert.ok((await evaluate(window,
            `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/spurGear"] img.examplesExplorerThumb')?.src`) ?? '').startsWith('data:image/png'),
            'The cached thumbnail was not shown immediately after re-filtering.');

        // Selecting a shape (a STEP file, exercising the occt-import-js path) previews it as a
        // live rotating 3D render rather than applying it immediately -- nothing on the node
        // should change until Apply is clicked explicitly.
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').classList.contains('selected')`), true);
        await waitFor(window, `!document.querySelector('#shapeLibraryDetailContent').hidden && document.querySelector('#shapeLibraryDetailTitle').textContent === 'L-Bracket'`, 'The shape preview did not populate.');
        assert.equal(await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`), statusBeforeSelect, 'Selecting a shape must not apply it yet.');

        // Switching the selection before the previous preview finishes loading (both requests
        // are in flight together here) must not leave a stale mesh/title from the shape that's
        // no longer selected -- this is the revision-guard in selectShapeLibraryPreview.
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="fluid/valveBody"]').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDetailTitle').textContent === 'Valve Body'`, 'Switching the selected shape did not update the preview.');

        // Apply a STEP-format shape (mechanical/lBracket) via the editor path.
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDetailTitle').textContent === 'L-Bracket'`, 'The shape preview did not populate.');
        await evaluate(window, `document.querySelector('#shapeLibraryApply').click()`);
        await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
        assert.equal(await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`), 'L-Bracket applied');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), '');

        // Apply an STL-format shape via the "Add node" builder path.
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await evaluate(window, `document.querySelector('#builderBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open from the node builder.');
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="fluid/valveBody"]').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDetailTitle').textContent === 'Valve Body'`, 'The shape preview did not populate.');
        await evaluate(window, `document.querySelector('#shapeLibraryApply').click()`);
        await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
        assert.equal(await evaluate(window, `document.querySelector('#geometryImportStatus').textContent`), 'Valve Body ready');
        assert.equal(await evaluate(window, `document.querySelector('#newNodeShape').value`), 'imported');
        await evaluate(window, `document.querySelector('#nodeBuilder [data-close-card]').click()`);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
    });

    await run('disabling a node greys it out, cascades to its edges, and is undoable', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleNodeEnabled').textContent`), 'Disable node');
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);

        await evaluate(window, `document.querySelector('#toggleNodeEnabled').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleNodeEnabled').textContent`), 'Enable node');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).closest('.node-label-container').classList.contains('disabled')`), true);

        // The edge cascades (renders as disabled) even though its own `enabled` field never
        // changed -- only the node's did. Its own toggle button must still read "Disable edge".
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Disable edge');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        // Undo restores the node (and, since nothing about the edge's own state changed, its
        // cascaded edges too) in one step.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleNodeEnabled').textContent`), 'Disable node');
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
    });

    await run('disabling an edge directly is independent of its endpoint nodes and is undoable', async () => {
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Disable edge');

        await evaluate(window, `document.querySelector('#toggleEdgeEnabled').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Enable edge');
        // Its endpoint nodes are untouched -- only the edge itself is disabled.
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#toggleEdgeEnabled').textContent`), 'Disable edge');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
    });

    await run('Connect to chooses a canvas endpoint and restores the builder', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Electrical losses')).click()`);
        await evaluate(window, `document.querySelector('#connectFromNode').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#endpointPickBanner').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`), true);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#endpointPickBanner').hidden`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`), true);
        assert.notEqual(await evaluate(window, `document.querySelector('#edgeTarget').value`), '');
        await evaluate(window, `document.querySelector('#edgeBuilder [data-close-card]').click()`);
    });

    // Excludes "... copy" matches: a soft-deleted "... copy" node from an earlier paste test can
    // still be present (hidden) in the DOM, and a plain .includes() would match it too, since
    // e.g. "Enclosed air copy" contains "Enclosed air" as a substring.
    const electricalLossesLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Electrical losses') && !label.textContent.includes('copy'))`;
    const batteryModuleLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy'))`;
    const enclosedAirLabel = `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Enclosed air') && !label.textContent.includes('copy'))`;
    const batteryBundleLabel = `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module') && !label.textContent.includes('copy'))`;

    await run('right-clicking a node opens a context menu with connect, disable and delete', async () => {
        await rightClickElement(window, electricalLossesLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'Right-clicking a node did not open its context menu.');
        assert.equal(await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').classList.contains('selected')`), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextConnect'), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextToggle'), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextDisableAll'), false);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextToggleLabel').textContent`), 'Disable node');

        // "Connect from here" reuses the editor's own endpoint-pick flow.
        await evaluate(window, `document.querySelector('#nodeContextConnect').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextMenu').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `!document.querySelector('#endpointPickBanner').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeSource').value`), await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').dataset.node`));
        await evaluate(window, `${batteryModuleLabel}.click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`), true);
        await evaluate(window, `document.querySelector('#edgeBuilder [data-close-card]').click()`);

        // Disable via the context menu toggle, then delete via the context menu, both undoable.
        await rightClickElement(window, electricalLossesLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'The node context menu did not reopen.');
        await evaluate(window, `document.querySelector('#nodeContextToggle').click()`);
        assert.equal(await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').classList.contains('disabled')`), true);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `${electricalLossesLabel}.closest('.node-label-container').classList.contains('disabled')`), false);

        const before = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        await rightClickElement(window, electricalLossesLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'The node context menu did not reopen for delete.');
        await evaluate(window, `document.querySelector('#nodeContextDelete').click()`);
        await waitFor(window, `document.querySelectorAll('.modelStatus span')[0].textContent !== '${before}'`, 'The context menu delete action did not remove the node.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `document.querySelectorAll('.modelStatus span')[0].textContent === '${before}'`, 'Undo did not restore the deleted node.');
    });

    await run('right-clicking a multi-selected node offers bulk disable/enable all', async () => {
        // Shift-clicks both nodes rather than a plain click + shift-click: a plain click also
        // opens the node editor, and this deep into the suite the editor panel can overlap
        // where the second label renders, making a real mouse click land on the panel instead.
        await clickElement(window, batteryModuleLabel, ['shift']);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await clickElement(window, enclosedAirLabel, ['shift']);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 2`, 'Shift-click did not build a two-node selection.');

        await rightClickElement(window, enclosedAirLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'Right-clicking a selected node did not open the context menu.');
        // Right-clicking a member of an existing multi-selection must not collapse it to one node.
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await isRenderedVisible(window, '#nodeContextConnect'), false);
        assert.equal(await isRenderedVisible(window, '#nodeContextToggle'), false);
        assert.equal(await isRenderedVisible(window, '#nodeContextDisableAll'), true);
        assert.equal(await isRenderedVisible(window, '#nodeContextEnableAll'), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextDeleteLabel').textContent`), 'Delete 2 nodes');

        await evaluate(window, `document.querySelector('#nodeContextDisableAll').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 2);

        // Chains straight into "enable all" while the selection is still intact -- undo/redo
        // deliberately clear the selection (see undo()/redo() in renderer.mjs), so exercising
        // that separately below rebuilds the selection first rather than assuming it survives.
        await rightClickElement(window, enclosedAirLabel);
        await waitFor(window, `!document.querySelector('#nodeContextMenu').classList.contains('hidden')`, 'The node context menu did not reopen for enable-all.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        await evaluate(window, `document.querySelector('#nodeContextEnableAll').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 0);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 2);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 0);
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 2);
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.disabled').length`), 0);
    });

    await run('right-clicking an edge label opens a context menu with disable and delete', async () => {
        await waitFor(window, `Boolean(${batteryBundleLabel})`, 'Battery module bundle label was not available.');
        await rightClickElement(window, batteryBundleLabel);
        await waitFor(window, `!document.querySelector('#edgeContextMenu').classList.contains('hidden')`, 'Right-clicking an edge did not open its context menu.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextToggleLabel').textContent`), 'Disable edge');

        await evaluate(window, `document.querySelector('#edgeContextToggle').click()`);
        assert.equal(await evaluate(window, `document.querySelector('.node-label-container.disabled') === null`), true);
        assert.match(await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).textContent`), /Disabled/);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.doesNotMatch(await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).textContent`), /Disabled/);
    });

    await run('select all via Ctrl/Cmd+A and via the canvas context menu', async () => {
        const totalNodes = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === ${totalNodes.match(/\d+/)[0]}`, 'Ctrl/Cmd+A did not select every node.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), Number(totalNodes.match(/\d+/)[0]));

        const emptyPoint = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + 20), y: Math.round(bounds.top + 20) }; })()`);
        window.webContents.sendInputEvent({ type: 'mouseMove', ...emptyPoint });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...emptyPoint, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...emptyPoint, button: 'left', clickCount: 1 });
        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 0`, 'Clicking blank canvas did not clear the select-all selection.');

        window.webContents.sendInputEvent({ type: 'mouseMove', ...emptyPoint });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...emptyPoint, button: 'right', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...emptyPoint, button: 'right', clickCount: 1 });
        await waitFor(window, `!document.querySelector('#addPalette').classList.contains('hidden')`, 'Right-clicking blank canvas did not open the add palette.');
        await evaluate(window, `document.querySelector('[data-action="select-all"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#addPalette').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), Number(totalNodes.match(/\d+/)[0]));
        window.webContents.sendInputEvent({ type: 'mouseMove', ...emptyPoint });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...emptyPoint, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...emptyPoint, button: 'left', clickCount: 1 });
    });

    await run('right-click-drag pans without opening a context menu, but a stationary right-click still does', async () => {
        const start = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + bounds.width * 0.7), y: Math.round(bounds.top + 40) }; })()`);
        const end = { x: start.x + 60, y: start.y + 40 };

        window.webContents.sendInputEvent({ type: 'mouseMove', ...start });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'right', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseMove', ...end });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...end, button: 'right', clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(await evaluate(window, `document.querySelector('#addPalette').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeContextMenu').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextMenu').classList.contains('hidden')`), true);

        window.webContents.sendInputEvent({ type: 'mouseMove', ...start });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'right', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...start, button: 'right', clickCount: 1 });
        await waitFor(window, `!document.querySelector('#addPalette').classList.contains('hidden')`, 'A stationary right-click did not open the add palette.');
        window.webContents.sendInputEvent({ type: 'mouseMove', ...start });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...start, button: 'left', clickCount: 1 });
    });

    await run('node creation closes its dialog and supports undo and redo', async () => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await evaluate(window, `(() => {
            document.querySelector('#newNodeName').value = 'Interaction node';
            const values = { name: 'Pressure', symbol: 'pressure', value: '101325', unit: 'Pa' };
            Object.entries(values).forEach(([field, value]) => { const input = document.querySelector('.stateVariableRow [data-field="' + field + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
            document.querySelector('#createNode').click();
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeBuilder').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '4 nodes');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '3 nodes');
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '4 nodes');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
    });

    await run('node builder creates a node with an inline Python source term', async () => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await evaluate(window, `(() => {
            document.querySelector('#newNodeName').value = 'Interaction source node';
            const values = { name: 'Level', symbol: 'level', value: '10', unit: 'm' };
            Object.entries(values).forEach(([field, value]) => { const input = document.querySelector('.stateVariableRow [data-field="' + field + '"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
            document.querySelector('#addSourceTerm').click();
        })()`);
        await evaluate(window, `(() => {
            const kind = document.querySelector('.sourceTermRow .sourceTermKind');
            kind.value = 'python';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('.sourceTermRow .sourceTermProviderFields').hidden`), false);
        assert.equal(await evaluate(window, `document.querySelector('.sourceTermRow .sourceExpression').hidden`), true);
        assert.match(await evaluate(window, `document.querySelector('.sourceTermRow .sourceTermProviderSource').value`), /from konjugate import/);

        await evaluate(window, `(() => {
            document.querySelector('.sourceTermRow .addSourceTermBinding').click();
            const key = document.querySelector('.sourceTermRow .providerBindingRow [data-field="key"]');
            key.value = 'level';
            document.querySelector('.sourceTermRow .sourceTermProviderOutputKey').value = 'levelRate';
            document.querySelector('#createNode').click();
        })()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '4 nodes');
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`,
            'The new node with a programmable source term did not reach native validation.');
        assert.doesNotMatch(await evaluate(window, `document.querySelector('#validationIssues')?.textContent ?? ''`), /provider|programmable/i);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '3 nodes');
    });

    await run('edge creation composes state references and supports undo', async () => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        await evaluate(window, `(() => {
            const choose = (selector, text) => { const field = document.querySelector(selector); field.value = [...field.options].find((option) => option.textContent === text).value; field.dispatchEvent(new Event('change', { bubbles: true })); };
            choose('#edgeSource', 'Electrical losses');
            choose('#edgeTarget', 'Enclosed air');
            document.querySelector('#newEdgeName').value = 'Interaction relationship';
            const field = document.querySelector('#edgeMathField');
            field.setValue('\\\\mathrm{sourceQDot}');
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#createEdge').click();
        })()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '4 relationships');
        assert.equal(await evaluate(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`), true);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    });

    await run('edge builder creates a new relationship with an inline Python provider', async () => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        await evaluate(window, `(() => {
            const choose = (selector, text) => { const field = document.querySelector(selector); field.value = [...field.options].find((option) => option.textContent === text).value; field.dispatchEvent(new Event('change', { bubbles: true })); };
            choose('#edgeSource', 'Electrical losses');
            choose('#edgeTarget', 'Enclosed air');
            document.querySelector('#newEdgeName').value = 'Interaction provider relationship';
            const kind = document.querySelector('#edgeImplementationKind');
            kind.value = 'python';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        assert.equal(await isRenderedVisible(window, '#edgeProviderSection'), true);
        assert.equal(await isRenderedVisible(window, '#edgeEquationHeading'), false);
        assert.match(await evaluate(window, `document.querySelector('#edgeProviderSource').value`), /from konjugate import/);
        await evaluate(window, `(() => {
            document.querySelector('#addProviderBinding').click();
            const key = document.querySelector('#providerBindingRows .providerBindingRow [data-field="key"]');
            key.value = 'sourceQDot';
            key.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#providerOutputKey').value = 'targetHeatGradient';
            window.confirm = () => true;
            document.querySelector('#insertProviderTemplate').click();
        })()`);
        const builderSource = await evaluate(window, `document.querySelector('#edgeProviderSource').value`);
        assert.match(builderSource, /ScalarPort\("sourceQDot", "sourceQDot", ""\)/);
        assert.match(builderSource, /ScalarPort\("targetHeatGradient", "targetHeatGradient", ""\)/);
        await evaluate(window, `document.querySelector('#createEdge').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '4 relationships');
        assert.equal(await evaluate(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`), true);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'The new provider relationship did not reach native validation.');
        // The edge builder leaves source/target stateId null for every new relationship
        // regardless of implementation kind, which the native validator separately flags
        // (a pre-existing gap unrelated to provider support); only assert that the new
        // implementation fields themselves did not produce a provider-specific diagnostic.
        assert.doesNotMatch(await evaluate(window, `document.querySelector('#validationIssues')?.textContent ?? ''`), /provider|programmable/i);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    });

    await run('clicking a relationship after replacing a deleted one selects the new edge', async () => {
        // Regression test: deleting a relationship only soft-deletes it (definition.deleted =
        // true, line/marker hidden via .visible = false) -- its mesh is never removed from
        // relationshipPickTargets, which is only ever cleared on a full project reload. A new
        // relationship created between the same two nodes renders at the same curve (same node
        // pair, default zero offset), so without a .visible filter, firstIntersection() could
        // resolve the tie to the invisible, deleted original instead of the new one. Fixed by
        // having firstIntersection() skip non-visible hits (Three.js's Raycaster does not check
        // .visible itself -- confirmed in node_modules/three/src/core/Raycaster.js).
        const createEdge = async (name) => {
            await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
            await evaluate(window, `(() => {
                const choose = (selector, text) => { const field = document.querySelector(selector); field.value = [...field.options].find((option) => option.textContent === text).value; field.dispatchEvent(new Event('change', { bubbles: true })); };
                choose('#edgeSource', 'Electrical losses');
                choose('#edgeTarget', 'Enclosed air');
                document.querySelector('#newEdgeName').value = ${JSON.stringify(name)};
                const field = document.querySelector('#edgeMathField');
                field.setValue('\\\\mathrm{sourceQDot}');
                field.dispatchEvent(new Event('input', { bubbles: true }));
                document.querySelector('#createEdge').click();
            })()`);
            assert.equal(await evaluate(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`), true);
        };

        await createEdge('First relationship');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '4 relationships');
        await evaluate(window, `document.querySelector('[data-action="delete"]').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');

        await createEdge('Second relationship');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '4 relationships');

        if (await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`)) {
            await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        }

        const point = await evaluate(window, `window.__relationshipScreenPoint('Second relationship')`);
        assert.ok(point, 'Could not locate the new relationship on screen.');
        window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Clicking the relationship did not open the edge editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeName').value`), 'Second relationship');

        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    });

    // Waypoint-handle dragging goes through the same dragControls instance as node dragging,
    // which is only enabled while currentTool === 'select' -- ensure that's actually the
    // active tool rather than assume it, since an earlier test in the suite may have left a
    // different tool (rotate/scale/rectangleSelect) selected. Shared by both waypoint tests
    // below since either could run with a leftover tool from whichever ran just before it.
    const selectWaypointTestTool = () => evaluate(window, `document.querySelector('[data-tool="select"]').click()`);

    const createWaypointTestEdge = async (name) => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        await evaluate(window, `(() => {
            const choose = (selector, text) => { const field = document.querySelector(selector); field.value = [...field.options].find((option) => option.textContent === text).value; field.dispatchEvent(new Event('change', { bubbles: true })); };
            choose('#edgeSource', 'Electrical losses');
            choose('#edgeTarget', 'Enclosed air');
            document.querySelector('#newEdgeName').value = ${JSON.stringify(name)};
            const field = document.querySelector('#edgeMathField');
            field.setValue('\\\\mathrm{sourceQDot}');
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#createEdge').click();
        })()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, `Edge builder did not close after creating ${name}.`);
        if (await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`)) {
            await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
        }
        assert.deepEqual(await evaluate(window, `window.__relationshipWaypoints(${JSON.stringify(name)})`), []);
    };

    const pressAndHold = async (point) => {
        window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
        window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    };

    const deleteWaypointTestEdge = async (name) => {
        const cleanedUp = await retryGesture(window, async () => {
            const cleanupPoint = await evaluate(window, `window.__relationshipScreenPoint(${JSON.stringify(name)})`);
            window.webContents.sendInputEvent({ type: 'mouseMove', ...cleanupPoint });
            window.webContents.sendInputEvent({ type: 'mouseDown', ...cleanupPoint, button: 'left', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseUp', ...cleanupPoint, button: 'left', clickCount: 1 });
        }, `!document.querySelector('#edgeEditor').classList.contains('hidden')`);
        assert.ok(cleanedUp, 'Clicking the edge did not reopen the edge editor for cleanup after 5 attempts.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeName').value`), name);
        await evaluate(window, `document.querySelector('[data-action="delete"]').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    };

    await run('pressing and holding an edge enters waypoint mode, and dragging a waypoint reroutes it with undo/redo', async () => {
        await selectWaypointTestTool();
        await createWaypointTestEdge('Waypoint drag test edge');

        // Pressing and holding (rather than a quick click) selects the edge -- which is what
        // already makes its waypoint handles visible -- without popping its editor card open
        // over the canvas. A quick click still opens the editor, unaffected (checked in the
        // sibling add/remove test below, which relies on quick clicks throughout).
        // t=0.75, not the curve's default 0.5 -- the relationship's own CSS2D bundle label
        // anchors at getPoint(0.5) (every edge gets one, even an unbundled "bundle of one"), so
        // a click there can land on the label's DOM element instead of the canvas beneath it.
        const held = await retryGesture(window, async () => {
            // A genuine real mouse movement during the artificial 600ms hold window (this test
            // runs in a real, visible window, not headless -- incidental cursor movement from
            // whoever's at the machine can inject a real pointermove that cancels the hold
            // timer, same as a real drag would) can leave a stray "quick click" open the editor
            // on a failed attempt. Close it defensively before each attempt so that residue
            // from a prior failed attempt can't cause the eventual successful one to be judged
            // against stale editor-visibility state.
            if (!await evaluate(window, `document.querySelector('#edgeEditor').classList.contains('hidden')`)) {
                await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);
            }
            const holdPoint = await evaluate(window, `window.__relationshipScreenPoint('Waypoint drag test edge', 0.75)`);
            await pressAndHold(holdPoint);
        }, `document.querySelector('#statusText').textContent === 'Editing waypoints · Waypoint drag test edge' && document.querySelector('#edgeEditor').classList.contains('hidden')`);
        assert.ok(held, 'Press-and-hold did not report entering waypoint mode without opening the edge editor after 5 attempts.');

        const added = await retryGesture(window, async () => {
            const linePoint = await evaluate(window, `window.__relationshipScreenPoint('Waypoint drag test edge', 0.75)`);
            window.webContents.sendInputEvent({ type: 'mouseMove', ...linePoint });
            window.webContents.sendInputEvent({ type: 'mouseDown', ...linePoint, button: 'right', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseUp', ...linePoint, button: 'right', clickCount: 1 });
        }, `!document.querySelector('#edgeContextMenu').classList.contains('hidden')`);
        assert.ok(added, 'Right-clicking the edge line did not open its context menu after 5 attempts.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextAddWaypoint').hidden`), false, 'Add-waypoint action was not offered for a click on the edge line.');
        await evaluate(window, `document.querySelector('#edgeContextAddWaypoint').click()`);

        const initialWaypoints = await evaluate(window, `window.__relationshipWaypoints('Waypoint drag test edge')`);
        assert.equal(initialWaypoints.length, 1, 'Right-clicking the edge line did not add a waypoint.');
        const initialWaypointJson = JSON.stringify(initialWaypoints[0]);
        // Adding the waypoint also hides this edge's bundle label (it would otherwise sit right
        // on top of the new handle, re-anchored to the curve's new midpoint) -- give the
        // renderer a moment to actually apply that display:none before synthesizing a drag,
        // rather than risk racing a hit-test against a still-composited previous frame.
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Drag the handle and confirm the underlying model's waypoint position actually moved
        // (not just the handle mesh) -- this is the same live-mutate-during-gesture idiom node
        // dragging already uses, so the model and the handle should never be out of sync mid-drag.
        // A short pause between each synthetic pointer event (rather than firing all four back
        // to back) matters: DragControls needs its own 'pointerdown' handler to actually run
        // (setting its internal _selected) before a 'pointermove' arrives, and a zero-delay
        // burst of sendInputEvent calls can reach Chromium's input queue faster than that JS
        // callback gets a turn to run. A short, fixed offset (not toward wherever's convenient)
        // keeps the dragged position clear of the endpoint nodes' own pick geometry -- landing
        // on or near a node would route later clicks to the node's context menu instead of the
        // waypoint's, since the contextmenu handler checks for a node hit first.
        const dragged = await retryGesture(window, async () => {
            const currentHandlePoint = await findCanvasPoint(window, await evaluate(window, `window.__waypointScreenPoint('Waypoint drag test edge', 0)`));
            if (!currentHandlePoint) return;
            const dragTo = { x: currentHandlePoint.x + 15, y: currentHandlePoint.y - 12 };
            const midDrag = { x: Math.round((currentHandlePoint.x + dragTo.x) / 2), y: Math.round((currentHandlePoint.y + dragTo.y) / 2) };
            window.webContents.sendInputEvent({ type: 'mouseMove', ...currentHandlePoint });
            window.webContents.sendInputEvent({ type: 'mouseDown', ...currentHandlePoint, button: 'left', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseMove', ...midDrag });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseMove', ...dragTo });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseUp', ...dragTo, button: 'left', clickCount: 1 });
        }, `JSON.stringify(window.__relationshipWaypoints('Waypoint drag test edge')[0]) !== ${JSON.stringify(initialWaypointJson)}`);
        assert.ok(dragged, 'Dragging the waypoint handle did not move it after 5 attempts.');
        const draggedWaypoint = (await evaluate(window, `window.__relationshipWaypoints('Waypoint drag test edge')`))[0];

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await waitFor(window, `JSON.stringify(window.__relationshipWaypoints('Waypoint drag test edge')[0]) === ${JSON.stringify(JSON.stringify(initialWaypoints[0]))}`, 'Undo did not revert the dragged waypoint.');
        await evaluate(window, `document.querySelector('#redoButton').click()`);
        await waitFor(window, `JSON.stringify(window.__relationshipWaypoints('Waypoint drag test edge')[0]) === ${JSON.stringify(JSON.stringify(draggedWaypoint))}`, 'Redo did not restore the dragged waypoint.');

        await deleteWaypointTestEdge('Waypoint drag test edge');
    });

    await run('right-click adds and removes an edge waypoint via its own context menus', async () => {
        await selectWaypointTestTool();
        await createWaypointTestEdge('Waypoint add-remove test edge');

        const added = await retryGesture(window, async () => {
            const linePoint = await evaluate(window, `window.__relationshipScreenPoint('Waypoint add-remove test edge', 0.75)`);
            window.webContents.sendInputEvent({ type: 'mouseMove', ...linePoint });
            window.webContents.sendInputEvent({ type: 'mouseDown', ...linePoint, button: 'right', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseUp', ...linePoint, button: 'right', clickCount: 1 });
        }, `!document.querySelector('#edgeContextMenu').classList.contains('hidden')`);
        assert.ok(added, 'Right-clicking the edge line did not open its context menu after 5 attempts.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextAddWaypoint').hidden`), false, 'Add-waypoint action was not offered for a click on the edge line.');
        await evaluate(window, `document.querySelector('#edgeContextAddWaypoint').click()`);
        await waitFor(window, `window.__relationshipWaypoints('Waypoint add-remove test edge').length === 1`, 'Right-clicking the edge line did not add a waypoint.');
        // See the drag test above for why this delay matters: the label hiding that keeps a
        // fresh handle clickable needs a moment to actually apply.
        await new Promise((resolve) => setTimeout(resolve, 300));

        const removed = await retryGesture(window, async () => {
            const handlePoint = await findCanvasPoint(window, await evaluate(window, `window.__waypointScreenPoint('Waypoint add-remove test edge', 0)`));
            if (!handlePoint) return;
            window.webContents.sendInputEvent({ type: 'mouseMove', ...handlePoint });
            window.webContents.sendInputEvent({ type: 'mouseDown', ...handlePoint, button: 'right', clickCount: 1 });
            await new Promise((resolve) => setTimeout(resolve, 60));
            window.webContents.sendInputEvent({ type: 'mouseUp', ...handlePoint, button: 'right', clickCount: 1 });
        }, `!document.querySelector('#waypointContextMenu').classList.contains('hidden')`);
        assert.ok(removed, 'Right-clicking the waypoint handle did not open its context menu after 5 attempts.');
        await evaluate(window, `document.querySelector('#waypointContextRemove').click()`);
        await waitFor(window, `window.__relationshipWaypoints('Waypoint add-remove test edge').length === 0`, 'Removing the waypoint did not clear it.');
        assert.equal(await evaluate(window, `window.__waypointScreenPoint('Waypoint add-remove test edge', 0)`), null, 'The waypoint handle was not removed from the scene once its waypoint was deleted.');

        await deleteWaypointTestEdge('Waypoint add-remove test edge');
    });

    await run('deleting a node hides connected relationships and undo restores them', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Electrical losses')).click(); document.querySelector('[data-action="delete"]').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '2 nodes');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '2 relationships');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), '3 nodes');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
    });

    await run('view cube changes the camera to a named view', async () => {
        await evaluate(window, `document.querySelector('[data-nav-view="top"]').click()`);
        await waitFor(window, `document.querySelector('[data-nav-view="top"]').classList.contains('active')`, 'Top camera view did not become active.', 2000);
    });

    await run('camera controls provide wheel-free zoom and model fitting', async () => {
        assert.equal(await evaluate(window, `document.querySelector('[data-nav-action="zoomIn"]').ariaLabel`), 'Zoom camera in');
        const before = Number(await evaluate(window, `document.querySelector('#viewCube').dataset.cameraDistance`));
        await evaluate(window, `document.querySelector('[data-nav-action="zoomIn"]').click()`);
        await waitFor(window, `Number(document.querySelector('#viewCube').dataset.cameraDistance) < ${before}`, 'Camera zoom-in control did not reduce its target distance.');
        await evaluate(window, `document.querySelector('[data-nav-action="fit"]').click()`);
        assert.ok(Number(await evaluate(window, `document.querySelector('#viewCube').dataset.cameraDistance`)) > 0);
    });

    await run('camera controls provide button and keyboard panning', async () => {
        const before = await evaluate(window, `document.querySelector('#viewCube').dataset.cameraTarget`);
        await evaluate(window, `document.querySelector('[data-nav-pan="left"]').click()`);
        await waitFor(window, `document.querySelector('#viewCube').dataset.cameraTarget !== ${JSON.stringify(before)}`, 'Pan control did not move the camera target.');
        assert.equal(await evaluate(window, `document.querySelectorAll('[data-nav-pan]').length`), 4);
        assert.equal(await evaluate(window, `document.querySelector('.webglSurface').getAttribute('aria-label')`), '3D model canvas');
    });

    await run('the 2D lock toggle turns left-drag into pan and disables isometric corners', async () => {
        const point = await evaluate(window, `(() => { const bounds = document.querySelector('#webglContainer').getBoundingClientRect(); return { x: Math.round(bounds.left + 20), y: Math.round(bounds.top + 20) }; })()`);
        const dragTo = { x: point.x + 50, y: point.y + 30 };
        const cameraTargetExpression = `document.querySelector('#viewCube').dataset.cameraTarget`;
        const drag = () => {
            window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
            window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
            window.webContents.sendInputEvent({ type: 'mouseMove', ...dragTo });
            window.webContents.sendInputEvent({ type: 'mouseUp', ...dragTo, button: 'left', clickCount: 1 });
        };
        const readTarget = async () => (await evaluate(window, cameraTargetExpression)).split(',').map(Number);
        // OrbitControls' damping (dampingFactor 0.07) eases a pan's momentum into the target
        // exponentially and never reaches an exact fixed point to poll for -- unlike the
        // deterministic 650ms snap animation below, comparing "close enough" after a generous
        // settle is the reliable check here, not exact equality.
        const targetsClose = (a, b, epsilon = 0.02) => a.every((value, index) => Math.abs(value - b[index]) < epsilon);

        assert.equal(await evaluate(window, `document.querySelector('#lock2DButton').ariaPressed`), 'false');
        await evaluate(window, `document.querySelector('#lock2DButton').click()`);
        await waitFor(window, `document.querySelector('#lock2DButton').ariaPressed === 'true'`, '2D lock button did not report itself pressed.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.cubeCorner')].every((corner) => corner.disabled)`), true, 'Isometric corner buttons should be disabled while locked.');
        // Engaging the lock snaps to the nearest orthogonal view via the existing 650ms animated
        // camera transition, which sets orbitControls.target once and then only lerps
        // camera.position -- genuinely stable to poll for, unlike a damped pan/rotate.
        await waitForStableRect(window, cameraTargetExpression, '2D lock camera snap did not settle.');

        const targetBeforeLockedDrag = await readTarget();
        drag();
        await waitFor(window, `${cameraTargetExpression} !== ${JSON.stringify(targetBeforeLockedDrag.map((v) => v.toFixed(4)).join(','))}`, 'A left-drag while 2D-locked did not pan the camera.');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.ok(!targetsClose(targetBeforeLockedDrag, await readTarget()), 'A left-drag while 2D-locked did not pan the camera by a meaningful amount.');

        await evaluate(window, `document.querySelector('#lock2DButton').click()`);
        await waitFor(window, `document.querySelector('#lock2DButton').ariaPressed === 'false'`, '2D lock button did not report itself unpressed.');
        assert.equal(await evaluate(window, `[...document.querySelectorAll('.cubeCorner')].every((corner) => !corner.disabled)`), true, 'Isometric corner buttons should re-enable once unlocked.');

        const targetBeforeUnlockedDrag = await readTarget();
        drag();
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.ok(targetsClose(targetBeforeUnlockedDrag, await readTarget()), 'An unlocked left-drag should rotate around a fixed target, not pan it.');
    });

    await run('encrypted-save password feedback updates continuously', async () => {
        await evaluate(window, `document.querySelector('#saveEncryptedButton').click()`);
        await waitFor(window, `document.querySelector('#passwordDialog').open`, 'Password dialog did not open.');
        await evaluate(window, `(() => {
            const password = document.querySelector('#projectPassword');
            password.value = 'short'; password.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#passwordSubmit').disabled`), true);
        await evaluate(window, `(() => {
            const password = document.querySelector('#projectPassword');
            const confirmation = document.querySelector('#confirmProjectPassword');
            password.value = 'longEnoughPassword'; confirmation.value = 'longEnoughPassword';
            password.dispatchEvent(new Event('input', { bubbles: true })); confirmation.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#passwordSubmit').disabled`), false);
        await evaluate(window, `document.querySelector('#passwordCancel').click()`);
    });

    await run('project title editing applies camel case filenames', async () => {
        await evaluate(window, `(() => { document.querySelector('.documentTitle').click(); const input = document.querySelector('.documentTitleInput'); input.value = 'My Test Model'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('.documentTitle').textContent`), 'myTestModel');
    });

    await run('interface zoom controls increase and reset application scale', async () => {
        const before = await evaluate(window, `window.uiZoom.get()`);
        await evaluate(window, `document.querySelector('#zoomInButton').click()`);
        assert.ok(await evaluate(window, `window.uiZoom.get()`) > before);
        await evaluate(window, `window.uiZoom.reset()`);
        assert.equal(Math.round((await evaluate(window, `window.uiZoom.get()`)) * 10) / 10, 1);
    });

    await run('component library places node templates and connects them with an auto-bound edge template', async () => {
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('.componentLibrarySection h3')].some((h) => h.textContent === 'Thermal')`), 'Templates were not sectioned by domain when idle.');

        // Multi-select domain chips: filtering to "Mechanical" alone should hide the thermal-only
        // edge template but keep a mechanical one, and collapse from sectioned to a flat filtered list.
        await evaluate(window, `[...document.querySelectorAll('#componentLibraryDomainChips button')].find((b) => b.textContent === 'Mechanical').click()`);
        assert.equal(await evaluate(window, `document.querySelector('[data-template-id="conduction"]')`), null);
        assert.notEqual(await evaluate(window, `document.querySelector('[data-template-id="rotationalDrive"]')`), null);
        await evaluate(window, `[...document.querySelectorAll('#componentLibraryDomainChips button')].find((b) => b.textContent === 'Mechanical').click()`);

        const nodesBefore = await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`);
        const relationshipsBefore = await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`);

        // Two instances of the same node template, so the edge template below has a guaranteed
        // exact-symbol match on both ends without depending on the bundled example's own state names.
        await evaluate(window, `document.querySelector('[data-template-id="thermalMass"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass')).length === 1`, 'The first thermal mass node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="thermalMass"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass')).length === 2`, 'The second thermal mass node template was not placed.');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `!document.querySelector('#componentLibraryPanel').hidden`), true, 'The library panel closed itself after placing a node.');

        await evaluate(window, `document.querySelector('[data-template-id="conduction"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the edge template did not arm endpoint picking.');
        assert.match(await evaluate(window, `document.querySelector('#componentLibraryHint').textContent`), /Conduction/);
        assert.equal(await evaluate(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`), true, 'The edge builder should stay out of the way during the chained endpoint pick.');

        // Endpoint picking is wired to the CSS2D label's own click listener (not 3D raycasting),
        // so a plain .click() reaches it directly -- the same approach every other test in this
        // file already uses for .objectLabel, and it sidesteps CSS2DRenderer position/timing
        // entirely rather than needing real screen coordinates.
        const clickThermalMass = async (index) => {
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass'))[${index}]?.click()`);
        };

        await clickThermalMass(0);
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain from the source to the target endpoint after the first click.');
        await clickThermalMass(1);
        await waitFor(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'The edge builder did not reappear once both endpoints were picked.');
        assert.equal(await evaluate(window, `document.querySelector('#componentLibraryHint').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#newEdgeName').value`), 'Conduction');
        assert.equal(await evaluate(window, `document.querySelector('#edgeParameterRows .parameterRow [data-field="symbol"]').value`), 'conductance');
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true, 'The name-matched ports did not auto-bind to a valid equation.');
        // Regression check: the builder's own default output (target's first state) is not
        // reliable across a chained two-endpoint pick -- see the explicit `output` field on every
        // bundled edge template -- so this specifically verifies the override actually lands on
        // target.temperature rather than getting stuck on an implicit source-side selection.
        assert.equal(await evaluate(window, `document.querySelector('#edgeEquationOutput').selectedOptions[0].textContent`), 'target.temperature');

        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the templated edge did not close the builder.');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);
        // Conduction is bidirectional -- confirms the post-creation setRelationshipDirectionality
        // hook actually ran, not just that some edge got created. Opens the edge editor (same
        // bundle-label click precedent other tests in this file use) to read it back the same
        // way a real user would see it, rather than reaching into renderer module state. The
        // bundle label's header shows the connected node names ("Thermal mass ↔ Thermal mass"),
        // not the edge's own title -- clicking anywhere on a single-relationship bundle (not just
        // a specific row) opens that one relationship directly.
        await waitFor(window, `[...document.querySelectorAll('.bundleLabel')].some((l) => l.textContent.includes('Thermal mass'))`, 'The relationship bundle label for the new Conduction edge did not appear.');
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((l) => l.textContent.includes('Thermal mass'))?.click()`);
        await waitFor(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`, 'Clicking the new Conduction relationship did not open the edge editor.');
        assert.equal(await evaluate(window, `document.querySelector('#editEdgeDirectionality').value`), 'bidirectional', 'Conduction was not created as a bidirectional edge.');
        await evaluate(window, `document.querySelector('#edgeEditor [data-close-card]').click()`);

        // Undo the edge and both placed nodes so this scenario leaves the baseline model unchanged
        // before the next one starts.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Second scenario: a node template with a self-referencing source term (Rotational link),
        // and an edge template with an explicit non-default output (Rotational drive updates
        // angularVelocity, not the target's declared-first state, angle) -- covers the two schema
        // additions the thermal scenario above doesn't exercise.
        await evaluate(window, `document.querySelector('[data-template-id="motor"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Motor'))`, 'The motor node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="rotationalLink"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Rotational link'))`, 'The rotational link node template was not placed.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Rotational link'))?.click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The placed rotational link node did not open its editor.');
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorSourceTerms .sourceTermPreview')?.textContent`), 'Updates angle', "The template's self-referencing source term was not applied to the placed node.");
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        const clickLabelContaining = async (text) => {
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes(${JSON.stringify(text)}))?.click()`);
        };

        await evaluate(window, `document.querySelector('[data-template-id="rotationalDrive"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the rotational drive edge template did not arm endpoint picking.');
        await clickLabelContaining('Motor');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for rotational drive.');
        await clickLabelContaining('Rotational link');
        await waitFor(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'The edge builder did not reappear once both endpoints were picked for rotational drive.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeEquationOutput').selectedOptions[0].textContent`),
            'target.angularVelocity', "The explicit output override did not select angularVelocity over the target's default first state, angle.");
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true);

        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the rotational drive edge did not close the builder.');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Undo the edge and both placed nodes so this scenario leaves the baseline model unchanged
        // before the next one starts.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Third scenario: a cross-domain node (Motor, tagged both electrical and mechanical) and
        // two edge templates whose ports declare more than one expected symbol on the same side
        // (target: current AND angularVelocity) -- covers the array-valued ports the scenarios
        // above only exercise with a single symbol per role.
        //
        // "Motor" was also used (and undone) in the second scenario -- a soft-deleted node's label
        // stays in the DOM, just hidden, so counting/selecting by text alone here could pick up
        // that stale one. visibleLabelsWith() filters on the CSS2DObject's own root element
        // (.node-label-container, what CSS2DRenderer actually toggles display:none on), matching
        // the same distinction the multi-selection and Cmd/Ctrl+V paste tests above are careful
        // about for the same reason.
        const visibleLabelsWith = (text) => `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes(${JSON.stringify(text)}) && getComputedStyle(l.closest('.node-label-container')).display !== 'none')`;
        await evaluate(window, `document.querySelector('[data-template-id="motor"]').click()`);
        await waitFor(window, `${visibleLabelsWith('Motor')}.length === 1`, 'The motor node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="voltageSource"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Voltage source'))`, 'The voltage source node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="torqueLoad"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].some((l) => l.textContent.includes('Torque load'))`, 'The torque load node template was not placed.');
        assert.equal(await evaluate(window, `Number.parseInt(document.querySelectorAll('.modelStatus span')[0].textContent, 10)`),
            Number.parseInt(nodesBefore, 10) + 3, 'Placing the three node templates did not add exactly three nodes.');

        await evaluate(window, `document.querySelector('[data-template-id="armatureDynamics"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the armature dynamics edge template did not arm endpoint picking.');
        assert.match(await evaluate(window, `document.querySelector('#componentLibraryHint').textContent`),
            /"current"\/"angularVelocity"/, 'The hint did not list both target port symbols for a multi-symbol port.');
        await clickLabelContaining('Voltage source');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for armature dynamics.');
        await evaluate(window, `${visibleLabelsWith('Motor')}[0]?.click()`);
        await waitFor(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'The edge builder did not reappear once both endpoints were picked for armature dynamics.');
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true,
            'A latex expression referencing two states on the same side did not auto-bind to a valid equation.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeEquationOutput').selectedOptions[0].textContent`), 'target.current');
        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the armature dynamics edge did not close the builder.');
        assert.equal(await evaluate(window, `Number.parseInt(document.querySelectorAll('.modelStatus span')[0].textContent, 10)`),
            Number.parseInt(nodesBefore, 10) + 3, 'Creating the armature dynamics edge unexpectedly changed the node count.');

        await evaluate(window, `document.querySelector('[data-template-id="shaftDynamics"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the shaft dynamics edge template did not arm endpoint picking.');
        await clickLabelContaining('Torque load');
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for shaft dynamics.');
        await evaluate(window, `${visibleLabelsWith('Motor')}[0]?.click()`);
        await waitFor(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'The edge builder did not reappear once both endpoints were picked for shaft dynamics.');
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEquationOutput').selectedOptions[0].textContent`),
            'target.angularVelocity', 'Shaft dynamics did not override the default output to angularVelocity.');
        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the shaft dynamics edge did not close the builder.');

        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#componentLibraryPanel').hidden`), true);

        for (let undo = 0; undo < 5; undo += 1) await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);
    });

    await run('Pose Visualizer add-on auto-detects and renders a 6-DOF free body node', async () => {
        const idsBeforeBodies = new Set(await evaluate(window, `window.__debugTransform.allNodeIds()`));
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Free body')).length === 1`, 'The first free body node template was not placed.');
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Free body')).length === 2`, 'The second free body node template was not placed.');
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);

        // Give the first free body a known editor rotation/scale (must happen before the run
        // below locks the transform tools in result mode) so the add-on's "Editor shapes,
        // colors & transforms" toggle has a real, non-identity transform to verify downstream.
        const bodyIds = (await evaluate(window, `window.__debugTransform.allNodeIds()`)).filter((id) => !idsBeforeBodies.has(id));
        assert.equal(bodyIds.length, 2, 'Expected exactly two new free body nodes.');
        const [firstBodyId] = bodyIds;
        const selectFirstBody = `document.querySelector('.node-label-container[data-node="${firstBodyId}"] .objectLabel').click()`;
        await evaluate(window, selectFirstBody);
        await evaluate(window, `document.querySelector('[data-tool="rotate"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(0.4, 0, 0)`);
        await evaluate(window, selectFirstBody);
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(2, 1, 1)`);
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);

        // A manual edge between the two free bodies (rather than a component-library template,
        // none of which connect two freeBody nodes) so the add-on's edge-line/label feature has
        // a real connection to render -- the equation's content is irrelevant here, only that
        // sourceNodeId/targetNodeId land on two detected 6-DOF bodies.
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        await evaluate(window, `(() => {
            const options = (selector) => [...document.querySelector(selector).options].filter((option) => option.textContent === 'Free body');
            const source = document.querySelector('#edgeSource');
            source.value = options('#edgeSource')[0].value;
            source.dispatchEvent(new Event('change', { bubbles: true }));
            const target = document.querySelector('#edgeTarget');
            target.value = options('#edgeTarget')[1].value;
            target.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('#newEdgeName').value = 'Pose link';
            const field = document.querySelector('#edgeMathField');
            field.setValue('\\\\mathrm{sourceX}');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true);
        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the Pose link edge did not close the builder.');

        await evaluate(window, `document.querySelector('#runButton').click()`);
        await evaluate(window, `(() => { document.querySelector('#runTargetTime').value = '1'; document.querySelector('#startRun').click(); })()`);
        await waitFor(window, `document.querySelector('.resultMode b').textContent === 'Results'`, 'Offline run did not complete.', 15000);

        await waitFor(window, `Boolean(document.querySelector('.addonTool[data-addon-id="konjugate.poseVisualizer"][data-command-id="openPoseVisualizer"]:not([hidden])'))`, 'Pose Visualizer toolstrip command did not appear.');
        const windowIdsBeforeOpen = new Set(BrowserWindow.getAllWindows().map((item) => item.id));
        await evaluate(window, `document.querySelector('.addonTool[data-addon-id="konjugate.poseVisualizer"][data-command-id="openPoseVisualizer"]').click()`);
        const poseWindow = await (async () => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 5000) {
                const candidate = BrowserWindow.getAllWindows().find((item) => !windowIdsBeforeOpen.has(item.id) && !item.isDestroyed());
                if (candidate) return candidate;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            throw new Error('Pose Visualizer add-on window did not open.');
        })();

        const consoleMessages = await captureConsoleMessages(poseWindow, async () => {
            await waitFor(poseWindow, `Boolean(document.querySelector('.konjugateAddonTitlebar'))`, 'Host titlebar was not added to the Pose Visualizer window.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('.konjugateAddonIdentity b').textContent`), 'Pose Visualizer');
            await waitFor(poseWindow, `getComputedStyle(document.querySelector('.konjugateAddonTitlebar')).position === 'fixed'`, 'Host titlebar styles did not load.');
            await waitFor(poseWindow, `document.querySelectorAll('.bodyOption').length === 2`, 'Pose Visualizer did not detect both free body nodes.');
            assert.match(await evaluate(poseWindow, `document.querySelector('.bodyOption b').textContent`), /Free body/);
            assert.equal(await evaluate(poseWindow, `document.querySelector('.sceneWorkspace').classList.contains('hasBodies')`), true);
            assert.ok(await evaluate(poseWindow, `document.querySelector('#scene').clientWidth`) > 0);
            assert.equal(await evaluate(poseWindow, `typeof require === 'undefined'`), true);

            assert.equal(await evaluate(poseWindow, `document.querySelector('#edgeLabels').children.length`), 0);
            await evaluate(poseWindow, `document.querySelector('#showConnections').click()`);
            await waitFor(poseWindow, `document.querySelector('#edgeLabels').children.length === 1`, 'Enabling connections did not draw the edge line/label.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('.edgeLabel').textContent`), 'Pose link');
            await evaluate(poseWindow, `document.querySelector('#showConnections').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#edgeLabels').children.length`), 0);

            await evaluate(poseWindow, `document.querySelector('#useEditorShapes').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#useEditorShapes').checked`), true);
            const editorShapeTransform = await evaluate(poseWindow, `window.__debugPoseVisualizer.shapeTransform(${firstBodyId})`);
            assert.ok(editorShapeTransform, 'Pose Visualizer did not build a shape sub-group for the rotated/scaled body.');
            assert.deepEqual(editorShapeTransform.rotation.map((v) => Math.round(v * 100) / 100), [0.4, 0, 0]);
            assert.deepEqual(editorShapeTransform.scale, [2, 1, 1]);
            await evaluate(poseWindow, `document.querySelector('#useEditorShapes').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#useEditorShapes').checked`), false);
            const defaultShapeTransform = await evaluate(poseWindow, `window.__debugPoseVisualizer.shapeTransform(${firstBodyId})`);
            assert.deepEqual(defaultShapeTransform, { rotation: [0, 0, 0], scale: [1, 1, 1] });

            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = String(Number(timeline.max) / 2); timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await waitFor(window, `document.querySelector('#resultCurrentTime').value !== '0 s'`, 'Visualizer seek did not synchronize to the project window.');

            await evaluate(poseWindow, `document.querySelector('.bodyOption input').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('.bodyOption input').checked`), false);

            await waitFor(poseWindow, `document.querySelector('#runLifecycle').textContent === 'Completed'`, 'Pose Visualizer did not report the run as completed.');
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').disabled`), false);
            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await waitFor(window, `document.querySelector('#resultCurrentTime').value === '0 s'`, 'Resetting the add-on timeline to zero did not synchronize.');
            await evaluate(poseWindow, `document.querySelector('#playPause').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').textContent`), '❚❚');
            await waitFor(poseWindow, `document.querySelector('#playPause').textContent === '▶'`, 'Add-on-driven playback did not reach the end and stop.', 5000);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#timeline').value`), await evaluate(poseWindow, `document.querySelector('#timeline').max`));
            await waitFor(window, `document.querySelector('#resultCurrentTime').value === '1 s'`, 'Main window did not sync to the end of add-on-driven playback.');

            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            await evaluate(poseWindow, `document.querySelector('#playPause').click()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').textContent`), '❚❚');
            await evaluate(poseWindow, `(() => { const timeline = document.querySelector('#timeline'); timeline.value = '0.5'; timeline.dispatchEvent(new Event('input', { bubbles: true })); })()`);
            assert.equal(await evaluate(poseWindow, `document.querySelector('#playPause').textContent`), '▶', 'Manually scrubbing the timeline did not stop playback.');
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);

        poseWindow.close();
        for (let attempt = 0; attempt < 100 && !poseWindow.isDestroyed(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(poseWindow.isDestroyed(), true);

        await evaluate(window, `document.querySelector('#closeResults').click()`);
        await waitFor(window, `document.querySelector('#closeResultsDialog').open`, 'Closing results did not request confirmation.');
        await evaluate(window, `document.querySelector('#confirmCloseResults').click()`);
        await waitFor(window, `document.querySelector('#addButton') && !document.querySelector('#addButton').disabled`, 'Model editing did not re-enable after closing results.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Free body'))?.click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Free body'))?.click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    });

    await run('importing a node shape file also saves it into the user shape library', async () => {
        // Deliberately operates on whatever node is already on the canvas at this point in the
        // suite, rather than loading a fresh example -- by now the document is dirty from many
        // earlier tests, and loading a new example would raise a native "Discard changes?"
        // dialog that executeJavaScript can't click. The specific project content is irrelevant
        // to what's under test here (the upload-to-library wiring), so any node will do.
        await waitFor(window, `document.querySelectorAll('.objectLabel').length > 0`, 'No node available to select for the upload test.');
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'Node editor did not open.');
        await evaluate(window, `document.querySelector('[data-node-tab="appearance"]').click()`);
        await waitFor(window, `!document.querySelector('[data-node-panel="appearance"]').hidden`, 'Appearance tab did not open.');

        const stlContent = 'solid uploadTest\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid uploadTest\n';
        await evaluate(window, `(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([${JSON.stringify(stlContent)}], 'uploadTest.stl', { type: 'model/stl' }));
            const input = document.querySelector('#editNodeGeometryFile');
            input.files = dataTransfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(window, `document.querySelector('#editGeometryStatus').textContent.includes('saved to shape library')`, 'Upload did not report being saved to the shape library.');

        const shapes = await evaluate(window, `window.shapeLibrary.list()`);
        const uploaded = shapes.find((shape) => shape.domain === 'userUploaded' && shape.name === 'uploadTest');
        assert.ok(uploaded, `Expected an uploaded shape library entry, got: ${JSON.stringify(shapes.map((s) => s.id))}`);

        await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library dialog did not open.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].some((b) => b.textContent === 'User uploaded')`), 'No "User uploaded" domain chip appeared.');
        assert.ok(await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem b')].some((b) => b.textContent === 'uploadTest')`), 'Uploaded shape did not appear in the library grid.');
        await evaluate(window, `document.querySelector('#shapeLibraryCancel').click()`);
    });

    await run('rotate and scale tools transform a node with undo/redo and persist through copy/paste', async () => {
        await waitFor(window, `document.querySelectorAll('.objectLabel').length > 0`, 'No node available to select.');
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        const nodeId = await evaluate(window, `window.__debugTransform.selectedId()`);
        assert.ok(nodeId, 'No node was selected.');

        // --- Rotate ---
        await evaluate(window, `document.querySelector('[data-tool="rotate"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.mode()`), 'rotate');
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), nodeId);
        await evaluate(window, `window.__debugTransform.simulateDragTo(0.3, 0.5, 0.7)`);
        let rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation, [0, 0, 0]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);

        // --- Scale ---
        // undo()/redo() unconditionally clearSelection() before replaying (renderer.mjs) -- an
        // existing, intentional app behavior, not specific to rotate/scale -- so the node needs
        // reselecting here regardless of which tool is active.
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.mode()`), 'scale');
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), nodeId);
        await evaluate(window, `window.__debugTransform.simulateDragTo(2, 1.5, 3)`);
        let scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [2, 1.5, 3]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [1, 1, 1]);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [2, 1.5, 3]);

        // --- Appearance tab: precise rotation/scale number inputs ---
        // The scale redo just above clears selection/closes the editor (same undo()/redo()
        // clearSelection() behavior noted earlier), so the node needs reselecting before its
        // Appearance tab fields can be read or edited.
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `document.querySelector('[data-node-tab="appearance"]').click()`);
        let rotationDegrees = await evaluate(window, `[document.querySelector('#editNodeRotationX').value, document.querySelector('#editNodeRotationY').value, document.querySelector('#editNodeRotationZ').value].map(Number)`);
        assert.deepEqual(rotationDegrees.map((v) => Math.round(v)), [17, 29, 40]);
        let scaleFields = await evaluate(window, `[document.querySelector('#editNodeScaleX').value, document.querySelector('#editNodeScaleY').value, document.querySelector('#editNodeScaleZ').value].map(Number)`);
        assert.deepEqual(scaleFields, [2, 1.5, 3]);

        // Typing a precise value commits it, going through the same node-object mutation and
        // undo history as a gizmo drag.
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeRotationX'); input.value = '90'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [1.57, 0.5, 0.7]);

        // Live gizmo drags refresh the open Appearance tab fields too, not just typed edits.
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(4, 1.5, 3)`);
        scaleFields = await evaluate(window, `[document.querySelector('#editNodeScaleX').value, document.querySelector('#editNodeScaleY').value, document.querySelector('#editNodeScaleZ').value].map(Number)`);
        assert.deepEqual(scaleFields, [4, 1.5, 3]);

        // Zero/negative scale is rejected (would collapse or invert the geometry) and the field
        // snaps back to the last valid value instead of committing.
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeScaleY'); input.value = '0'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        scaleFields = await evaluate(window, `[document.querySelector('#editNodeScaleX').value, document.querySelector('#editNodeScaleY').value, document.querySelector('#editNodeScaleZ').value].map(Number)`);
        assert.deepEqual(scaleFields, [4, 1.5, 3]);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [4, 1.5, 3]);

        // Undo back through the gizmo scale-drag and the typed rotation edit (the rejected
        // scale never recorded history) to restore what the earlier gizmo section left behind,
        // so the copy/paste assertions below still see [0.3, 0.5, 0.7] / [2, 1.5, 3].
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        rotation = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'rotation')`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(rotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);
        assert.deepEqual(scale, [2, 1.5, 3]);

        // --- Persistence through copy/paste, which round-trips via the same
        // serializeProjectDocument -> hydrateProjectDocument path a real save/reload would. ---
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        const nodeCountBefore = await evaluate(window, `document.querySelectorAll('.node-label-container').length`);
        // Diffing the node-ID set (rather than matching on a " copy" title suffix) avoids
        // mistaking this for some unrelated leftover "X copy" node other tests earlier in the
        // full suite may have already created and left on the canvas.
        const idsBefore = new Set(await evaluate(window, `window.__debugTransform.allNodeIds()`));
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === ${nodeCountBefore + 1}`, 'Paste did not create a new node.');
        const idsAfter = await evaluate(window, `window.__debugTransform.allNodeIds()`);
        const pastedId = idsAfter.find((id) => !idsBefore.has(id));
        assert.ok(pastedId, 'Could not find the pasted node.');
        const pastedRotation = await evaluate(window, `window.__debugTransform.nodeTransform(${pastedId}, 'rotation')`);
        const pastedScale = await evaluate(window, `window.__debugTransform.nodeTransform(${pastedId}, 'scale')`);
        assert.deepEqual(pastedRotation.map((v) => Math.round(v * 100) / 100), [0.3, 0.5, 0.7]);
        assert.deepEqual(pastedScale, [2, 1.5, 3]);

        // Cleanup: undo the paste and the scale/rotate changes so this test doesn't leave the
        // canvas mutated for whatever runs after it.
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
    });

    await run('shift held during a scale drag forces uniform scaling, even mid-drag', async () => {
        // window.__debugTransform.scaleDrag drives the real objectChange handler's Shift-uniform
        // override step by step (mouseDown / move / mouseUp), letting a test toggle Shift
        // between movement steps the same way a real drag would -- rather than real screen
        // coordinates raycast against the gizmo's 3D handle geometry, `move` sets the object's
        // scale directly to stand in for whatever a real per-axis drag would have produced, and
        // sets TransformControls' own pointStart/pointEnd (all uniformScaleFactorForDrag reads)
        // for the Shift-held steps.
        await waitFor(window, `document.querySelectorAll('.objectLabel').length > 0`, 'No node available to select.');
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        const nodeId = await evaluate(window, `window.__debugTransform.selectedId()`);
        assert.ok(nodeId, 'No node was selected.');
        await evaluate(window, `document.querySelector('[data-tool="scale"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.mode()`), 'scale');
        const startScale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);

        await evaluate(window, `window.__debugTransform.scaleDrag.mouseDown()`);

        // Without Shift, a normal (non-uniform) per-axis drag is left untouched.
        let scale = await evaluate(window, `window.__debugTransform.scaleDrag.move({ manualScale: [2, 1, 1], shiftHeld: false })`);
        assert.deepEqual(scale, [2, 1, 1]);

        // Pressing Shift mid-drag immediately snaps to uniform scaling, computed from the drag's
        // *original* start scale (captured at mouseDown, not the intermediate value above) and
        // the pointStart/pointEnd distance ratio TransformControls' own centre-handle math uses
        // -- this is the actual scenario that was reported broken (Shift pressed mid-drag).
        scale = await evaluate(window, `window.__debugTransform.scaleDrag.move({ pointStart: [1, 0, 0], pointEnd: [2, 0, 0], shiftHeld: true })`);
        assert.deepEqual(scale, startScale.map((value) => value * 2));

        // Releasing Shift mid-drag resumes normal per-axis behaviour.
        scale = await evaluate(window, `window.__debugTransform.scaleDrag.move({ manualScale: [3, 1, 1], shiftHeld: false })`);
        assert.deepEqual(scale, [3, 1, 1]);

        await evaluate(window, `window.__debugTransform.scaleDrag.mouseUp()`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [3, 1, 1]);

        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, startScale);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        scale = await evaluate(window, `window.__debugTransform.nodeTransform(${nodeId}, 'scale')`);
        assert.deepEqual(scale, [3, 1, 1]);

        // Cleanup: undo back to the starting scale so this test doesn't leave the canvas
        // mutated for whatever runs after it.
        await evaluate(window, `document.querySelector('.objectLabel').click()`);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
    });

    await run('rotate tool revolves a multi-node selection around the pivot as a rigid group', async () => {
        // Fresh nodes, not nodes already on the canvas, so both start at a guaranteed identity
        // rotation -- letting the revolve math below be checked with plain 2D rotation
        // trigonometry instead of needing to account for whatever pre-existing orientation an
        // example project's nodes might carry.
        const idsBefore = new Set(await evaluate(window, `window.__debugTransform.allNodeIds()`));
        await evaluate(window, `document.querySelector('#componentLibraryButton').click()`);
        await waitFor(window, `!document.querySelector('#componentLibraryPanel').hidden`, 'Component library panel did not open.');
        await waitFor(window, `document.querySelectorAll('.componentLibraryItem').length > 0`, 'Component library did not load any templates.');
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await evaluate(window, `document.querySelector('[data-template-id="freeBody"]').click()`);
        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
        const newIds = (await evaluate(window, `window.__debugTransform.allNodeIds()`)).filter((id) => !idsBefore.has(id));
        assert.equal(newIds.length, 2, 'Expected exactly two new free body nodes.');
        const [pivotId, otherId] = newIds;
        const selectPivot = `document.querySelector('.node-label-container[data-node="${pivotId}"] .objectLabel').click()`;
        const selectOther = `document.querySelector('.node-label-container[data-node="${otherId}"] .objectLabel').click()`;

        // Earlier tests in the suite pan and zoom the camera and never reset it, so by this
        // point it can be framed anywhere -- fit it to the model first so both freshly-placed
        // nodes are reliably on screen and clickable for the real mouse clicks below, rather
        // than landing wherever a prior test happened to leave the view.
        await evaluate(window, `document.querySelector('[data-nav-action="fit"]').click()`);

        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'rotation')`), [0, 0, 0]);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'rotation')`), [0, 0, 0]);
        const pivotPosition = await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'position')`);

        // Give the second node a known, meaningful offset from the pivot first, so the revolve
        // assertions below check real, non-trivial movement rather than however the component
        // library happened to place these two nodes relative to each other.
        await evaluate(window, selectOther);
        await evaluate(window, `document.querySelector('[data-tool="move"]').click()`);
        await evaluate(window, `window.__debugTransform.simulateDragTo(${pivotPosition[0] + 2}, ${pivotPosition[1]}, ${pivotPosition[2]})`);
        const otherStartPosition = await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`);
        assert.deepEqual(otherStartPosition, [pivotPosition[0] + 2, pivotPosition[1], pivotPosition[2]]);

        // Select the pivot and switch to the rotate tool first, so the gizmo attaches to it --
        // then add the other node to the selection via window.__debugTransform.selectAdditive
        // (selectNode's own additive path, the same one a real Shift-click drives) rather than a
        // real screen-coordinate Shift-click. Whether a Shift-click lands on the right on-screen
        // label is a real-mouse/CSS2D-layout concern the existing multi-selection copy/paste
        // test already covers; what this test needs a multi-selection *for* is the group-rotate
        // math below, so establishing it directly keeps the test focused on that and avoids
        // depending on wherever this point in the full suite happens to leave the camera framed.
        // selectNode() reassigns the "primary" selectedNode to whichever node was added last
        // (needed so the node editor tracks it), but only reattaches the gizmo when the
        // currently-attached node has fallen out of the selection -- since the pivot stays
        // selected throughout, the gizmo (and this drag's pivot) stays on it rather than jumping
        // to the other node.
        await evaluate(window, selectPivot);
        await evaluate(window, `document.querySelector('[data-tool="rotate"]').click()`);
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), pivotId);
        await evaluate(window, `window.__debugTransform.selectAdditive(${otherId})`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.node-label-container.selected').length`), 2);
        assert.equal(await evaluate(window, `window.__debugTransform.attachedId()`), pivotId, 'The gizmo should stay on the originally-selected node.');

        // A pure 90 degree rotation around Z, so the other node's expected revolved position can
        // be checked with plain 2D rotation trigonometry.
        await evaluate(window, `window.__debugTransform.simulateDragTo(0, 0, Math.PI / 2)`);

        // The `|| 0` normalizes -0 to 0 -- quaternion-to-Euler conversion can legitimately land
        // on -0 for a component that's mathematically exactly zero (e.g. via an internal
        // atan2(-0, 1)), which is numerically harmless but would otherwise fail a strict
        // deepEqual against a literal 0 below.
        const round2 = (values) => values.map((v) => Math.round(v * 100) / 100 || 0);
        const round3 = (values) => values.map((v) => Math.round(v * 1000) / 1000 || 0);

        const pivotEndPosition = await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'position')`);
        assert.deepEqual(pivotEndPosition, pivotPosition, "The pivot node's own position must not move during a rotate drag.");
        const pivotEndRotation = round2(await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'rotation')`));
        assert.deepEqual(pivotEndRotation, [0, 0, 1.57]);
        const otherEndRotation = round2(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'rotation')`));
        assert.deepEqual(otherEndRotation, pivotEndRotation, "Every selected node's own orientation should spin by the same amount.");

        // Rotating (1, 0, 0) by 90 degrees around Z gives (0, 1, 0): the other node, 2 units
        // along X from the pivot, should end up 2 units along Y from the pivot instead of
        // staying put and just spinning in place around its own centre.
        const expectedOtherPosition = round3([pivotPosition[0], pivotPosition[1] + 2, pivotPosition[2]]);
        const otherEndPosition = round3(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`));
        assert.deepEqual(otherEndPosition, expectedOtherPosition, 'The other selected node should revolve around the pivot, not spin in place.');

        // Undo restores both nodes' position and rotation together in one step; redo re-applies
        // the whole group rotation again.
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, bubbles: true }))`);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${pivotId}, 'rotation')`), [0, 0, 0]);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'rotation')`), [0, 0, 0]);
        assert.deepEqual(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`), otherStartPosition);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, ctrlKey: true, shiftKey: true, bubbles: true }))`);
        const otherRedoPosition = round3(await evaluate(window, `window.__debugTransform.nodeTransform(${otherId}, 'position')`));
        assert.deepEqual(otherRedoPosition, expectedOtherPosition);

        // Cleanup: delete both newly-created nodes so this test doesn't leave the canvas
        // mutated for whatever runs after it.
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
        await evaluate(window, selectPivot);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        await evaluate(window, selectOther);
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    });

    await run('edge group meshes a selection, saves a shared equation, and supports detach/delete/undo', async () => {
        const nodeLabel = (name) => `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}) && !label.textContent.includes('copy'))`;
        const nodeIdFor = (name) => `Number(${nodeLabel(name)}.closest('.node-label-container').dataset.node)`;
        // The move tool is active so #createNode's own "attach the gizmo to whatever was just
        // created" behavior lets simulateDragTo spread each node to a distinct position --
        // #createNode always spawns at the same [0, -0.7, 0], and three nodes left coincident
        // would leave every one of their CSS2D labels (and, in turn, every mesh edge's midpoint
        // bundle label) stacked at the same screen point, making click targeting ambiguous.
        await evaluate(window, `document.querySelector('[data-tool="move"]').click()`);
        const addNode = async (name, x) => {
            await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
            await evaluate(window, `(() => {
                document.querySelector('#newNodeName').value = ${JSON.stringify(name)};
                const values = { name: 'Temperature', symbol: 'temperature', value: '300', unit: 'K' };
                Object.entries(values).forEach(([field, value]) => {
                    const input = document.querySelector('.stateVariableRow [data-field="' + field + '"]');
                    input.value = value;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
                document.querySelector('#createNode').click();
            })()`);
            // A newly created node's CSS2D label isn't inserted into the DOM synchronously with
            // model.nodes.push() -- CSS2DRenderer only appends it on the next throttled render
            // tick (~30fps). Three nodes created back to back with little work between them can
            // otherwise all fire before that tick ever lands.
            await waitFor(window, `Boolean(${nodeLabel(name)})`, `The label for "${name}" did not render.`);
            await evaluate(window, `window.__debugTransform.simulateDragTo(${x}, 0, 0)`);
        };
        const bundleLabel = (name) => `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}))`;
        const relationshipCount = async () => Number((await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`)).match(/\d+/)[0]);
        // Real Shift-click's own screen-coordinate targeting is already covered by the
        // multi-selection copy/paste and bulk-disable tests above; this test's own subject is
        // edge-group behavior, so selection is built the same debug-hook way the multi-node
        // rotate/scale tests above build theirs.
        const selectAll = async (...names) => {
            await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
            // A real, exclusive click on the first node -- reliable now that addNode spreads
            // nodes apart -- clears whatever the selection happened to be left at by a prior
            // step; selectAdditive then builds the rest without depending on any more real
            // screen-coordinate targeting.
            await clickElement(window, nodeLabel(names[0]));
            await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === 1`,
                'The exclusive click did not select the first node.');
            let expected = 1;
            for (const name of names.slice(1)) {
                expected += 1;
                const id = await evaluate(window, nodeIdFor(name));
                const isSelected = () => evaluate(window, `document.querySelector('.node-label-container[data-node="${id}"]')?.classList.contains('selected')`);
                // Confirmed via instrumented runs: this environment's SwiftShader-throttled
                // render loop can occasionally leave a call's effect un-landed even several
                // seconds later (not just briefly stale). Retry the call itself, not just the
                // wait -- but only when this specific node's own selected state genuinely never
                // flipped; selectAdditive toggles, so re-issuing it after a call that actually
                // landed (just slow to be observed) would deselect the node instead of fixing
                // anything.
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (!(await isSelected())) await evaluate(window, `window.__debugTransform.selectAdditive(${id})`);
                    try {
                        await waitFor(window, `document.querySelectorAll('.node-label-container.selected').length === ${expected}`,
                            `selectAdditive did not add "${name}" to the selection.`, 2000);
                        break;
                    } catch (error) {
                        if (attempt === 2) throw error;
                    }
                }
            }
        };

        await addNode('Group test A', 0);
        await addNode('Group test B', 3);
        await addNode('Group test C', 6);
        const before = await relationshipCount();

        await selectAll('Group test A', 'Group test B', 'Group test C');
        assert.equal(await evaluate(window, `document.querySelector('#createEdgeGroup').disabled`), false);

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `document.querySelector('#createEdgeGroup').click()`);
            await waitFor(window, `!document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'The edge group editor did not open.');
            // 3 members -> N(N-1) = 6 mesh edges: one directed edge each way per pair (see
            // docs/edgeDirectionality.md for why groups use directed pairs, not one bidirectional
            // edge per pair).
            await waitFor(window, `document.querySelectorAll('.modelStatus span')[1].textContent === '${before + 6} relationships'`, 'The mesh did not create 6 edges.');

            await evaluate(window, `(() => {
                const output = document.querySelector('#groupEquationOutput');
                output.value = 'temperature';
                output.dispatchEvent(new Event('change', { bubbles: true }));
                const field = document.querySelector('#groupMathField');
                field.setValue('\\\\mathrm{sourceTemperature}-\\\\mathrm{targetTemperature}');
                field.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await waitFor(window, `document.querySelector('#groupEquationDiagnostics').classList.contains('valid')`, 'The group equation did not validate.');
            // Autosaves live, like the node/edge editors -- the "change" event (matching a real
            // blur) is what finishes the equation-typing session and commits its undo step,
            // there is no separate Save action to click anymore.
            await evaluate(window, `document.querySelector('#groupMathField').dispatchEvent(new Event('change', { bubbles: true }))`);
        });
        assert.deepEqual(consoleMessages, [], 'Saving the edge group logged unexpected console messages.');
        assert.equal(await evaluate(window, `document.querySelector('#groupEquationDiagnostics').classList.contains('valid')`), true);

        await waitFor(window, `Boolean(${bundleLabel('Group test A')})`, 'A mesh edge bundle label was not available.');
        await waitForStableRect(window,
            `(() => { const el = ${bundleLabel('Group test A')}; const rect = el?.getBoundingClientRect(); return rect && JSON.stringify(rect); })()`,
            'The mesh edge bundle label did not settle into a stable position.');
        await rightClickElement(window, bundleLabel('Group test A'));
        await waitFor(window, `!document.querySelector('#edgeContextMenu').classList.contains('hidden')`, 'Right-clicking a mesh edge did not open its context menu.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextOpenGroup').hidden`), false);
        assert.equal(await evaluate(window, `document.querySelector('#edgeContextDelete').hidden`), true);
        await evaluate(window, `document.querySelector('#edgeContextOpenGroup').click()`);
        await waitFor(window, `!document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'Opening the edge group from its context menu failed.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#groupMembersList .groupMemberRow').length`), 3);

        await evaluate(window, `[...document.querySelectorAll('#groupMembersList .groupMemberRow')].find((row) => row.textContent.includes('Group test C')).querySelector('.removeBuilderRow').click()`);
        await waitFor(window, `document.querySelectorAll('#groupMembersList .groupMemberRow').length === 2`, 'Detach did not remove the member row.');
        // Detaching C from the 3-member mesh un-groups its 4 edges (both directions to A and to
        // B) as ordinary edges -- nothing is deleted, so the total is still all 6 mesh edges.
        assert.equal(await relationshipCount(), before + 6, 'Detaching a member should leave its edges behind as ordinary edges, not delete them.');

        await evaluate(window, `document.querySelector('[data-delete-edge-group]').click()`);
        await waitFor(window, `document.querySelector('#edgeGroupEditor').classList.contains('hidden')`, 'Deleting the group did not close its editor.');
        // Only the group's own remaining mesh (A<->B, the sole pair with both endpoints still
        // members: 2 directed edges) is removed; C's 4 now-ordinary edges are untouched.
        assert.equal(await relationshipCount(), before + 4, 'Deleting the group should remove only its remaining mesh edges, leaving the 4 detached ones.');

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await relationshipCount(), before + 6, 'Undoing the group deletion did not restore its edges.');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await relationshipCount(), before + 6, 'Undoing the detach did not restore membership.');

        // Cleanup: delete the three throwaway nodes (and, with them, every mesh/detached edge)
        // so this test doesn't leave the canvas mutated for whatever runs after it.
        await selectAll('Group test A', 'Group test B', 'Group test C');
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
        assert.equal(await relationshipCount(), before);
    });

    await run('causal inference proposes a lagged edge and materializes it as one undoable step', async () => {
        // Deterministic pseudo-random generator (mulberry32), used instead of a smooth formula
        // like a sinusoid: a smooth curve is strongly autocorrelated with itself, which the
        // engine-side unit tests (engine/tests/causalInferenceTests.cpp) found leaks information
        // across lags in exactly the way real noise must not, producing a spurious reverse edge.
        function mulberry32(seed) {
            return function () {
                seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }
        function gaussianFrom(random) {
            const u1 = Math.max(random(), 1e-9);
            const u2 = random();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        }
        // columnA follows a genuine AR(1) process, and columnB[t] = 3*columnA[t-1] + noise, with
        // columnA independent of columnB -- the same one-directional generative shape validated
        // in engine/tests/causalInferenceTests.cpp's inferGraphFindsAOneDirectionalLaggedEdge.
        function buildLaggedPairCsv(rowCount = 60) {
            const random = mulberry32(2002);
            const a = [0.2];
            for (let t = 1; t < rowCount; t += 1) a.push(0.5 * a[t - 1] + 0.3 * gaussianFrom(random));
            const lines = ['time,columnA,columnB'];
            for (let t = 0; t < rowCount; t += 1) {
                const previousA = t > 0 ? a[t - 1] : a[0];
                lines.push(`${t},${a[t]},${3.0 * previousA + 0.05 * gaussianFrom(random)}`);
            }
            return `${lines.join('\n')}\n`;
        }

        const nodeLabel = (name) => `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes(${JSON.stringify(name)}) && !label.textContent.includes('copy'))`;
        const nodeCount = async () => Number((await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`)).match(/\d+/)[0]);
        const relationshipCount = async () => Number((await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`)).match(/\d+/)[0]);

        // An existing node whose state symbol exactly matches the CSV's "columnA" header --
        // exercising the "match an existing state, don't create a new node" mapping path.
        // "columnB" has no existing match, exercising "create a new node" instead.
        await evaluate(window, `document.querySelector('[data-tool="move"]').click()`);
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await evaluate(window, `(() => {
            document.querySelector('#newNodeName').value = 'Import test A';
            const values = { name: 'Column A', symbol: 'columnA', value: '0', unit: '' };
            Object.entries(values).forEach(([field, value]) => {
                const input = document.querySelector('.stateVariableRow [data-field="' + field + '"]');
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            document.querySelector('#createNode').click();
        })()`);
        await waitFor(window, `Boolean(${nodeLabel('Import test A')})`, 'The label for "Import test A" did not render.');
        await evaluate(window, `window.__debugTransform.simulateDragTo(0, 0, 0)`);

        const nodesBefore = await nodeCount();
        const edgesBefore = await relationshipCount();

        await evaluate(window, `document.querySelector('#causalInferenceButton').click()`);
        await waitFor(window, `!document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not open.');

        // A real OS file-picker dialog can't be driven by this harness (no Playwright
        // setInputFiles/CDP bridge) -- window.__debugCausalInference.loadCsv exercises the exact
        // same code path the real file input's change handler calls.
        await evaluate(window, `window.__debugCausalInference.loadCsv(${JSON.stringify(buildLaggedPairCsv())})`);
        await waitFor(window, `!document.querySelector('#causalInferenceMappingSection').hidden`, 'The column mapping section did not appear.');
        assert.equal(await evaluate(window, `document.querySelectorAll('#causalInferenceMappingRows .causalInferenceMappingRow').length`), 2);
        const mappingSelectValue = (index) => evaluate(window, `document.querySelectorAll('#causalInferenceMappingRows select')[${index}].value`);
        assert.notEqual(await mappingSelectValue(0), 'create', 'columnA should auto-match the existing node/state, not default to creating one.');
        assert.equal(await mappingSelectValue(1), 'create', 'columnB has no existing match and should default to creating a new node.');

        await evaluate(window, `document.querySelector('#runCausalInference').click()`);
        await waitFor(window, `!document.querySelector('#causalInferenceCandidatesSection').hidden`, 'The candidate list did not appear.', 15000);
        assert.equal(await evaluate(window, `
            [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].some((span) => span.textContent.includes('columnA → columnB'))
        `), true, 'Expected a columnA -> columnB candidate.');
        assert.equal(await evaluate(window, `
            [...document.querySelectorAll('#causalInferenceCandidateRows .causalInferenceCandidateMain')].some((span) => span.textContent.includes('columnB → columnA'))
        `), false, 'Did not expect a spurious columnB -> columnA candidate.');
        assert.equal(await evaluate(window, `document.querySelector('#causalInferenceCandidateRows .causalInferenceCandidateTag.lagged') !== null`), true,
            'Expected the accepted candidate to be tagged lagged.');

        const consoleMessages = await captureConsoleMessages(window, async () => {
            await evaluate(window, `document.querySelector('#commitCausalInference').click()`);
            await waitFor(window, `document.querySelector('#causalInference').classList.contains('hidden')`, 'The causal inference card did not close after commit.', 15000);
        });
        assert.deepEqual(consoleMessages.filter((message) => /error|uncaught|exception/i.test(message)), []);

        assert.equal(await nodeCount(), nodesBefore + 1, 'Committing should have created exactly one new node for columnB.');
        assert.equal(await relationshipCount(), edgesBefore + 1, 'Committing should have created exactly one new edge.');

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore, 'Undo should remove the created node.');
        assert.equal(await relationshipCount(), edgesBefore, 'Undo should remove the created edge.');

        await evaluate(window, `document.querySelector('#redoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore + 1, 'Redo should restore the created node.');
        assert.equal(await relationshipCount(), edgesBefore + 1, 'Redo should restore the created edge.');

        // Cleanup: undo the import again, then delete the throwaway "Import test A" node so this
        // test doesn't leave the canvas mutated for whatever runs after it. replaceModelContents
        // (which every undo/redo above runs through) rebuilds every CSS2D label from scratch,
        // and that render is throttled to ~30fps -- after three rapid-fire history operations,
        // clickElement's own getBoundingClientRect() needs the label to have actually reappeared
        // in the DOM first.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await nodeCount(), nodesBefore);
        await waitFor(window, `Boolean(${nodeLabel('Import test A')})`, 'The label for "Import test A" did not re-render after undo.');
        await evaluate(window, `document.querySelector('[data-tool="select"]').click()`);
        await clickElement(window, nodeLabel('Import test A'));
        await evaluate(window, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    });

    console.log(`Interaction tests passed: ${passed}`);
}
