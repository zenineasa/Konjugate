/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How a driven run answers the operating system's own dialogs (docs/drivingTheApp.md). A native dialog cannot be clicked by a
// script, and one left open stays on the screen until a person closes it, so while the app is driven every one is answered here
// instead: with an answer the script queued for it, or, with none queued, as a person backing out would (a save or an open
// cancelled, a message box with its cancel button). Every dialog is recorded with what it asked and the answer it was given.
//
// Plain decisions with no Electron in them, so they can be tested alone; tests/drivers/electronWindowDriver.mjs routes the
// dialogs here.
//
// The kinds of dialog:
//   save, open        the main process's file dialogs (dialog.showSaveDialog / showOpenDialog and their Sync forms)
//   message           the main process's message boxes (dialog.showMessageBox / showMessageBoxSync)
//   alert, confirm,   a window's window.alert / confirm / prompt, which Electron shows as native dialogs too. A queued message
//   prompt            answer serves an alert or a confirm as well, whose buttons are OK (and Cancel)
//   error             dialog.showErrorBox, Electron's own "A JavaScript error occurred in the main process" among them: nothing to answer
//   certificate       dialog.showCertificateTrustDialog (macOS, Windows): nothing to answer
//   external          shell.openExternal, openPath, showItemInFolder, trashItem: not a dialog, but another app brought in front of
//                     the run; recorded and not done

const answerKinds = ['save', 'open', 'message', 'prompt'];
// The kind of queue a dialog takes its answer from.
const queueOf = { save: 'save', open: 'open', message: 'message', alert: 'message', confirm: 'message', prompt: 'prompt' };

// The kind of dialog an answer is for, from its shape when not said.
function kindOfAnswer(answer) {
    if (answer.kind !== undefined) {
        const kind = queueOf[answer.kind];
        if (!kind) throw new Error(`A dialog answer's kind is one of ${answerKinds.join(', ')} (or alert, confirm), not ${JSON.stringify(answer.kind)}.`);
        return kind;
    }
    if ('button' in answer || 'response' in answer) return 'message';
    if ('filePaths' in answer) return 'open';
    if ('filePath' in answer) return 'save';
    if ('text' in answer) return 'prompt';
    throw new Error('A dialog answer says what to answer: { button } or { response } for a message box, { filePaths } for an open dialog, { filePath } for a save dialog, { text } for a prompt, or { kind, cancel: true }.');
}

// Checks an answer when it is queued, so a mistake in a script shows where it was made rather than when a dialog comes.
export function normalizeAnswer(answer) {
    if (!answer || typeof answer !== 'object') throw new Error('A dialog answer is an object, e.g. { button: \'Discard changes\' }.');
    const kind = kindOfAnswer(answer);
    const normalized = { kind, cancel: answer.cancel === true };
    if (answer.expect !== undefined) {
        if (typeof answer.expect !== 'string' && !(answer.expect instanceof RegExp)) throw new Error('A dialog answer\'s expect is a string or a RegExp.');
        normalized.expect = answer.expect;
    }
    if (normalized.cancel) return normalized;
    if (kind === 'message') {
        if ('button' in answer) {
            if (typeof answer.button !== 'string' || !answer.button) throw new Error('A dialog answer\'s button is the label of a button, e.g. \'Discard changes\'.');
            normalized.button = answer.button;
        } else if (!Number.isInteger(answer.response) || answer.response < 0) throw new Error('A dialog answer\'s response is the index of a button (0 for the first).');
        else normalized.response = answer.response;
        if (answer.checkboxChecked !== undefined) normalized.checkboxChecked = Boolean(answer.checkboxChecked);
    } else if (kind === 'open') {
        if (!Array.isArray(answer.filePaths) || !answer.filePaths.length || answer.filePaths.some((path) => typeof path !== 'string' || !path)) throw new Error('A dialog answer\'s filePaths is a list of one or more paths.');
        normalized.filePaths = [...answer.filePaths];
    } else if (kind === 'save') {
        if (typeof answer.filePath !== 'string' || !answer.filePath) throw new Error('A dialog answer\'s filePath is a path.');
        normalized.filePath = answer.filePath;
    } else if (kind === 'prompt') {
        if (typeof answer.text !== 'string') throw new Error('A dialog answer\'s text is a string (use { kind: \'prompt\', cancel: true } to cancel a prompt).');
        normalized.text = answer.text;
    }
    return normalized;
}

