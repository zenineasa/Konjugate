/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's apply, unsaved-changes and leaving rules (docs/proposals/codeEditor.md, "The window"), kept apart from any window or
// page so both hosts share them and a unit test can drive them. The source is "unsaved" while it differs from what was last loaded or
// applied: typing and then undoing back to it leaves nothing to save.

export function createEditorSession() {
    let savedSource = '';
    let currentSource = '';
    let applyingSource = null;
    let failure = '';

    const session = {
        get source() { return currentSource; },
        get dirty() { return currentSource !== savedSource; },
        get applying() { return applyingSource !== null; },
        get failure() { return failure; },
        // 'clean' (nothing to apply), 'dirty', 'applying' (a request in flight) or 'failed' (the project refused the last one; the
        // changes are still unsaved).
        get applyState() {
            if (applyingSource !== null) return 'applying';
            if (failure && session.dirty) return 'failed';
            return session.dirty ? 'dirty' : 'clean';
        },
        load(source) {
            savedSource = source ?? '';
            currentSource = savedSource;
            applyingSource = null;
            failure = '';
        },
        edit(source) {
            currentSource = source ?? '';
        },
        // The source to send, or null when there is nothing to apply or an apply is already in flight (a second one would race it).
        beginApply() {
            if (applyingSource !== null || !session.dirty) return null;
            applyingSource = currentSource;
            failure = '';
            return applyingSource;
        },
        finishApply(result) {
            const applied = applyingSource;
            applyingSource = null;
            if (result?.applied) {
                savedSource = applied ?? savedSource;
                failure = '';
            } else {
                failure = result?.error || 'The project did not take the change.';
            }
            return Boolean(result?.applied);
        },
        // Closing (the window's ×, the panel's ×, the project window closing): 'close' at once, or 'ask' first.
        closeAction() {
            return session.dirty ? 'ask' : 'close';
        }
    };
    return session;
}

// Leaving with unsaved changes: asks "Apply your changes to …?" and answers whether the editor may go. Apply leaves only once the
// project took the change; Don't apply leaves; Keep editing stays. ask() resolves to 'apply', 'discard' or 'keep'; apply() to the
// project's { applied, error } answer.
export async function confirmLeave(session, { ask, apply }) {
    if (session.closeAction() === 'close') return true;
    const answer = await ask();
    if (answer === 'discard') return true;
    if (answer !== 'apply') return false;
    const source = session.beginApply();
    if (source === null) return !session.dirty;
    let result;
    try { result = await apply(source); } catch (error) { result = { applied: false, error: error?.message ?? String(error) }; }
    return session.finishApply(result) && !session.dirty;
}

// "Heater · Program": what the window and panel are called.
export function programEditorTitle(title) {
    const name = String(title ?? '').trim();
    return name ? `${name} · Program` : 'Program';
}

// "Apply your changes to Heater's program?"
export function leaveQuestion(title) {
    const name = String(title ?? '').trim();
    return name ? `Apply your changes to ${name}’s program?` : 'Apply your changes to the program?';
}

// Two targets name the same program (the same relationship, node, part or objective).
export function sameTarget(a, b) {
    if (!a || !b) return a === b;
    return JSON.stringify(a) === JSON.stringify(b);
}

// The 1-based line a port is declared on, or null: the first line naming its key in quotes (C++'s {this, "measurement"}, an older
// program's 'measurement'), or a Python class attribute declaring it (measurement = Input("K")).
export function portDeclarationLine(source, port) {
    if (!port) return null;
    const lines = String(source ?? '').split('\n');
    const key = port.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`["']${key}["']|^\\s*${key}\\s*=\\s*[A-Za-z_][\\w.]*\\(`);
    const index = lines.findIndex((line) => pattern.test(line));
    return index >= 0 ? index + 1 : null;
}

// The toolbar's language and format: "C++ · version 2", or "Python · older format" for a version 1 program.
export function formatLabel(kind, version, program = true) {
    const language = kind === 'python' ? 'Python' : 'C++';
    if (!program) return language;
    return version === 1 ? `${language} · older format` : `${language} · version 2`;
}

// The one problem count: "No problems", "1 problem", "3 problems".
export function problemCountText(count) {
    if (!count) return 'No problems';
    return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}
