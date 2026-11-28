/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { AssistantProviderError } from './assistantProviders.mjs';
import { isStreamingResponse, newlineDelimitedJson, serverSentEvents, streamLines } from './aiStreaming.mjs';
import { loopbackAuthorization } from './aiOAuth.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'node:crypto';
import { usageFrom } from './assistantUsage.mjs';

const defaults = Object.freeze({
    ollama: 'http://127.0.0.1:11434',
    openAi: 'https://api.openai.com',
    nvidia: 'https://integrate.api.nvidia.com',
    huggingFace: 'https://router.huggingface.co',
    openRouter: 'https://openrouter.ai/api',
    anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com'
});

function baseUrl(configuration) {
    const value = configuration.endpoint || defaults[configuration.provider];
    let url;
    try { url = new URL(value); } catch { throw new AssistantProviderError('The provider endpoint is not a valid URL.', 'invalidEndpoint'); }
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        throw new AssistantProviderError('Remote AI endpoints must use HTTPS. Plain HTTP is allowed only for localhost.', 'insecureEndpoint');
    }
    return url.href.replace(/\/$/, '');
}

async function responseOk(fetchImpl, url, options = {}, { unauthorizedHint = '' } = {}) {
    let response;
    try { response = await fetchImpl(url, options); } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new AssistantProviderError(`Could not connect to the AI provider: ${error.message}`, 'connectionFailed');
    }
    if (!response.ok) {
        const text = await response.text();
        let detail = text.slice(0, 500);
        let providerCode = null;
        try {
            const body = JSON.parse(text);
            detail = String(body.error?.message ?? body.message ?? body.detail ?? detail).slice(0, 500);
            providerCode = typeof body.error?.code === 'string' ? body.error.code : null;
        } catch { /* use bounded text */ }
        const hint = response.status === 401 && unauthorizedHint ? ` ${unauthorizedHint}` : '';
        const failure = new AssistantProviderError(`The AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}${hint}`, 'providerHttpError');
        failure.status = response.status;
        // The provider's own name for what went wrong (OpenAI's `error.code`), for an adapter that explains some of them.
        failure.providerCode = providerCode;
        throw failure;
    }
    return response;
}

async function jsonBody(response) {
    try { return JSON.parse(await response.text()); } catch { throw new AssistantProviderError('The AI provider returned invalid JSON.', 'invalidProviderResponse'); }
}

async function responseJson(fetchImpl, url, options = {}, hints = {}) {
    return jsonBody(await responseOk(fetchImpl, url, options, hints));
}

// Google is retiring standard API keys for the Gemini API: unrestricted ones are already refused, and the
// refusal reads like an OAuth problem, which sends people looking in the wrong place. New keys made in
// Google AI Studio are the kind it accepts.
const geminiUnauthorizedHint = 'If the key was made some time ago, Google may no longer accept it: it is phasing out standard API keys for the Gemini API (unrestricted ones are already refused). Create a new key in Google AI Studio and enter it in this configuration.';

const maximumOutputCharacters = 2_000_000;

function streamError(chunk) {
    const detail = chunk?.error?.message ?? (typeof chunk?.error === 'string' ? chunk.error : null);
    if (detail !== null && detail !== undefined) {
        throw new AssistantProviderError(`The AI provider reported an error: ${String(detail).slice(0, 500)}`, 'providerHttpError');
    }
}

// One generation request. A server that streams (server-sent events or newline-delimited JSON) is read
// as it arrives, reporting each piece of the model's reasoning and output through `onEvent` so the panel
// can show what is happening and the idle clock can see the model is alive; one that answers with a
// plain JSON body (a proxy that buffers, an older server) still works, reporting everything at the end.
// `fromChunk` and `fromWhole` read one provider's own shapes and return { output, thinking }.
async function generateText(fetchImpl, url, options, { protocol, fromChunk, fromWhole, unauthorizedHint }, onEvent) {
    const response = await responseOk(fetchImpl, url, options, { unauthorizedHint });
    let output = '';
    if (!isStreamingResponse(response)) {
        const whole = await jsonBody(response);
        streamError(whole);
        const read = fromWhole(whole);
        if (read.thinking) onEvent?.({ type: 'thinking', text: read.thinking });
        if (read.output) onEvent?.({ type: 'output', text: read.output });
        if (read.usage) onEvent?.({ type: 'usage', usage: read.usage });
        return typeof read.output === 'string' && read.output !== '' ? read.output : undefined;
    }
    const events = protocol === 'sse' ? serverSentEvents : newlineDelimitedJson;
    // What the request used, as the stream last said it (some providers repeat running totals in every chunk): told once, at the end.
    let lastUsage = null;
    try {
        output = await readStream();
    } finally {
        if (lastUsage) onEvent?.({ type: 'usage', usage: lastUsage });
    }
    return output === '' ? undefined : output;

    async function readStream() {
    let text = '';
    for await (const chunk of events(streamLines(response, () => onEvent?.({ type: 'activity' })))) {
        streamError(chunk);
        const read = fromChunk(chunk);
        if (read.usage) lastUsage = read.usage;
        if (read.thinking) onEvent?.({ type: 'thinking', text: read.thinking });
        if (read.output) {
            text += read.output;
            if (text.length > maximumOutputCharacters) {
                throw new AssistantProviderError('The AI provider response is too large.', 'responseTooLarge');
            }
            onEvent?.({ type: 'output', text: read.output });
        }
    }
    return text;
    }
}

