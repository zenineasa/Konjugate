/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a relationship, a source term or an edge group shows when it is written as a program (docs/proposals/tuningEditorsAndPrograms.md,
// "An objective that is a program": "A shared ProgramSourceSection class draws them"): the program's summary and preview with Edit program
// (docs/proposals/codeEditor.md, "The card"), an installed plugin's provider in its place when there is one, the Bindings heading with
// its ＋, where the bindings go, and the output key. The edge builder, the edge editor, the source-term editor, the edge group editor and
// each source-term row of the node builder had this markup and its small rules copied out; they now each make one of these into their
// own placeholder.
//
// The card never edits the source: the code editor window is the one place a program is edited. What a binding row is differs (a
// builder's form row, an edge's state or parameter, a node's own state), so each owner still draws its rows into `bindings` and says what
// its buttons do. The ids are given by the owner and kept as they were, so what already finds an element by its id still does; an owner
// drawn more than once names its parts by class instead, and each section finds its own inside its container.

import { programSummary } from './programSummary.mjs';

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The program's summary on a card: "PidController · C++" with at most one status, what it reads and sets, its first lines (a click on one
// opens the editor at that line) and one button, Edit program, or, with no program yet, "No program yet." and Write program.
export class ProgramSummaryView {
    // container: where it is drawn. openId / openClass: the button's id or class, kept as the owner's tests and tours find it.
    // bindsInPorts: the program's inputs are bound in the code editor's Ports, which a link under its reads line opens.
    constructor({ container, openId = '', openClass = '', bindsInPorts = false }) {
        container.classList.add('programSummary');
        container.innerHTML = `
            <div class="equationHeading programSummaryHeading"><h3>Program</h3><button class="programStatus" type="button" hidden></button></div>
            <p class="programIdentity" hidden></p>
            <p class="programBindingsLine programReads" hidden><span class="programLineLabel">reads</span><span class="programLineItems"></span></p>
            <p class="programBindingsLine programSets" hidden><span class="programLineLabel">sets</span><span class="programLineItems"></span></p>
            ${bindsInPorts ? '<button class="programBindLink linkButton" type="button" hidden>Bind its inputs in Ports ›</button>' : ''}
            <div class="programPreview" hidden aria-label="The program's first lines; click one to edit the program there"></div>
            <p class="programEmpty" hidden>No program yet.</p>
            <button${openId ? ` id="${escapeHtml(openId)}"` : ''} class="programEditButton${openClass ? ` ${escapeHtml(openClass)}` : ''}" type="button">Edit program</button>`;
        this.container = container;
        this.openButton = container.querySelector('.programEditButton');
        this.statusButton = container.querySelector('.programStatus');
        this.handlers = [];
        this.status = null;
        this.summary = null;
        this.details = null;
        this.openButton.addEventListener('click', () => this.open(this.summary?.empty ? { write: true } : {}));
        container.querySelector('.programBindLink')?.addEventListener('click', () => this.open({ showPorts: true }));
        // The status opens the editor where it points: an older program on its conversion, a problem at its line.
        this.statusButton.addEventListener('click', () => {
            if (this.status?.kind === 'older') this.open({ convert: true });
            else if (this.status?.kind === 'problem') this.open(this.status.line ? { line: this.status.line } : {});
        });
        container.querySelector('.programPreview').addEventListener('click', (event) => {
            const line = event.target.closest('[data-line]');
            if (line) this.open({ line: Number(line.dataset.line) });
        });
    }

    open(options) { for (const handler of this.handlers) handler(options); }
    onOpen(handler) { this.handlers.push(handler); }

    // { kind, source, reads: [{ key, label }], sets: [{ key, label }], record } (programSummary.mjs).
    render(details) {
        const summary = programSummary(details);
        this.details = details;
        this.summary = summary;
        this.status = summary.status;
        const $ = (selector) => this.container.querySelector(selector);
        this.container.dataset.programEmpty = String(summary.empty);
        $('.programEmpty').hidden = !summary.empty;
        this.openButton.textContent = summary.empty ? 'Write program' : 'Edit program';
        const identity = $('.programIdentity');
        identity.hidden = summary.empty;
        identity.textContent = summary.name ? `${summary.name} · ${summary.language}` : summary.language;
        this.statusButton.hidden = !summary.status;
        this.statusButton.textContent = summary.status?.text ?? '';
        this.statusButton.className = `programStatus${summary.status ? ` ${summary.status.kind}` : ''}`;
        this.statusButton.disabled = summary.status?.kind === 'passed';
        for (const [selector, entries] of [['.programReads', summary.reads], ['.programSets', summary.sets]]) {
            const line = $(selector);
            line.hidden = summary.empty || !entries.length;
            line.querySelector('.programLineItems').replaceChildren(...entries.flatMap((entry, index) => [
                ...(index ? [document.createTextNode(', ')] : []),
                Object.assign(document.createElement('span'), { className: entry.unbound ? 'unbound' : '', textContent: entry.text })
            ]));
        }
        const bindLink = $('.programBindLink');
        if (bindLink) bindLink.hidden = summary.empty;
        const preview = $('.programPreview');
        preview.hidden = summary.empty;
        preview.replaceChildren(...summary.preview.map((line) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'programPreviewLine';
            row.dataset.line = String(line.number);
            row.title = `Edit the program at line ${line.number}`;
            const number = Object.assign(document.createElement('span'), { className: 'programPreviewNumber', textContent: String(line.number) });
            const code = document.createElement('code');
            code.append(...line.tokens.map((token) => (token.type
                ? Object.assign(document.createElement('span'), { className: `token-${token.type}`, textContent: token.text })
                : document.createTextNode(token.text))));
            if (!line.tokens.length) code.textContent = ' ';
            row.append(number, code);
            return row;
        }));
    }
}

