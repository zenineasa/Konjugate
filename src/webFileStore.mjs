/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A launcher add-on's store of large files it keeps for the user, in the web edition (docs/proposals/webEditionPackages.md, stage 5):
// addonFileStore.mjs for a page. The same entries (<id>.data and <id>.json), the same unfinished downloads (<key>.part and <key>.partial,
// continued with a Range request when the server still has the same file), the same limits, checks and messages, with the differences a
// browser makes: files are kept in a `volume` (webVolume.mjs, backed by the browser's private file system), the bytes of a download come
// from `transport.stream` (a sandboxed frame, renderer/fetchFrame.html, since the page may not connect to other sites), a file from the
// person's disk is a File and not a path, and the entry's bytes are handed back as a Blob and not a path. A browser lets a page read only
// the response headers a server exposes, so a download can be continued only when the server says which file it is (Last-Modified is
// always readable; an ETag only if the server exposes it) and sends the range asked for; otherwise it starts again, as the desktop does
// when the server cannot say. No Node, no DOM.

import { createMd5 } from './md5.mjs';
import { addressFailure } from './webFetch.mjs';
import { bodyLength, checkedDetails, connectTimeoutMilliseconds, maximumStoredFileBytes, partialLifeMilliseconds, safeName, validId } from './storedFiles.mjs';

const noSpace = 'There is not enough space in this browser to keep that. Remove stored files to make room, or free some space.';
const withSpaceMessage = (error) => (error?.name === 'QuotaExceededError' ? new Error(noSpace) : error);