// What a dialog says, for messages and matching: its title, message and detail, those it has.
const wording = (dialog) => [dialog.title, dialog.message, dialog.detail].filter(Boolean).join(' — ');
const named = (dialog) => `the ${dialog.kind} dialog "${dialog.message || dialog.title || '(no text)'}"`;

// The buttons a renderer dialog shows (Electron's own labels), and which is its cancel.
function withButtons(dialog) {
    if (dialog.kind === 'alert') return { buttons: ['OK'], cancelId: 0, ...dialog };
    if (dialog.kind === 'confirm') return { buttons: ['OK', 'Cancel'], cancelId: 1, ...dialog };
    return dialog;
}

// A message box's cancel button: the one it names, else one labelled as backing out, else the first.
function cancelButton({ cancelId, buttons = [] }) {
    if (Number.isInteger(cancelId) && cancelId >= 0) return cancelId;
    const found = buttons.findIndex((label) => /cancel|^no\b|don.t|keep/i.test(label));
    return found >= 0 ? found : 0;
}

// The value the app receives, by kind, for a dialog cancelled.
function cancelled(dialog) {
    switch (dialog.kind) {
        case 'save': return { canceled: true, filePath: '' };
        case 'open': return { canceled: true, filePaths: [] };
        case 'message': return { response: cancelButton(dialog), checkboxChecked: Boolean(dialog.checkboxChecked) };
        case 'alert': return undefined;
        case 'confirm': return false;
        case 'prompt': return null;
        default: return undefined;
    }
}

// The value the app receives for a message box, alert or confirm answered with button `response`.
function pressed(dialog, response, checkboxChecked) {
    if (dialog.kind === 'confirm') return response === 0;
    if (dialog.kind === 'alert') return undefined;
    return { response, checkboxChecked: checkboxChecked ?? Boolean(dialog.checkboxChecked) };
}

