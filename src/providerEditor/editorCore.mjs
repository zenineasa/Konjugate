/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor itself (docs/proposals/codeEditor.md, "One editor on the web"): CodeMirror, the toolbar, Convert, Check, Apply, Cancel
// and the unsaved-changes guard. Neither host owns it. The desktop's window (src/providerEditor/renderer.mjs) and the web edition's
// in-page panel (src/renderer/webShims/providerEditor.mjs) each hand it an element to fill and a host:
//
//   validate(source, kind)        → { valid, diagnostics: [{ line, column, severity, message }] }, or { valid: null, message } when
//                                    the program cannot be checked here
//   check(source, kind, inputs)   → the engine's Check program answer, { available, ok, program, problems, outputs, memory, reason? }
//   apply(source, target)         → { applied, error? } from the project
//   close()                       → closes the window or hides the panel (the editor has already decided it may)
//   setTitle(text)                → "Heater · Program"
//   dirtyChanged(dirty)           → optional: told whenever there come to be, or stop being, unsaved changes
//
// It touches no Electron global, so it runs the same in the window and in the web page.

import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import { linter, lintGutter } from '@codemirror/lint';
import {
    buildThemeExtensions, customThemeFields, customTokenFields, defaultThemeId, themeFromCustomColors, themePresets
} from './themes.mjs';
import { convertProgramToVersion2, olderFormatNotice } from '../programConversion.mjs';
import { programSourceVersion } from '../providerTemplate.mjs';
import {
    confirmLeave, createEditorSession, formatLabel, leaveQuestion, portDeclarationLine, problemCountText, programEditorTitle, sameTarget
} from './editorSession.mjs';

const themeLabels = { background: 'Background', foreground: 'Text', gutterBackground: 'Gutter', gutterForeground: 'Line numbers', caret: 'Cursor & accent',
    comment: 'Comment', keyword: 'Keyword', string: 'String', number: 'Number', function: 'Function', typeName: 'Type' };

const markup = `
    <div class="programEditorToolbar">
        <span id="programEditorFormat" class="kindBadge"></span>
        <button id="programEditorConvert" class="linkButton" type="button" hidden>Convert to version 2 ›</button>
        <button id="programEditorProblems" class="problemCount" type="button" role="status">Checking…</button>
        <span class="toolbarSpacer"></span>
        <button id="programEditorCheck" class="secondaryButton" type="button" hidden title="Runs the program's standard checks: its ports, its outputs, purity and its memory">Check program</button>
        <button id="programEditorCancel" class="secondaryButton" type="button" title="Close without applying">Cancel</button>
        <button id="programEditorApply" class="applyButton" type="button" title="Apply to the model (Ctrl+S)">Apply</button>
        <button id="programEditorMore" class="moreButton" type="button" aria-label="More" aria-haspopup="true" aria-expanded="false">⋯</button>
        <div id="programEditorMenu" class="programEditorMenu" hidden>
            <label><span>Colour theme</span><select id="programEditorTheme" aria-label="Editor colour theme"></select></label>
            <div id="programEditorThemeColors" class="themeColors" hidden></div>
        </div>
    </div>
    <div id="programEditorFormatNotice" class="editorNotice" hidden>
        <span id="programEditorFormatNoticeText"></span>
        <button id="programEditorNoticeConvert" class="linkButton" type="button">Convert to version 2 ›</button>
    </div>
    <div id="programEditorApplyFailure" class="editorNotice failure" hidden role="alert"></div>
    <div id="programEditorConvertPanel" class="editorConvertPanel" hidden>
        <p id="programEditorConvertSummary" class="convertSummary"></p>
        <ul id="programEditorConvertNotes" class="convertNotes"></ul>
        <div class="convertColumns">
            <div><h3>As it is</h3><pre id="programEditorConvertBefore"></pre></div>
            <div><h3>Converted</h3><pre id="programEditorConvertAfter"></pre></div>
        </div>
        <div class="convertActions">
            <button id="programEditorConvertCancel" class="secondaryButton" type="button">Keep it as it is</button>
            <button id="programEditorConvertAccept" class="applyButton" type="button">Use the converted program</button>
        </div>
    </div>
    <div id="programEditorCheckPanel" class="editorCheckPanel" hidden role="status">
        <p id="programEditorCheckSummary" class="checkSummary"></p>
        <ul id="programEditorCheckProblems" class="checkProblems"></ul>
        <p id="programEditorCheckDetails" class="checkDetails"></p>
    </div>
    <div id="programEditorHost" class="programEditorHost"></div>
    <div id="programEditorLeave" class="programEditorLeave" hidden>
        <div class="leaveCard" role="alertdialog" aria-modal="true" aria-labelledby="programEditorLeaveQuestion">
            <p id="programEditorLeaveQuestion"></p>
            <div class="leaveActions">
                <button id="programEditorLeaveKeep" class="secondaryButton" type="button">Keep editing</button>
                <button id="programEditorLeaveDiscard" class="secondaryButton" type="button">Don’t apply</button>
                <button id="programEditorLeaveApply" class="applyButton" type="button">Apply</button>
            </div>
        </div>
    </div>`;

