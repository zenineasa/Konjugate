/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor itself (docs/proposals/codeEditor.md, "One editor on the web"): CodeMirror, the toolbar, Convert, Check, Apply, Cancel
// and the unsaved-changes guard. Neither host owns it. The desktop's window (src/providerEditor/renderer.mjs) and the web edition's
// in-page panel (src/renderer/webShims/providerEditor.mjs) each hand it an element to fill and a host:
//
//   validate(source, kind)        → { valid, diagnostics: [{ line, column, severity, message }] }, { valid: null, message } when
//                                    the program cannot be checked here (or its check took too long), or { superseded: true } when a
//                                    newer check took its place (src/lintScheduler.mjs)
//   check(source, kind, inputs)   → the engine's Check program answer, { available, ok, program, problems, outputs, memory, reason? }
//   apply(source, target)         → { applied, error? } from the project
//   close()                       → closes the window or hides the panel (the editor has already decided it may)
//   setTitle(text)                → "Heater · Program"
//   dirtyChanged(dirty)           → optional: told whenever there come to be, or stop being, unsaved changes
//   describe(source, kind, inputs) → optional: the engine's description of a version 2 program (describeProgram: its ports, memory and
//                                    clock with their lines), or { available: false, reason } where it cannot be read
//   reportStatus(status)          → optional: what lint and Check found on a source, { kind, source, problems: [{ line, message }],
//                                    checkPassed }, for the card's status line
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
import { formatPortValue, portsTable } from './portsTable.mjs';
import { lintHash } from '../lintScheduler.mjs';
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
        <button id="programEditorTemplate" class="secondaryButton" type="button" hidden title="Write the template again from the program's bindings (undo brings it back)">Reset template</button>
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
    <div class="programEditorBody">
        <div id="programEditorHost" class="programEditorHost"></div>
        <aside id="programEditorSide" class="programEditorSide" hidden>
            <div id="programEditorSideResize" class="sideResize" title="Drag to resize"></div>
            <div class="sideTabs">
                <button class="sideTab active" type="button" data-side-tab="ports">Ports</button>
                <span class="toolbarSpacer"></span>
                <button id="programEditorFold" class="foldButton" type="button" title="Fold the panel away" aria-label="Fold the panel away">›</button>
            </div>
            <div id="programEditorPorts" class="portsPanel" data-side-panel="ports">
                <p id="programEditorPortsNote" class="portsNote" hidden></p>
                <div id="programEditorPortsList" class="portsList" role="list"></div>
            </div>
        </aside>
        <button id="programEditorUnfold" class="unfoldButton" type="button" hidden title="Show the Ports panel">‹ Ports</button>
    </div>
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
    let templateSource = '';
    // What lint and Check last found, each for the source it looked at; reported to the card together.
    let lintResult = { source: null, problems: [] };
    let checkResult = { source: null, ok: false, problems: [] };
    function reportStatus() {
        const source = session.source;
        const problems = [
            ...(lintResult.source === source ? lintResult.problems : []),
            ...(checkResult.source === source && !checkResult.ok ? checkResult.problems.map((message) => ({ line: null, message })) : [])
        ];
        host.reportStatus?.({ kind, source, problems, checkPassed: checkResult.source === source && checkResult.ok && !problems.length });
    }

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

    // ---- The side panel: Ports (docs/proposals/codeEditor.md, "Ports: the program in its model") -----------------------------------
    // What the project says of the program's bindings ({ bindings, outputs }, portsTable.mjs), the engine's description of the source,
    // the last one that loaded (shown greyed while the source does not), and the port asked for.
    let portContext = { bindings: [], outputs: [] };
    let description = null;
    let lastGoodDescription = null;
    let portsNote = '';
    let portsStale = false;
    let selectedPort = null;
    let revealPortOnDescription = false;
    let describeSequence = 0;
    let describeTimer = null;
    const describeCache = new Map();
    const side = $('#programEditorSide');
    let sideFolded = read('konjugate.providerEditor.sideFolded') === '1';
    const storedWidth = Number(read('konjugate.providerEditor.sideWidth'));
    let sideWidth = Number.isFinite(storedWidth) && storedWidth >= 200 ? storedWidth : 300;

    function showSide(shown) {
        side.hidden = !shown || sideFolded;
        $('#programEditorUnfold').hidden = !shown || !sideFolded;
        side.style.width = `${sideWidth}px`;
    }
    $('#programEditorFold').addEventListener('click', () => { sideFolded = true; write('konjugate.providerEditor.sideFolded', '1'); showSide(sideShown()); });
    $('#programEditorUnfold').addEventListener('click', () => { sideFolded = false; write('konjugate.providerEditor.sideFolded', '0'); showSide(sideShown()); });
    $('#programEditorSideResize').addEventListener('pointerdown', (event) => {
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = side.getBoundingClientRect().width;
        const move = (moveEvent) => {
            const limit = Math.max(200, root.getBoundingClientRect().width - 240);
            sideWidth = Math.round(Math.min(limit, Math.max(200, startWidth + startX - moveEvent.clientX)));
            side.style.width = `${sideWidth}px`;
        };
        const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', end);
            write('konjugate.providerEditor.sideWidth', String(sideWidth));
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
    });
    const sideShown = () => context.program;

    function renderPorts() {
        const shown = description ?? (portsStale ? lastGoodDescription : null);
        const { rows } = portsTable(shown, portContext);
        const note = $('#programEditorPortsNote');
        note.hidden = !portsNote;
        note.textContent = portsNote;
        const list = $('#programEditorPortsList');
        list.classList.toggle('stale', Boolean(portsStale && shown));
        list.replaceChildren(...rows.map((row) => {
            const item = document.createElement('div');
            item.className = `portRow ${row.group} ${row.state}${row.key === selectedPort ? ' selected' : ''}`;
            item.setAttribute('role', 'listitem');
            item.dataset.port = row.key;
            item.dataset.group = row.group;
            if (row.line) {
                item.dataset.line = String(row.line);
                item.title = `Line ${row.line}`;
            }
            const head = document.createElement('div');
            head.className = 'portHead';
            head.append(
                Object.assign(document.createElement('span'), { className: 'portTag', textContent: row.tag }),
                Object.assign(document.createElement('span'), { className: 'portKey', textContent: row.key }),
                Object.assign(document.createElement('span'), { className: 'portUnit', textContent: row.unit }));
            item.append(head);
            const boundText = row.group === 'output' ? (row.bound ? `→ ${row.bound}${row.part ? ` · ${row.part}` : ''}` : '') : (row.bound ?? '');
            const value = formatPortValue(row.value);
            if (boundText || value) {
                const detail = document.createElement('div');
                detail.className = 'portDetail';
                detail.append(Object.assign(document.createElement('span'), { className: 'portBound', textContent: boundText }),
                    Object.assign(document.createElement('span'), { className: 'portValue', textContent: value }));
                item.append(detail);
            }
            if (row.note) item.append(Object.assign(document.createElement('div'), { className: 'portNote', textContent: row.note }));
            return item;
        }));
        if (!rows.length && !portsNote) list.append(Object.assign(document.createElement('p'), { className: 'portsEmpty', textContent: 'The program declares no ports yet.' }));
        list.querySelector('.portRow.selected')?.scrollIntoView({ block: 'nearest' });
    }
    // A click on a port goes to the line that declares it.
    $('#programEditorPortsList').addEventListener('click', (event) => {
        const row = event.target.closest('.portRow');
        if (!row) return;
        selectedPort = row.dataset.port;
        for (const other of $('#programEditorPortsList').querySelectorAll('.portRow')) other.classList.toggle('selected', other === row);
        if (row.dataset.line) goToLine(Number(row.dataset.line));
    });

    // The engine reads the program after a pause in typing, once per source (its answers kept by the source and the values it starts
    // from); an answer for a source since changed is dropped.
    function scheduleDescribe(delay = 900) {
        clearTimeout(describeTimer);
        if (!context.program) return;
        const source = session.source;
        if (programSourceVersion(kind, source) === 1 || !host.describe) {
            description = null;
            portsStale = false;
            portsNote = programSourceVersion(kind, source) === 1
                ? 'Older program format: its bindings only. Convert to version 2 to see its ports with their units, its memory and its clock.'
                : '';
            renderPorts();
            return;
        }
        describeTimer = setTimeout(() => describe(source), delay);
    }
    async function describe(source) {
        const sequence = ++describeSequence;
        const inputs = context.checkInputs ?? {};
        const cacheKey = `${kind}|${lintHash(source)}|${lintHash(JSON.stringify(inputs))}`;
        let answer = describeCache.get(cacheKey);
        if (!answer) {
            if (!lastGoodDescription) { portsNote = 'Reading the program’s ports…'; renderPorts(); }
            try { answer = await host.describe(source, kind, inputs); } catch (error) { answer = { available: false, reason: `The ports could not be read: ${error?.message ?? error}` }; }
            if (answer?.available && (answer.ok || answer.problems?.length)) {
                describeCache.set(cacheKey, answer);
                while (describeCache.size > 16) describeCache.delete(describeCache.keys().next().value);
            }
        }
        if (answer?.superseded || sequence !== describeSequence || source !== session.source) return;
        if (!answer?.available) {
            description = null;
            portsStale = false;
            portsNote = answer?.reason ?? 'The ports are read by the simulation engine, which is not available here: its bindings only.';
        } else if (answer.ok) {
            description = answer;
            lastGoodDescription = answer;
            portsStale = false;
            portsNote = '';
        } else {
            description = null;
            portsStale = true;
            const first = answer.problems?.[0];
            const problem = first ? `${first.message}${first.line ? ` (line ${first.line})` : ''}` : 'it does not load';
            portsNote = lastGoodDescription
                ? `The program does not load as it is, so these are its ports as they last were. ${problem}`
                : `The program does not load as it is: ${problem}`;
        }
        renderPorts();
        if (revealPortOnDescription && description) {
            revealPortOnDescription = false;
            const row = [...(description.inputs ?? []), ...(description.outputs ?? [])].find((port) => port.key === selectedPort);
            if (row?.line) goToLine(row.line);
        }
    }

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
        if (sequence !== validationSequence || result?.superseded) return []; // A newer keystroke superseded this request.
        if (result?.valid === null || result?.valid === undefined) {
            diagnostics = [];
            showProblemCount(result?.message ?? '', 'unknown');
            return [];
        }
        diagnostics = result.diagnostics ?? [];
        lintResult = { source, problems: result.valid ? [] : (diagnostics.length ? diagnostics.filter((diagnostic) => diagnostic.severity !== 'info' && diagnostic.severity !== 'warning') : [{ line: null, message: 'The program has a problem.' }]).map((diagnostic) => ({ line: diagnostic.line ?? null, message: diagnostic.message })) };
        reportStatus();
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

    // ---- Reset template: the program written again from its bindings, in one edit undo takes back ------------------------------------
    $('#programEditorTemplate').addEventListener('click', () => {
        if (!view || !templateSource) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: templateSource } });
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
            const checkedSource = view.state.doc.toString();
            const answer = await host.check(checkedSource, kind, context.checkInputs);
            if (answer?.available) {
                checkResult = { source: checkedSource, ok: Boolean(answer.ok), problems: answer.ok ? [] : (answer.problems?.length ? answer.problems : ['Check program found a problem.']) };
                reportStatus();
            }
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
                // C++ waits longer for a pause than Python: its check starts a compiler.
                linter(sourceLinter, { delay: kind === 'cpp' ? 800 : 500 }),
                EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    session.edit(update.state.doc.toString());
                    refreshApplyState();
                    refreshFormat();
                    scheduleDescribe();
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
        portContext = { bindings: payload.ports?.bindings ?? [], outputs: payload.ports?.outputs ?? [] };
        description = null;
        lastGoodDescription = null;
        portsStale = false;
        portsNote = '';
        selectedPort = payload.port ?? null;
        revealPortOnDescription = Boolean(payload.port) && !payload.line;
        showSide(sideShown());
        session.load(payload.source ?? '');
        templateSource = payload.templateSource ?? '';
        $('#programEditorTemplate').hidden = !templateSource;
        lintResult = { source: null, problems: [] };
        checkResult = { source: null, ok: false, problems: [] };
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
        // Write program: a new program starts from its template, unsaved until applied (undo leaves it empty again).
        if (payload.startWith && !session.source.trim()) view.dispatch({ changes: { from: 0, insert: payload.startWith } });
        if (payload.convert && context.program && programSourceVersion(kind, session.source) === 1) showConversion();
        renderPorts();
        scheduleDescribe(0);
    }

    function revealLineOrPort(payload) {
        const line = payload.line ?? portDeclarationLine(session.source, payload.port);
        if (payload.port) {
            selectedPort = payload.port;
            // A port the source does not name as written (Python's level_rate is the key levelRate) waits for the engine's line.
            revealPortOnDescription = !line;
            renderPorts();
        }
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
