/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAssistantHistory } from '../src/assistantHistory.mjs';

async function withHistory(task) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-history-'));
    let clock = 1000;
    try {
        await task(createAssistantHistory({ directory, now: () => (clock += 10) }), directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('A conversation keeps its turns in order, each naming the one before, and its replies and outcomes as they change', () => withHistory(async (history) => {
    const conversation = await history.create({ title: 'Heat exchanger' });
    const first = await history.appendTurn(conversation.id, { request: 'Make a heat exchanger', outcome: { kind: 'asked', text: 'Asked: counterflow?' }, reply: { responseKind: 'clarification', question: 'Counterflow?' }, model: { configuration: 'Claude', provider: 'claudeCode', model: 'default' }, project: { title: 'untitled', path: '' } });
    const second = await history.appendTurn(conversation.id, { request: 'Counterflow', outcome: { kind: 'pending', text: '' } });
    assert.equal(first.parentId, null);
    assert.equal(second.parentId, first.id);
    await history.updateTurn(conversation.id, second.id, { reply: { responseKind: 'proposal', summary: 'Cells', operations: [] }, outcome: { kind: 'proposed', text: 'Proposed: Cells' } });
    await history.updateTurn(conversation.id, second.id, { outcome: { kind: 'applied', text: 'Applied: Cells' } });
    const kept = await history.get(conversation.id);
    assert.deepEqual(kept.turns.map((turn) => [turn.request, turn.outcome.kind]), [['Make a heat exchanger', 'asked'], ['Counterflow', 'applied']]);
    assert.equal(kept.turns[1].reply.summary, 'Cells', 'Changing the outcome lost the reply.');
    assert.deepEqual(kept.turns[0].model, { configuration: 'Claude', provider: 'claudeCode', model: 'default' });
    await assert.rejects(history.updateTurn(conversation.id, 'not-a-turn', {}), { code: 'turnNotFound' });
}));

test('Conversations are listed most recently used first, and found by any word of their title, requests or outcomes', () => withHistory(async (history) => {
    const older = await history.create({ title: 'Battery' });
    await history.appendTurn(older.id, { request: 'Add an ambient boundary', outcome: { kind: 'proposed', text: 'Proposed: Ambient boundary at 293 K' } });
    const newer = await history.create({ title: 'Heat exchanger' });
    await history.appendTurn(newer.id, { request: 'Counterflow cells', outcome: { kind: 'applied', text: 'Applied: ten cells' }, project: { title: 'Plant', path: '/x/Plant.kjt' }, model: { configuration: 'Claude' } });
    const listed = await history.list();
    assert.deepEqual(listed.map((item) => item.title), ['Heat exchanger', 'Battery']);
    assert.deepEqual({ project: listed[0].project, model: listed[0].model, turnCount: listed[0].turnCount }, { project: 'Plant', model: 'Claude', turnCount: 1 });
    assert.deepEqual((await history.list({ query: 'ambient 293' })).map((item) => item.title), ['Battery']);
    assert.deepEqual((await history.list({ query: 'TEN cells' })).map((item) => item.title), ['Heat exchanger']);
    assert.deepEqual(await history.list({ query: 'nothing like this' }), []);
}));

test('Deleting a conversation removes its folder and everything in it, and leaves the others; clearing removes all', () => withHistory(async (history, directory) => {
    const kept = await history.create({ title: 'Kept' });
    const gone = await history.create({ title: 'Gone' });
    const hash = await history.putSnapshot(gone.id, { nodes: [{ id: 1 }], edges: [] });
    assert.deepEqual(await history.getSnapshot(gone.id, hash), { nodes: [{ id: 1 }], edges: [] });
    await history.remove(gone.id);
    assert.deepEqual((await readdir(directory)).sort(), [kept.id]);
    await assert.rejects(history.get(gone.id), { code: 'conversationNotFound' });
    assert.equal((await history.list()).length, 1);
    await history.clear();
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(await history.usage(), { conversations: 0, bytes: 0 });
}));

test('A model snapshot is stored once in its conversation however often it is kept, and never in another', () => withHistory(async (history, directory) => {
    const one = await history.create({ title: 'One' });
    const two = await history.create({ title: 'Two' });
    const model = { nodes: [{ id: 1, name: 'A' }], edges: [] };
    const first = await history.putSnapshot(one.id, model);
    assert.equal(await history.putSnapshot(one.id, JSON.stringify(model)), first);
    assert.equal((await readdir(join(directory, one.id, 'snapshots'))).length, 1);
    assert.deepEqual(await readdir(join(directory, two.id, 'snapshots')), [], 'A snapshot was shared with another conversation.');
    await assert.rejects(history.getSnapshot(two.id, first), { code: 'snapshotNotFound' });
    assert.ok((await history.usage()).bytes > 0);
}));

test('Nothing outside the history folder can be named, and what a turn may hold is bounded', () => withHistory(async (history, directory) => {
    await assert.rejects(history.get('../../etc'), { code: 'conversationNotFound' });
    await assert.rejects(history.remove('../outside'), { code: 'conversationNotFound' });
    await assert.rejects(history.getSnapshot((await history.create()).id, '../../conversation.json'), { code: 'snapshotNotFound' });
    const conversation = await history.create({ title: '  ' });
    assert.equal(conversation.title, 'New conversation');
    const turn = await history.appendTurn(conversation.id, { request: 'x'.repeat(9000), outcome: { kind: 'made up', text: 'y' }, extra: 'dropped', before: 'not a hash' });
    assert.equal(turn.request.length, 8000);
    assert.equal(turn.outcome.kind, 'pending');
    assert.equal('extra' in turn, false);
    assert.equal(turn.before, null);
    await assert.rejects(history.appendTurn(conversation.id, { request: 'big', reply: { text: 'z'.repeat(1_100_000) } }), { code: 'turnTooLarge' });
    // A conversation whose file cannot be read is left out of the list, not fatal.
    await writeFile(join(directory, conversation.id, 'conversation.json'), 'not json');
    assert.deepEqual(await history.list(), (await history.list()).filter((item) => item.id !== conversation.id));
}));

test('Over its size limit, the history drops the least recently used checkpoints first, then whole conversations, never the one in use', () => withHistory(async (history) => {
    const big = (seed) => ({ nodes: Array.from({ length: 400 }, (_, index) => ({ id: index, name: `${seed}-${index}-${Math.sin(index * seed)}` })), edges: [] });
    const oldest = await history.create({ title: 'Oldest' });
    await history.putSnapshot(oldest.id, big(1));
    const middle = await history.create({ title: 'Middle' });
    await history.putSnapshot(middle.id, big(2));
    const current = await history.create({ title: 'Current' });
    await history.putSnapshot(current.id, big(3));
    const { bytes } = await history.usage();
    assert.deepEqual(await history.enforceLimit(bytes + 1, { keep: current.id }), { checkpoints: [], conversations: [] }, 'Within the limit, nothing goes.');
    // Just under: the oldest conversation's checkpoints go, and it stays.
    const first = await history.enforceLimit(bytes - 1, { keep: current.id });
    assert.deepEqual(first, { checkpoints: [oldest.id], conversations: [] });
    assert.equal((await history.list()).length, 3);
    // Far under: every other conversation's checkpoints, then those conversations; the one in use stays whole.
    const second = await history.enforceLimit(1, { keep: current.id });
    assert.deepEqual(second.conversations.sort(), [oldest.id, middle.id].sort());
    assert.deepEqual((await history.list()).map((item) => item.id), [current.id]);
    assert.ok((await history.usage()).bytes > 0, 'The conversation in use lost what it kept.');
}));

test('A fork holds its own copies of the turns and checkpoints up to where it was made, and outlives the conversation it came from', () => withHistory(async (history, directory) => {
    const source = await history.create({ title: 'Heat exchanger' });
    const beforeHash = await history.putSnapshot(source.id, { nodes: [], edges: [] });
    const afterHash = await history.putSnapshot(source.id, { nodes: [{ id: 1 }], edges: [] });
    const first = await history.appendTurn(source.id, { request: 'Make cells', outcome: { kind: 'applied', text: 'Applied: cells' }, before: beforeHash, after: afterHash });
    const second = await history.appendTurn(source.id, { request: 'Counterflow', outcome: { kind: 'proposed', text: 'Proposed: counterflow' } });
    await history.appendTurn(source.id, { request: 'Later', outcome: { kind: 'proposed', text: 'Proposed: later' } });

    const fork = await history.fork(source.id, second.id);
    assert.equal(fork.title, 'Heat exchanger (fork)');
    assert.deepEqual(fork.forkedFrom, { conversationId: source.id, turnId: second.id, title: 'Heat exchanger' });
    assert.deepEqual(fork.turns.map((turn) => turn.request), ['Make cells', 'Counterflow']);
    const edit = await history.fork(source.id, second.id, { including: false });
    assert.deepEqual(edit.turns.map((turn) => turn.request), ['Make cells'], 'Editing a turn forks from the turn before it.');
    // A fork from before any turn still holds the model it starts from.
    const fromTheStart = await history.fork(source.id, first.id, { including: false, startingFrom: beforeHash });
    assert.deepEqual(fromTheStart.turns, []);
    assert.deepEqual(await history.getSnapshot(fromTheStart.id, beforeHash), { nodes: [], edges: [] });

    // The fork's checkpoints are its own: deleting where it came from leaves them, and its turns, whole.
    await history.remove(source.id);
    assert.deepEqual(await history.getSnapshot(fork.id, afterHash), { nodes: [{ id: 1 }], edges: [] });
    assert.equal((await history.get(fork.id)).turns[0].id, first.id);
    const continued = await history.appendTurn(fork.id, { request: 'Parallel instead', outcome: { kind: 'pending', text: '' } });
    assert.equal(continued.parentId, second.id, 'A turn added to the fork does not follow the turn it was forked from.');
    assert.deepEqual((await readdir(join(directory, fork.id, 'snapshots'))).sort(), [afterHash, beforeHash].sort().map((hash) => `${hash}.bin`));
    await assert.rejects(history.fork(fork.id, 'no-such-turn'), { code: 'turnNotFound' });
}));

test('Saved prompts are kept apart from conversations, once each, newest first, and outlive clearing the conversations', () => withHistory(async (history) => {
    assert.deepEqual(await history.listPrompts(), []);
    const first = await history.savePrompt('  Add a convective loss to ambient for every node  ');
    await history.savePrompt('Make every relationship bidirectional');
    await history.savePrompt('Add a convective loss to ambient for every node');
    const listed = await history.listPrompts();
    assert.deepEqual(listed.map((prompt) => prompt.text), ['Add a convective loss to ambient for every node', 'Make every relationship bidirectional'], 'A prompt saved again was kept twice, or not moved to the top.');
    await assert.rejects(history.savePrompt('   '), { code: 'emptyPrompt' });
    const conversation = await history.create({ title: 'Something' });
    await history.clear();
    assert.equal((await history.listPrompts()).length, 2, 'Clearing the conversations cleared the saved prompts.');
    assert.deepEqual(await history.usage(), { conversations: 0, bytes: 0 }, 'The saved prompts were counted as a conversation.');
    void conversation;
    assert.equal(await history.removePrompt(listed[1].id), true);
    assert.equal(await history.removePrompt(first.id), false, 'A prompt saved again has a new id; the old one is gone.');
    assert.deepEqual((await history.listPrompts()).map((prompt) => prompt.text), ['Add a convective loss to ambient for every node']);
    await history.clearPrompts();
    assert.deepEqual(await history.listPrompts(), []);
}));

test('The same request is answered from the newest turn asked it, in any conversation, unless that answer was turned down', () => withHistory(async (history) => {
    const key = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    assert.equal(await history.findAnswer(key), null);
    assert.equal(await history.findAnswer('not a key'), null);
    const first = await history.create({ title: 'Battery' });
    const proposal = { responseKind: 'proposal', summary: 'Cells', operations: [{ op: 'addNode' }] };
    const turn = await history.appendTurn(first.id, { request: 'Add cells', outcome: { kind: 'applied', text: 'Applied: Cells' }, reply: proposal, key });
    await history.appendTurn(first.id, { request: 'Something else', outcome: { kind: 'proposed', text: 'Proposed: x' }, reply: { responseKind: 'proposal', summary: 'x', operations: [] }, key: other });
    const found = await history.findAnswer(key);
    assert.deepEqual([found.conversationId, found.turnId, found.reply], [first.id, turn.id, proposal]);
    assert.equal(found.conversationTitle, 'Battery');

    // A newer turn with the same key, in another conversation, answers instead; once it is discarded, nothing is reused.
    const second = await history.create({ title: 'Battery again' });
    const newer = await history.appendTurn(second.id, { request: 'Add cells', outcome: { kind: 'asked', text: 'Asked: how many?' }, reply: { responseKind: 'clarification', question: 'How many?' }, key });
    assert.equal((await history.findAnswer(key)).turnId, newer.id);
    await history.updateTurn(second.id, newer.id, { outcome: { kind: 'discarded', text: 'Discarded' } });
    assert.equal(await history.findAnswer(key), null, 'An answer the person discarded was offered again.');

    // A turn without a reply is never an answer, and a reused turn says where it came from.
    await history.appendTurn(second.id, { request: 'Add cells', outcome: { kind: 'error', text: 'Error: timed out' }, key: other });
    assert.equal((await history.findAnswer(other)).reply.summary, 'x');
    const reused = await history.appendTurn(second.id, { request: 'Add cells', reusedFrom: { conversationId: first.id, turnId: turn.id, createdAt: turn.createdAt }, key: 'not hex' });
    assert.deepEqual(reused.reusedFrom, { conversationId: first.id, turnId: turn.id, createdAt: turn.createdAt });
    assert.equal(reused.key, null);
}));

test('A regenerated turn keeps every version, with what each used and was asked with, and which one is chosen', () => withHistory(async (history) => {
    const conversation = await history.create({ title: 'Cells' });
    const first = { responseKind: 'proposal', summary: 'Ten cells', operations: [] };
    const second = { responseKind: 'proposal', summary: 'Five cells', operations: [] };
    const turn = await history.appendTurn(conversation.id, { request: 'Add cells', outcome: { kind: 'proposed', text: 'Proposed: Ten cells' }, reply: first });
    assert.equal(turn.versions, null, 'A turn answered once has versions.');
    const versions = [
        { reply: first, usage: { inputTokens: 100, outputTokens: 10 }, note: '', model: { configuration: 'Local', provider: 'ollama', model: 'qwen' }, createdAt: 5 },
        { reply: second, usage: { inputTokens: 120, outputTokens: 12 }, note: 'use five cells', model: { configuration: 'Claude', provider: 'claudeCode', model: 'default' }, createdAt: 6, secret: 'dropped' }
    ];
    await history.updateTurn(conversation.id, turn.id, { reply: second, versions, version: 1, outcome: { kind: 'applied', text: 'Applied: Five cells' } });
    const kept = (await history.get(conversation.id)).turns[0];
    assert.equal(kept.version, 1);
    assert.deepEqual(kept.versions.map((version) => [version.reply.summary, version.note, version.model.provider, version.usage.inputTokens]), [['Ten cells', '', 'ollama', 100], ['Five cells', 'use five cells', 'claudeCode', 120]]);
    assert.equal('secret' in kept.versions[1], false);
    assert.equal(kept.reply.summary, 'Five cells');
}));