const equationRules = `EQUATION RULES:\n- The latex field must be real LaTeX math notation, exactly what you would typeset in a document, never a function-call expression. Function-call syntax like Name(args) is not LaTeX and will be misparsed letter by letter.\n- Wrap every state and parameter symbol in \\mathrm{...}, for example \\mathrm{sourceTemperature}, never bare sourceTemperature. Without \\mathrm{}, a multi-letter symbol is misread as a product of single-letter variables (temperature becomes t times e times m times p times e times r times a times t times u times r times e), which is the single most common cause of an equation being rejected.\n- Write multiplication as juxtaposition or \\cdot, e.g. "5 \\cdot \\mathrm{heatingPower}", never "Multiply(5, heatingPower)". Write subtraction as "\\mathrm{a} - \\mathrm{b}", never "Subtract(a, b)". Write powers as "\\mathrm{x}^{2}", never "Power(x, 2)". Write division as "\\frac{\\mathrm{a}}{\\mathrm{b}}", never "Divide(a, b)". Write square roots as "\\sqrt{\\mathrm{x}}", never "Sqrt(x)", and other roots as "\\sqrt[3]{\\mathrm{x}}" for Root.\n- Named functions (Max, Min, Sin, Cos, Tan, Ln, Log, Exp) use their literal lowercase LaTeX command applied like a function, e.g. "\\max(\\mathrm{a}, \\mathrm{b})", "\\min(\\mathrm{a}, \\mathrm{b})", "\\sin(\\mathrm{x})", "\\ln(\\mathrm{x})". Never write these as "\\operatorname{Max}(...)" or a bare capitalized word like "Max(a, b)" -- both are rejected. Write Abs as "\\left|\\mathrm{x}\\right|", never "Abs(x)". Write Negate as a unary minus, "-\\mathrm{x}", never "Negate(x)".\n- For a piecewise value write a LaTeX cases environment with a final otherwise branch, e.g. "\\begin{cases} \\mathrm{rate} & \\mathrm{sourceStock} > 0 \\\\ 0 & \\text{otherwise} \\end{cases}". Conditions may use <, >, \\le, \\ge, =, \\ne, \\land, \\lor and \\lnot; comparisons are only allowed as conditions, never as values.\n- Only these operators are supported: Abs, Add, Cos, Divide, Exp, Ln, Log, Max, Min, Multiply, Negate, Power, Root, Sin, Sqrt, Subtract, Tan, and Which (cases) with Less, LessEqual, Greater, GreaterEqual, Equal, NotEqual, And, Or, Not in its conditions. Never use complex numbers, derivatives, summations, or any other operator or function.\n- Every equation may use t, the simulation time in seconds, for schedules and time-varying inputs (e.g. \"\\begin{cases} \\mathrm{rate} & 3600 \\le t < 7200 \\\\ 0 & \\text{otherwise} \\end{cases}\"). Write it as a bare t, never \\mathrm{t}. Never use t to integrate a state yourself; the engine integrates states over time automatically. Never use the bare letters i or e as symbols outside \\mathrm{}; a real math parser treats them as the imaginary unit and Euler's number.\n- A local source-term equation (addSourceTerm) may only reference that same node's own declared state symbols, used exactly as declared. Nodes cannot have named parameters; write any constant coefficient as a plain number.\n- A relationship equation (setEdgeEquation) may only reference: for each state on the edge's source node, "source" followed by that state's symbol capitalized (a state with symbol "temperature" becomes "sourceTemperature"); for each state on the edge's target node, "target" followed by that state's symbol capitalized ("targetTemperature"); and any parameter already added to that edge with addParameter, using exactly the symbol declared there.\n- Declare every state and every edge parameter an equation will use before the operation that writes the equation, and use no symbol that was not declared this way.`;

// The prompt in two parts (docs/aiProviderArchitecture.md, "What a request costs"). The instructions are the same for every
// request (the task, the equation rules and, unless the provider enforces it, the operation schema), so each adapter sends them
// first, as the provider's system instructions where it has them: a repeated prefix is what providers cache, and are charged
// less for. What changes (the model context, the request and any correction) comes last, after the conversation's turns.
// `includeSchema: false` where the provider is given the schema to enforce (structured outputs), which shows it to the model
// itself; sending it in the text as well would only cost tokens.
export function assistantInstructions(operationSchema, { includeSchema = true } = {}) {
    const schema = includeSchema ? `\n\nOPERATION SCHEMA:\n${JSON.stringify(operationSchema)}` : '\n\nThe response must match the JSON schema this request enforces.';
    return `You are the Konjugate modelling assistant. Create a Konjugate model-operation proposal for the user's request. Return only JSON matching the supplied schema: either a { "responseKind": "proposal", ... } object, or, if the request is ambiguous (could reasonably apply to more than one entity) or missing information needed to act (e.g. a value), a { "responseKind": "clarification", "question": "...", "suggestions": ["...", ...] } object instead of guessing. suggestions is optional and capped at 5 short options. Prefer a clarification over inventing a plausible-sounding assumption whenever there's a genuine choice to make; state engineering assumptions explicitly when you do proceed with a proposal instead. Use existing numeric entity IDs exactly. Use lower camel case for temporary refs and symbols. Do not invent existing entities.\n\n${equationRules}${schema}`;
}

export function requestPrompt(context, request, repair) {
    const correction = repair ? `\n\nCORRECTION REQUIRED:\nYour previous proposal was rejected: ${repair.error}\nPrevious rejected proposal:\n${JSON.stringify(repair.proposal)}\nReturn a complete corrected proposal, not a patch or explanation.` : '';
    return `MODEL CONTEXT:\n${JSON.stringify(context)}\n\nUSER REQUEST:\n${request}${correction}`;
}

// Regenerate (docs/aiProviderArchitecture.md, "Another answer"): the person wants a different proposal for the same request, so
// the proposals they did not take and what they want different go with it, for the model to propose something else rather
// than a near copy. Appended to the request; bounded by the caller.
export function alternativesPrompt({ earlier = [], note = '' } = {}) {
    const said = String(note ?? '').trim();
    const shown = earlier.map((proposal) => ({ summary: proposal?.summary ?? '', assumptions: proposal?.assumptions ?? [], operations: proposal?.operations ?? [] }));
    return `\n\nANOTHER ANSWER WANTED: the person asked for a different proposal for this same request. ${shown.length === 1 ? 'An earlier proposal they did not take' : 'Earlier proposals they did not take'}:\n${JSON.stringify(shown)}\n${said ? `What should be different: ${said}\n` : ''}Propose a different approach that still does what the request asks${said ? ' and does what they said' : ''}; do not repeat an earlier proposal.`;
}

// Both parts as one text, for a provider that takes a single prompt.
export function proposalPrompt(operationSchema, context, request, repair) {
    return `${assistantInstructions(operationSchema)}\n\n${requestPrompt(context, request, repair)}`;
}

// Prior turns are a compact { request, outcome } summary the renderer builds (never the raw
// proposal JSON, to keep the payload bounded) -- see assistantTurnHistory in renderer.mjs. Two
// shapes: real alternating messages for chat-completions APIs that support them, and a single
// prepended text block for the providers below that only ever send one blob.
function historyMessages(history) {
    return (history ?? []).flatMap((turn) => [
        { role: 'user', content: turn.request },
        { role: 'assistant', content: turn.outcome }
    ]);
}

