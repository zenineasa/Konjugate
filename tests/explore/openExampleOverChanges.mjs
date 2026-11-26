/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An example for scripts/exploreApp.mjs (docs/drivingTheApp.md):
//
//     node scripts/exploreApp.mjs tests/explore/openExampleOverChanges.mjs
//
// Changes the new project, then opens an example over it, which asks the native "Discard unsaved changes?". Answered Cancel first
// (the change is kept), then Discard changes (the example opens), with a screenshot after each.

const nodeCount = `document.querySelectorAll('.node-label-container').length`;

async function openExample(window, waitFor, title) {
    await window.evaluate(`document.querySelector('#exampleButton').click()`);
    await waitFor(window, `Boolean([...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === ${JSON.stringify(title)}))`, 'The examples did not show.');
    await window.evaluate(`[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.querySelector('b').textContent === ${JSON.stringify(title)}).click()`);
    await window.evaluate(`document.querySelector('#examplesExplorerLoad').click()`);
}

export async function explore(driver, { window, waitFor, screenshot, log }) {
    // A change to the new project: a node added.
    await window.evaluate(`document.querySelector('#addButton').click(); document.querySelector('[data-add-kind="node"]').click()`);
    await waitFor(window, `${nodeCount} === 1`, 'The node was not added.');

    // Cancel: the prompt is answered, and the project keeps its change.
    const asked = await driver.answerDialog({ button: 'Cancel', expect: 'Discard unsaved changes?' }, () => openExample(window, waitFor, 'Spring Mass Damper'));
    log(`The app asked "${asked.message}" (${asked.detail}), offering ${asked.buttons.join(' / ')}; answered: ${asked.answer}.`);
    await window.evaluate(`document.querySelector('#examplesExplorerDialog').open && document.querySelector('#examplesExplorerDialog').close()`);
    await waitFor(window, `${nodeCount} === 1`, 'Cancel did not keep the project.');
    await screenshot('after-cancel');

    // Discard changes: the example opens in its place.
    await driver.answerDialog({ button: 'Discard changes' }, () => openExample(window, waitFor, 'Spring Mass Damper'));
    await waitFor(window, `document.querySelector('.modelStatus').textContent.includes('2 nodes')`, 'Discard changes did not open the example.', 15000);
    await screenshot('after-discard');
    log(`Now open: ${await window.evaluate(`document.querySelector('.documentTitle').textContent`)}`);
}
