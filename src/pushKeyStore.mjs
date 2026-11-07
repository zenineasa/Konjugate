/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The keys of the push service (docs/proposals/pushService.md, "Keys"): one for each rig or script, named by the person who made it,
// allowed to send only the signals it is given, and revoked on its own. A key is 32 random bytes, shown once when it is made; only
// its SHA-256 hash is kept, with its name, its signals and when it was made or revoked, in `pushKeys.json` in the app's own folder,
// never in a project. A revoked key is kept (marked) so a script using it is told it was revoked, not that it is unknown.
//
// The file is written only by whoever manages the keys (the app's main process, or `konjugate --cli serve keys`), each change a
// read, a change and an atomic replace; the service only reads it, picking up a change within half a second, so a key added or
// revoked in the panel applies at once to a running service, in another process, with no message between them. When a key was
// last used is the service's to know, and is kept in memory and reported in its status, not written here.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const pushKeysFileName = 'pushKeys.json';
const keyPrefix = 'kjp_';
const signalNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

export const hashPushKey = (key) => createHash('sha256').update(String(key), 'utf8').digest('hex');

export class PushKeyStore {
    #path;
    #keys = [];
    #byHash = new Map();
    #loadedVersion = null;
    #checkedAt = -Infinity;
    #refreshing = null;
    #now;

    // directory: where pushKeys.json is kept. now: milliseconds, for the time a key is made or revoked (tests give their own).
    constructor(directory, { now = () => Date.now() } = {}) {
        this.#path = join(directory, pushKeysFileName);
        this.directory = directory;
        this.#now = now;
    }

    get path() { return this.#path; }

    // The keys as they are on disk, read again only when the file has changed (and checked at most every `minimumMilliseconds`). A
    // caller arriving while a check is under way waits for it, rather than answering from what was there before.
    async refresh({ minimumMilliseconds = 500 } = {}) {
        if (this.#refreshing) return this.#refreshing;
        const now = performance.now();
        if (now - this.#checkedAt < minimumMilliseconds) return;
        this.#checkedAt = now;
        this.#refreshing = this.#reload().finally(() => { this.#refreshing = null; });
        return this.#refreshing;
    }

    async #reload() {
        let version = null;
        try {
            const info = await stat(this.#path);
            version = `${info.mtimeMs}:${info.size}`;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (version === this.#loadedVersion) return;
        this.#loadedVersion = version;
        this.#keys = version === null ? [] : PushKeyStore.#parse(await readFile(this.#path, 'utf8'));
        this.#byHash = new Map(this.#keys.map((record) => [record.hash, record]));
    }

    static #parse(text) {
        const parsed = JSON.parse(text);
        if (parsed?.version !== 1 || !Array.isArray(parsed.keys)) throw new Error('The push service\'s key file is not one this version of Konjugate reads.');
        return parsed.keys.map((record) => Object.freeze({ ...record, signals: Object.freeze([...record.signals]) }));
    }

    // The keys, newest first, without their hashes: { name, signals, created, revoked }.
    async list() {
        await this.refresh({ minimumMilliseconds: 0 });
        return this.#keys.map(({ hash: _hash, ...record }) => record).sort((a, b) => b.created - a.created);
    }

    // The record a key belongs to, or null; revoked records are found too (record.revoked is when).
    async find(key) {
        if (typeof key !== 'string' || !key.startsWith(keyPrefix)) return null;
        const hash = hashPushKey(key);
        await this.refresh();
        if (this.#byHash.has(hash)) return this.#byHash.get(hash);
        // Not known: perhaps made since the last look, so the file is looked at again before the key is refused.
        await this.#refreshNow();
        return this.#byHash.get(hash) ?? null;
    }

    // A look at the file that starts now, after any look already under way (which may have begun before the change being sought).
    async #refreshNow() {
        await this.#refreshing?.catch(() => {});
        this.#checkedAt = -Infinity;
        await this.refresh({ minimumMilliseconds: 0 });
    }

    // The record a client admitted earlier belongs to, found again by its key's hash: a key revoked while a connection is open is
    // seen at the connection's next message.
    async findByHash(hash) {
        await this.refresh();
        return this.#byHash.get(hash) ?? null;
    }

    // Makes a key for `name`, allowed to send `signals`; answers { key, record }, the key itself shown this once.
    async add(name, signals) {
        const cleanName = String(name ?? '').trim();
        if (!cleanName) throw new Error('A key needs a name: the rig or script that will use it.');
        const cleanSignals = [...new Set((signals ?? []).map((signal) => String(signal).trim()).filter(Boolean))];
        if (!cleanSignals.length) throw new Error('A key needs at least one signal it may send.');
        const badSignal = cleanSignals.find((signal) => !signalNamePattern.test(signal));
        if (badSignal) throw new Error(`"${badSignal}" cannot name a signal: use letters, digits and underscores, starting with a letter.`);
        return this.#change((keys) => {
            if (keys.some((record) => !record.revoked && record.name === cleanName)) throw new Error(`There is already a key named "${cleanName}".`);
            const key = keyPrefix + randomBytes(32).toString('base64url');
            const record = { name: cleanName, hash: hashPushKey(key), signals: cleanSignals, created: this.#now(), revoked: null };
            keys.push(record);
            const { hash: _hash, ...shown } = record;
            return { key, record: shown };
        });
    }

    // Revokes the key named `name`; it stops working at once, and the others go on.
    async revoke(name) {
        return this.#change((keys) => {
            const record = keys.find((candidate) => !candidate.revoked && candidate.name === name);
            if (!record) throw new Error(`There is no key named "${name}".`);
            record.revoked = this.#now();
            return true;
        });
    }

    async #change(apply) {
        await mkdir(this.directory, { recursive: true });
        let keys = [];
        try {
            keys = PushKeyStore.#parse(await readFile(this.#path, 'utf8')).map((record) => ({ ...record, signals: [...record.signals] }));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const answer = apply(keys);
        const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.#path);
        await this.#refreshNow();
        return answer;
    }
}
