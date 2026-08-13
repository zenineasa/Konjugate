/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';

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

    await run('example menu loads a project copy', async () => {
        await evaluate(window, `document.querySelector('#exampleButton').click()`);
        await waitFor(window, `Boolean([...document.querySelectorAll('#exampleMenu button')].find((button) => button.textContent === 'Thermal Management'))`, 'Example menu did not populate.');
        await evaluate(window, `[...document.querySelectorAll('#exampleMenu button')].find((button) => button.textContent === 'Thermal Management').click()`);
        await waitFor(window, `document.querySelectorAll('.node-label-container').length === 3`, 'Thermal example did not load.');
        assert.equal(await evaluate(window, `document.querySelector('.documentTitle').textContent`), 'thermalManagement');
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
        // SwiftShader frames have been observed stalling well past 250ms, so wait for two
        // consecutive identical bounding rects rather than a single fixed delay.
        await waitFor(window, `(() => {
            const rectOf = () => { const rect = document.querySelector('.bundleLabel')?.getBoundingClientRect(); return rect && JSON.stringify(rect); };
            const first = rectOf();
            return new Promise((resolve) => requestAnimationFrame(() => resolve(Boolean(first) && first === rectOf())));
        })()`, 'The bundle label did not settle into a stable position.', 3000);
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
        // computed drag rectangle. Wait for two consecutive identical rects, like that test does.
        const labelRectsSelector = `[...document.querySelectorAll('.node-label-container')]
            .filter((label) => (label.textContent.includes('Battery module') || label.textContent.includes('Enclosed air')) && !label.textContent.includes('copy'))
            .map((label) => label.getBoundingClientRect())`;
        await waitFor(window, `(() => {
            const rectsOf = () => JSON.stringify(${labelRectsSelector});
            const first = rectsOf();
            return new Promise((resolve) => requestAnimationFrame(() => resolve(first === rectsOf())));
        })()`, 'The node labels did not settle into a stable position.', 3000);
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

    await run('shape library searches, filters by domain and applies a shape', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-node-tab="appearance"]').click()`);
        await evaluate(window, `document.querySelector('#editBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open.');
        const shapeCount = await evaluate(window, `document.querySelectorAll('.shapeLibraryItem').length`);
        assert.ok(shapeCount > 0, 'Shape library did not list any shapes.');
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].map((button) => button.textContent)`),
            ['All', 'Mechanical', 'Structural', 'Electrical', 'Fluid']);

        await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = 'gear'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem b')].map((element) => element.textContent)`), ['Spur Gear']);
        assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryEmpty').hidden`), true);

        await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = 'no such shape'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.shapeLibraryItem').length`), 0);
        assert.equal(await evaluate(window, `document.querySelector('#shapeLibraryEmpty').hidden`), false);

        await evaluate(window, `(() => { const input = document.querySelector('#shapeLibrarySearch'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].find((button) => button.textContent === 'Fluid').click()`);
        const fluidShapes = await evaluate(window, `[...document.querySelectorAll('.shapeLibraryItem')].map((item) => item.dataset.shapeId)`);
        assert.ok(fluidShapes.length > 0 && fluidShapes.every((id) => id.startsWith('fluid/')));

        // Apply a STEP-format shape (mechanical/lBracket) via the editor path.
        await evaluate(window, `[...document.querySelectorAll('#shapeLibraryDomains button')].find((button) => button.textContent === 'All').click()`);
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="mechanical/lBracket"]').click()`);
        await waitFor(window, `!document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not close after applying a shape.');
        assert.equal(await evaluate(window, `document.querySelector('#editGeometryStatus').textContent`), 'L-Bracket applied');
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), '');

        // Apply an STL-format shape via the "Add node" builder path.
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
        await evaluate(window, `document.querySelector('#builderBrowseShapeLibrary').click()`);
        await waitFor(window, `document.querySelector('#shapeLibraryDialog').open`, 'Shape library did not open from the node builder.');
        await evaluate(window, `document.querySelector('.shapeLibraryItem[data-shape-id="fluid/valveBody"]').click()`);
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
        // edge template but keep the mechanical one, and collapse from sectioned to a flat filtered list.
        await evaluate(window, `[...document.querySelectorAll('#componentLibraryDomainChips button')].find((b) => b.textContent === 'Mechanical').click()`);
        assert.equal(await evaluate(window, `document.querySelector('[data-template-id="thermalConductor"]')`), null);
        assert.notEqual(await evaluate(window, `document.querySelector('[data-template-id="spring"]')`), null);
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

        await evaluate(window, `document.querySelector('[data-template-id="thermalConductor"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the edge template did not arm endpoint picking.');
        assert.match(await evaluate(window, `document.querySelector('#componentLibraryHint').textContent`), /Conduction/);
        assert.equal(await evaluate(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`), true, 'The edge builder should stay out of the way during the chained endpoint pick.');

        // Endpoint picking is wired to the CSS2D label's own click listener (not 3D raycasting),
        // so a plain .click() reaches it directly -- the same approach every other test in this
        // file already uses for .objectLabel, and it sidesteps CSS2DRenderer position/timing
        // entirely rather than needing real screen coordinates.
        const clickThermalMass = async (index) => {
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Thermal mass'))[${index}].click()`);
        };

        await clickThermalMass(0);
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain from the source to the target endpoint after the first click.');
        await clickThermalMass(1);
        await waitFor(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'The edge builder did not reappear once both endpoints were picked.');
        assert.equal(await evaluate(window, `document.querySelector('#componentLibraryHint').hidden`), true);
        assert.equal(await evaluate(window, `document.querySelector('#newEdgeName').value`), 'Conduction');
        assert.equal(await evaluate(window, `document.querySelector('#edgeParameterRows .parameterRow [data-field="symbol"]').value`), 'conductance');
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true, 'The name-matched ports did not auto-bind to a valid equation.');

        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the templated edge did not close the builder.');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Undo the edge and both placed nodes so this scenario leaves the baseline model unchanged
        // before the next one starts.
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        // Second scenario: a node template with a self-referencing source term (Mechanical mass),
        // and an edge template with an explicit non-default output (Spring updates velocity, not
        // the target's first state, displacement) -- covers the two schema additions the thermal
        // scenario above doesn't exercise.
        await evaluate(window, `document.querySelector('[data-template-id="mechanicalMass"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Mechanical mass')).length === 1`, 'The first mechanical mass node template was not placed.');
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((l) => l.textContent.includes('Mechanical mass')).click()`);
        await waitFor(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`, 'The placed mechanical mass node did not open its editor.');
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorSourceTerms .sourceTermPreview')?.textContent`), 'Updates displacement', "The template's self-referencing source term was not applied to the placed node.");
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);

        await evaluate(window, `document.querySelector('[data-template-id="mechanicalMass"]').click()`);
        await waitFor(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Mechanical mass')).length === 2`, 'The second mechanical mass node template was not placed.');

        await evaluate(window, `document.querySelector('[data-template-id="spring"]').click()`);
        await waitFor(window, `!document.querySelector('#endpointPickBanner').hidden`, 'Applying the spring edge template did not arm endpoint picking.');
        const clickMechanicalMass = async (index) => {
            await evaluate(window, `[...document.querySelectorAll('.objectLabel')].filter((l) => l.textContent.includes('Mechanical mass'))[${index}].click()`);
        };
        await clickMechanicalMass(0);
        await waitFor(window, `document.querySelector('#endpointPickTitle').textContent.includes('target')`, 'Picking did not chain to the target endpoint for the spring template.');
        await clickMechanicalMass(1);
        await waitFor(window, `!document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'The edge builder did not reappear once both endpoints were picked for the spring template.');
        assert.equal(await evaluate(window, `document.querySelector('#edgeEquationOutput').selectedOptions[0].textContent`),
            'target.velocity', "The explicit output override did not select velocity over the target's default first state, displacement.");
        assert.equal(await evaluate(window, `document.querySelector('#builderEquationDiagnostics').classList.contains('valid')`), true);

        await evaluate(window, `document.querySelector('#createEdge').click()`);
        await waitFor(window, `document.querySelector('#edgeBuilder').classList.contains('hidden')`, 'Creating the spring edge did not close the builder.');
        assert.notEqual(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);

        await evaluate(window, `document.querySelector('#closeComponentLibraryPanel').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#componentLibraryPanel').hidden`), true);

        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[0].textContent`), nodesBefore);
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), relationshipsBefore);
    });

    console.log(`Interaction tests passed: ${passed}`);
}
