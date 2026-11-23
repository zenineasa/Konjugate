/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { linter, lintGutter } from '@codemirror/lint';
import {
    buildThemeExtensions, customThemeFields, customTokenFields, defaultThemeId, themeFromCustomColors, themePresets
} from './themes.mjs';
import { convertProgramToVersion2, olderFormatNotice } from '../programConversion.mjs';
import { programSourceVersion } from '../providerTemplate.mjs';

const $ = (selector) => document.querySelector(selector);

window.windowControls.onMaximizedChange(() => {});
$('#minimize').addEventListener('click', () => window.windowControls.minimize());
$('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
$('#close').addEventListener('click', () => window.windowControls.close());

let currentKind = 'cpp';
// What the project window said of the source: whether it is a model's program (not, say, a tuning objective), and the values its inputs
// have in the model now, for Check program.
let programContext = { program: false, checkInputs: {} };
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

// The Apply button doubles as a save-status indicator: 'clean' (nothing to save, matches the
// last successful apply or freshly loaded content), 'dirty' (edited since then), 'applying'
// (request in flight) and 'failed' (the project window rejected the apply -- e.g. its
// relationship or source term was deleted while this window was open).
let applyInFlight = false;
function setApplyState(state, detail = '') {
    applyInFlight = state === 'applying';
    const button = $('#applyButton');
    button.classList.remove('applyClean', 'applyDirty', 'applyFailed');
    button.disabled = state === 'clean' || state === 'applying';
    button.title = state === 'failed' ? detail : '';
    if (state === 'clean') { button.classList.add('applyClean'); button.textContent = 'Saved'; }
    else if (state === 'applying') { button.textContent = 'Applying…'; }
    else if (state === 'failed') { button.classList.add('applyFailed'); button.textContent = 'Apply failed'; }
    else { button.classList.add('applyDirty'); button.textContent = 'Apply'; }
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
            linter(sourceLinter, { delay: 500 }),
            EditorView.updateListener.of((update) => {
                // Ignore doc changes fired while an apply is in flight -- the click handler
                // resolves the correct end state (clean/dirty/failed) once it settles, and
                // flipping the button back to a clickable "Apply" mid-request would let a
                // second overlapping apply race the first (see pendingProviderApply in main.mjs).
                if (update.docChanged && !applyInFlight) setApplyState('dirty');
                if (update.docChanged) refreshProgramFormat();
            })
        ]
    });
    return new EditorView({ state, parent: $('#editorHost') });
}

let editorView = null;

// The program's format, plainly: an older program says so and offers to convert; a program in the current format offers Check program.
function refreshProgramFormat() {
    const source = editorView?.state.doc.toString() ?? '';
    const older = programContext.program && programSourceVersion(currentKind, source) === 1;
    $('#editorFormatNotice').hidden = !older;
    $('#editorFormatNoticeText').textContent = older ? olderFormatNotice : '';
    $('#checkProgramButton').hidden = !programContext.program || older;
}

// Convert to version 2: the program as it is beside the program converted, and what the conversion could not finish, before anything
// changes. Using it replaces the source in one edit, which undo takes back in one step.
let pendingConversion = null;
function showConversion() {
    if (!editorView) return;
    const before = editorView.state.doc.toString();
    pendingConversion = convertProgramToVersion2(currentKind, before);
    $('#convertBefore').textContent = before;
    $('#convertAfter').textContent = pendingConversion.source;
    $('#convertSummary').textContent = pendingConversion.complete
        ? 'The converted program is complete: it takes part in every stage of every method. Use it, then Apply to save it in the model.'
        : 'Converted as far as its ports. It is not finished: each place that needs a decision is marked in the code. Until it compiles, the model cannot run.';
    $('#convertNotes').replaceChildren(...pendingConversion.notes.map((note) => Object.assign(document.createElement('li'), { textContent: note })));
    $('#editorConvertPanel').hidden = false;
    $('#editorCheckPanel').hidden = true;
}
$('#convertButton').addEventListener('click', showConversion);
$('#convertCancel').addEventListener('click', () => { $('#editorConvertPanel').hidden = true; pendingConversion = null; });
$('#convertAccept').addEventListener('click', () => {
    if (!editorView || !pendingConversion) return;
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: pendingConversion.source } });
    $('#editorConvertPanel').hidden = true;
    pendingConversion = null;
    editorView.focus();
});

