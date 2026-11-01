/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The visual equation editor every formula in the canvas is written in (docs/proposals/tuningEditorsAndPrograms.md): a maths field and a
// LaTeX textarea kept in step, the Visual / LaTeX buttons, inserting a reference at the cursor, a line saying whether the formula is
// valid, and a row of reference buttons. An edge's equation, a source term's, an edge group's, the edge builder's and a tuning objective
// are all one of these; what differs between them (what the references are, what is checked, what a change does to the model) is what
// each owner hands in, never a copy of this. Subclasses change what is checked or what a reference button inserts.

import { latexForBinding, validateEquationLatex } from '../equationModel.mjs';

export function bindingInsertTitle(binding) {
    if (binding.kind === 'time') return 'Insert simulation time (seconds)';
    return binding.kind === 'parameter' ? 'Insert parameter' : 'Insert state reference';
}

// A row of buttons drawn from a list of { label, title, onClick }.
export class ReferenceChips {
    constructor(container) {
        this.container = container;
    }

    render(items) {
        this.container.replaceChildren(...items.map((item) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = item.label;
            button.title = item.title ?? '';
            button.addEventListener('click', item.onClick);
            return button;
        }));
    }
}

// Elements, all optional but `mathField` and `source`:
//   mathField, source   the <math-field> and the LaTeX <textarea>
//   diagnostics         where the validity line is written
//   modeButtons         the Visual / LaTeX buttons; each carries its mode (`visual` or `latex`) in the data attribute named by `modeKey`
//   references          the container the reference buttons are drawn into
// Behaviour handed in by the owner:
//   onInput(latex, origin)   the formula changed by typing ('visual' or 'latex'); the other field has already been brought in step
//   onCommit()               an edit ended (the field lost focus or Enter), for owners that group edits into one undo step
//   canEdit()                false while the formula must not change (results are open); inserting then does nothing
//   onModeChange(mode)       return true to say the owner handled showing and hiding the fields itself
export class EquationEditor {
    #visible = true;

    constructor({ mathField, source, diagnostics = null, modeButtons = [], modeKey = null, references = null, onInput = null, onCommit = null, canEdit = () => true, onModeChange = null }) {
        this.mathField = mathField;
        this.source = source;
        this.diagnostics = diagnostics;
        this.modeButtons = modeButtons;
        this.modeKey = modeKey;
        this.chips = references ? new ReferenceChips(references) : null;
        this.canEdit = canEdit;
        this.onModeChange = onModeChange;
        const active = modeButtons.find((button) => button.classList.contains('active'));
        this.mode = active && this.#modeOf(active) === 'latex' ? 'latex' : 'visual';
        mathField.addEventListener('input', (event) => this.#typed(event.target.value, 'visual', onInput));
        source.addEventListener('input', (event) => this.#typed(event.target.value, 'latex', onInput));
        if (onCommit) {
            mathField.addEventListener('change', () => onCommit());
            source.addEventListener('change', () => onCommit());
        }
        modeButtons.forEach((button) => button.addEventListener('click', () => this.setMode(this.#modeOf(button), { focus: true })));
    }

    #modeOf(button) {
        return button.dataset[this.modeKey];
    }

    #typed(latex, origin, onInput) {
        // The field that was not typed in follows, without telling anyone.
        if (origin === 'visual') this.source.value = latex;
        else this.mathField.setValue(latex, { silenceNotifications: true });
        onInput?.(latex, origin);
    }

    // The formula as it stands: what is showing, so that it is right even in a field the owner is about to refresh.
    get latex() {
        return this.mathField.hidden ? this.source.value : this.mathField.value;
    }

    // Shows a formula the model holds, in both fields.
    load(latex) {
        this.mathField.value = latex;
        this.source.value = latex;
    }

    // Shows the field of the current mode, or neither (a program is written in place of the equation).
    show(visible = true) {
        this.#visible = visible;
        this.mathField.hidden = !visible || this.mode === 'latex';
        this.source.hidden = !visible || this.mode !== 'latex';
    }

    setMode(mode, { focus = false } = {}) {
        this.mode = mode === 'latex' ? 'latex' : 'visual';
        this.modeButtons.forEach((button) => button.classList.toggle('active', this.#modeOf(button) === this.mode));
        if (this.onModeChange?.(this.mode)) return;
        this.show(this.#visible);
        if (focus) this.focus();
    }

    focus() {
        (this.mathField.hidden ? this.source : this.mathField).focus();
    }

    // Puts a piece of LaTeX at the cursor of whichever field is showing.
    insert(latex) {
        if (!this.canEdit()) return;
        if (this.mathField.hidden) {
            this.source.setRangeText(latex, this.source.selectionStart, this.source.selectionEnd, 'end');
            this.source.dispatchEvent(new Event('input', { bubbles: true }));
            this.source.focus();
        } else {
            this.mathField.insert(latex);
            this.mathField.focus();
        }
    }

    insertBinding(binding) {
        this.insert(latexForBinding(binding));
    }

    // What is checked about a formula; a subclass changes it (the tuning objective is checked differently from an equation).
    validate(latex, bindings) {
        return validateEquationLatex(latex, bindings);
    }

    // What the line says when all is well; a subclass says what is true of its own kind of formula.
    get validMessage() {
        return 'Valid expression · MathJSON ready';
    }

    // Writes the verdict on the line under the formula.
    showVerdict(valid, message) {
        if (!this.diagnostics) return;
        this.diagnostics.classList.toggle('valid', valid);
        this.diagnostics.textContent = message;
    }

    // Checks the formula and says so; returns the validation for owners that act on it.
    diagnose(bindings, latex = this.latex) {
        const validation = this.validate(latex, bindings);
        this.showVerdict(validation.valid, validation.valid ? this.validMessage : validation.errors.join(' '));
        return validation;
    }

    // Draws one button per reference; each inserts that reference's LaTeX.
    renderReferences(bindings) {
        this.chips?.render(bindings.map((binding) => ({
            label: binding.label, title: bindingInsertTitle(binding), onClick: () => this.insertBinding(binding)
        })));
    }
}
