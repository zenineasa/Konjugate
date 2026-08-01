/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';

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

    await run('icon-only toolstrip controls expose custom accessible tooltips', async () => {
        const controls = await evaluate(window, `[...document.querySelectorAll('.toolstrip .squareTool')].map((button) => ({
            label: button.getAttribute('aria-label'),
            tooltip: button.dataset.tooltip,
            nativeTitle: button.getAttribute('title')
        }))`);
        assert.ok(controls.length >= 6);
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
        await evaluate(window, `document.querySelector('[data-node-tab="appearance"]').click()`);
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