// unmatched: what a dialog with no answer queued for it gets. 'cancel' (the default) cancels it; 'fail' cancels it too and records it
// as an error, for a script that means to answer every dialog itself; a function is given the dialog and returns an answer (or
// nothing, to cancel).
export function createNativeDialogAnswers({ unmatched = 'cancel', now = () => Date.now() } = {}) {
    const queues = { save: [], open: [], message: [], prompt: [] };
    const records = [];
    let taken = 0;
    let policy;
    const setUnmatched = (value) => {
        if (value !== 'cancel' && value !== 'fail' && typeof value !== 'function') throw new Error('What an unanswered dialog gets is \'cancel\', \'fail\' or a function.');
        policy = value;
    };
    setUnmatched(unmatched);

    // An answer applied to a dialog: the value for the app, a description of the answer, and an error when it does not fit.
    function apply(dialog, answer, from) {
        if (answer.expect !== undefined) {
            const text = wording(dialog);
            const fits = typeof answer.expect === 'string' ? text.includes(answer.expect) : answer.expect.test(text);
            if (!fits) return { result: cancelled(dialog), answer: 'cancelled', error: `An answer queued for a dialog saying ${JSON.stringify(String(answer.expect))} came to ${named(dialog)}${dialog.detail ? ` (${dialog.detail})` : ''}; it was cancelled.` };
        }
        if (answer.cancel) return { result: cancelled(dialog), answer: from === 'queued' ? 'cancelled (as queued)' : 'cancelled' };
        switch (dialog.kind) {
            case 'save': return { result: { canceled: false, filePath: answer.filePath }, answer: `saved as ${answer.filePath}` };
            case 'open': return { result: { canceled: false, filePaths: answer.filePaths }, answer: `opened ${answer.filePaths.join(', ')}` };
            case 'prompt': return { result: answer.text, answer: `typed ${JSON.stringify(answer.text)}` };
            default: {
                const buttons = dialog.buttons ?? [];
                const response = answer.button !== undefined ? buttons.indexOf(answer.button) : answer.response;
                if (response < 0 || response >= buttons.length) {
                    const asked = answer.button !== undefined ? `"${answer.button}" button` : `button ${answer.response}`;
                    return { result: cancelled(dialog), answer: 'cancelled', error: `${named(dialog)[0].toUpperCase()}${named(dialog).slice(1)} has no ${asked}; it offers ${buttons.map((label) => `"${label}"`).join(', ') || 'no buttons'}. It was cancelled.` };
                }
                return { result: pressed(dialog, response, answer.checkboxChecked), answer: `pressed "${buttons[response]}"` };
            }
        }
    }

    return {
        // Queues an answer for the next dialog of its kind (see normalizeAnswer for the shapes). Answers of a kind are used in order.
        queue(answer) {
            const normalized = normalizeAnswer(answer);
            queues[normalized.kind].push(normalized);
            return normalized;
        },
        setUnmatched,
        // Answers a dialog: { kind, title, message, detail, buttons, cancelId, checkboxChecked, source, ... }. Returns the value for the
        // app and the record kept of it.
        answer(asked) {
            const dialog = withButtons({ ...asked });
            const record = {
                id: records.length + 1,
                kind: dialog.kind,
                source: dialog.source ?? 'main',
                title: dialog.title ?? '',
                message: dialog.message ?? '',
                detail: dialog.detail ?? '',
                buttons: dialog.buttons ? [...dialog.buttons] : [],
                ...(dialog.url ? { url: dialog.url } : {}),
                ...(dialog.path ? { path: dialog.path } : {}),
                at: now()
            };
            let outcome;
            if (dialog.kind === 'error' || dialog.kind === 'certificate') outcome = { result: undefined, answer: 'dismissed' };
            else if (dialog.kind === 'external') outcome = { result: undefined, answer: 'not opened' };
            else {
                const queue = queues[queueOf[dialog.kind]];
                if (!queue) throw new Error(`Unknown kind of native dialog: ${dialog.kind}.`);
                if (queue.length) outcome = apply(dialog, queue.shift(), 'queued');
                else if (typeof policy === 'function') {
                    const chosen = policy({ ...record, cancelId: dialog.cancelId });
                    outcome = chosen === undefined || chosen === null ? { result: cancelled(dialog), answer: 'cancelled' } : apply(dialog, normalizeAnswer({ kind: dialog.kind === 'alert' || dialog.kind === 'confirm' ? 'message' : dialog.kind, ...chosen }), 'policy');
                } else {
                    outcome = { result: cancelled(dialog), answer: 'cancelled' };
                    if (policy === 'fail') outcome.error = `${named(dialog)[0].toUpperCase()}${named(dialog).slice(1)} came with no answer queued for it; it was cancelled.`;
                }
            }
            record.answer = outcome.answer;
            if (outcome.error) record.error = outcome.error;
            records.push(record);
            return { result: outcome.result, record };
        },
        // Records a dialog answered elsewhere (one the watchdog caught past the interception), in the same order as the rest.
        note(record) {
            const kept = { title: '', message: '', detail: '', buttons: [], source: 'main', ...record, id: records.length + 1, at: record.at ?? now() };
            records.push(kept);
            return kept;
        },
        // Every dialog so far, oldest first.
        records: () => records.map((record) => ({ ...record })),
        // The dialogs since the last call.
        take() {
            const fresh = records.slice(taken);
            taken = records.length;
            return fresh;
        },
        // The answers queued and not yet used, which are dropped.
        clearQueued() {
            const left = Object.values(queues).flat();
            for (const queue of Object.values(queues)) queue.length = 0;
            return left;
        },
        queued: () => Object.values(queues).flat().map((answer) => ({ ...answer }))
    };
}

// One line saying what a dialog asked and how it was answered, for a run's output.
export function describeDialog(record) {
    if (record.kind === 'external') return `an outside app was asked for (${record.message}); it was not opened`;
    const text = record.message || record.title || '(no text)';
    const buttons = record.buttons.length ? ` [${record.buttons.join(' | ')}]` : '';
    return `a native ${record.kind} dialog${record.source === 'renderer' ? ' from a window' : ''}, "${text}"${buttons}: ${record.answer}${record.error ? ` -- ${record.error}` : ''}`;
}
