/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingInsertTitle, EquationEditor, ReferenceChips } from '../src/renderer/equationEditor.mjs';

// Just enough of a page for the editor: elements that hold a value, can be hidden and focused, and send events.
class FakeElement extends EventTarget {
    constructor(dataset = {}) {
        super();
        this.hidden = false;
        this.value = '';
        this.dataset = dataset;
        this.children = [];
        this.focused = 0;
        this.textContent = '';
        this.selectionStart = 0;
        this.selectionEnd = 0;
        const classes = new Set();
        this.classList = { add: (name) => classes.add(name), contains: (name) => classes.has(name), toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) };
    }
    focus() { this.focused += 1; }
    setValue(value) { this.value = value; }
    insert(latex) { this.value += latex; }
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); }
    replaceChildren(...children) { this.children = children; }
    click() { this.dispatchEvent(new Event('click')); }
}
globalThis.document = { createElement: () => new FakeElement() };

function make(options = {}) {
    const mathField = new FakeElement();
    const source = new FakeElement();
    const visual = new FakeElement({ mode: 'visual' });
    const latex = new FakeElement({ mode: 'latex' });
    visual.classList.add('active');
    const diagnostics = new FakeElement();
    const references = new FakeElement();
    const calls = [];
    const editor = new EquationEditor({
        mathField, source, diagnostics, modeButtons: [visual, latex], modeKey: 'mode', references,
        onInput: (value, origin) => calls.push(['input', value, origin]), onCommit: () => calls.push(['commit']), ...options
    });
    return { editor, mathField, source, visual, latex, diagnostics, references, calls };
}
const type = (element, value) => { element.value = value; element.dispatchEvent(new Event('input')); };

test('typing in either field brings the other along and tells the owner where it came from', () => {
    const { mathField, source, calls } = make();
    mathField.setValue = (value) => { mathField.value = value; };
    type(mathField, 'k\\cdot x');
    assert.equal(source.value, 'k\\cdot x');
    type(source, 'k');
    assert.equal(mathField.value, 'k');
    assert.deepEqual(calls, [['input', 'k\\cdot x', 'visual'], ['input', 'k', 'latex']]);
});

test('the mode buttons choose which field shows, and a program hides both', () => {
    const { editor, mathField, source, visual, latex } = make();
    assert.equal(editor.mode, 'visual');
    latex.click();
    assert.equal(editor.mode, 'latex');
    assert.deepEqual([mathField.hidden, source.hidden], [true, false]);
    assert.ok(latex.classList.contains('active') && !visual.classList.contains('active'));
    assert.equal(source.focused, 1, 'the keyboard goes to the field that appeared');
    editor.show(false);
    assert.deepEqual([mathField.hidden, source.hidden], [true, true]);
    visual.click();
    assert.deepEqual([mathField.hidden, source.hidden], [true, true], 'changing mode does not bring back an equation that is not in use');
    editor.show(true);
    assert.deepEqual([mathField.hidden, source.hidden], [false, true]);
});

test('an owner that shows the fields itself can take over a mode change', () => {
    const seen = [];
    const { editor, mathField, latex } = make({ onModeChange: (mode) => { seen.push(mode); return true; } });
    latex.click();
    assert.deepEqual(seen, ['latex']);
    assert.equal(editor.mode, 'latex');
    assert.equal(mathField.hidden, false, 'left as the owner has it');
});

test('a reference goes in at the cursor of the field that is showing, unless editing is not allowed', () => {
    let allowed = true;
    const { editor, mathField, source, latex } = make({ canEdit: () => allowed });
    editor.insertBinding({ kind: 'parameter', symbol: 'k' });
    assert.match(mathField.value, /k/);
    latex.click();
    source.value = 'a+b';
    source.selectionStart = 1;
    source.selectionEnd = 1;
    editor.insert('X');
    assert.equal(source.value, 'aX+b');
    allowed = false;
    editor.insert('Y');
    assert.equal(source.value, 'aX+b');
    assert.equal(mathField.value, 'aX+b', 'the typed insertion also reached the other field');
});

test('diagnosing says what is wrong, or that it is valid, and returns the verdict', () => {
    const { editor, diagnostics } = make();
    const bindings = [{ kind: 'parameter', symbol: 'k', label: 'k' }];
    assert.equal(editor.diagnose(bindings, 'k').valid, true);
    assert.equal(diagnostics.textContent, 'Valid expression · MathJSON ready');
    assert.ok(diagnostics.classList.contains('valid'));
    assert.equal(editor.diagnose(bindings, 'k+').valid, false);
    assert.ok(!diagnostics.classList.contains('valid'));
    assert.ok(diagnostics.textContent.length > 0 && diagnostics.textContent !== 'Valid expression · MathJSON ready');
});

test('a subclass can change what is checked', () => {
    class Strict extends EquationEditor {
        validate(latex) { return { valid: latex === 'ok', errors: ['Only ok is allowed.'] }; }
    }
    const make2 = () => new Strict({ mathField: new FakeElement(), source: new FakeElement(), diagnostics: new FakeElement() });
    const editor = make2();
    assert.equal(editor.diagnose([], 'ok').valid, true);
    assert.equal(editor.diagnose([], 'no').valid, false);
    assert.equal(editor.diagnostics.textContent, 'Only ok is allowed.');
});

