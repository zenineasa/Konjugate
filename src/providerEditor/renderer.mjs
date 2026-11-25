/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The desktop host of the code editor (docs/proposals/codeEditor.md): its own window, around the shared editor in editorCore.mjs.

import { createProgramEditor } from './editorCore.mjs';

const $ = (selector) => document.querySelector(selector);
const bridge = window.providerEditorWindow;

window.windowControls.onMaximizedChange(() => {});
$('#minimize').addEventListener('click', () => window.windowControls.minimize());
$('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());

const editor = createProgramEditor({
    root: $('#programEditorRoot'),
    host: {
        validate: async (source, kind) => {
            const answer = await bridge.validate(source, kind);
            window.__programLintStats = answer?.stats; // Debug/test hook only: how many checks ran, were kept, or ran at once.
            return answer;
        },
        check: (source, kind, inputs) => bridge.check(source, kind, inputs),
        describe: (source, kind, inputs) => bridge.describe(source, kind, inputs),
        bind: (key, value, target) => bridge.request('bind', target, { key, value }),
        apply: (source, target) => bridge.apply(source, target),
        close: () => window.windowControls.close(),
        setTitle: (text) => { $('#editorTitle').textContent = text; document.title = text; },
        dirtyChanged: (dirty) => bridge.setDirty(dirty),
        reportStatus: (status) => bridge.reportStatus(status)
    }
});

$('#close').addEventListener('click', () => editor.requestClose());

bridge.onContent(async (payload) => {
    await editor.open(payload);
    window.__providerEditorView = editor.view; // Debug/test hook only; not part of the app's public surface.
});

// The window closing from outside (the keyboard, or its project window closing) with unsaved changes: the question is asked here, and
// the answer (whether it closed) goes back.
bridge.onCloseRequest(async (requestId) => {
    const closed = await editor.requestClose();
    bridge.answerCloseRequest(requestId, closed);
});

window.__providerEditor = editor; // Debug/test hook only.