// Check program: the standard checks, run by the engine as a run would load the program, at the values its inputs have in the model.
$('#checkProgramButton').addEventListener('click', async () => {
    if (!editorView) return;
    const button = $('#checkProgramButton');
    const panel = $('#editorCheckPanel');
    button.disabled = true;
    button.textContent = 'Checking…';
    panel.hidden = false;
    panel.classList.remove('passed', 'failed');
    $('#checkSummary').textContent = 'Checking the program…';
    $('#checkProblems').replaceChildren();
    $('#checkDetails').textContent = '';
    try {
        const answer = await window.providerEditorWindow.check(editorView.state.doc.toString(), currentKind, programContext.checkInputs);
        if (!answer?.available) {
            $('#checkSummary').textContent = 'The simulation engine is not available, so the program cannot be checked here.';
            panel.classList.add('failed');
            return;
        }
        const name = answer.program || 'The program';
        panel.classList.add(answer.ok ? 'passed' : 'failed');
        $('#checkSummary').textContent = answer.ok ? `${name}: every check passed.` : `${name}: ${answer.problems.length} ${answer.problems.length === 1 ? 'problem' : 'problems'}.`;
        $('#checkProblems').replaceChildren(...(answer.problems ?? []).map((problem) => Object.assign(document.createElement('li'), { textContent: problem })));
        const number = (value) => (Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : String(value));
        const outputs = Object.entries(answer.outputs ?? {}).map(([key, value]) => `${key} = ${number(value)}`);
        const memory = Object.entries(answer.memory ?? {}).map(([key, values]) => `${key} = ${values.map(number).join(', ')}`);
        $('#checkDetails').textContent = [
            outputs.length ? `Outputs at the model's values: ${outputs.join('; ')}.` : '',
            memory.length ? `Memory after three steps: ${memory.join('; ')}.` : ''
        ].filter(Boolean).join(' ');
    } catch (error) {
        panel.classList.add('failed');
        $('#checkSummary').textContent = `The check could not run: ${error?.message ?? error}`;
    } finally {
        button.disabled = false;
        button.textContent = 'Check program';
    }
});

window.providerEditorWindow.onContent(({ source, kind, title, program = false, checkInputs = {}, convert = false }) => {
    $('#editorTitle').textContent = title ? `${title} · Provider source` : 'Provider source';
    $('#editorKindLabel').textContent = kind === 'python' ? 'Python' : 'C++';
    document.title = $('#editorTitle').textContent;
    if (editorView) editorView.destroy();
    editorView = createEditor(source ?? '', kind);
    editorView.focus();
    setApplyState('clean');
    programContext = { program, checkInputs };
    $('#editorConvertPanel').hidden = true;
    $('#editorCheckPanel').hidden = true;
    refreshProgramFormat();
    if (convert && programContext.program && programSourceVersion(kind, source ?? '') === 1) showConversion();
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

async function applySource() {
    if (!editorView || applyInFlight) return;
    const source = editorView.state.doc.toString();
    setApplyState('applying');
    try {
        const result = await window.providerEditorWindow.apply(source);
        if (!result.applied) {
            setApplyState('failed', result.error);
        } else {
            // The user may have kept typing while this request was in flight; a successful
            // apply of the older text still leaves those newer keystrokes unsaved.
            setApplyState(editorView.state.doc.toString() === source ? 'clean' : 'dirty');
        }
    } catch (error) {
        setApplyState('failed', error?.message ?? 'The apply request failed.');
    }
}

$('#applyButton').addEventListener('click', applySource);

window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        applySource();
    }
});
