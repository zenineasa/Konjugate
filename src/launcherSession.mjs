/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a launcher keeps with the project it opens (docs/projectSchema.md, `addonData`): shared by the desktop (launcherHost.mjs) and the web
// edition (webLauncherBridge.mjs). No Node, no DOM. `hashText` is how a missing hash of an input's text is made; the desktop gives it the
// synchronous SHA-256 of node:crypto and the web edition, whose WebCrypto is asynchronous, fills the hashes in before it calls.

const maximumSessionWindowBytes = 2 * 1024 * 1024;
const maximumSessionInputBytes = 64 * 1024 * 1024;

// What a launcher keeps with the project it opens in the canvas (docs/projectSchema.md, `addonData`): the window's
// own state, as the window gave it, and the input files the model was built from, so the session can be restored
// on any machine without fetching or choosing anything again. Throws a message a user can act on.
export function buildSessionEntry({ addon, window, inputs, savedAt = new Date().toISOString() }) {
    const windowText = JSON.stringify(window ?? null);
    if (windowText.length > maximumSessionWindowBytes) throw new Error('The window\'s session is larger than the host keeps.');
    // A binary input is not kept: what was derived from it is.
    const kept = inputs.filter((input) => !input.binary).map(({ role, name, text, encoding, url, retrievedAt, sha256: hash, bytes, sample, source }) => ({
        role, name, text, encoding: encoding ?? 'utf-8', sha256: hash, bytes, ...(url ? { url, retrievedAt } : {}), ...(sample ? { sample: true } : {}),
        // A derived file says what it was read from (the binary file's name).
        ...(source ? { source } : {})
    }));
    if (kept.reduce((total, input) => total + (input.text?.length ?? 0), 0) > maximumSessionInputBytes) {
        throw new Error(`The data this session was built from is larger than the ${maximumSessionInputBytes / 1024 / 1024} MB a project keeps.`);
    }
    return { version: 1, addonVersion: addon.version, savedAt, window: JSON.parse(windowText), inputs: kept };
}

// The project text with one launcher's entry in its addonData, leaving any other launcher's entry as it was.
export function attachAddonData(contentText, addonId, entry) {
    const document = JSON.parse(contentText);
    document.addonData = { ...(document.addonData ?? {}), [addonId]: entry };
    return JSON.stringify(document);
}

// The input files of a saved session that this launcher still declares, ready to be pending files again.
export function sessionInputs(entry, importers, hashText = () => null) {
    if (entry?.version !== 1 || !Array.isArray(entry.inputs)) return null;
    const roles = new Set((importers ?? []).flatMap((importer) => importer.files.map((file) => file.role)));
    const multiple = new Set((importers ?? []).flatMap((importer) => importer.files.filter((file) => file.multiple).map((file) => file.role)));
    return entry.inputs
        .filter((input) => roles.has(input.role) && typeof input.text === 'string' && typeof input.name === 'string')
        .map((input) => ({ key: multiple.has(input.role) ? `${input.role}::${input.name}` : input.role, file: {
            role: input.role, name: input.name, text: input.text, encoding: input.encoding ?? 'utf-8', sha256: input.sha256 ?? hashText(input.text),
            bytes: input.bytes ?? new TextEncoder().encode(input.text).length, sample: Boolean(input.sample), ...(input.url ? { url: input.url, retrievedAt: input.retrievedAt } : {}), ...(typeof input.source === 'string' ? { source: input.source } : {}), restored: true
        } }));
}
