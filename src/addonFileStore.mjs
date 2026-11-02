/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A launcher add-on's store of large files it keeps for the user: map extracts of a gigabyte, say, downloaded once or
// brought in from the user's own disk, and read again whenever they are wanted. One folder per add-on under the user's
// data (which no operating system keeps private from Konjugate, as it may the Downloads folder), never seen by the
// add-on's window: the window asks for a download or a copy, lists what is kept, and names an entry to read.
//
// Each entry keeps where it came from: downloaded (from which server, from which address) or brought in by the user
// (and what the file was called). An add-on may add its own details to an entry (what area a map covers, how old its
// data is), shown back with it. Nothing is removed but by the user.
//
// An entry is two files, named by its id: <id>.data (the bytes) and <id>.json ({ id, name, bytes, storedAt, origin,
// details }). A download is written to <key>.part (with <key>.partial saying where from) and only becomes an entry when
// it is whole and, where a checksum is published, matches it; one that stopped is kept, to continue or to give up.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

// The largest file kept: as large as an importer may be given.
export const maximumStoredFileBytes = 1024 * 1024 * 1024;
const maximumRedirects = 5;
const connectTimeoutMilliseconds = 30000;
const maximumDetailsBytes = 16 * 1024;
// How long a download left unfinished is kept before it is removed.
const partialLifeMilliseconds = 7 * 24 * 60 * 60 * 1000;