// `volume`: webVolume.mjs. `transport.stream({ url, hosts, headers, method, signal })` answers { status, url, headers (a Map, lower-case names), body
// (async iterable of Uint8Array, or null), cancel() }; `transport.fetchText({ url, hosts })` answers a small text. `sha256Hex(text)` is async.
export function createWebFileStore({ volume, transport, sha256Hex, now = () => Date.now(), randomId = () => globalThis.crypto.randomUUID().replaceAll('-', '') }) {
    const names = (id) => ({ data: `${id}.data`, meta: `${id}.json`, part: `${id}.part`, partial: `${id}.partial` });
    const readJson = async (name) => { try { const text = await volume.readText(name); return text === null ? null : JSON.parse(text); } catch { return null; } };
    const partialKey = async (url) => (await sha256Hex(String(url))).slice(0, 32);
    const active = new Set();
    const readPartial = async (key) => {
        const meta = await readJson(names(key).partial);
        const bytes = await volume.size(names(key).part);
        return meta && typeof meta.resolved === 'string' && bytes !== null ? { meta, bytes, updatedAt: meta.updatedAt ?? 0 } : null;
    };
    const discardPartialFiles = (key) => Promise.all([volume.remove(names(key).part), volume.remove(names(key).partial)]);
    const add = async (entry) => { await volume.writeText(names(entry.id).meta, JSON.stringify(entry)); return entry; };
    const allowedHosts = (hosts) => new Set((hosts ?? []).map((host) => host.toLowerCase()));
    // The file the person chose, written to the volume as it is read, never held whole.
    const writeBlob = async (name, blob) => {
        const out = await volume.open(name, { append: false });
        try {
            const reader = blob.stream().getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                await out.write(value);
            }
            await out.close();
        } catch (error) {
            await out.abort?.();
            await volume.remove(name);
            throw withSpaceMessage(error);
        }
    };

    return {
        // Every entry, the latest first: { id, name, bytes, storedAt, origin, details }.
        async list() {
            const entries = [];
            for (const name of (await volume.names()).filter((item) => item.endsWith('.json'))) {
                const entry = await readJson(name);
                if (entry && validId(entry.id)) entries.push(entry);
            }
            return entries.sort((a, b) => b.storedAt.localeCompare(a.storedAt));
        },
        // One entry with its bytes as a Blob (for the host to read; never given to a window).
        async get(id) {
            if (!validId(id)) return null;
            const entry = await readJson(names(id).meta);
            const blob = entry ? await volume.blob(names(id).data) : null;
            return blob ? { ...entry, blob } : null;
        },
        // Brings in a file the person chose, as a copy, marked as their own.
        async putFile({ file, details = {} }) {
            if (file.size > maximumStoredFileBytes) throw new Error(`${file.name} is larger than the ${maximumStoredFileBytes / 1024 / 1024} MB a stored file may be.`);
            const id = randomId();
            await writeBlob(names(id).data, file);
            return add({ id, name: safeName(file.name), bytes: file.size, storedAt: new Date(now()).toISOString(), origin: { kind: 'upload', name: file.name }, details: checkedDetails(details) });
        },
        // Downloads one address at a time: the same asked for twice at once is refused.
        async download(options) {
            const key = await partialKey(options.url);
            if (active.has(key)) throw new Error('That file is already being downloaded.');
            active.add(key);
            try { return await this.downloadKept(options, key); } finally { active.delete(key); }
        },
        // Downloads a file from an address on `hosts` into the store: { url, name, server, hosts, checksumUrl (an MD5 sum published beside it, checked
        // when given), onProgress({ done, total, resumedFrom }), signal, details, fresh (ignore a download left unfinished) } → the entry.
        async downloadKept({ url, name = null, server = null, hosts, checksumUrl = null, onProgress = null, signal = null, details = {}, fresh = false }, key = null) {
            const allowed = allowedHosts(hosts);
            let first;
            try { first = new URL(url); } catch { throw new Error('That is not a web address.'); }
            addressFailure(first, allowed, 'download');
            key ??= await partialKey(url);
            const open = async (start, headers = {}) => {
                addressFailure(start, allowed, 'download');
                try { return await transport.stream({ url: start.href, hosts: [...allowed], headers, signal, timeoutMilliseconds: connectTimeoutMilliseconds }); } catch (error) {
                    if (signal?.aborted) throw new Error('The download was cancelled.');
                    throw error;
                }
            };
            let kept = fresh ? null : await readPartial(key);
            if (fresh) await discardPartialFiles(key);
            let opened = null;
            let from = 0;
            if (kept) {
                const validator = kept.meta.etag ?? kept.meta.lastModified;
                if (validator && kept.bytes > 0 && kept.bytes < maximumStoredFileBytes) {
                    opened = await open(new URL(kept.meta.resolved), { Range: `bytes=${kept.bytes}-`, 'If-Range': validator });
                    // A browser may read Content-Range only if the server exposes it: a 206 to a range asked from here is taken to start there.
                    const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(opened.headers.get('content-range') ?? '');
                    const status = opened.status;
                    if (status === 206 && (!range || Number(range[1]) === kept.bytes)) from = kept.bytes;
                    else if (status === 200) from = 0;
                    else if (status === 206 || [404, 410, 416].includes(status)) { await opened.cancel(); opened = null; }
                    else if (!(status >= 200 && status < 300)) throw new Error(`${new URL(opened.url).hostname} answered ${status}.`);
                    else { await opened.cancel(); opened = null; }
                }
                if (!opened) await discardPartialFiles(key);
            }
            if (!opened) opened = await open(first);
            const response = opened;
            const host = new URL(response.url).hostname;
            if (!(response.status >= 200 && response.status < 300)) throw new Error(`${host} answered ${response.status}.`);
            const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
            const length = bodyLength(response);
            const total = from && range ? Number(range[1]) : (length ? from + length : null);
            if (total && total > maximumStoredFileBytes) { await response.cancel(); throw new Error(`The file is larger than the ${maximumStoredFileBytes / 1024 / 1024} MB a stored file may be.`); }
            const md5 = createMd5();
            if (from) {
                const reader = (await volume.blob(names(key).part)).slice(0, from).stream().getReader();
                for (;;) { const { done, value } = await reader.read(); if (done) break; md5.update(value); }
            }
            const fileName = safeName(name ?? decodeURIComponent(first.pathname.split('/').at(-1)));
            await volume.writeText(names(key).partial, JSON.stringify({ url, resolved: response.url, name: fileName, server: server ? String(server).slice(0, 120) : null, details: checkedDetails(details), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), total, updatedAt: now() }));
            const out = await volume.open(names(key).part, { append: from > 0 });
            let done = from;
            let keep = true;
            try {
                for await (const value of response.body ?? []) {
                    if (signal?.aborted) throw new Error('The download was cancelled.');
                    done += value.length;
                    if (done > maximumStoredFileBytes) { keep = false; throw new Error(`The file is larger than the ${maximumStoredFileBytes / 1024 / 1024} MB a stored file may be.`); }
                    md5.update(value);
                    await out.write(value);
                    onProgress?.({ done, total, resumedFrom: from });
                }
                await out.close();
                if (signal?.aborted) throw new Error('The download was cancelled.');
                if (total && done !== total) throw new Error(`The download stopped at ${done} of ${total} bytes.`);
                if (checksumUrl) {
                    const published = await transport.fetchText({ url: checksumUrl, hosts: [...allowed] });
                    const expected = /^[0-9a-f]{32}/i.exec(published.trim())?.[0]?.toLowerCase();
                    const actual = md5.digest();
                    if (!expected) throw new Error('The checksum published beside the file could not be read.');
                    if (expected !== actual) { keep = false; throw new Error('The file downloaded does not match the checksum published beside it: it was not kept. Try again.'); }
                }
            } catch (error) {
                // What arrived stays for a later try, unless it is known to be no use.
                if (keep) await out.close().catch(() => {}); else await out.abort?.();
                await response.cancel().catch(() => {});
                if (!keep) await discardPartialFiles(key);
                if (signal?.aborted) throw new Error('The download was cancelled.');
                throw withSpaceMessage(error);
            }
            const id = randomId();
            await volume.rename(names(key).part, names(id).data);
            await volume.remove(names(key).partial);
            return add({ id, name: fileName, bytes: done, storedAt: new Date(now()).toISOString(), origin: { kind: 'download', url, ...(server ? { server: String(server).slice(0, 120) } : {}) }, details: checkedDetails(details) });
        },
        // Downloads left unfinished, the latest first. One not touched for a week, or with a half missing, is removed here.
        async partials() {
            const all = await volume.names();
            const found = [];
            for (const file of all.filter((item) => item.endsWith('.partial'))) {
                const id = file.slice(0, -8);
                if (active.has(id)) continue;
                const kept = validId(id) ? await readPartial(id) : null;
                if (!kept || !kept.bytes || now() - kept.updatedAt > partialLifeMilliseconds) { await discardPartialFiles(id); continue; }
                found.push({ id, name: kept.meta.name, url: kept.meta.url, server: kept.meta.server, details: kept.meta.details ?? {}, bytes: kept.bytes, total: kept.meta.total ?? null, updatedAt: new Date(kept.updatedAt).toISOString() });
            }
            for (const file of all.filter((item) => item.endsWith('.part') && validId(item.slice(0, -5)))) {
                if (!all.includes(`${file.slice(0, -5)}.partial`)) await volume.remove(file);
            }
            return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        },
        // Gives up an unfinished download, so its bytes are not kept.
        async discardPartial(id) {
            if (validId(id)) await discardPartialFiles(id);
        },
        // How large the file at an allowed address is, asked of the server before downloading it: bytes, or null when the server does not say.
        async size({ url, hosts }) {
            const allowed = allowedHosts(hosts);
            let address;
            try { address = new URL(url); } catch { throw new Error('That is not a web address.'); }
            addressFailure(address, allowed, 'download');
            const response = await transport.stream({ url: address.href, hosts: [...allowed], method: 'HEAD', timeoutMilliseconds: connectTimeoutMilliseconds });
            await response.cancel();
            if (!(response.status >= 200 && response.status < 300)) throw new Error(`${new URL(response.url).hostname} answered ${response.status}.`);
            return bodyLength(response);
        },
        // Adds an add-on's details to an entry (merged with those it has).
        async describe(id, details) {
            const entry = validId(id) ? await readJson(names(id).meta) : null;
            if (!entry) throw new Error('No such stored file.');
            const updated = { ...entry, details: checkedDetails({ ...entry.details, ...checkedDetails(details) }) };
            await volume.writeText(names(id).meta, JSON.stringify(updated));
            return updated;
        },
        async remove(id) {
            if (!validId(id)) return;
            await Promise.all([volume.remove(names(id).data), volume.remove(names(id).meta), volume.remove(names(id).part)]);
        },
        // The bytes kept, in all.
        async usage() {
            return (await this.list()).reduce((sum, entry) => sum + entry.bytes, 0);
        },
        async clear() { await volume.clear(); }
    };
}