export function historyText(history) {
    if (!history?.length) return '';
    const lines = history.map((turn) => `User: ${turn.request}\nAssistant: ${turn.outcome}`).join('\n');
    return `CONVERSATION SO FAR:\n${lines}\n\n`;
}

// Small models often quote an entity id ("stateRef": "2"). A temporary ref must start with a letter, so a string of digits
// can only mean the numeric id; reading it as one cannot select a different entity.
const referenceFields = new Set(['stateRef', 'nodeRef', 'edgeRef', 'entityRef', 'parameterRef', 'outputStateRef', 'sourceNodeRef', 'targetNodeRef']);
function numericReferences(proposal) {
    if (!Array.isArray(proposal?.operations)) return proposal;
    for (const operation of proposal.operations) {
        if (!operation || typeof operation !== 'object') continue;
        for (const field of referenceFields) {
            if (typeof operation[field] === 'string' && /^[1-9]\d{0,15}$/.test(operation[field])) operation[field] = Number(operation[field]);
        }
    }
    return proposal;
}

// For adapters elsewhere (the vendor tools) that read a proposal the same way.
export const parseProposalText = (text) => parseProposal(text);

function parseProposal(text) {
    if (typeof text !== 'string') throw new AssistantProviderError('The AI provider did not return proposal text.', 'emptyProviderOutput');
    const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return numericReferences(JSON.parse(normalized)); } catch { throw new AssistantProviderError('The AI provider returned malformed proposal JSON.', 'invalidProposalJson'); }
}

function requireCredential(credential, providerName) {
    if (!credential) throw new AssistantProviderError(`${providerName} requires an API key.`, 'credentialRequired');
}

// `headers`: sent with every request besides the key. `modelsPath`: where the models this key can use are listed.
// `extra`: what else the provider offers (signing in, choosing a model after it).
// `streamUsage`: the API takes stream_options.include_usage, so a stream ends with what it used (OpenAI); others report it unasked
// (OpenRouter) or not at all, and are not sent an option they may refuse.
function openAICompatibleProvider({ id, name, endpoint, schemaResponse = false, headers = {}, modelsPath = '/v1/models', extra = {}, streamUsage = false }) {
    return {
        id, name, defaultEndpoint: endpoint, defaultTimeoutSeconds: 60, credentialRequired: true, locality: 'online', ...extra,
        async listModels({ configuration, credential, signal, fetchImpl }) {
            requireCredential(credential, name);
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: id, endpoint: configuration.endpoint || endpoint })}${modelsPath}`, {
                headers: { ...headers, Authorization: `Bearer ${credential}` }, signal
            });
            return (result.data ?? []).map((model) => ({ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id }));
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: id, modelCount: models.length };
        },
        async generateProposal({ configuration, credential, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent }) {
            requireCredential(credential, name);
            if (!configuration.model) throw new AssistantProviderError('Select a model before generating a proposal.', 'modelRequired');
            const url = `${baseUrl({ ...configuration, provider: id, endpoint: configuration.endpoint || endpoint })}/v1/chat/completions`;
            // The instructions first (cacheable), the schema in them only when the response format is not the schema itself.
            const attempt = (responseFormat) => generateText(fetchImpl, url, {
                method: 'POST', signal,
                headers: { ...headers, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: configuration.model,
                    messages: [
                        { role: 'system', content: assistantInstructions(operationSchema, { includeSchema: responseFormat.type !== 'json_schema' }) },
                        ...historyMessages(history),
                        { role: 'user', content: requestPrompt(context, request, repair) }
                    ],
                    response_format: responseFormat,
                    stream: true,
                    ...(streamUsage ? { stream_options: { include_usage: true } } : {})
                })
            }, {
                protocol: 'sse',
                // Reasoning models name the reasoning field differently depending on who serves them.
                fromChunk: (chunk) => {
                    const delta = chunk.choices?.[0]?.delta ?? {};
                    return { output: delta.content ?? '', thinking: delta.reasoning_content ?? delta.reasoning ?? '', usage: usageFrom.chatCompletions(chunk.usage) };
                },
                fromWhole: (body) => {
                    const message = body.choices?.[0]?.message ?? {};
                    return { output: message.content, thinking: message.reasoning_content ?? message.reasoning ?? '', usage: usageFrom.chatCompletions(body.usage) };
                }
            }, onEvent);
            const schemaFormat = { type: 'json_schema', json_schema: { name: 'konjugate_proposal', strict: false, schema: operationSchema } };
            let text;
            try {
                text = await attempt(schemaResponse ? schemaFormat : { type: 'json_object' });
            } catch (error) {
                // OpenAI's schema mode has rules of its own about the schema (its documentation says the root must
                // be an object and not anyOf, while this proposal schema is a oneOf of two shapes). If the schema is
                // what it refused, ask again in plain JSON mode, which every provider here supports: the host
                // validates the proposal against the full schema either way.
                if (!schemaResponse || error.status !== 400 || !/response_format|json_schema|schema/i.test(error.message)) throw error;
                text = await attempt({ type: 'json_object' });
            }
            return parseProposal(text);
        }
    };
}

function ollamaProvider() {
    return {
        id: 'ollama', name: 'Ollama', defaultEndpoint: defaults.ollama, defaultTimeoutSeconds: 180,
        credentialRequired: false, locality: 'local', reasoningSetting: true,
        async listModels({ configuration, signal, fetchImpl }) {
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: 'ollama' })}/api/tags`, { signal });
            return (result.models ?? []).map((model) => ({ id: model.model ?? model.name, name: model.name ?? model.model }));
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: 'ollama', modelCount: models.length };
        },
        async generateProposal({ configuration, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent, vary = false }) {
            if (!configuration.model) throw new AssistantProviderError('Select an installed Ollama model before generating a proposal.', 'modelRequired');
            const text = await generateText(fetchImpl, `${baseUrl({ ...configuration, provider: 'ollama' })}/api/chat`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: configuration.model, stream: true,
                    format: 'json',
                    // Only when set: models that cannot think reject `think`, and the default is the model's own.
                    ...(typeof configuration.think === 'boolean' ? { think: configuration.think } : {}),
                    // Edits should repeat for the same request, and Ollama's default window (4096 tokens) is barely larger than this prompt. A proposal is a few hundred tokens, so the cap only ever stops a model that has started to loop.
                    // `vary` (another answer to the same request) lifts the temperature for that request, or the same answer comes back.
                    options: { temperature: vary ? 0.8 : 0, num_ctx: 8192, num_predict: 4096 },
                    // The instructions first: Ollama keeps a loaded model's work on an unchanged prompt start, so requests start sooner.
                    messages: [
                        { role: 'system', content: assistantInstructions(operationSchema) },
                        { role: 'user', content: historyText(history) + requestPrompt(context, request, repair) }
                    ]
                })
            }, {
                protocol: 'ndjson',
                fromChunk: (chunk) => ({ output: chunk.message?.content ?? '', thinking: chunk.message?.thinking ?? '', usage: chunk.done ? usageFrom.ollama(chunk) : null }),
                fromWhole: (body) => ({ output: body.message?.content, thinking: body.message?.thinking ?? '', usage: usageFrom.ollama(body) })
            }, onEvent);
            return parseProposal(text);
        }
    };
}

