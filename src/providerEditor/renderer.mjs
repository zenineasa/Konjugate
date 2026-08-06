/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { linter, lintGutter } from '@codemirror/lint';

const $ = (selector) => document.querySelector(selector);

window.windowControls.onMaximizedChange(() => {});
$('#minimize').addEventListener('click', () => window.windowControls.minimize());
$('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
$('#close').addEventListener('click', () => window.windowControls.close());

let currentKind = 'cpp';
let latestDiagnostics = [];
let validationSequence = 0;

function editorTheme() {
    return EditorView.theme({
        '&': { color: '#c7d4d9', backgroundColor: '#09131b', height: '100%' },
        '.cm-content': { caretColor: '#6ce0d5' },
        '.cm-cursor': { borderLeftColor: '#6ce0d5' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgb(66 201 188 / 22%)' },
        '.cm-gutters': { color: '#4c6069', backgroundColor: '#081119', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'rgb(66 201 188 / 4%)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgb(66 201 188 / 6%)' }
    }, { dark: true });
}

async function sourceLinter(view) {
    const source = view.state.doc.toString();
    const sequence = ++validationSequence;
    const result = await window.providerEditorWindow.validate(source, currentKind);
    if (sequence !== validationSequence) return []; // A newer keystroke superseded this request.

    latestDiagnostics = result.diagnostics ?? [];
    const status = $('#editorStatus');
    status.classList.toggle('valid', result.valid);
    status.classList.toggle('invalid', !result.valid);
    status.textContent = result.valid
        ? 'No issues found.'
        : `${latestDiagnostics.length} ${latestDiagnostics.length === 1 ? 'issue' : 'issues'} found.`;

    const lineCount = view.state.doc.lines;
    return latestDiagnostics
        .filter((diagnostic) => diagnostic.line >= 1 && diagnostic.line <= lineCount)
        .map((diagnostic) => {
            const line = view.state.doc.line(diagnostic.line);
            const from = Math.min(line.to, line.from + Math.max(0, diagnostic.column - 1));
            return { from, to: line.to, severity: diagnostic.severity, message: diagnostic.message };
        });
}

function createEditor(source, kind) {
    currentKind = kind;
    const languageExtension = kind === 'python' ? python() : cpp();
    const state = EditorState.create({
        doc: source,
        extensions: [
            basicSetup,
            languageExtension,
            editorTheme(),
            lintGutter(),
            linter(sourceLinter, { delay: 500 })
        ]
    });
    return new EditorView({ state, parent: $('#editorHost') });
}

let editorView = null;

window.providerEditorWindow.onContent(({ source, kind, title }) => {
    $('#editorTitle').textContent = title ? `${title} · Provider source` : 'Provider source';
    $('#editorKindLabel').textContent = kind === 'python' ? 'Python' : 'C++';
    document.title = $('#editorTitle').textContent;
    if (editorView) editorView.destroy();
    editorView = createEditor(source ?? '', kind);
    editorView.focus();
    window.__providerEditorView = editorView; // Debug/test hook only; not part of the app's public surface.
});

$('#applyButton').addEventListener('click', async () => {
    if (!editorView) return;
    const button = $('#applyButton');
    button.disabled = true;
    try {
        await window.providerEditorWindow.apply(editorView.state.doc.toString());
    } finally {
        button.disabled = false;
    }
});
