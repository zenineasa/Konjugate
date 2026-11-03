/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The parts of a launcher's importing that need neither Node nor a window, shared by the desktop's host (launcherHost.mjs) and the web
// edition's (webLauncherBridge.mjs): reading a chosen file's text, which files an importer is given, checking what an importer says of its
// progress and returns, and which addresses a launcher may open. One implementation, so an importer is held to the same rules on both.

export const maximumInputBytes = 10 * 1024 * 1024;
export const maximumDerivedFiles = 64;
export const maximumImporterDataBytes = 8 * 1024 * 1024;
export const maximumOptionsBytes = 2 * 1024 * 1024;

// Text as a spreadsheet may have saved it: UTF-8 (with or without a byte-order mark), UTF-16 with a mark, or,
// failing a strict UTF-8 read, Windows-1252, which is what Excel writes for "CSV" on Windows. The name of the
// encoding used is returned so the importer can tell the user when it was not UTF-8.
export function decodeText(bytes) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch {
        return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
    }
}

// What one fetch from a listed host may take: bytes, the part of them a window may receive as text, and time.
export const maximumFetchBytes = 5 * 1024 * 1024;
export const maximumFetchedTextBytes = 1024 * 1024;
export const fetchTimeoutMilliseconds = 20000;

// An address the window may ask for: https, no credentials, a host the manifest lists. Throws a message a user can act on.
export function checkAddress(address, allowed) {
    if (address.protocol !== 'https:') throw new Error('Only https addresses can be fetched.');
    if (address.username || address.password) throw new Error('An address with a user name or password cannot be fetched.');
    if (!allowed.has(address.hostname.toLowerCase())) throw new Error(`This window may not connect to ${address.hostname}. It may reach: ${[...allowed].join(', ')}.`);
}

export function addressAllowed(url, hosts) {
    let address;
    try { address = new URL(url); } catch { throw new Error('That is not a web address.'); }
    checkAddress(address, new Set(hosts.map((host) => host.toLowerCase())));
    return address.href;
}

// A name safe to show and to key a file by: no path separators or control characters.
export const safeFileName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} .&()_=^-]+/gu, '_').trim().slice(0, 60);

// What an importer says of its progress, made safe to show: `done` of `total` (numbers, done within 0 and total) and
// a short message. Null when it says nothing usable.
export function checkedProgress(progress) {
    const total = Number(progress?.total);
    const done = Number(progress?.done);
    if (!(total > 0) || !Number.isFinite(done)) return null;
    return { done: Math.min(total, Math.max(0, done)), total, message: typeof progress.message === 'string' ? progress.message.slice(0, 200) : '' };
}

// The inputs an importer is given for a run: those of its roles, and binary files only when the run asks for them
// (`options.useBinaryFiles`). A binary file is read from disk for each run it is given to, and may be a gigabyte: the
// steps that do not read it (most of them) do not wait for it or hold it.
export function importerInputs(pending, roles, options = {}) {
    return [...pending].filter((file) => roles.has(file.role) && (!file.binary || options?.useBinaryFiles === true));
}

// The text files an importer derived from what it was given (`derived: [{ role, name, text }]`), checked: each is of
// a role the importer declares that is not binary, and no larger than a chosen file may be. They take the place of
// the files of their roles, and of the binary files they were read from. Throws a message naming what is wrong.
export function checkedDerived(importer, derived) {
    if (!Array.isArray(derived) || derived.length > maximumDerivedFiles) throw new Error(`An importer may derive up to ${maximumDerivedFiles} files.`);
    const roles = new Map(importer.files.map((file) => [file.role, file]));
    const names = new Set();
    return derived.map((item) => {
        const file = roles.get(item?.role);
        if (!file || file.binary) throw new Error('An importer may derive files only of its own roles that are not binary.');
        if (typeof item.text !== 'string') throw new Error('A derived file must be text.');
        if (new TextEncoder().encode(item.text).length > maximumInputBytes) throw new Error(`A derived file is larger than the ${maximumInputBytes / 1024 / 1024} MB limit.`);
        const name = safeFileName(item.name);
        if (!name) throw new Error('A derived file needs a name.');
        const key = `${file.role}::${name}`;
        if (names.has(key) || (!file.multiple && [...names].some((other) => other.startsWith(`${file.role}::`)))) throw new Error('An importer derived two files where one is taken.');
        names.add(key);
        return { role: file.role, name, text: item.text, ...(typeof item.source === 'string' ? { source: item.source.slice(0, 200) } : {}) };
    });
}

// What an importer returned, checked before anyone uses it; throws a message a user can act on. `result` is the importer's own return value.
export function checkedImporterResult(importer, result) {
    if (typeof result?.ok !== 'boolean' || !result.report) throw new Error('The importer returned an unexpected result.');
    // A successful importer returns a model, or only `data` when it is a first step that needs the window to do more
    // (for example run an analysis) before the model can be built.
    if (result.ok && result.data === undefined && (!Array.isArray(result.document?.nodes) || !Array.isArray(result.document?.edges))) throw new Error('The importer reported success without a model.');
    if (result.data !== undefined && JSON.stringify(result.data).length > maximumImporterDataBytes) throw new Error('The importer returned more data than a window may receive.');
    if (result.derived !== undefined) result.derived = checkedDerived(importer, result.derived);
    return result;
}