function geminiProvider() {
    return {
        id: 'gemini', name: 'Google Gemini', defaultEndpoint: defaults.gemini, defaultTimeoutSeconds: 60,
        credentialRequired: true, locality: 'online',
        // Keys made in Google AI Studio are free and have a free tier, the shortest way to a working Gemini configuration.
        keyPage: 'https://aistudio.google.com/apikey', keyPageLabel: 'Get a free key from Google AI Studio ›',
        async listModels({ configuration, credential, signal, fetchImpl }) {
            requireCredential(credential, 'Google Gemini');
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: 'gemini' })}/v1beta/models`, {
                headers: { 'x-goog-api-key': credential }, signal
            }, { unauthorizedHint: geminiUnauthorizedHint });
            return (result.models ?? []).filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
                .map((model) => ({ id: model.name.replace(/^models\//, ''), name: model.displayName ?? model.name }));
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: 'gemini', modelCount: models.length };
        },
        async generateProposal({ configuration, credential, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent }) {
            requireCredential(credential, 'Google Gemini');
            if (!configuration.model) throw new AssistantProviderError('Select a Gemini model before generating a proposal.', 'modelRequired');
            const model = encodeURIComponent(configuration.model.replace(/^models\//, ''));
            // Gemini marks reasoning summaries with `thought: true` on a part, when the model sends any.
            const fromParts = (body) => {
                const parts = body.candidates?.[0]?.content?.parts ?? [];
                const textOf = (selected) => selected.map((part) => part.text ?? '').join('');
                return { output: textOf(parts.filter((part) => !part.thought)), thinking: textOf(parts.filter((part) => part.thought)), usage: usageFrom.gemini(body.usageMetadata) };
            };
            const text = await generateText(fetchImpl, `${baseUrl({ ...configuration, provider: 'gemini' })}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
                method: 'POST', signal, headers: { 'x-goog-api-key': credential, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: assistantInstructions(operationSchema) }] },
                    contents: [{ role: 'user', parts: [{ text: historyText(history) + requestPrompt(context, request, repair) }] }],
                    generationConfig: { responseMimeType: 'application/json' }
                })
            }, { protocol: 'sse', fromChunk: fromParts, fromWhole: fromParts, unauthorizedHint: geminiUnauthorizedHint }, onEvent);
            return parseProposal(text);
        }
    };
}

// The numbers in a model id, for telling a newer version of a family from an older one ("…-4.5" before "…-5").
const versionOf = (id) => (id.match(/\d+/g) ?? []).map(Number);
const newerFirst = (a, b) => {
    const [left, right] = [versionOf(a.id), versionOf(b.id)];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (right[index] ?? -1) - (left[index] ?? -1);
        if (difference) return difference;
    }
    return 0;
};

// What a sign-in starts with when the person has not chosen: the newest of the first family the account offers. These are
// strong at the assistant's job and priced for everyday use; the largest models (Claude Opus, for one) cost several times
// more per request on an account that pays per use, so they are a choice the person makes, not the default. Variants
// (":free", ":thinking") are left out: their limits and behaviour differ from the model's own.
export const openRouterPreferredFamilies = Object.freeze([
    /^anthropic\/claude-sonnet-[\d.]+$/,
    /^openai\/gpt-[\d.]+$/,
    /^google\/gemini-[\d.]+-pro$/
]);

export function suggestedModel(models, families = openRouterPreferredFamilies) {
    const plain = models.filter((model) => typeof model?.id === 'string' && !model.id.includes(':'));
    for (const family of families) {
        const matches = plain.filter((model) => family.test(model.id)).sort(newerFirst);
        if (matches.length) return matches[0].id;
    }
    return plain[0]?.id ?? models[0]?.id ?? '';
}

// OpenRouter: one account for models from every major vendor, signed in to with OAuth and PKCE
// (https://openrouter.ai/docs/guides/overview/auth/oauth). The sign-in hands back an ordinary key that belongs to the
// person's own account, which they can see, limit and revoke on OpenRouter, so it is kept like any other key. The
// attribution headers name Konjugate on the person's OpenRouter activity page; they change nothing about a request.
const openRouterSite = 'https://openrouter.ai';
function openRouterProvider() {
    return openAICompatibleProvider({
        id: 'openRouter', name: 'OpenRouter', endpoint: defaults.openRouter,
        headers: { 'HTTP-Referer': 'https://github.com/zenineasa/Konjugate', 'X-OpenRouter-Title': 'Konjugate' },
        // The models this key may use, after the account's own guardrails and privacy settings.
        modelsPath: '/v1/models/user',
        extra: {
            signInDescription: 'One account for Claude, GPT, Gemini and many more. Pay only for what you use.',
            keyPage: `${openRouterSite}/settings/keys`,
            suggestModel: (models) => suggestedModel(models),
            async signIn({ openExternal, signal, fetchImpl }) {
                const { code, verifier } = await loopbackAuthorization({
                    host: 'localhost', requireState: false, openExternal, signal,
                    authorizationUrl: (redirectUri, { challenge, state }) => `${openRouterSite}/auth?${new URLSearchParams({
                        callback_url: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, key_label: 'Konjugate'
                    })}`
                });
                const result = await responseJson(fetchImpl, `${openRouterSite}/api/v1/auth/keys`, {
                    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' })
                });
                if (typeof result?.key !== 'string' || !result.key.trim()) throw new AssistantProviderError('OpenRouter did not return a key.', 'invalidProviderResponse');
                return { credential: result.key.trim() };
            }
        }
    });
}