export function createProgramEditor({ root, host, storage = globalThis.localStorage }) {
    root.classList.add('programEditor');
    root.innerHTML = markup;
    const $ = (selector) => root.querySelector(selector);

    const session = createEditorSession();
    const themeCompartment = new Compartment();
    let view = null;
    let kind = 'cpp';
    let title = '';
    let target = null;
    // What the project said of the source: whether it is a model's program (not a tuning objective), and the values its inputs have in
    // the model now, for Check program.
    let context = { program: false, checkInputs: {} };
    let diagnostics = [];
    let validationSequence = 0;
    let lastDirty = false;
    let pendingConversion = null;

    // ---- Theme (kept in the app's settings under the existing konjugate.providerEditor.* keys) --------------------------------------
    const read = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
    const write = (key, value) => { try { storage?.setItem(key, value); } catch { /* settings not kept */ } };
    const storedThemeId = read('konjugate.providerEditor.themeId');
    let activeThemeId = storedThemeId && (storedThemeId === 'custom' || themePresets[storedThemeId]) ? storedThemeId : defaultThemeId;
    let customColors = {};
    try { customColors = JSON.parse(read('konjugate.providerEditor.customColors') ?? '{}') ?? {}; } catch { customColors = {}; }
    const activeTheme = () => (activeThemeId === 'custom' ? themeFromCustomColors(customColors) : themePresets[activeThemeId]);

    $('#programEditorTheme').replaceChildren(
        ...Object.entries(themePresets).map(([id, preset]) => new Option(preset.label, id)),
        new Option('Custom…', 'custom'));
    $('#programEditorTheme').value = activeThemeId;
    $('#programEditorThemeColors').replaceChildren(...[...customThemeFields, ...customTokenFields].map((field) => {
        const label = document.createElement('label');
        const input = Object.assign(document.createElement('input'), { type: 'color', id: `programEditorThemeColor-${field}` });
        input.dataset.themeField = field;
        label.append(Object.assign(document.createElement('span'), { textContent: themeLabels[field] ?? field }), input);
        return label;
    }));
    function applyActiveTheme() {
        view?.dispatch({ effects: themeCompartment.reconfigure(buildThemeExtensions(activeTheme())) });
        $('#programEditorThemeColors').hidden = activeThemeId !== 'custom';
        if (activeThemeId === 'custom') {
            const theme = activeTheme();
            for (const field of customThemeFields) $(`#programEditorThemeColor-${field}`).value = theme.chrome[field];
            for (const field of customTokenFields) $(`#programEditorThemeColor-${field}`).value = theme.tokens[field];
        }
    }
    $('#programEditorTheme').addEventListener('change', (event) => {
        const next = event.target.value;
        // The first time Custom is chosen, it starts from the preset being looked at.
        if (next === 'custom' && Object.keys(customColors).length === 0) {
            const seed = activeTheme();
            customColors = { ...seed.chrome, ...seed.tokens };
            write('konjugate.providerEditor.customColors', JSON.stringify(customColors));
        }
        activeThemeId = next;
        write('konjugate.providerEditor.themeId', activeThemeId);
        applyActiveTheme();
    });
    $('#programEditorThemeColors').addEventListener('input', (event) => {
        const field = event.target.dataset.themeField;
        if (!field) return;
        customColors = { ...customColors, [field]: event.target.value };
        write('konjugate.providerEditor.customColors', JSON.stringify(customColors));
        applyActiveTheme();
    });
    const toggleMenu = (open = $('#programEditorMenu').hidden) => {
        $('#programEditorMenu').hidden = !open;
        $('#programEditorMore').setAttribute('aria-expanded', String(open));
    };
    $('#programEditorMore').addEventListener('click', () => toggleMenu());
    root.addEventListener('pointerdown', (event) => {
        if (!$('#programEditorMenu').hidden && !event.target.closest('#programEditorMenu, #programEditorMore')) toggleMenu(false);
    });

    // ---- Apply state -------------------------------------------------------------------------------------------------------------
    function refreshApplyState() {
        const state = session.applyState;
        const button = $('#programEditorApply');
        button.disabled = state === 'clean' || state === 'applying';
        button.classList.toggle('applyFailed', state === 'failed');
        button.textContent = state === 'applying' ? 'Applying…' : state === 'failed' ? 'Apply failed' : 'Apply';
        button.title = state === 'failed' ? session.failure : 'Apply to the model (Ctrl+S)';
        $('#programEditorApplyFailure').hidden = state !== 'failed';
        $('#programEditorApplyFailure').textContent = state === 'failed' ? `Not applied: ${session.failure}` : '';
        root.dataset.applyState = state;
        if (session.dirty !== lastDirty) {
            lastDirty = session.dirty;
            host.dirtyChanged?.(lastDirty);
        }
    }

    async function apply() {
        const source = session.beginApply();
        if (source === null) return session.applyState !== 'failed';
        refreshApplyState();
        let result;
        try { result = await host.apply(source, target); } catch (error) { result = { applied: false, error: error?.message ?? 'The apply request failed.' }; }
        session.finishApply(result);
        refreshApplyState();
        return Boolean(result?.applied);
    }
    $('#programEditorApply').addEventListener('click', () => apply());
    root.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            event.stopPropagation();
            apply();
        }
        if (event.key === 'Escape' && !$('#programEditorLeave').hidden) {
            event.preventDefault();
            answerLeave('keep');
        }
    });

    // ---- Leaving: "Apply your changes to Heater's program?" ----------------------------------------------------------------------
    let leaveResolver = null;
    function askLeave() {
        $('#programEditorLeaveQuestion').textContent = leaveQuestion(title);
        $('#programEditorLeave').hidden = false;
        $('#programEditorLeaveApply').focus();
        return new Promise((resolve) => { leaveResolver = resolve; });
    }
    function answerLeave(answer) {
        $('#programEditorLeave').hidden = true;
        const resolve = leaveResolver;
        leaveResolver = null;
        resolve?.(answer);
        if (answer === 'keep') view?.focus();
    }
    $('#programEditorLeaveKeep').addEventListener('click', () => answerLeave('keep'));
    $('#programEditorLeaveDiscard').addEventListener('click', () => answerLeave('discard'));
    $('#programEditorLeaveApply').addEventListener('click', () => answerLeave('apply'));

    let leaving = null;
    // Whether the editor may go (asking first when there are unsaved changes). A second request while the question is up gets the same
    // answer.
    function mayLeave() {
        if (leaving) return leaving;
        leaving = confirmLeave(session, {
            ask: askLeave,
            apply: async (source) => {
                refreshApplyState();
                let result;
                try { result = await host.apply(source, target); } catch (error) { result = { applied: false, error: error?.message ?? String(error) }; }
                return result;
            }
        }).finally(() => { leaving = null; refreshApplyState(); });
        return leaving;
    }
    // The × of the window or panel, or the project window closing: true when the editor closed.
    async function requestClose() {
        if (!await mayLeave()) return false;
        closeNow();
        return true;
    }
    function closeNow() {
        session.load(session.source); // Nothing is left unsaved once it has gone.
        refreshApplyState();
        host.close();
    }
    // Cancel: close without applying.
    $('#programEditorCancel').addEventListener('click', () => closeNow());

    // ---- Lint ----------------------------------------------------------------------------------------------------------------------
    function showProblemCount(text, state) {
        const button = $('#programEditorProblems');
        button.textContent = text;
        button.classList.toggle('valid', state === 'valid');
        button.classList.toggle('invalid', state === 'invalid');
        button.disabled = state !== 'invalid';
    }
    async function sourceLinter(editorView) {
        const source = editorView.state.doc.toString();
        const sequence = ++validationSequence;
        let result;
        try { result = await host.validate(source, kind); } catch (error) { result = { valid: null, message: `Could not check: ${error?.message ?? error}` }; }
        if (sequence !== validationSequence) return []; // A newer keystroke superseded this request.
        if (result?.valid === null || result?.valid === undefined) {
            diagnostics = [];
            showProblemCount(result?.message ?? '', 'unknown');
            return [];
        }
        diagnostics = result.diagnostics ?? [];
        const errors = diagnostics.length || (result.valid ? 0 : 1);
        showProblemCount(result.valid ? 'No problems' : problemCountText(errors), result.valid ? 'valid' : 'invalid');
        const lineCount = editorView.state.doc.lines;
        return diagnostics
            .filter((diagnostic) => diagnostic.line >= 1 && diagnostic.line <= lineCount)
            .map((diagnostic) => {
                const line = editorView.state.doc.line(diagnostic.line);
                const from = Math.min(line.to, line.from + Math.max(0, (diagnostic.column ?? 1) - 1));
                return { from, to: line.to, severity: diagnostic.severity ?? 'error', message: diagnostic.message };
            });
    }
    // The problem count moves the cursor to the first problem.
    $('#programEditorProblems').addEventListener('click', () => {
        const first = diagnostics.find((diagnostic) => diagnostic.line >= 1);
        if (first) goToLine(first.line, first.column);
    });

    function goToLine(lineNumber, column = 1) {
        if (!view) return;
        const line = view.state.doc.line(Math.min(Math.max(1, Math.round(lineNumber)), view.state.doc.lines));
        const position = Math.min(line.to, line.from + Math.max(0, (column ?? 1) - 1));
        view.dispatch({ selection: EditorSelection.cursor(position), effects: EditorView.scrollIntoView(position, { y: 'center' }) });
        view.focus();
    }

    // ---- The program's format, and Convert -----------------------------------------------------------------------------------------
    function refreshFormat() {
        const source = session.source;
        const version = context.program ? programSourceVersion(kind, source) : 2;
        const older = context.program && version === 1;
        $('#programEditorFormat').textContent = formatLabel(kind, version, context.program);
        $('#programEditorConvert').hidden = !older;
        $('#programEditorFormatNotice').hidden = !older;
        $('#programEditorFormatNoticeText').textContent = older ? olderFormatNotice : '';
        $('#programEditorCheck').hidden = !context.program || older;
    }
    function showConversion() {
        if (!view) return;
        const before = view.state.doc.toString();
        pendingConversion = convertProgramToVersion2(kind, before);
        $('#programEditorConvertBefore').textContent = before;
        $('#programEditorConvertAfter').textContent = pendingConversion.source;
        $('#programEditorConvertSummary').textContent = pendingConversion.complete
            ? 'The converted program is complete: it takes part in every stage of every method. Use it, then Apply to save it in the model.'
            : 'Converted as far as its ports. It is not finished: each place that needs a decision is marked in the code. Until it compiles, the model cannot run.';
        $('#programEditorConvertNotes').replaceChildren(...pendingConversion.notes.map((note) => Object.assign(document.createElement('li'), { textContent: note })));
        $('#programEditorConvertPanel').hidden = false;
        $('#programEditorCheckPanel').hidden = true;
    }
    $('#programEditorConvert').addEventListener('click', showConversion);
    $('#programEditorNoticeConvert').addEventListener('click', showConversion);
    $('#programEditorConvertCancel').addEventListener('click', () => { $('#programEditorConvertPanel').hidden = true; pendingConversion = null; });
    $('#programEditorConvertAccept').addEventListener('click', () => {
        if (!view || !pendingConversion) return;
        // One edit, which undo takes back in one step.
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pendingConversion.source } });
        $('#programEditorConvertPanel').hidden = true;
        pendingConversion = null;
        view.focus();
    });

    // ---- Check program -------------------------------------------------------------------------------------------------------------
    $('#programEditorCheck').addEventListener('click', async () => {
        if (!view) return;
        const button = $('#programEditorCheck');
        const panel = $('#programEditorCheckPanel');
        button.disabled = true;
        button.textContent = 'Checking…';
        panel.hidden = false;
        panel.classList.remove('passed', 'failed');
        $('#programEditorCheckSummary').textContent = 'Checking the program…';
        $('#programEditorCheckProblems').replaceChildren();
        $('#programEditorCheckDetails').textContent = '';
        try {
            const answer = await host.check(view.state.doc.toString(), kind, context.checkInputs);
            if (!answer?.available) {
                $('#programEditorCheckSummary').textContent = answer?.reason ?? 'The simulation engine is not available, so the program cannot be checked here.';
                panel.classList.add('failed');
                return;
            }
            const name = answer.program || 'The program';
            const problems = answer.problems ?? [];
            panel.classList.add(answer.ok ? 'passed' : 'failed');
            $('#programEditorCheckSummary').textContent = answer.ok ? `${name}: every check passed.` : `${name}: ${problemCountText(problems.length || 1)}.`;
            $('#programEditorCheckProblems').replaceChildren(...problems.map((problem) => Object.assign(document.createElement('li'), { textContent: problem })));
            const number = (value) => (Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : String(value));
            const outputs = Object.entries(answer.outputs ?? {}).map(([key, value]) => `${key} = ${number(value)}`);
            const memory = Object.entries(answer.memory ?? {}).map(([key, values]) => `${key} = ${[].concat(values).map(number).join(', ')}`);
            $('#programEditorCheckDetails').textContent = [
                outputs.length ? `Outputs at the model's values: ${outputs.join('; ')}.` : '',
                memory.length ? `Memory after three steps: ${memory.join('; ')}.` : ''
            ].filter(Boolean).join(' ');
        } catch (error) {
            panel.classList.add('failed');
            $('#programEditorCheckSummary').textContent = `The check could not run: ${error?.message ?? error}`;
        } finally {
            button.disabled = false;
            button.textContent = 'Check program';
        }
    });

    // ---- Opening -------------------------------------------------------------------------------------------------------------------
    function createView(source) {
        view?.destroy();
        const state = EditorState.create({
            doc: source,
            extensions: [
                basicSetup,
                kind === 'python' ? python() : cpp(),
                themeCompartment.of(buildThemeExtensions(activeTheme())),
                lintGutter(),
                linter(sourceLinter, { delay: 500 }),
                EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    session.edit(update.state.doc.toString());
                    refreshApplyState();
                    refreshFormat();
                })
            ]
        });
        view = new EditorView({ state, parent: $('#programEditorHost') });
        editor.view = view;
    }

    function load(payload) {
        kind = payload.kind === 'python' ? 'python' : 'cpp';
        title = payload.title ?? '';
        target = payload.target ?? null;
        context = { program: Boolean(payload.program), checkInputs: payload.checkInputs ?? {} };
        session.load(payload.source ?? '');
        diagnostics = [];
        showProblemCount('Checking…', 'unknown');
        host.setTitle(programEditorTitle(title));
        createView(session.source);
        refreshApplyState();
        $('#programEditorConvertPanel').hidden = true;
        $('#programEditorCheckPanel').hidden = true;
        pendingConversion = null;
        refreshFormat();
        applyActiveTheme();
        if (payload.convert && context.program && programSourceVersion(kind, session.source) === 1) showConversion();
    }

    function revealLineOrPort(payload) {
        const line = payload.line ?? portDeclarationLine(session.source, payload.port);
        if (line) goToLine(line, payload.column ?? 1);
        else view?.focus();
    }

    // A program to edit. The same program open with unsaved changes is only brought forward (at the asked line); another program asks
    // first whether to apply the changes to the one open. Answers whether the new program was loaded.
    async function open(payload = {}) {
        if (view && session.dirty) {
            if (sameTarget(payload.target ?? null, target) && payload.kind === kind) {
                revealLineOrPort(payload);
                return false;
            }
            if (!await mayLeave()) return false;
        }
        load(payload);
        revealLineOrPort(payload);
        return true;
    }

    const editor = {
        view: null,
        open,
        requestClose,
        apply,
        goToLine,
        get dirty() { return session.dirty; },
        get title() { return title; },
        get target() { return target; }
    };
    return editor;
}
