/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a relationship, a source term or an edge group shows when it is written as a program (docs/proposals/tuningEditorsAndPrograms.md,
// "An objective that is a program": "A shared ProgramSourceSection class draws them"): the source with Open code editor and Reset
// template, an installed plugin's provider in its place when there is one, the Bindings heading with its ＋, where the bindings go, and
// the output key. The edge builder, the edge editor, the source-term editor, the edge group editor and each source-term row of the node
// builder had this markup and its small rules copied out; they now each make one of these into their own placeholder.
//
// The section draws the parts and keeps the rules that are the same everywhere (Reset template is offered once there is a source to
// reset). What a binding row is differs (a builder's form row, an edge's state or parameter, a node's own state), so each owner still
// draws its rows into `bindings` and says what its buttons do. The ids are given by the owner and kept as they were, so what already
// finds an element by its id still does; an owner drawn more than once (a node builder's source-term rows) names its parts by class
// instead, and each section finds its own inside its container.

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class ProgramSourceSection {
    // container: the element the section is drawn into (its own visibility stays the owner's). ids: { code, open, reset, source,
    // pluginFields, pluginSelect, addBinding, bindings, outputKey }; `code`, `pluginFields` and `pluginSelect` only for an owner that
    // offers installed plugin providers. classes: the same names, for an owner drawn more than once, each part found by its class
    // inside the container. rows: the source box's height. bindingHint, pluginHint, outputPlaceholder: the owner's words.
    // bindingsClass: a class for the rows' container.
    constructor({ container, ids = {}, classes = {}, rows = 12, bindingHint, pluginHint = null, outputPlaceholder, bindingsClass = '' }) {
        const names = { ...ids, ...classes };
        // A part's id or its own class, with the classes it always has.
        const attributes = (name, always = '') => {
            const classList = [always, classes[name]].filter(Boolean).join(' ');
            return `${ids[name] ? ` id="${escapeHtml(ids[name])}"` : ''}${classList ? ` class="${escapeHtml(classList)}"` : ''}`;
        };
        const id = (name) => attributes(name);
        const code = `
            <div class="equationHeading"><h3>Provider source</h3><div class="templateButtonGroup">
                <button${attributes('open', 'templateButton')} type="button">Open code editor</button>
                <button${attributes('reset', 'templateButton')} type="button" hidden>Reset template</button>
            </div></div>
            <p class="builderHint">Implement <code>describe()</code>/<code>evaluate()</code> using the Konjugate provider SDK. Source is stored with the project and compiled or launched locally.</p>
            <textarea${attributes('source', 'providerSource')} rows="${Number(rows)}" spellcheck="false" placeholder="#include &lt;konjugate/relationshipProvider.hpp&gt;…"></textarea>`;
        container.innerHTML = `
            ${names.code ? `<div${id('code')}>${code}</div>` : code}
            ${names.pluginFields ? `<div${id('pluginFields')} hidden>
                <label class="editorField"><span>Provider</span><select${id('pluginSelect')}></select></label>
                <p class="builderHint">${escapeHtml(pluginHint ?? '')}</p>
            </div>` : ''}
            <h3>Bindings <button${id('addBinding')} type="button">＋</button></h3>
            <p class="builderHint">${escapeHtml(bindingHint)}</p>
            <div${attributes('bindings', bindingsClass)}></div>
            <label class="editorField"><span>Output key</span><input${id('outputKey')} autocomplete="off" placeholder="${escapeHtml(outputPlaceholder)}"></label>`;
        const find = (name) => {
            if (ids[name]) return container.querySelector(`#${CSS.escape(ids[name])}`);
            return classes[name] ? container.querySelector(`.${CSS.escape(classes[name])}`) : null;
        };
        this.container = container;
        this.code = find('code');
        this.openButton = find('open');
        this.resetButton = find('reset');
        this.sourceField = find('source');
        this.pluginFields = find('pluginFields');
        this.pluginSelect = find('pluginSelect');
        this.addBindingButton = find('addBinding');
        this.bindings = find('bindings');
        this.outputKeyField = find('outputKey');
        // Typing a source in offers to put the template back.
        this.sourceField.addEventListener('input', () => this.refreshReset());
    }

    get source() { return this.sourceField.value; }

    // Shows a source, and offers Reset template once there is something to reset.
    set source(text) {
        this.sourceField.value = text ?? '';
        this.refreshReset();
    }

    get outputKey() { return this.outputKeyField.value; }
    set outputKey(key) { this.outputKeyField.value = key ?? ''; }

    refreshReset() {
        this.resetButton.hidden = !this.sourceField.value.trim();
    }

    // A program's own source, or an installed plugin's provider in its place.
    showPlugin(plugin) {
        if (this.code) this.code.hidden = plugin;
        if (this.pluginFields) this.pluginFields.hidden = !plugin;
    }

    onOpenEditor(handler) { this.openButton.addEventListener('click', handler); }
    onReset(handler) { this.resetButton.addEventListener('click', handler); }
    onAddBinding(handler) { this.addBindingButton.addEventListener('click', handler); }
    onOutputKeyChange(handler) { this.outputKeyField.addEventListener('change', handler); }
}