// What Claude's structured outputs accept of the operation schema: a copy with `oneOf` as `anyOf` (the two shapes are told
// apart by `responseKind`, so either reads the same), and without the keywords structured outputs do not take (string
// and number limits, patterns, array sizes) or that describe the document rather than the value. Only the request is
// constrained by the copy: the host still validates the proposal against the full schema.
const unsupportedOutputKeywords = new Set(['$schema', '$id', '$comment', 'title', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems']);
export function claudeOutputSchema(schema) {
    if (Array.isArray(schema)) return schema.map(claudeOutputSchema);
    if (!schema || typeof schema !== 'object') return schema;
    // A tuple (`prefixItems`, draft 2020-12) becomes an array of its item types: Claude Code's schema check refuses
    // `prefixItems`, and structured outputs take no array sizes anyway. Its length is still checked by the full schema.
    if (Array.isArray(schema.prefixItems)) {
        const { prefixItems, items, ...rest } = schema;
        const kinds = [...new Map(prefixItems.map((item) => [JSON.stringify(item), item])).values()];
        return claudeOutputSchema({ ...rest, items: kinds.length === 1 ? kinds[0] : { anyOf: kinds } });
    }
    return Object.fromEntries(Object.entries(schema)
        .filter(([key]) => !unsupportedOutputKeywords.has(key))
        .map(([key, value]) => [key === 'oneOf' ? 'anyOf' : key, key === 'properties' || key === '$defs'
            ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, claudeOutputSchema(entry)]))
            : claudeOutputSchema(value)]));
}

// The SDK's failures as the adapters' own: a cancel stays an AbortError (which the main process tells from a timeout), an
// HTTP refusal keeps its status, and a connection that never opened says so.
function fromAnthropicError(error) {
    if (error instanceof Anthropic.APIUserAbortError || error?.name === 'AbortError') return new DOMException('The request was cancelled.', 'AbortError');
    if (error instanceof Anthropic.APIConnectionError) return new AssistantProviderError(`Could not connect to the AI provider: ${error.message}`, 'connectionFailed');
    if (error instanceof Anthropic.APIError && error.status) {
        const detail = String(error.error?.error?.message ?? error.message ?? '').slice(0, 500);
        const failure = new AssistantProviderError(`The AI provider returned HTTP ${error.status}${detail ? `: ${detail}` : '.'}`, 'providerHttpError');
        failure.status = error.status;
        return failure;
    }
    return error;
}

// Anthropic (Claude) with an API key from the Claude Console, through Anthropic's own SDK, given this module's fetch so
// requests are made the same way as every other provider's. Proposals are asked for with structured outputs and the
// reduced schema above; a model or schema the API will not constrain (HTTP 400 naming the format) is asked again without
// it, as OpenAI's schema mode is. No `thinking` setting is sent: each model's own default is used, since models differ in
// which settings they accept, so the panel shows no reasoning (current models think without showing it by default).
function anthropicProvider() {
    const client = ({ configuration, credential, fetchImpl }) => new Anthropic({
        apiKey: credential, baseURL: baseUrl({ ...configuration, provider: 'anthropic' }), fetch: fetchImpl
    });
    return {
        id: 'anthropic', name: 'Anthropic (Claude)', defaultEndpoint: defaults.anthropic, defaultTimeoutSeconds: 120,
        credentialRequired: true, locality: 'online', keyPage: 'https://platform.claude.com/settings/keys',
        async listModels({ configuration, credential, signal, fetchImpl }) {
            requireCredential(credential, 'Anthropic');
            const models = [];
            try {
                for await (const model of client({ configuration, credential, fetchImpl }).models.list({}, { signal })) {
                    models.push({ id: model.id, name: model.display_name || model.id });
                }
            } catch (error) { throw fromAnthropicError(error); }
            return models;
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: 'anthropic', modelCount: models.length };
        },
        async generateProposal({ configuration, credential, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent }) {
            requireCredential(credential, 'Anthropic');
            if (!configuration.model) throw new AssistantProviderError('Select a Claude model before generating a proposal.', 'modelRequired');
            const anthropic = client({ configuration, credential, fetchImpl });
            const attempt = async (constrained) => {
                const stream = anthropic.messages.stream({
                    model: configuration.model,
                    // A proposal is a few hundred tokens; the room is for the model's own thinking, which is billed as used.
                    max_tokens: 32000,
                    // The instructions as a cached block (repeated requests read it at a fraction of the price), without the schema
                    // when the output format enforces it.
                    system: [{ type: 'text', text: assistantInstructions(operationSchema, { includeSchema: !constrained }), cache_control: { type: 'ephemeral' } }],
                    messages: [...historyMessages(history), { role: 'user', content: requestPrompt(context, request, repair) }],
                    ...(constrained ? { output_config: { format: { type: 'json_schema', schema: claudeOutputSchema(operationSchema) } } } : {})
                }, { signal });
                let output = '';
                for await (const event of stream) {
                    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                        output += event.delta.text;
                        if (output.length > maximumOutputCharacters) throw new AssistantProviderError('The AI provider response is too large.', 'responseTooLarge');
                        onEvent?.({ type: 'output', text: event.delta.text });
                    } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && event.delta.thinking) {
                        onEvent?.({ type: 'thinking', text: event.delta.thinking });
                    } else {
                        // Any other event (a ping, a block starting) still shows the request is alive.
                        onEvent?.({ type: 'activity' });
                    }
                }
                const message = await stream.finalMessage();
                const used = usageFrom.anthropic(message.usage);
                if (used) onEvent?.({ type: 'usage', usage: used });
                if (message.stop_reason === 'refusal') {
                    throw new AssistantProviderError('Claude declined this request. Rephrase it, or choose another model or provider.', 'providerRefused');
                }
                return output === '' ? undefined : output;
            };
            let text;
            try {
                try {
                    text = await attempt(true);
                } catch (error) {
                    const failure = fromAnthropicError(error);
                    if (failure.status !== 400 || !/output_config|output_format|json_schema|schema|structured/i.test(failure.message)) throw failure;
                    text = await attempt(false);
                }
            } catch (error) { throw fromAnthropicError(error); }
            return parseProposal(text);
        }
    };
}

