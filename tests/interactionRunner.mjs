/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';

async function evaluate(window, expression) {
    return window.webContents.executeJavaScript(expression, true);
}

async function waitFor(window, expression, message, timeout = 5000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await evaluate(window, expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
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
        await evaluate(window, `(() => {
            document.querySelector('#runConfigurationName').value = 'Fast response';
            document.querySelector('#runGlobalTimeStep').value = '0.02';
            document.querySelector('#runOutputInterval').value = '0.1';
            document.querySelector('#applyRunConfiguration').click();
        })()`);
        assert.equal(await evaluate(window, `document.querySelector('#runConfigurationDialog').open`), false);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-node-tab="numerics"]').click()`);
        await evaluate(window, `(() => { const input = document.querySelector('#editNodeSubsteps'); input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeSubsteps').value`), '2');
        assert.match(await evaluate(window, `document.querySelector('#nodeEffectiveTimeStep').textContent`), /0\.01/);
        await evaluate(window, `document.querySelector('#nodeEditor [data-close-card]').click()`);
        await waitFor(window, `document.querySelector('#validationSummary').dataset.validationSource === 'engine'`, 'Updated numerical settings were not validated.');
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
        assert.equal(await evaluate(window, `document.querySelector('[data-detail="nodes"]').classList.contains('active')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#canvas').classList.contains('showNodesDetails')`), true);
        const finalValue = await evaluate(window, `document.querySelector('.node-label-container dd').textContent`);
        assert.notEqual(finalValue, before);
        assert.ok(Number(await evaluate(window, `document.querySelector('#resultTimeline').max`)) > 0);
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

    await run('icon-only toolstrip controls expose custom accessible tooltips', async () => {
        const controls = await evaluate(window, `[...document.querySelectorAll('.toolstrip .squareTool')].map((button) => ({
            label: button.getAttribute('aria-label'),
            tooltip: button.dataset.tooltip,
            nativeTitle: button.getAttribute('title')
        }))`);
        assert.ok(controls.length >= 5);
        assert.ok(controls.every((control) => control.label && control.tooltip && control.nativeTitle === null));
    });

    await run('canvas help reflects left-click inspection controls', async () => {
        const help = await evaluate(window, `document.querySelector('.canvasHelp').textContent.replace(/\\s+/g, ' ').trim()`);
        assert.match(help, /Left click inspect/);
        assert.match(help, /Drag move or orbit/);
        assert.match(help, /Shift-drag pan/);
        assert.match(help, /Scroll or −\/\+ zoom/);
        assert.doesNotMatch(help, /Right click edit/);
    });

    await run('left-click opens node and relationship inspectors', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#nodeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#nodeEditorTitle').textContent`), 'Battery module');
        await evaluate(window, `[...document.querySelectorAll('.bundleLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#edgeEditor').classList.contains('hidden')`), true);
        assert.equal(await evaluate(window, `document.querySelector('#edgeEditor .doneButton') === null`), true);
    });

    await run('equation editor switches between visual and LaTeX modes', async () => {
        await evaluate(window, `document.querySelector('[data-equation-mode="latex"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#editEdgeMathField').hidden && document.querySelector('#editEdgeEquation').hidden`), false);
        await evaluate(window, `document.querySelector('[data-equation-mode="visual"]').click()`);
        assert.equal(await evaluate(window, `!document.querySelector('#editEdgeMathField').hidden && document.querySelector('#editEdgeEquation').hidden`), true);
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
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.focus();
            field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, composed: true, cancelable: true }));
            field.position = field.value.length;
            field.executeCommand('deleteBackward');
        })()`);
        await waitFor(window, `document.querySelector('#editEdgeMathField').value !== ${JSON.stringify(equationBefore)}`, 'Backspace did not edit the equation.');
        assert.equal(await evaluate(window, `document.querySelectorAll('.modelStatus span')[1].textContent`), '3 relationships');
        await evaluate(window, `(() => {
            const field = document.querySelector('#editEdgeMathField');
            field.setValue(${JSON.stringify(equationBefore)});
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#edgeEditor [data-close-card]').click();
        })()`);
    });

    await run('node appearance changes and participates in undo', async () => {
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), false);
        await evaluate(window, `document.querySelector('[data-node-tab="appearance"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#nodeModelActions').hidden`), true);
        await evaluate(window, `(() => { const field = document.querySelector('#editNodeShape'); field.value = 'sphere'; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'sphere');
        await evaluate(window, `document.querySelector('#undoButton').click()`);
        await evaluate(window, `[...document.querySelectorAll('.objectLabel')].find((label) => label.textContent.includes('Battery module')).click(); document.querySelector('[data-node-tab="appearance"]').click()`);
        assert.equal(await evaluate(window, `document.querySelector('#editNodeShape').value`), 'box');
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

    await run('edge creation composes state references and supports undo', async () => {
        await evaluate(window, `document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="edge"]').click()`);
        await evaluate(window, `(() => {
            const choose = (selector, text) => { const field = document.querySelector(selector); field.value = [...field.options].find((option) => option.textContent === text).value; field.dispatchEvent(new Event('change', { bubbles: true })); };
            choose('#edgeSource', 'Electrical losses');
            choose('#edgeTarget', 'Coolant reservoir');
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
        await evaluate(window, `(() => { document.querySelector('.documentTitle').click(); const input = document.querySelector('.documentTitleInput'); input.value = 'My Test Model'; input.blur(); })()`);
        assert.equal(await evaluate(window, `document.querySelector('.documentTitle').textContent`), 'myTestModel');
    });

    await run('interface zoom controls increase and reset application scale', async () => {
        const before = await evaluate(window, `window.uiZoom.get()`);
        await evaluate(window, `document.querySelector('#zoomInButton').click()`);
        assert.ok(await evaluate(window, `window.uiZoom.get()`) > before);
        await evaluate(window, `window.uiZoom.reset()`);
        assert.equal(Math.round((await evaluate(window, `window.uiZoom.get()`)) * 10) / 10, 1);
    });

    console.log(`Interaction tests passed: ${passed}`);
}
