/* Copyright © 2026 Zenin Easa Panthakkalakath */

// window.providerEditor for the web shell (docs/proposals/webEdition.md, phase 4) -- a minimal
// in-page <dialog> (plain textarea, no syntax highlighting, no live-as-you-type validation, just
// a "Validate" button) in place of the desktop's separate native BrowserWindow code editor.
// Satisfies renderer.mjs's exact openWindow/onApplied/reportApplied contract (5 real call sites,
// e.g. renderer.mjs:7438) with zero renderer.mjs changes -- built at runtime via
// document.createElement, appended from webShims/index.mjs, the same injection pattern already
// used for the phase-3 "not available yet" banner, not an index.html body edit.
//
// reportApplied is a no-op here: on desktop it relays a result back across a second-window IPC
// boundary that doesn't exist in this single-page design.

import { runPythonSyntaxCheck } from '../../webPythonProviderBridge.mjs';

let dialog = null;
let titleElement = null;
let textarea = null;
let statusElement = null;
const appliedListeners = [];

function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'webProviderEditorDialog';
    dialog.innerHTML = `
        <form method="dialog">
            <h2></h2>
            <textarea rows="20" spellcheck="false" aria-label="Provider source"></textarea>
            <p class="webProviderEditorStatus" role="status"></p>
            <menu>
                <button type="button" data-action="validate">Validate</button>
                <button type="button" data-action="cancel">Cancel</button>
                <button type="button" data-action="save">Save</button>
            </menu>
        </form>
    `;
    titleElement = dialog.querySelector('h2');
    textarea = dialog.querySelector('textarea');
    statusElement = dialog.querySelector('.webProviderEditorStatus');

    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-action="save"]').addEventListener('click', () => {
        const source = textarea.value;
        dialog.close();
        appliedListeners.forEach((listener) => listener({ source }));
    });
    dialog.querySelector('[data-action="validate"]').addEventListener('click', async () => {
        if (dialog.dataset.kind !== 'python') {
            statusElement.textContent = 'Only Python providers can be checked in the web edition.';
            return;
        }
        statusElement.textContent = 'Checking…';
        try {
            const result = await runPythonSyntaxCheck(textarea.value);
            const diagnostic = result.diagnostics[0];
            statusElement.textContent = result.valid
                ? 'No syntax errors found.'
                : `Line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`;
        } catch (error) {
            statusElement.textContent = `Could not check syntax: ${error.message}`;
        }
    });

    document.body.append(dialog);
}

function openWindow({ source, kind, title }) {
    ensureDialog();
    titleElement.textContent = title ?? 'Provider source';
    textarea.value = source ?? '';
    statusElement.textContent = '';
    dialog.dataset.kind = kind ?? '';
    dialog.showModal();
}

function onApplied(callback) {
    appliedListeners.push(callback);
}

export default {
    openWindow,
    onApplied,
    reportApplied: () => {}
};