// ChatGPT plan usage (https://developers.openai.com/siwc/token-sharing-open-source): a person signs in with their ChatGPT
// account and Konjugate's requests are paid for by their Plus or Pro plan, within its limits, instead of by an API key.
// OpenAI documents it for open-source apps that run on the person's own computer, which Konjugate is; it is a preview.
// The first sign-in registers Konjugate with the account (client_id=dynamic_agent_client, a stable host id for this
// installation and the app's name), and the callback names the client OpenAI issued, which every later request uses.
// The credential is that client, the account and the tokens, kept together as one JSON string in the configuration's
// encrypted credential: an access token for an hour, and a refresh token for thirty days that is replaced by each refresh.
const chatGptAuth = 'https://auth.openai.com';
const chatGptResource = 'https://api.openai.com/v1';
const chatGptScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const chatGptPlanScope = 'chatgpt.tokens.use.direct';
const chatGptUsagePage = 'https://chatgpt.com/settings/usage';

const decodeJwtPayload = (token) => {
    try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
};

function readChatGptCredential(credential) {
    let record = null;
    try { record = JSON.parse(credential); } catch { /* not a sign-in */ }
    if (record?.kind !== 'chatGptSignIn' || typeof record.accessToken !== 'string' || typeof record.clientId !== 'string') {
        throw new AssistantProviderError('This ChatGPT configuration has no sign-in. Sign in with ChatGPT in Settings › Model assistant.', 'credentialRequired');
    }
    return record;
}

// What OpenAI's own error codes mean for the person, and what to do. Anything else is reported as it came.
function chatGptFailure(error) {
    const plain = (message, code) => Object.assign(new AssistantProviderError(message, code), { status: error.status, providerCode: error.providerCode });
    switch (error.providerCode) {
        case 'subscription_sharing_usage_limit_exceeded':
            return plain(`Your ChatGPT plan's limit for Konjugate is reached for now. See what is left at ${chatGptUsagePage}, or use another model configuration until then.`, 'planLimitReached');
        case 'subscription_sharing_user_not_eligible':
            return plain('Your ChatGPT plan cannot be used by apps such as Konjugate: it needs a Plus or Pro plan, and a workspace that allows it.', 'planNotEligible');
        case 'subscription_sharing_usage_unavailable':
        case 'subscription_sharing_user_unavailable':
            return plain('ChatGPT could not check your plan just now. Try again in a moment.', 'planTemporarilyUnavailable');
        case 'subscription_sharing_invalid_user':
            return plain('ChatGPT no longer accepts this sign-in. Sign in with ChatGPT again in Settings › Model assistant.', 'signInExpired');
        case 'subscription_sharing_unsupported_capability':
            return plain(`ChatGPT plan usage does not support part of this request${error.message ? ` (${error.message})` : ''}. Choose another model.`, 'unsupportedCapability');
        default:
            if (error.status === 401) return plain('ChatGPT did not accept this sign-in. Sign in with ChatGPT again in Settings › Model assistant.', 'signInExpired');
            if (error.status === 503) return plain('ChatGPT plan usage is not available just now. Try again in a moment.', 'planTemporarilyUnavailable');
            return error;
    }
}

const terminalRefreshErrors = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

