/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { linter, lintGutter } from '@codemirror/lint';
import {
    buildThemeExtensions, customThemeFields, customTokenFields, defaultThemeId, themeFromCustomColors, themePresets
} from './themes.mjs';

const $ = (selector) => document.querySelector(selector);

window.windowControls.onMaximizedChange(() => {});
$('#minimize').addEventListener('click', () => window.windowControls.minimize());
$('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
$('#close').addEventListener('click', () => window.windowControls.close());

let currentKind = 'cpp';
let latestDiagnostics = [];
let validationSequence = 0;
const themeCompartment = new Compartment();

const storedThemeId = localStorage.getItem('konjugate.providerEditor.themeId');
let activeThemeId = storedThemeId && (storedThemeId === 'custom' || themePresets[storedThemeId]) ? storedThemeId : defaultThemeId;
let customColors = {};
try { customColors = JSON.parse(localStorage.getItem('konjugate.providerEditor.customColors') ?? '{}'); } catch { customColors = {}; }

function activeTheme() {
    return activeThemeId === 'custom' ? themeFromCustomColors(customColors) : themePresets[activeThemeId];
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
            themeCompartment.of(buildThemeExtensions(activeTheme())),
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

function populateThemeSelect() {
    const select = $('#editorThemeSelect');
    select.replaceChildren(
        ...Object.entries(themePresets).map(([id, preset]) => new Option(preset.label, id)),
        new Option('Custom…', 'custom')
    );
    select.value = activeThemeId;
}

function populateCustomColorInputs() {
    const theme = activeTheme();
    for (const field of customThemeFields) $(`#themeColor-${field}`).value = theme.chrome[field];
    for (const field of customTokenFields) $(`#themeColor-${field}`).value = theme.tokens[field];
}

function applyActiveTheme() {
    if (editorView) {
        editorView.dispatch({ effects: themeCompartment.reconfigure(buildThemeExtensions(activeTheme())) });
    }
    $('#editorThemePanel').hidden = activeThemeId !== 'custom';
    if (activeThemeId === 'custom') populateCustomColorInputs();
}

populateThemeSelect();
applyActiveTheme();

$('#editorThemeSelect').addEventListener('change', (event) => {
    const nextThemeId = event.target.value;
    // The first time a user opens Custom, start from whatever preset they were just looking
    // at rather than always resetting to the default theme's colors.
    if (nextThemeId === 'custom' && Object.keys(customColors).length === 0) {
        const seed = activeTheme();
        customColors = { ...seed.chrome, ...seed.tokens };
        localStorage.setItem('konjugate.providerEditor.customColors', JSON.stringify(customColors));
    }
    activeThemeId = nextThemeId;
    localStorage.setItem('konjugate.providerEditor.themeId', activeThemeId);
    applyActiveTheme();
});

$('#editorThemePanel').addEventListener('input', (event) => {
    const field = event.target.dataset.themeField;
    if (!field) return;
    customColors = { ...customColors, [field]: event.target.value };
    localStorage.setItem('konjugate.providerEditor.customColors', JSON.stringify(customColors));
    if (editorView) editorView.dispatch({ effects: themeCompartment.reconfigure(buildThemeExtensions(activeTheme())) });
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
