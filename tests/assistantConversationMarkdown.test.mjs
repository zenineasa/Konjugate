/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationMarkdown } from '../src/assistantConversationMarkdown.mjs';

const conversation = {
    title: 'Heat exchanger', forkedFrom: { title: 'First try' },
    turns: [
        { request: 'Make a heat exchanger', createdAt: 0, project: { title: 'Plant' }, model: { configuration: 'Claude (through Claude Code)', model: 'default' },
            outcome: { kind: 'asked', text: 'Asked: Counterflow or parallel?' }, reply: { responseKind: 'clarification', question: 'Counterflow or parallel?' } },
        { request: 'Counterflow\n# not a heading', createdAt: 60_000, project: { title: 'Plant' }, model: { configuration: 'Claude (through Claude Code)', model: 'opus' },
            reference: { summary: 'Cells from last week' },
            outcome: { kind: 'applied', text: 'Applied: Ten cells in counterflow' }, before: 'a', after: 'b',
            reply: { responseKind: 'proposal', summary: 'Ten cells', assumptions: ['Water on both sides.'], operations: [{}, {}, {}] } },
        { request: 'Add a heat sink', createdAt: 120_000, outcome: { kind: 'rejected', text: 'Rejected: 1 problem' }, problems: ['Heat Loss: no state variables.'] }
    ]
};

test('A conversation exports as a record: each request, when and with which model, what came of it, assumptions and problems', () => {
    const markdown = conversationMarkdown(conversation, { exportedAt: 0, formatTime: (time) => `t${time / 60_000}` });
    assert.match(markdown, /^# Heat exchanger\n\nA conversation with Konjugate's model assistant, exported t0\.\nForked from “First try”\.\n/);
    assert.match(markdown, /## 1\. Make a heat exchanger\n\n\*t0 · project “Plant” · Claude \(through Claude Code\)\*\n\n\*\*The assistant asked\*\*: Counterflow or parallel\?/);
    assert.match(markdown, /## 2\. Counterflow # not a heading\n\n\*t1 · project “Plant” · Claude \(through Claude Code\), opus\*/);
    assert.match(markdown, /About an earlier proposal: Cells from last week/);
    assert.match(markdown, /\*\*Applied\*\*: Ten cells in counterflow\n\nAssumptions:\n\n- Water on both sides\.\n\nThe proposal had 3 operations\.\n\nThe model was kept before and after this change\./);
    assert.match(markdown, /\*\*Rejected\*\*: 1 problem\n\nProblems found:\n\n- Heat Loss: no state variables\./);
    assert.equal(markdown.split('\n').some((line) => line === '# not a heading'), false, 'A request made a heading of its own.');
    assert.equal(conversationMarkdown({ title: '', turns: [] }, { exportedAt: 0 }).includes('No turns yet.'), true);
});
