/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Bootstrap for the web shell (docs/proposals/webEdition.md, phase 3): assigns every window.*
// global renderer.mjs expects, synchronously, at this module's own top level. Must run to
// completion before renderer.mjs's <script type=module> does -- module scripts execute in
// document order (see indexWeb.html), and renderer.mjs itself calls window.engine.onUpdate/
// .onComplete/.onError at ITS OWN top level, so window.engine has to already be a complete
// object by then, not lazily attached.

import engine from './engine.mjs';
import projectFiles, { setPendingDroppedFile } from './projectFiles.mjs';
import providerEditor from './providerEditor.mjs';
import {
    addons, aiProviders, applicationInfo, componentLibrary, diagnostics, extensions,
    modelClipboard, providerToolchains, shapeLibrary, uiZoom, windowControls
} from './misc.mjs';

window.engine = engine;
window.projectFiles = projectFiles;
window.uiZoom = uiZoom;
window.windowControls = windowControls;
window.applicationInfo = applicationInfo;
window.diagnostics = diagnostics;
window.extensions = extensions;
window.shapeLibrary = shapeLibrary;
window.componentLibrary = componentLibrary;
window.providerEditor = providerEditor;
window.providerToolchains = providerToolchains;
window.modelClipboard = modelClipboard;
window.aiProviders = aiProviders;
window.addons = addons;

// Drag-drop project load: reuses openProject()'s real flow (its confirmDiscard() check included)
// by stashing the dropped file's bytes for projectFiles.open() to pick up, then synthesizing a
// click on the toolbar's real #loadButton (wired directly to openProject in renderer.mjs) --
// avoids needing to import or fork renderer.mjs's module-local loadOpenedProjectFile()/
// openProject() functions.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    setPendingDroppedFile(new Uint8Array(await file.arrayBuffer()), file.name);
    document.getElementById('loadButton')?.click();
});

// A dismissible banner framing this as a lightweight trial and pointing to the desktop app for
// the full experience, plus an honest summary of what's not here yet (styles.css gates
// .webEditionBanner's visibility to [data-web-edition], so this is inert in the desktop app even
// if it were ever reached there, which it isn't -- this module is only loaded by the web shell's
// own index.html). "Encrypted projects" is deliberately not in the unavailable list -- real since
// phase 3 (src/browserProjectCodec.mjs) -- this list should only ever name things still genuinely
// missing, not carry forward a claim once it's stopped being true.
const banner = document.createElement('div');
banner.className = 'webEditionBanner';
banner.innerHTML = '<span>This is a free, lightweight trial of Konjugate running in your browser. ' +
    'Run here is batch-only (no live progress or mid-run control), and programmable C++ providers, ' +
    "FMU import/export, add-ons, and AI-assisted authoring aren't available yet. For the full " +
    'experience, <a href="https://github.com/zenineasa/Konjugate/releases/latest" target="_blank" ' +
    'rel="noopener">download the free desktop app</a>.</span>' +
    '<button type="button" aria-label="Dismiss">×</button>';
banner.querySelector('button').addEventListener('click', () => banner.remove());
document.body.prepend(banner);
