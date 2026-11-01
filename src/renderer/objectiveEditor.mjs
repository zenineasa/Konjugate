/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The equation editor, for a number a tuning wants: its objective, or a limit it must stay within (docs/proposals/tuningEditorsAndPrograms.md).
// It is an EquationEditor that is given the names an objective may use (states, parameters, measured columns) instead of an edge's
// references, checks the formula as an objective (the summaries over a run are allowed, and the result must be one number), and adds
// buttons that put a summary around what is selected. The engine has the last word on whether a formula is a single number, so once the
// formula reads, it is asked, a moment after typing stops, and its answer is what the line under the formula says.

import { EquationEditor } from './equationEditor.mjs';
import { latexToObjectiveText, objectiveNameLatex } from '../objectiveText.mjs';

export class ObjectiveEditor extends EquationEditor {
    #names = [];
    #text = null;
    #pending = null;
    #latest = 0;

    // checkWithEngine(text) -> Promise<{ available, valid, message }>, or null for no second opinion; `delay` is how long typing must pause.
    constructor({ checkWithEngine = null, delay = 300, ...options }) {
        super(options);
        this.checkWithEngine = checkWithEngine;
        this.delay = delay;
    }

    get validMessage() {
        return 'Valid objective';
    }

    // The objective in the engine's text, once the formula reads; null before that.
    get text() {
        return this.#text;
    }

    setNames(names) {
        this.#names = names;
    }

    validate(latex) {
        const result = latexToObjectiveText(latex, this.#names);
        this.#text = result.valid ? result.text : null;
        return result;
    }

    diagnose(bindings = [], latex = this.latex) {
        clearTimeout(this.#pending);
        const validation = super.diagnose(bindings, latex);
        if (validation.valid && this.checkWithEngine) {
            const ticket = ++this.#latest;
            this.#pending = setTimeout(async () => {
                const verdict = await this.checkWithEngine(validation.text).catch(() => null);
                // An answer to something no longer on the screen says nothing.
                if (ticket === this.#latest && verdict?.available && !verdict.valid) this.showVerdict(false, verdict.message);
            }, this.delay);
        } else {
            this.#latest += 1;
        }
        return validation;
    }

    // Puts a name where the cursor is, as any reference is.
    insertName(name) {
        this.insert(objectiveNameLatex(name));
    }

    // Puts a summary around what is selected, or opens an empty one to fill in.
    insertSummary(summary) {
        if (!this.canEdit()) return;
        if (this.mathField.hidden) {
            const start = this.source.selectionStart;
            const end = this.source.selectionEnd;
            this.source.setRangeText(summary.template.replace('#@', this.source.value.slice(start, end)), start, end, 'end');
            this.source.dispatchEvent(new Event('input', { bubbles: true }));
            this.source.focus();
            return;
        }
        const selected = this.mathField.selection?.ranges?.some(([from, to]) => to > from);
        this.mathField.insert(selected ? summary.template : summary.template.replace('#@', '#?'), { selectionMode: 'placeholder' });
        this.mathField.focus();
    }
}

// A limit is written the same way: a number from the run to keep at most, or at least, some value.
export class LimitEditor extends ObjectiveEditor {
    get validMessage() {
        return 'Valid limit';
    }
}
