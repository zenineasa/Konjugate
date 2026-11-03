/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the desktop's store of a launcher's large files (addonFileStore.mjs) and the web edition's (webFileStore.mjs) agree on. No Node, no DOM.

// The largest file kept: as large as an importer may be given.
export const maximumStoredFileBytes = 1024 * 1024 * 1024;
export const maximumRedirects = 5;
export const connectTimeoutMilliseconds = 30000;
export const maximumDetailsBytes = 16 * 1024;
// How long a download left unfinished is kept before it is removed.
export const partialLifeMilliseconds = 7 * 24 * 60 * 60 * 1000;

export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
export const safeName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} .&()_=^-]+/gu, '_').trim().slice(0, 120) || 'file';

// What an add-on adds to an entry, kept as it is but small: plain JSON, at most 16 KB.
export function checkedDetails(details) {
    if (details === undefined || details === null) return {};
    if (typeof details !== 'object' || Array.isArray(details)) throw new Error('A stored file\'s details must be an object.');
    const text = JSON.stringify(details);
    if (text.length > maximumDetailsBytes) throw new Error('A stored file\'s details are larger than the 16 KB they may be.');
    return JSON.parse(text);
}

// How many bytes a response's body will read as, when its server says. A body sent compressed (GitHub sends text so)
// is unpacked as it is read, while its content-length counts it compressed, so then the size is not known.
// `headers` has a `get` (a Headers, or a Map of lower-case names).
export function bodyLength({ headers }) {
    const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') return null;
    const length = Number(headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : null;
}
