/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsage, describeUsage, usage, usageFrom } from '../src/assistantUsage.mjs';

test('Each provider\'s report is read into one shape, and nothing countable is nothing', () => {
    assert.deepEqual(usageFrom.chatCompletions({ prompt_tokens: 1200, completion_tokens: 310, prompt_tokens_details: { cached_tokens: 900 }, cost: 0.004 }),
        { inputTokens: 1200, cachedInputTokens: 900, outputTokens: 310, costUsd: 0.004, premiumRequests: 0 });
    assert.deepEqual(usageFrom.anthropic({ input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 2500, output_tokens: 400 }),
        { inputTokens: 2600, cachedInputTokens: 2500, outputTokens: 400, costUsd: 0, premiumRequests: 0 }, 'Anthropic\'s cached input is input too.');
    assert.deepEqual(usageFrom.gemini({ promptTokenCount: 3000, candidatesTokenCount: 200, thoughtsTokenCount: 100 }).outputTokens, 300, 'Gemini\'s thinking is output.');
    assert.deepEqual(usageFrom.ollama({ prompt_eval_count: 2800, eval_count: 350 }), { inputTokens: 2800, cachedInputTokens: 0, outputTokens: 350, costUsd: 0, premiumRequests: 0 });
    assert.equal(usageFrom.copilot({ premiumRequests: 1 }).premiumRequests, 1);
    assert.equal(usageFrom.chatCompletions(undefined), undefined);
    assert.equal(usage({}), null);
    assert.equal(usage({ inputTokens: -5, outputTokens: Number.NaN }), null);
});

test('Usage adds up over the attempts of a request, and reads as one line, with the plan it counts against', () => {
    const total = addUsage(usage({ inputTokens: 2700, cachedInputTokens: 0, outputTokens: 400 }), usage({ inputTokens: 2900, cachedInputTokens: 2600, outputTokens: 350 }));
    assert.deepEqual(total, { inputTokens: 5600, cachedInputTokens: 2600, outputTokens: 750, costUsd: 0, premiumRequests: 0 });
    assert.equal(addUsage(null, total), total);
    assert.equal(describeUsage(total, 'anthropic'), '5.6k tokens in (2.6k cached) · 750 out');
    assert.equal(describeUsage(usage({ inputTokens: 1200, outputTokens: 310, costUsd: 0.004 }), 'openRouter'), '1.2k tokens in · 310 out · $0.0040');
    assert.equal(describeUsage(usage({ inputTokens: 12_400, outputTokens: 900, costUsd: 0.21 }), 'claudeCode'), '12k tokens in · 900 out · ≈ $0.21 at API prices · from your Claude plan');
    assert.equal(describeUsage(usage({ premiumRequests: 1 }), 'copilotCli'), '1 premium request · from your Copilot plan');
    assert.equal(describeUsage(null), '');
});
