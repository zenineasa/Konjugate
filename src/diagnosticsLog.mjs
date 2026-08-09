/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A small in-memory backstop for anything logged via console.error/console.warn in the main
// process (see main.mjs) -- including paths nobody has explicitly wired up to a UI element yet.
// The renderer surfaces this as a quiet badge/log panel rather than interrupting the user.

const maxEntries = 200;
const entries = [];
let nextId = 1;
let listener = null;

export function recordDiagnostic({ severity = 'error', message, detail }) {
    const entry = {
        id: nextId++,
        severity,
        message: String(message ?? ''),
        ...(detail ? { detail: String(detail) } : {}),
        timestamp: Date.now()
    };
    entries.push(entry);
    if (entries.length > maxEntries) entries.shift();
    listener?.(entry);
    return entry;
}

export function listDiagnostics() {
    return entries.slice();
}

export function onDiagnostic(callback) {
    listener = callback;
}