const safeId = (addonId) => String(addonId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
const entryId = () => randomUUID().replaceAll('-', '');
const partialKey = (url) => createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
const safeName = (name) => String(name ?? '').replace(/[^\p{L}\p{N} .&()_=^-]+/gu, '_').trim().slice(0, 120) || 'file';

// The folder an add-on's stored files live in.
export function addonFilesDirectory(userData, addonId) {
    return join(userData, 'addonFiles', safeId(addonId));
}

// What an add-on adds to an entry, kept as it is but small: plain JSON, at most 16 KB.
function checkedDetails(details) {
    if (details === undefined || details === null) return {};
    if (typeof details !== 'object' || Array.isArray(details)) throw new Error('A stored file\'s details must be an object.');
    const text = JSON.stringify(details);
    if (text.length > maximumDetailsBytes) throw new Error('A stored file\'s details are larger than the 16 KB they may be.');
    return JSON.parse(text);
}

// An address the store may download from: https, a host the add-on declares, no user name or password.
function checkAddress(address, allowed) {
    if (address.protocol !== 'https:') throw new Error('Only https addresses can be downloaded.');
    if (address.username || address.password) throw new Error('An address with a user name or password cannot be downloaded.');
    if (!allowed.has(address.hostname.toLowerCase())) throw new Error(`This window may not download from ${address.hostname}. It may reach: ${[...allowed].join(', ')}.`);
}

// How many bytes a response's body will read as, when its server says. A body sent compressed (GitHub sends text so)
// is unpacked as it is read, while its content-length counts it compressed, so then the size is not known.
export function bodyLength(response) {
    const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
    if (encoding && encoding !== 'identity') return null;
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : null;
}

export function createFileStore({ directory, now = () => Date.now() }) {
    const paths = (id) => ({ data: join(directory, `${id}.data`), meta: join(directory, `${id}.json`), part: join(directory, `${id}.part`), partial: join(directory, `${id}.partial`) });
    const readMeta = async (id) => {
        try { return JSON.parse(await readFile(paths(id).meta, 'utf8')); } catch { return null; }
    };
    // An unfinished download is named by the address asked for, as an id of the same shape as an entry's.
    const active = new Set();
    const readPartial = async (key) => {
        try {
            const meta = JSON.parse(await readFile(paths(key).partial, 'utf8'));
            const { size, mtimeMs } = await stat(paths(key).part);
            return meta && typeof meta.resolved === 'string' ? { meta, bytes: size, updatedAt: mtimeMs } : null;
        } catch { return null; }
    };
    const discardPartialFiles = (key) => Promise.all([rm(paths(key).part, { force: true }), rm(paths(key).partial, { force: true })]);
    const writeMeta = (entry) => writeFile(paths(entry.id).meta, JSON.stringify(entry));
    const add = async (entry) => {
        await writeMeta(entry);
        return entry;
    };

    return {
        directory,
        // Every entry, the latest first: { id, name, bytes, storedAt, origin, details }.
        async list() {
            let names = [];
            try { names = await readdir(directory); } catch { return []; }
            const entries = [];
            for (const name of names.filter((item) => item.endsWith('.json'))) {
                const entry = await readMeta(name.slice(0, -5));
                if (entry && validId(entry.id)) entries.push(entry);
            }
            return entries.sort((a, b) => b.storedAt.localeCompare(a.storedAt));
        },
        // One entry, with the path its bytes are at (for the host to read; never given to a window).
        async get(id) {
            if (!validId(id)) return null;
            const entry = await readMeta(id);
            if (!entry) return null;
            try { await stat(paths(id).data); } catch { return null; }
            return { ...entry, path: paths(id).data };
        },
        // Brings in a file from the user's disk, as a copy: { path, details } → the entry, marked as the user's own.
        async putCopy({ path, details = {} }) {
            const { size } = await stat(path);
            if (size > maximumStoredFileBytes) throw new Error(`${basename(path)} is larger than the ${maximumStoredFileBytes / 1024 / 1024} MB a stored file may be.`);
            await mkdir(directory, { recursive: true });
            const id = entryId();
            await copyFile(path, paths(id).data);
            return add({ id, name: safeName(basename(path)), bytes: size, storedAt: new Date(now()).toISOString(), origin: { kind: 'upload', name: basename(path) }, details: checkedDetails(details) });
        },
        // Downloads one address at a time: the same asked for twice at once is refused.
        async download(options) {
            const key = partialKey(options.url);
            if (active.has(key)) throw new Error('That file is already being downloaded.');
            active.add(key);
            try { return await this.downloadKept(options); } finally { active.delete(key); }
        },
        // Downloads a file from an address on `hosts` into the store, streaming it to disk: { url, name, server (what
        // the server is called, for the record), hosts, checksumUrl (an MD5 sum published beside it, checked when
        // given), onProgress({ done, total, resumedFrom }), signal (to cancel), fetchImpl, userAgent, details, fresh
        // (ignore a download left unfinished) } → the entry.
        //
        // A download that stops (the connection drops, the server cuts it short, it is cancelled) leaves what arrived in
        // <key>.part, the key being made of the address asked for, with <key>.partial saying where it was being read from
        // and how to tell the file is unchanged. Asking for the same address again continues from there with a Range
        // request, if the server still has the same file (If-Range with its ETag or date): otherwise, or when the server
        // sends the whole file, it starts again. A file that fails its checksum, or is too large, is not left.
        async downloadKept({ url, name = null, server = null, hosts, checksumUrl = null, onProgress = null, signal = null, fetchImpl = globalThis.fetch, userAgent = 'Konjugate', details = {}, fresh = false }) {
            const allowed = new Set((hosts ?? []).map((host) => host.toLowerCase()));
            let first;
            try { first = new URL(url); } catch { throw new Error('That is not a web address.'); }
            // The address asked for, followed through its redirects: { response, current }.
            const open = async (start, extra = {}) => {
                let current = start;
                for (let hop = 0; ; hop += 1) {
                    checkAddress(current, allowed);
                    const connect = AbortSignal.timeout(connectTimeoutMilliseconds);
                    let response;
                    try {
                        response = await fetchImpl(current.href, { redirect: 'manual', headers: { 'User-Agent': userAgent, Accept: '*/*', ...extra }, signal: signal ? AbortSignal.any([signal, connect]) : connect });
                    } catch (error) {
                        if (signal?.aborted) throw new Error('The download was cancelled.');
                        throw new Error(error.name === 'TimeoutError' ? `${current.hostname} did not answer within ${connectTimeoutMilliseconds / 1000} seconds.` : `Could not reach ${current.hostname}. Check the connection.`);
                    }
                    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, current };
                    if (hop >= maximumRedirects) throw new Error(`${current.hostname} redirected too many times.`);
                    const location = response.headers.get('location');
                    if (!location) throw new Error(`${current.hostname} redirected without saying where.`);
                    current = new URL(location, current);
                }
            };
            const key = partialKey(url);
            await mkdir(directory, { recursive: true });
            let kept = fresh ? null : await readPartial(key);
            if (fresh) await discardPartialFiles(key);
            let opened = null;
            let from = 0;
            if (kept) {
                const validator = kept.meta.etag ?? kept.meta.lastModified;
                if (validator && kept.bytes > 0 && kept.bytes < maximumStoredFileBytes) {
                    opened = await open(new URL(kept.meta.resolved), { Range: `bytes=${kept.bytes}-`, 'If-Range': validator });
                    const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(opened.response.headers.get('content-range') ?? '');
                    const status = opened.response.status;
                    if (status === 206 && range && Number(range[1]) === kept.bytes) from = kept.bytes;
                    else if (status === 200) from = 0;
                    else if (status === 206 || [404, 410, 416].includes(status)) { await opened.response.body?.cancel(); opened = null; }
                    else if (!opened.response.ok) throw new Error(`${opened.current.hostname} answered ${status}.`);
                    else { await opened.response.body?.cancel(); opened = null; }
                }
                // The file is gone from where it was (the dated name moved on), unusable, or the server would not say.
                if (!opened) await discardPartialFiles(key);
            }
            if (!opened) opened = await open(first);
            const { response, current } = opened;
            if (!response.ok) throw new Error(`${current.hostname} answered ${response.status}.`);
            const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
            const length = bodyLength(response);
            const total = from && range ? Number(range[1]) : (length ? from + length : null);
            if (total && total > maximumStoredFileBytes) throw new Error(`The file is larger than the ${maximumStoredFileBytes / 1024 / 1024} MB a stored file may be.`);
            const part = paths(key).part;
            const md5 = createHash('md5');
            if (from) {
                await new Promise((resolve, reject) => createReadStream(part, { end: from - 1 }).on('data', (chunk) => md5.update(chunk)).on('end', resolve).on('error', reject));
            }
            const fileName = safeName(name ?? decodeURIComponent(basename(new URL(url).pathname)));
            await writeFile(paths(key).partial, JSON.stringify({ url, resolved: current.href, name: fileName, server: server ? String(server).slice(0, 120) : null, details: checkedDetails(details), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), total }));
            const out = createWriteStream(part, { flags: from ? 'a' : 'w' });
            let done = from;
            let keep = true;
            try {
                const reader = response.body.getReader();
                for (;;) {
                    if (signal?.aborted) throw new Error('The download was cancelled.');
                    const { done: finished, value } = await reader.read();
                    if (finished) break;
                    done += value.length;
                    if (done > maximumStoredFileBytes) { keep = false; throw new Error(`The file is larger than the ${maximumStoredFileBytes / 1024 / 1024} MB a stored file may be.`); }
                    md5.update(value);
                    if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
                    onProgress?.({ done, total, resumedFrom: from });
                }
                await new Promise((resolve, reject) => { out.end((error) => (error ? reject(error) : resolve())); });
                if (total && done !== total) throw new Error(`The download stopped at ${done} of ${total} bytes.`);
                // The sum the server publishes beside the file: a file that does not match it is not kept.
                if (checksumUrl) {
                    const published = await this.fetchText({ url: checksumUrl, hosts, fetchImpl, userAgent });
                    const expected = /^[0-9a-f]{32}/i.exec(published.trim())?.[0]?.toLowerCase();
                    const actual = md5.digest('hex');
                    if (!expected) throw new Error('The checksum published beside the file could not be read.');
                    if (expected !== actual) { keep = false; throw new Error('The file downloaded does not match the checksum published beside it: it was not kept. Try again.'); }
                }
            } catch (error) {
                // What arrived stays for a later try, written out first, unless it is known to be no use.
                if (keep) await new Promise((resolve) => { out.end(resolve); });
                else out.destroy();
                if (!keep) await discardPartialFiles(key);
                if (signal?.aborted) throw new Error('The download was cancelled.');
                throw error;
            }
            const id = entryId();
            await rename(part, paths(id).data);
            await rm(paths(key).partial, { force: true });
            return add({ id, name: fileName, bytes: done, storedAt: new Date(now()).toISOString(), origin: { kind: 'download', url, ...(server ? { server: String(server).slice(0, 120) } : {}) }, details: checkedDetails(details) });
        },
        // Downloads left unfinished, the latest first: { id, name, url, server, details, bytes, total, updatedAt }. One not touched
        // for a week, or with a half missing, is removed here.
        async partials() {
            let names = [];
            try { names = await readdir(directory); } catch { return []; }
            const found = [];
            for (const file of names.filter((item) => item.endsWith('.partial'))) {
                const id = file.slice(0, -8);
                if (active.has(id)) continue;
                const kept = validId(id) ? await readPartial(id) : null;
                if (!kept || !kept.bytes || now() - kept.updatedAt > partialLifeMilliseconds) { await discardPartialFiles(id); continue; }
                found.push({ id, name: kept.meta.name, url: kept.meta.url, server: kept.meta.server, details: kept.meta.details ?? {}, bytes: kept.bytes, total: kept.meta.total ?? null, updatedAt: new Date(kept.updatedAt).toISOString() });
            }
            for (const file of names.filter((item) => item.endsWith('.part') && validId(item.slice(0, -5)))) {
                if (!names.includes(`${file.slice(0, -5)}.partial`)) await rm(join(directory, file), { force: true });
            }
            return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        },
        // Gives up an unfinished download, so its bytes are not kept.
        async discardPartial(id) {
            if (validId(id)) await discardPartialFiles(id);
        },
        // How large the file at an allowed address is, asked of the server (a HEAD request, following redirects) before
        // downloading it: bytes, or null when the server does not say.
        async size({ url, hosts, fetchImpl = globalThis.fetch, userAgent = 'Konjugate' }) {
            const allowed = new Set((hosts ?? []).map((host) => host.toLowerCase()));
            let current;
            try { current = new URL(url); } catch { throw new Error('That is not a web address.'); }
            for (let hop = 0; hop <= maximumRedirects; hop += 1) {
                checkAddress(current, allowed);
                let response;
                try {
                    response = await fetchImpl(current.href, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(connectTimeoutMilliseconds) });
                } catch {
                    throw new Error(`Could not reach ${current.hostname}. Check the connection.`);
                }
                if ([301, 302, 303, 307, 308].includes(response.status)) { current = new URL(response.headers.get('location'), current); continue; }
                if (!response.ok) throw new Error(`${current.hostname} answered ${response.status}.`);
                return bodyLength(response);
            }
            throw new Error(`${current.hostname} redirected too many times.`);
        },
        // A small text from an allowed address (a checksum), following redirects as a download does.
        async fetchText({ url, hosts, fetchImpl = globalThis.fetch, userAgent = 'Konjugate' }) {
            const allowed = new Set((hosts ?? []).map((host) => host.toLowerCase()));
            let current = new URL(url);
            for (let hop = 0; hop <= maximumRedirects; hop += 1) {
                checkAddress(current, allowed);
                const response = await fetchImpl(current.href, { redirect: 'manual', headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(connectTimeoutMilliseconds) });
                if ([301, 302, 303, 307, 308].includes(response.status)) { current = new URL(response.headers.get('location'), current); continue; }
                if (!response.ok) throw new Error(`${current.hostname} answered ${response.status}.`);
                return response.text();
            }
            throw new Error(`${current.hostname} redirected too many times.`);
        },
        // Adds an add-on's details to an entry (merged with those it has).
        async describe(id, details) {
            const entry = validId(id) ? await readMeta(id) : null;
            if (!entry) throw new Error('No such stored file.');
            const updated = { ...entry, details: checkedDetails({ ...entry.details, ...checkedDetails(details) }) };
            await writeMeta(updated);
            return updated;
        },
        async remove(id) {
            if (!validId(id)) return;
            await Promise.all([rm(paths(id).data, { force: true }), rm(paths(id).meta, { force: true }), rm(paths(id).part, { force: true })]);
        },
        // The bytes kept, in all.
        async usage() {
            return (await this.list()).reduce((sum, entry) => sum + entry.bytes, 0);
        },
        // The SHA-256 of an entry's bytes, read from disk (for a test, or to check a copy).
        async digest(id) {
            const hash = createHash('sha256');
            await new Promise((resolve, reject) => createReadStream(paths(id).data).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject));
            return hash.digest('hex');
        }
    };
}