export class ProgramSourceSection {
    // container: the element the section is drawn into (its own visibility stays the owner's). ids: { code, open, pluginFields,
    // pluginSelect, addBinding, bindings, outputKey }; `code`, `pluginFields` and `pluginSelect` only for an owner that offers installed
    // plugin providers. classes: the same names, for an owner drawn more than once, each part found by its class inside the container.
    // bindingHint, pluginHint, outputPlaceholder: the owner's words. bindingsClass: a class for the rows' container. bindingRows: the
    // owner's own binding rows (an edge group's, which has no Ports); otherwise its inputs are bound in the code editor's Ports.
    constructor({ container, ids = {}, classes = {}, bindingHint = '', pluginHint = null, outputPlaceholder, bindingsClass = '', bindingRows = false }) {
        const names = { ...ids, ...classes };
        // A part's id or its own class, with the classes it always has.
        const attributes = (name, always = '') => {
            const classList = [always, classes[name]].filter(Boolean).join(' ');
            return `${ids[name] ? ` id="${escapeHtml(ids[name])}"` : ''}${classList ? ` class="${escapeHtml(classList)}"` : ''}`;
        };
        const id = (name) => attributes(name);
        container.innerHTML = `
            <div${attributes('code', 'programSummaryHost')}></div>
            ${names.pluginFields ? `<div${id('pluginFields')} hidden>
                <label class="editorField"><span>Provider</span><select${id('pluginSelect')}></select></label>
                <p class="builderHint">${escapeHtml(pluginHint ?? '')}</p>
            </div>` : ''}
            ${bindingRows ? `<h3>Bindings <button${id('addBinding')} type="button">＋</button></h3>
            <p class="builderHint">${escapeHtml(bindingHint)}</p>
            <div${attributes('bindings', bindingsClass)}></div>` : ''}
            <label class="editorField programSingleOutput"><span>Output key</span><input${id('outputKey')} autocomplete="off" placeholder="${escapeHtml(outputPlaceholder)}"></label>
            <div class="programOutputRows" hidden></div>
            <button class="addProgramOutput" type="button" hidden title="A program in the current format can give this relationship several outputs, each reaching a state of either end">＋ Another output</button>`;
        const find = (name) => {
            if (ids[name]) return container.querySelector(`#${CSS.escape(ids[name])}`);
            return classes[name] ? container.querySelector(`.${CSS.escape(classes[name])}`) : null;
        };
        this.container = container;
        this.code = container.querySelector('.programSummaryHost');
        this.summary = new ProgramSummaryView({ container: this.code, openId: ids.open ?? '', openClass: classes.open ?? '', bindsInPorts: !bindingRows });
        this.openButton = this.summary.openButton;
        this.pluginFields = find('pluginFields');
        this.pluginSelect = find('pluginSelect');
        this.addBindingButton = find('addBinding');
        this.bindings = find('bindings');
        this.outputKeyField = find('outputKey');
        // Several outputs (a relationship's program in the current format): a row each, and the way to add one; the owner draws them.
        this.singleOutput = container.querySelector('.programSingleOutput');
        this.outputRows = container.querySelector('.programOutputRows');
        this.addOutputButton = container.querySelector('.addProgramOutput');
        this.details = { kind: 'cpp', source: '', reads: [], sets: [], record: null };
    }

    get source() { return this.details.source; }

    // The program as the card shows it: { kind, source, reads, sets, record } (programSummary.mjs); what is not given stays as it was.
    show(details) {
        this.details = { ...this.details, ...details };
        this.summary.render(this.details);
    }

    get outputKey() { return this.outputKeyField.value; }
    set outputKey(key) { this.outputKeyField.value = key ?? ''; }

    // A program's own source, or an installed plugin's provider in its place.
    showPlugin(plugin) {
        if (this.code) this.code.hidden = plugin;
        if (this.pluginFields) this.pluginFields.hidden = !plugin;
    }

    // handler({ line, convert, write }): Edit program (or Write program), a preview line, or the status.
    onOpenEditor(handler) { this.summary.onOpen(handler); }
    onAddBinding(handler) { this.addBindingButton?.addEventListener('click', handler); }
    onOutputKeyChange(handler) { this.outputKeyField.addEventListener('change', handler); }
}
