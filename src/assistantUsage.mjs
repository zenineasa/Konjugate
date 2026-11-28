/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a model request used, as each provider reports it, in one shape (docs/aiProviderArchitecture.md, "What a request
// costs"): input tokens (of them, how many were read from the provider's cache), output tokens, and where the provider says
// so, the cost in dollars or the premium requests a plan counted. No price tables: prices change, so a cost is shown only when
// the provider reports one. Plain data in, plain data and text out.

const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'costUsd', 'premiumRequests'];
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

// Usage in the one shape, from whatever the provider sent; null when it sent nothing countable.
export function usage({ inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, costUsd = 0, premiumRequests = 0 } = {}) {
    const result = { inputTokens: count(inputTokens), cachedInputTokens: count(cachedInputTokens), outputTokens: count(outputTokens), costUsd: count(costUsd), premiumRequests: count(premiumRequests) };
    return fields.some((field) => result[field] > 0) ? result : null;
}

// Two usages added, for the attempts of one request and the turns of one conversation.
export function addUsage(a, b) {
    if (!a) return b ?? null;
    if (!b) return a;
    return Object.fromEntries(fields.map((field) => [field, count(a[field]) + count(b[field])]));
}

const compact = (value) => (value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)));
// Providers that bill a subscription rather than the tokens: their tokens are counted against the plan's limits.
const planProviders = { claudeCode: 'your Claude plan', chatGpt: 'your ChatGPT plan', copilotCli: 'your Copilot plan' };

// One line a person reads: "1.2k tokens in (900 cached) · 310 out · $0.004", with the plan it counts against where there is one.
// Claude Code's cost is its own estimate at API prices, which a subscription does not pay, so it is said as an estimate.
export function describeUsage(value, provider = '') {
    if (!value) return '';
    const parts = [];
    if (value.inputTokens || value.outputTokens) {
        parts.push(`${compact(value.inputTokens)} tokens in${value.cachedInputTokens ? ` (${compact(value.cachedInputTokens)} cached)` : ''}`);
        parts.push(`${compact(value.outputTokens)} out`);
    }
    if (value.premiumRequests) parts.push(`${value.premiumRequests} premium ${value.premiumRequests === 1 ? 'request' : 'requests'}`);
    if (value.costUsd) {
        const dollars = value.costUsd < 0.01 ? value.costUsd.toFixed(4) : value.costUsd.toFixed(2);
        parts.push(provider === 'claudeCode' ? `≈ $${dollars} at API prices` : `$${dollars}`);
    }
    if (planProviders[provider]) parts.push(`from ${planProviders[provider]}`);
    return parts.join(' · ');
}

// The shortest form, for a list: "8.1k tokens", or the premium requests or dollars where there are no tokens.
export function shortUsage(value) {
    if (!value) return '';
    const tokens = count(value.inputTokens) + count(value.outputTokens);
    if (tokens) return `${compact(tokens)} tokens`;
    if (value.premiumRequests) return `${value.premiumRequests} premium ${value.premiumRequests === 1 ? 'request' : 'requests'}`;
    return value.costUsd ? `$${value.costUsd.toFixed(2)}` : '';
}

// Each provider's own report, read into the one shape.
export const usageFrom = Object.freeze({
    // OpenAI chat completions and the APIs that copy them (OpenRouter adds its cost, in dollars of credit).
    chatCompletions: (raw) => raw && usage({
        inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens,
        cachedInputTokens: raw.prompt_tokens_details?.cached_tokens, costUsd: raw.cost
    }),
    // OpenAI's Responses API (ChatGPT plan usage).
    responses: (raw) => raw && usage({ inputTokens: raw.input_tokens, outputTokens: raw.output_tokens, cachedInputTokens: raw.input_tokens_details?.cached_tokens }),
    // Anthropic's Messages API and Claude Code: input is split into uncached, written to the cache and read from it.
    anthropic: (raw, costUsd = 0) => raw && usage({
        inputTokens: count(raw.input_tokens) + count(raw.cache_creation_input_tokens) + count(raw.cache_read_input_tokens),
        cachedInputTokens: raw.cache_read_input_tokens, outputTokens: raw.output_tokens, costUsd
    }),
    // Gemini's usageMetadata; its thinking is billed as output.
    gemini: (raw) => raw && usage({
        inputTokens: raw.promptTokenCount, cachedInputTokens: raw.cachedContentTokenCount,
        outputTokens: count(raw.candidatesTokenCount) + count(raw.thoughtsTokenCount)
    }),
    // Ollama's last chunk: what it read and what it wrote; nothing is charged.
    ollama: (raw) => raw && usage({ inputTokens: raw.prompt_eval_count, outputTokens: raw.eval_count }),
    // The Copilot CLI's result line.
    copilot: (raw) => raw && usage({ premiumRequests: raw.premiumRequests })
});
