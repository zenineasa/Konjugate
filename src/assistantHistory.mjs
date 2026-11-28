/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The model assistant's history (docs/proposals/assistantHistory.md): every conversation, kept for the person on this computer
// whichever project it was about, so work from one project can be found and reused in another. Shaped like Git, but Konjugate's
// own: one folder for each conversation holding its turns (the commits) and the model snapshots they need (named by the SHA-256
// of their content, compressed), and nothing shared between conversations, so deleting one removes everything it kept and
// touches no other. A fork is a new conversation holding copies of what it started from. Not encrypted: it is the person's own
// working record, like the model they work on.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

export const assistantHistoryVersion = 1;
const conversationFile = 'conversation.json';
const snapshotsFolder = 'snapshots';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const maximumTurnCharacters = 1_000_000;
const maximumSnapshotCharacters = 50_000_000;
const outcomeKinds = new Set(['pending', 'proposed', 'applied', 'discarded', 'rejected', 'asked', 'unanswered', 'error', 'cancelled']);

export class AssistantHistoryError extends Error {
    constructor(message, code = 'historyError') {
        super(message);
        this.name = 'AssistantHistoryError';
        this.code = code;
    }
}

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

// What a turn may hold, from what the window sent: anything else is dropped, and each part is bounded.
function cleanTurn(input = {}) {
    const turn = {
        request: text(input.request, 8000),
        outcome: {
            kind: outcomeKinds.has(input.outcome?.kind) ? input.outcome.kind : 'pending',
            text: text(input.outcome?.text, 20_000)
        },
        reply: input.reply && typeof input.reply === 'object' ? input.reply : null,
        problems: Array.isArray(input.problems) ? input.problems.filter((item) => typeof item === 'string').slice(0, 50).map((item) => item.slice(0, 1000)) : [],
        model: { configuration: text(input.model?.configuration, 200), provider: text(input.model?.provider, 100), model: text(input.model?.model, 200) },
        project: input.project && typeof input.project === 'object' ? { title: text(input.project.title, 300), path: text(input.project.path, 2000) } : null,
        // An earlier proposal this request drew on (Ask about this), by its summary.
        reference: input.reference && typeof input.reference === 'object' ? { summary: text(input.reference.summary, 500) } : null,
        before: typeof input.before === 'string' && hashPattern.test(input.before) ? input.before : null,
        after: typeof input.after === 'string' && hashPattern.test(input.after) ? input.after : null
    };
    if (JSON.stringify(turn).length > maximumTurnCharacters) throw new AssistantHistoryError('That turn is too large to keep.', 'turnTooLarge');
    return turn;
}

// The words a search looks in: the title, every request and every outcome.
const searchText = (conversation) => [conversation.title, ...conversation.turns.flatMap((turn) => [turn.request, turn.outcome.text])].join('\n').toLocaleLowerCase();

