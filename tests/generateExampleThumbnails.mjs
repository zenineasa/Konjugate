/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

// Regenerates the Examples Explorer's per-example preview screenshots by actually driving the
// running app: opening each bundled example, fitting the camera, and capturing the canvas --
// rather than hand-authoring images that would silently drift from the real model over time.
// Run via `npm run generate:example-thumbnails` whenever an example's layout or content changes,
// or a new example is added.
export async function generateExampleThumbnails(window) {
    const examplesDir = join(process.cwd(), 'examples');
    const originalShowMessageBox = dialog.showMessageBox;
    // Loading a second example while the first is unsaved-dirty raises a native "Discard
    // changes?" dialog that executeJavaScript can't click -- auto-answering it here (this
    // runs inside the same Electron main process as the app itself, so dialog is the exact
    // same module singleton main.mjs uses) sidesteps needing to drive an OS-level modal.
    dialog.showMessageBox = async () => ({ response: 1 });
    try {
        const exampleIds = await evaluate(window, `window.projectFiles.listExamples().then((examples) => examples.map((e) => e.id))`);
        for (const id of exampleIds) {
            await evaluate(window, `document.querySelector('#exampleButton').click()`);
            await waitFor(window, `document.querySelector('#examplesExplorerDialog').open`, `Examples explorer did not open for ${id}.`);
            await evaluate(window, `[...document.querySelectorAll('.examplesExplorerItem')].find((item) => item.dataset.exampleId === ${JSON.stringify(id)}).click()`);
            await evaluate(window, `document.querySelector('#examplesExplorerLoad').click()`);
            await waitFor(window, `!document.querySelector('#examplesExplorerDialog').open`, `Examples explorer did not close after loading ${id}.`);
            await waitFor(window, `document.querySelectorAll('.node-label-container').length > 0`, `${id} did not load for thumbnail capture.`);
            await evaluate(window, `document.querySelector('.cubeFit').click()`);
            // capturePage() can return a frame from before the most recent paint under this
            // project's interaction-test harness (software rendering via --disable-gpu); this
            // delay is a settle window, not a fixed animation duration.
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const rect = await evaluate(window, `(() => { const r = document.querySelector('#canvas').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
            const image = await window.webContents.capturePage(rect);
            const pngName = id.replace(/\.kjt$/, '.png');
            writeFileSync(join(examplesDir, pngName), image.toPNG());
            console.log(`wrote ${pngName}`);
        }
    } finally {
        dialog.showMessageBox = originalShowMessageBox;
    }
}