function chatGptProvider() {
    // One refresh at a time per refresh token: OpenAI replaces the refresh token on each use, so two at once would race.
    const refreshing = new Map();

    async function tokenRequest(fetchImpl, fields, signal) {
        let response;
        try {
            response = await fetchImpl(`${chatGptAuth}/api/accounts/oauth/token`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields).toString()
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            throw new AssistantProviderError(`Could not connect to ChatGPT: ${error.message}`, 'connectionFailed');
        }
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* reported below */ }
        if (!response.ok) {
            const code = typeof body?.error === 'string' ? body.error : body?.error?.code ?? null;
            // OpenAI's own reason, which says more than the code (an expired code, a redirect that differs, a verifier that does not match).
            const reason = String(body?.error_description ?? body?.error?.message ?? (body ? '' : text) ?? '').trim().slice(0, 300);
            // An exchange refused as invalid_grant is, in others' experience and with no reason given, most often an account that
            // cannot share its plan with apps (Free, Go, or a work workspace), so the person is told that first.
            const advice = code === 'invalid_grant' && fields.grant_type === 'authorization_code'
                ? ' This usually means the ChatGPT account cannot share its plan with apps: it needs ChatGPT Plus or Pro on a personal account (not Free, Go or a work workspace). If it has Plus or Pro, try signing in again.'
                : ' Try signing in again.';
            const failure = new AssistantProviderError(`ChatGPT refused the sign-in (HTTP ${response.status}${code ? `, ${code}` : ''})${reason ? `: ${reason}` : '.'}${advice}`, 'signInFailed');
            failure.status = response.status;
            failure.providerCode = code;
            // What OpenAI answered, for the log: an error response carries no token.
            failure.responseBody = text.slice(0, 500);
            throw failure;
        }
        if (!body || typeof body.access_token !== 'string') throw new AssistantProviderError('ChatGPT returned an unexpected sign-in response.', 'invalidProviderResponse');
        return body;
    }

    // The credential with an access token good for at least another minute, refreshing (and saving through `onCredential`) if not.
    async function current({ credential, onCredential, signal, fetchImpl }) {
        const record = readChatGptCredential(credential);
        if (record.expiresAt - Date.now() > 60_000) return record;
        if (!record.refreshToken) throw new AssistantProviderError('Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings › Model assistant.', 'signInExpired');
        let pending = refreshing.get(record.refreshToken);
        if (!pending) {
            pending = (async () => {
                try {
                    const body = await tokenRequest(fetchImpl, {
                        grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.refreshToken, resource: chatGptResource
                    }, signal);
                    const renewed = {
                        ...record, accessToken: body.access_token, refreshToken: body.refresh_token ?? record.refreshToken,
                        expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000, scope: body.scope ?? record.scope
                    };
                    await onCredential?.(JSON.stringify(renewed));
                    return renewed;
                } catch (error) {
                    if (terminalRefreshErrors.has(error.providerCode)) {
                        throw new AssistantProviderError('Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings › Model assistant.', 'signInExpired');
                    }
                    throw error;
                } finally {
                    refreshing.delete(record.refreshToken);
                }
            })();
            refreshing.set(record.refreshToken, pending);
        }
        return pending;
    }

    const apiBase = (configuration) => baseUrl({ ...configuration, provider: 'chatGpt', endpoint: configuration.endpoint || defaults.openAi });

    return {
        id: 'chatGpt', name: 'ChatGPT', defaultEndpoint: defaults.openAi, defaultTimeoutSeconds: 120, credentialRequired: true, locality: 'online',
        signInOnly: true,
        signInDescription: 'Use your ChatGPT Plus or Pro plan, within its limits. No API key.',
        // The models the plan offers, in OpenAI's own order: its first is the one a sign-in starts with.
        suggestModel: (models) => models[0]?.id ?? '',
        async signIn({ openExternal, signal, fetchImpl, hostId, previous, registeredClientId = null, onClientIssued }) {
            if (typeof hostId !== 'string' || !hostId) throw new Error('Signing in to ChatGPT needs this installation\'s host id.');
            // Signing in again to an account Konjugate is registered with uses the client OpenAI issued for it, and skips the account choice.
            let earlier = null;
            try { earlier = previous ? readChatGptCredential(previous) : null; } catch { /* a first sign-in */ }
            // A client OpenAI issued on an earlier attempt from this computer is used again, even if that attempt did not finish:
            // OpenAI's documentation says to retain it and start a fresh authorization with it, not to register again.
            if (!earlier && registeredClientId) earlier = { clientId: registeredClientId, idToken: null };
            const nonce = randomBytes(16).toString('base64url');
            const { code, verifier, redirectUri, params } = await loopbackAuthorization({
                host: '127.0.0.1', path: '/auth/callback', preferredPort: 1455, openExternal, signal,
                authorizationUrl: (redirect, { challenge, state }) => `${chatGptAuth}/api/accounts/authorize?${new URLSearchParams({
                    client_id: earlier?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
                    ...(earlier ? (earlier.idToken ? { id_token_hint: earlier.idToken } : {}) : { agent_name_hint: 'Konjugate' }),
                    response_type: 'code', redirect_uri: redirect, scope: chatGptScopes, resource: chatGptResource,
                    state, nonce, code_challenge: challenge, code_challenge_method: 'S256'
                })}`
            });
            const clientId = earlier?.clientId ?? params.client_id;
            if (!clientId) throw new AssistantProviderError('ChatGPT did not finish registering Konjugate. Try signing in again.', 'signInFailed');
            if (earlier && params.client_id && params.client_id !== earlier.clientId) throw new AssistantProviderError('ChatGPT answered for a different registration of Konjugate. Try signing in again.', 'signInFailed');
            // Kept before the exchange, so a failed exchange does not lose it.
            if (!earlier) await onClientIssued?.(clientId);
            const body = await tokenRequest(fetchImpl, {
                grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: chatGptResource
            }, signal);
            // The ID token came straight from OpenAI's token endpoint over TLS, which OpenID Connect accepts in place of checking its
            // signature; what it says is still checked against this sign-in.
            const claims = decodeJwtPayload(body.id_token);
            const audiences = [claims?.aud].flat();
            if (!claims || claims.iss !== chatGptAuth || !audiences.includes(clientId) || claims.nonce !== nonce) {
                throw new AssistantProviderError('ChatGPT\'s sign-in response did not match this sign-in. Try again.', 'signInFailed');
            }
            const scope = String(body.scope ?? params.scope ?? '');
            if (!scope.split(/[\s+]+/).includes(chatGptPlanScope)) {
                throw new AssistantProviderError('You signed in, but using your ChatGPT plan in Konjugate was not allowed. Sign in again and allow it, or use another way to reach a model.', 'planUsageNotAllowed');
            }
            const record = {
                kind: 'chatGptSignIn', clientId, hostId, sub: claims.sub ?? null, email: typeof claims.email === 'string' ? claims.email : null,
                idToken: body.id_token, accessToken: body.access_token, refreshToken: body.refresh_token ?? null,
                expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000, scope
            };
            return { credential: JSON.stringify(record), account: record.email ?? '' };
        },
        // Ends the sign-in at OpenAI too (the registration stays, for a later sign-in). Best effort: the caller removes it here regardless.
        async signOut({ credential, signal, fetchImpl }) {
            const record = readChatGptCredential(credential);
            if (!record.refreshToken) return false;
            const discovery = await responseJson(fetchImpl, `${chatGptAuth}/.well-known/openid-configuration`, { signal });
            if (typeof discovery?.revocation_endpoint !== 'string' || !discovery.revocation_endpoint.startsWith(`${chatGptAuth}/`)) return false;
            await responseOk(fetchImpl, discovery.revocation_endpoint, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }).toString()
            });
            return true;
        },
        async listModels({ configuration, credential, onCredential, signal, fetchImpl }) {
            requireCredential(credential, 'ChatGPT');
            const record = await current({ credential, onCredential, signal, fetchImpl });
            let result;
            try {
                result = await responseJson(fetchImpl, `${apiBase(configuration)}/v1/models`, { headers: { Authorization: `Bearer ${record.accessToken}` }, signal });
            } catch (error) { throw chatGptFailure(error); }
            return (result.models ?? result.data ?? [])
                .filter((model) => (model.visibility ?? 'list') === 'list')
                .map((model) => ({ id: model.slug ?? model.id, name: model.display_name ?? model.slug ?? model.id }))
                .filter((model) => typeof model.id === 'string' && model.id);
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: 'chatGpt', modelCount: models.length };
        },
        async generateProposal({ configuration, credential, onCredential, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent }) {
            requireCredential(credential, 'ChatGPT');
            if (!configuration.model) throw new AssistantProviderError('Select a model before generating a proposal.', 'modelRequired');
            const record = await current({ credential, onCredential, signal, fetchImpl });
            const attempt = async (constrained) => {
                const response = await responseOk(fetchImpl, `${apiBase(configuration)}/v1/responses`, {
                    method: 'POST', signal,
                    headers: { Authorization: `Bearer ${record.accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: configuration.model,
                        instructions: assistantInstructions(operationSchema, { includeSchema: !constrained }),
                        input: [...historyMessages(history), { role: 'user', content: requestPrompt(context, request, repair) }],
                        // Plan usage requires both: nothing is kept at OpenAI, and the reply streams.
                        store: false, stream: true,
                        ...(constrained ? { text: { format: { type: 'json_schema', name: 'konjugate_proposal', strict: false, schema: operationSchema } } } : {})
                    })
                });
                if (!isStreamingResponse(response)) throw new AssistantProviderError('ChatGPT did not stream its reply.', 'invalidProviderResponse');
                let output = '';
                let completed = false;
                for await (const event of serverSentEvents(streamLines(response, () => onEvent?.({ type: 'activity' })))) {
                    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                        output += event.delta;
                        if (output.length > maximumOutputCharacters) throw new AssistantProviderError('The AI provider response is too large.', 'responseTooLarge');
                        onEvent?.({ type: 'output', text: event.delta });
                    } else if (/^response\.reasoning(_summary)?_text\.delta$/.test(event.type) && typeof event.delta === 'string') {
                        onEvent?.({ type: 'thinking', text: event.delta });
                    } else if (event.type === 'response.completed') {
                        completed = true;
                        const used = usageFrom.responses(event.response?.usage);
                        if (used) onEvent?.({ type: 'usage', usage: used });
                    } else if (event.type === 'response.failed' || event.type === 'error') {
                        const failed = event.response?.error ?? event.error ?? {};
                        const failure = new AssistantProviderError(`ChatGPT stopped: ${String(failed.message ?? failed.code ?? 'unknown error').slice(0, 300)}`, 'providerHttpError');
                        failure.providerCode = failed.code ?? null;
                        throw chatGptFailure(failure);
                    } else if (event.type === 'response.incomplete') {
                        const reason = event.response?.incomplete_details?.reason;
                        throw new AssistantProviderError(`ChatGPT stopped before finishing${reason ? ` (${reason})` : ''}.`, 'providerIncomplete');
                    }
                }
                // Only a reply that says it finished is a reply: a stream that just ends was cut off.
                if (!completed) throw new AssistantProviderError('ChatGPT\'s reply ended before it finished.', 'invalidProviderResponse');
                return output === '' ? undefined : output;
            };
            let text;
            try {
                try {
                    text = await attempt(true);
                } catch (error) {
                    // Whether plan usage takes a schema for the reply is not documented: if it refuses that, ask in plain JSON instead.
                    const refusedFormat = (error.status === 400 || error.providerCode === 'subscription_sharing_unsupported_capability') && /text|format|schema|json/i.test(`${error.message} ${error.providerCode ?? ''}`);
                    if (!refusedFormat) throw error;
                    text = await attempt(false);
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                throw chatGptFailure(error);
            }
            return parseProposal(text);
        }
    };
}

// Signing in to Hugging Face (https://huggingface.co/docs/hub/oauth) with the `inference-api` scope, which grants inference
// through Inference Providers on the person's behalf. It needs Konjugate's own OAuth app, registered on Hugging Face as a
// public app (no secret) with the redirect http://127.0.0.1/callback, whose loopback rule accepts any port. Until its client
// id is filled in here (or given as KONJUGATE_HUGGING_FACE_CLIENT_ID), Hugging Face offers no sign-in, only a key. The access
// token is kept as the configuration's key: the router takes it as a bearer token the same way. Hugging Face does not say how
// long a sign-in lasts or whether it can be renewed; when it ends, its requests are refused and the person signs in again.
export const huggingFaceClientId = '';
const huggingFaceSite = 'https://huggingface.co';
function huggingFaceSignIn(clientId = process.env.KONJUGATE_HUGGING_FACE_CLIENT_ID || huggingFaceClientId) {
    if (!clientId) return {};
    return {
        signInDescription: 'Your Hugging Face account, for the models its Inference Providers serve.',
        async signIn({ openExternal, signal, fetchImpl }) {
            const { code, verifier, redirectUri } = await loopbackAuthorization({
                host: '127.0.0.1', path: '/callback', openExternal, signal,
                authorizationUrl: (redirect, { challenge, state }) => `${huggingFaceSite}/oauth/authorize?${new URLSearchParams({
                    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'openid profile inference-api',
                    state, code_challenge: challenge, code_challenge_method: 'S256'
                })}`
            });
            const body = await responseJson(fetchImpl, `${huggingFaceSite}/oauth/token`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }).toString()
            });
            if (typeof body?.access_token !== 'string' || !body.access_token) throw new AssistantProviderError('Hugging Face did not return an access token.', 'invalidProviderResponse');
            if (body.scope && !String(body.scope).split(/\s+/).includes('inference-api')) {
                throw new AssistantProviderError('You signed in, but Konjugate was not allowed to make inference requests. Sign in again and allow it.', 'planUsageNotAllowed');
            }
            const claims = decodeJwtPayload(body.id_token);
            return { credential: body.access_token, account: typeof claims?.preferred_username === 'string' ? claims.preferred_username : '' };
        }
    };
}

export function createRemoteAIProviders({ fetchImpl = globalThis.fetch, operationSchema } = {}) {
    if (typeof fetchImpl !== 'function' || !operationSchema) throw new Error('Remote AI providers require fetch and an operation schema.');
    const bind = (provider) => Object.freeze({
        ...provider,
        listModels: (input) => provider.listModels({ ...input, fetchImpl, operationSchema }),
        testConnection: (input) => provider.testConnection({ ...input, fetchImpl, operationSchema }),
        generateProposal: (input) => provider.generateProposal({ ...input, fetchImpl, operationSchema }),
        ...(provider.signIn ? { signIn: (input) => provider.signIn({ ...input, fetchImpl }) } : {}),
        ...(provider.signOut ? { signOut: (input) => provider.signOut({ ...input, fetchImpl }) } : {})
    });
    return [
        ollamaProvider(),
        chatGptProvider(),
        openAICompatibleProvider({ id: 'openAi', name: 'OpenAI', endpoint: defaults.openAi, schemaResponse: true, streamUsage: true, extra: { keyPage: 'https://platform.openai.com/api-keys' } }),
        openAICompatibleProvider({ id: 'nvidia', name: 'NVIDIA', endpoint: defaults.nvidia, extra: { keyPage: 'https://build.nvidia.com/settings/api-keys' } }),
        openAICompatibleProvider({ id: 'huggingFace', name: 'Hugging Face', endpoint: defaults.huggingFace, extra: { keyPage: 'https://huggingface.co/settings/tokens', ...huggingFaceSignIn() } }),
        openRouterProvider(),
        anthropicProvider(),
        geminiProvider()
    ].map(bind);
}