test('reference buttons are drawn from a list, each inserting its own reference', () => {
    const { editor, references, mathField } = make();
    editor.renderReferences([{ kind: 'parameter', symbol: 'k', label: 'k' }, { kind: 'time', symbol: 't', label: 't' }]);
    assert.deepEqual(references.children.map((button) => [button.textContent, button.title]), [['k', 'Insert parameter'], ['t', 'Insert simulation time (seconds)']]);
    references.children[0].click();
    assert.ok(mathField.value.length > 0);
    const chips = new ReferenceChips(new FakeElement());
    chips.render([{ label: 'a', onClick: () => {} }]);
    assert.equal(chips.container.children.length, 1);
    assert.equal(bindingInsertTitle({ kind: 'state' }), 'Insert state reference');
});

// ---- the objective and limit editors -------------------------------------------------------------------------------------------------
import { LimitEditor, ObjectiveEditor } from '../src/renderer/objectiveEditor.mjs';
import { objectiveSummaries } from '../src/objectiveText.mjs';

const makeObjective = (options = {}, Kind = ObjectiveEditor) => {
    const mathField = new FakeElement();
    const source = new FakeElement();
    const diagnostics = new FakeElement();
    const editor = new Kind({ mathField, source, diagnostics, delay: 0, ...options });
    editor.setNames(['tank', 'k']);
    return { editor, mathField, source, diagnostics };
};
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

test('an objective is checked as one: summaries are allowed, and the engine text is kept', () => {
    const { editor, diagnostics } = makeObjective();
    assert.equal(editor.diagnose([], '\\max\\left(\\mathrm{tank}\\right)+k').valid, true);
    assert.equal(editor.text, 'k + max(tank)', 'the parser puts a sum in its own order');
    assert.equal(diagnostics.textContent, 'Valid objective: k, plus the highest tank reached in the run', 'it says what it computes');
    editor.setNames(['tank', 'k'], new Map([['tank', 'Water tank · Temperature']]));
    editor.diagnose([], '\\max\\left(\\mathrm{tank}\\right)');
    assert.equal(diagnostics.textContent, 'Valid objective: the highest Water tank · Temperature reached in the run', 'names are called as their chips are');
    assert.equal(editor.diagnose([], 'k+').valid, false);
    assert.equal(editor.text, null, 'nothing to run while it does not read');
    assert.ok(!diagnostics.classList.contains('valid'));
});

test('a limit is the same editor with its own wording', () => {
    const { editor, diagnostics } = makeObjective({}, LimitEditor);
    assert.ok(editor instanceof ObjectiveEditor);
    editor.diagnose([], '\\max\\left(\\mathrm{tank}\\right)');
    assert.equal(diagnostics.textContent, 'Valid limit: the highest tank reached in the run');
});

test('the engine is asked once the formula reads, and its answer replaces the line, unless it is stale', async () => {
    const asked = [];
    let reply = { available: true, valid: true };
    const { editor, diagnostics } = makeObjective({ checkWithEngine: async (text) => { asked.push(text); return reply; } });
    editor.diagnose([], '\\mathrm{tank}');
    editor.diagnose([], 'k');
    await wait();
    assert.deepEqual(asked, ['k'], 'typing again cancels the check of what was typed before');
    assert.equal(diagnostics.textContent, 'Valid objective: k', 'the engine had no complaint about k');
    reply = { available: true, valid: false, message: 'The engine says no.' };
    editor.diagnose([], '\\mathrm{tank}');
    await wait();
    assert.equal(diagnostics.textContent, 'The engine says no.');
    reply = { available: false };
    editor.diagnose([], 'k');
    await wait();
    assert.equal(diagnostics.textContent, 'Valid objective: k', 'with no engine to ask, the formula is taken as read');
    editor.diagnose([], 'k+');
    assert.equal(asked.length, 3, 'a formula that does not read is not sent to the engine');
});

test('a summary goes around the selection in the LaTeX field, and a name goes in as a reference does', () => {
    const { editor, source, mathField } = makeObjective();
    mathField.hidden = true;
    source.hidden = false;
    source.value = 'a+b';
    source.selectionStart = 0;
    source.selectionEnd = 1;
    editor.insertSummary(objectiveSummaries.find((summary) => summary.id === 'max'));
    assert.equal(source.value, '\\max\\left(a\\right)+b');
    editor.insertName('tank');
    assert.match(source.value, /\\mathrm\{tank\}/);
    const visual = makeObjective();
    const inserted = [];
    visual.mathField.insert = (latex, options) => inserted.push([latex, options]);
    visual.editor.insertSummary(objectiveSummaries.find((summary) => summary.id === 'final'));
    assert.deepEqual(inserted, [['\\lim_{t\\to T}\\left(#?\\right)', { selectionMode: 'placeholder' }]]);
});