export function createAssistantHistory({ directory, uuidFactory = randomUUID, now = Date.now } = {}) {
    if (!directory) throw new AssistantHistoryError('The assistant history needs a folder.');
    const folderOf = (id) => {
        if (typeof id !== 'string' || !idPattern.test(id)) throw new AssistantHistoryError('That conversation does not exist.', 'conversationNotFound');
        return join(directory, id);
    };
    // One write at a time for each conversation, so two quick updates never interleave.
    const queues = new Map();
    const serially = (id, task) => {
        const next = (queues.get(id) ?? Promise.resolve()).then(task, task);
        queues.set(id, next.catch(() => {}));
        return next;
    };

    const writeAtomically = async (path, content) => {
        const temporary = `${path}.${uuidFactory()}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    };
    const read = async (id) => {
        let loaded;
        try { loaded = JSON.parse(await readFile(join(folderOf(id), conversationFile), 'utf8')); } catch (error) {
            if (error.code === 'ENOENT') throw new AssistantHistoryError('That conversation does not exist.', 'conversationNotFound');
            throw error;
        }
        if (loaded?.version !== assistantHistoryVersion || !Array.isArray(loaded.turns)) throw new AssistantHistoryError('That conversation was kept in a format this Konjugate cannot read.', 'unsupportedFormat');
        return loaded;
    };
    const write = (conversation) => writeAtomically(join(folderOf(conversation.id), conversationFile), `${JSON.stringify(conversation)}\n`);
    const summary = (conversation) => {
        const last = conversation.turns.at(-1);
        return {
            id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
            turnCount: conversation.turns.length, forkedFrom: conversation.forkedFrom ?? null,
            project: last?.project?.title ?? '', model: last?.model?.configuration ?? ''
        };
    };
    const folderSize = async (folder) => {
        let total = 0;
        for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
            const path = join(folder, entry.name);
            total += entry.isDirectory() ? await folderSize(path) : (await stat(path).catch(() => ({ size: 0 }))).size;
        }
        return total;
    };
    const ids = async () => (await readdir(directory, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && idPattern.test(entry.name)).map((entry) => entry.name);

    const history = {
        // The conversations, the most recently used first; `query` keeps those whose title, requests or outcomes contain every word.
        async list({ query = '' } = {}) {
            const words = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
            const conversations = [];
            for (const id of await ids()) {
                try {
                    const conversation = await read(id);
                    if (words.length && !words.every((word) => searchText(conversation).includes(word))) continue;
                    conversations.push(summary(conversation));
                } catch { /* a conversation that cannot be read is left out, not fatal */ }
            }
            return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
        },
        async get(id) {
            return read(id);
        },
        // A new conversation; `forkedFrom` ({ conversationId, turnId, title }) when it is a fork, which create alone does not copy.
        async create({ title = 'New conversation', forkedFrom = null } = {}) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const id = uuidFactory();
            await mkdir(join(folderOf(id), snapshotsFolder), { recursive: true, mode: 0o700 });
            const time = now();
            const conversation = {
                version: assistantHistoryVersion, id, title: text(title, 200).trim() || 'New conversation', createdAt: time, updatedAt: time,
                forkedFrom: forkedFrom && idPattern.test(forkedFrom.conversationId ?? '') ? { conversationId: forkedFrom.conversationId, turnId: text(forkedFrom.turnId, 100), title: text(forkedFrom.title, 200) } : null,
                turns: []
            };
            await write(conversation);
            return conversation;
        },
        // Adds a turn after the last one; returns it with its id.
        async appendTurn(id, input) {
            return serially(id, async () => {
                const conversation = await read(id);
                const turn = { id: uuidFactory(), parentId: conversation.turns.at(-1)?.id ?? null, createdAt: now(), ...cleanTurn(input) };
                conversation.turns.push(turn);
                conversation.updatedAt = turn.createdAt;
                await write(conversation);
                return turn;
            });
        },
        // Changes what a turn says (its outcome as it changes, its reply once it has one, its snapshots); other turns are untouched.
        async updateTurn(id, turnId, changes) {
            return serially(id, async () => {
                const conversation = await read(id);
                const index = conversation.turns.findIndex((turn) => turn.id === turnId);
                if (index < 0) throw new AssistantHistoryError('That turn does not exist.', 'turnNotFound');
                const existing = conversation.turns[index];
                const merged = cleanTurn({ ...existing, ...changes, outcome: { ...existing.outcome, ...(changes?.outcome ?? {}) } });
                conversation.turns[index] = { id: existing.id, parentId: existing.parentId, createdAt: existing.createdAt, ...merged };
                conversation.updatedAt = now();
                await write(conversation);
                return conversation.turns[index];
            });
        },
        async rename(id, title) {
            return serially(id, async () => {
                const conversation = await read(id);
                conversation.title = text(title, 200).trim() || conversation.title;
                await write(conversation);
                return summary(conversation);
            });
        },
        // A model document kept in the conversation's own folder, named by its content; returns its hash.
        async putSnapshot(id, document) {
            const json = typeof document === 'string' ? document : JSON.stringify(document);
            if (json.length > maximumSnapshotCharacters) throw new AssistantHistoryError('That model is too large to keep a checkpoint of.', 'snapshotTooLarge');
            const hash = createHash('sha256').update(json).digest('hex');
            const path = join(folderOf(id), snapshotsFolder, `${hash}.bin`);
            try { await stat(path); } catch {
                await mkdir(join(folderOf(id), snapshotsFolder), { recursive: true, mode: 0o700 });
                await writeAtomically(path, gzipSync(strToU8(json), { level: 6 }));
            }
            return hash;
        },
        async getSnapshot(id, hash) {
            if (!hashPattern.test(hash ?? '')) throw new AssistantHistoryError('That checkpoint does not exist.', 'snapshotNotFound');
            try {
                return JSON.parse(strFromU8(gunzipSync(await readFile(join(folderOf(id), snapshotsFolder, `${hash}.bin`)))));
            } catch (error) {
                throw new AssistantHistoryError(error.code === 'ENOENT' ? 'That checkpoint is no longer kept.' : 'That checkpoint could not be read.', 'snapshotNotFound');
            }
        },
        // Deletes the conversation's folder: its turns, replies and snapshots. Its forks keep their own copies.
        async remove(id) {
            const folder = folderOf(id);
            await serially(id, () => rm(folder, { recursive: true, force: true }));
            queues.delete(id);
            return true;
        },
        // Deletes every conversation.
        async clear() {
            for (const id of await ids()) await history.remove(id);
            return true;
        },
        // Keeps the history within `limitBytes`: the least recently used conversations' checkpoints go first (their turns stay,
        // and say a checkpoint is no longer kept when it is asked for), then whole conversations, never `keep`'s. Returns what went.
        async enforceLimit(limitBytes, { keep = null } = {}) {
            const entries = [];
            for (const id of await ids()) {
                const folder = join(directory, id);
                const updatedAt = await read(id).then((conversation) => conversation.updatedAt).catch(() => 0);
                entries.push({ id, updatedAt, bytes: await folderSize(folder), snapshotBytes: await folderSize(join(folder, snapshotsFolder)) });
            }
            let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
            const removed = { checkpoints: [], conversations: [] };
            if (total <= limitBytes) return removed;
            const oldestFirst = entries.filter((entry) => entry.id !== keep).sort((a, b) => a.updatedAt - b.updatedAt);
            for (const entry of oldestFirst) {
                if (total <= limitBytes) break;
                if (!entry.snapshotBytes) continue;
                await serially(entry.id, async () => {
                    await rm(join(directory, entry.id, snapshotsFolder), { recursive: true, force: true });
                    await mkdir(join(directory, entry.id, snapshotsFolder), { recursive: true, mode: 0o700 });
                });
                total -= entry.snapshotBytes;
                entry.bytes -= entry.snapshotBytes;
                removed.checkpoints.push(entry.id);
            }
            for (const entry of oldestFirst) {
                if (total <= limitBytes) break;
                await history.remove(entry.id);
                total -= entry.bytes;
                removed.conversations.push(entry.id);
            }
            return removed;
        },
        // How much is kept: the number of conversations and the bytes they take.
        async usage() {
            const all = await ids();
            let bytes = 0;
            for (const id of all) bytes += await folderSize(join(directory, id));
            return { conversations: all.length, bytes };
        }
    };
    return Object.freeze(history);
}
