/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { AssistantProviderError } from './assistantProviders.mjs';
import { isStreamingResponse, newlineDelimitedJson, serverSentEvents, streamLines } from './aiStreaming.mjs';

const defaults = Object.freeze({
    ollama: 'http://127.0.0.1:11434',
    openAi: 'https://api.openai.com',
    nvidia: 'https://integrate.api.nvidia.com',
    huggingFace: 'https://router.huggingface.co',
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
        try { detail = JSON.parse(text).error?.message ?? JSON.parse(text).message ?? detail; } catch { /* use bounded text */ }
        const hint = response.status === 401 && unauthorizedHint ? ` ${unauthorizedHint}` : '';
        const failure = new AssistantProviderError(`The AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}${hint}`, 'providerHttpError');
        failure.status = response.status;
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
        return typeof read.output === 'string' && read.output !== '' ? read.output : undefined;
    }
    const events = protocol === 'sse' ? serverSentEvents : newlineDelimitedJson;
    for await (const chunk of events(streamLines(response, () => onEvent?.({ type: 'activity' })))) {
        streamError(chunk);
        const read = fromChunk(chunk);
        if (read.thinking) onEvent?.({ type: 'thinking', text: read.thinking });
        if (read.output) {
            output += read.output;
            if (output.length > maximumOutputCharacters) {
                throw new AssistantProviderError('The AI provider response is too large.', 'responseTooLarge');
            }
            onEvent?.({ type: 'output', text: read.output });
        }
    }
    return output === '' ? undefined : output;
}

const equationRules = `EQUATION RULES:\n- The latex field must be real LaTeX math notation, exactly what you would typeset in a document, never a function-call expression. Function-call syntax like Name(args) is not LaTeX and will be misparsed letter by letter.\n- Wrap every state and parameter symbol in \\mathrm{...}, for example \\mathrm{sourceTemperature}, never bare sourceTemperature. Without \\mathrm{}, a multi-letter symbol is misread as a product of single-letter variables (temperature becomes t times e times m times p times e times r times a times t times u times r times e), which is the single most common cause of an equation being rejected.\n- Write multiplication as juxtaposition or \\cdot, e.g. "5 \\cdot \\mathrm{heatingPower}", never "Multiply(5, heatingPower)". Write subtraction as "\\mathrm{a} - \\mathrm{b}", never "Subtract(a, b)". Write powers as "\\mathrm{x}^{2}", never "Power(x, 2)". Write division as "\\frac{\\mathrm{a}}{\\mathrm{b}}", never "Divide(a, b)". Write square roots as "\\sqrt{\\mathrm{x}}", never "Sqrt(x)", and other roots as "\\sqrt[3]{\\mathrm{x}}" for Root.\n- Named functions (Max, Min, Sin, Cos, Tan, Ln, Log, Exp) use their literal lowercase LaTeX command applied like a function, e.g. "\\max(\\mathrm{a}, \\mathrm{b})", "\\min(\\mathrm{a}, \\mathrm{b})", "\\sin(\\mathrm{x})", "\\ln(\\mathrm{x})". Never write these as "\\operatorname{Max}(...)" or a bare capitalized word like "Max(a, b)" -- both are rejected. Write Abs as "\\left|\\mathrm{x}\\right|", never "Abs(x)". Write Negate as a unary minus, "-\\mathrm{x}", never "Negate(x)".\n- For a piecewise value write a LaTeX cases environment with a final otherwise branch, e.g. "\\begin{cases} \\mathrm{rate} & \\mathrm{sourceStock} > 0 \\\\ 0 & \\text{otherwise} \\end{cases}". Conditions may use <, >, \\le, \\ge, =, \\ne, \\land, \\lor and \\lnot; comparisons are only allowed as conditions, never as values.\n- Only these operators are supported: Abs, Add, Cos, Divide, Exp, Ln, Log, Max, Min, Multiply, Negate, Power, Root, Sin, Sqrt, Subtract, Tan, and Which (cases) with Less, LessEqual, Greater, GreaterEqual, Equal, NotEqual, And, Or, Not in its conditions. Never use complex numbers, derivatives, summations, or any other operator or function.\n- Every equation may use t, the simulation time in seconds, for schedules and time-varying inputs (e.g. \"\\begin{cases} \\mathrm{rate} & 3600 \\le t < 7200 \\\\ 0 & \\text{otherwise} \\end{cases}\"). Write it as a bare t, never \\mathrm{t}. Never use t to integrate a state yourself; the engine integrates states over time automatically. Never use the bare letters i or e as symbols outside \\mathrm{}; a real math parser treats them as the imaginary unit and Euler's number.\n- A local source-term equation (addSourceTerm) may only reference that same node's own declared state symbols, used exactly as declared. Nodes cannot have named parameters; write any constant coefficient as a plain number.\n- A relationship equation (setEdgeEquation) may only reference: for each state on the edge's source node, "source" followed by that state's symbol capitalized (a state with symbol "temperature" becomes "sourceTemperature"); for each state on the edge's target node, "target" followed by that state's symbol capitalized ("targetTemperature"); and any parameter already added to that edge with addParameter, using exactly the symbol declared there.\n- Declare every state and every edge parameter an equation will use before the operation that writes the equation, and use no symbol that was not declared this way.`;

function proposalPrompt(operationSchema, context, request, repair) {
    const correction = repair ? `\n\nCORRECTION REQUIRED:\nYour previous proposal was rejected: ${repair.error}\nPrevious rejected proposal:\n${JSON.stringify(repair.proposal)}\nReturn a complete corrected proposal, not a patch or explanation.` : '';
    return `Create a Konjugate model-operation proposal for the user's request. Return only JSON matching the supplied schema: either a { "responseKind": "proposal", ... } object, or, if the request is ambiguous (could reasonably apply to more than one entity) or missing information needed to act (e.g. a value), a { "responseKind": "clarification", "question": "...", "suggestions": ["...", ...] } object instead of guessing. suggestions is optional and capped at 5 short options. Prefer a clarification over inventing a plausible-sounding assumption whenever there's a genuine choice to make; state engineering assumptions explicitly when you do proceed with a proposal instead. Use existing numeric entity IDs exactly. Use lower camel case for temporary refs and symbols. Do not invent existing entities.\n\n${equationRules}\n\nOPERATION SCHEMA:\n${JSON.stringify(operationSchema)}\n\nMODEL CONTEXT:\n${JSON.stringify(context)}\n\nUSER REQUEST:\n${request}${correction}`;
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

function historyText(history) {
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

function parseProposal(text) {
    if (typeof text !== 'string') throw new AssistantProviderError('The AI provider did not return proposal text.', 'emptyProviderOutput');
    const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return numericReferences(JSON.parse(normalized)); } catch { throw new AssistantProviderError('The AI provider returned malformed proposal JSON.', 'invalidProposalJson'); }
}

function requireCredential(credential, providerName) {
    if (!credential) throw new AssistantProviderError(`${providerName} requires an API key.`, 'credentialRequired');
}

function openAICompatibleProvider({ id, name, endpoint, schemaResponse = false }) {
    return {
        id, name, defaultEndpoint: endpoint, defaultTimeoutSeconds: 60, credentialRequired: true, locality: 'online',
        async listModels({ configuration, credential, signal, fetchImpl }) {
            requireCredential(credential, name);
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: id, endpoint: configuration.endpoint || endpoint })}/v1/models`, {
                headers: { Authorization: `Bearer ${credential}` }, signal
            });
            return (result.data ?? []).map((model) => ({ id: model.id, name: model.id }));
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: id, modelCount: models.length };
        },
        async generateProposal({ configuration, credential, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent }) {
            requireCredential(credential, name);
            if (!configuration.model) throw new AssistantProviderError('Select a model before generating a proposal.', 'modelRequired');
            const url = `${baseUrl({ ...configuration, provider: id, endpoint: configuration.endpoint || endpoint })}/v1/chat/completions`;
            const prompt = proposalPrompt(operationSchema, context, request, repair);
            const attempt = (responseFormat) => generateText(fetchImpl, url, {
                method: 'POST', signal,
                headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: configuration.model,
                    messages: [
                        { role: 'system', content: 'You are the Konjugate modelling assistant. Return only JSON matching the supplied schema -- either a proposal or, if the request is ambiguous or missing information, a clarification.' },
                        ...historyMessages(history),
                        { role: 'user', content: prompt }
                    ],
                    response_format: responseFormat,
                    stream: true
                })
            }, {
                protocol: 'sse',
                // Reasoning models name the reasoning field differently depending on who serves them.
                fromChunk: (chunk) => {
                    const delta = chunk.choices?.[0]?.delta ?? {};
                    return { output: delta.content ?? '', thinking: delta.reasoning_content ?? delta.reasoning ?? '' };
                },
                fromWhole: (body) => {
                    const message = body.choices?.[0]?.message ?? {};
                    return { output: message.content, thinking: message.reasoning_content ?? message.reasoning ?? '' };
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
        credentialRequired: false, locality: 'local',
        async listModels({ configuration, signal, fetchImpl }) {
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: 'ollama' })}/api/tags`, { signal });
            return (result.models ?? []).map((model) => ({ id: model.model ?? model.name, name: model.name ?? model.model }));
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: 'ollama', modelCount: models.length };
        },
        async generateProposal({ configuration, context, request, history, repair, signal, fetchImpl, operationSchema, onEvent }) {
            if (!configuration.model) throw new AssistantProviderError('Select an installed Ollama model before generating a proposal.', 'modelRequired');
            const text = await generateText(fetchImpl, `${baseUrl({ ...configuration, provider: 'ollama' })}/api/chat`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: configuration.model, stream: true,
                    format: 'json',
                    // Only when set: models that cannot think reject `think`, and the default is the model's own.
                    ...(typeof configuration.think === 'boolean' ? { think: configuration.think } : {}),
                    // Edits should repeat for the same request, and Ollama's default window (4096 tokens) is barely larger than this prompt. A proposal is a few hundred tokens, so the cap only ever stops a model that has started to loop.
                    options: { temperature: 0, num_ctx: 8192, num_predict: 4096 },
                    messages: [{ role: 'user', content: historyText(history) + proposalPrompt(operationSchema, context, request, repair) }]
                })
            }, {
                protocol: 'ndjson',
                fromChunk: (chunk) => ({ output: chunk.message?.content ?? '', thinking: chunk.message?.thinking ?? '' }),
                fromWhole: (body) => ({ output: body.message?.content, thinking: body.message?.thinking ?? '' })
            }, onEvent);
            return parseProposal(text);
        }
    };
}

function geminiProvider() {
    return {
        id: 'gemini', name: 'Google Gemini', defaultEndpoint: defaults.gemini, defaultTimeoutSeconds: 60,
        credentialRequired: true, locality: 'online',
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
                return { output: textOf(parts.filter((part) => !part.thought)), thinking: textOf(parts.filter((part) => part.thought)) };
            };
            const text = await generateText(fetchImpl, `${baseUrl({ ...configuration, provider: 'gemini' })}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
                method: 'POST', signal, headers: { 'x-goog-api-key': credential, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: historyText(history) + proposalPrompt(operationSchema, context, request, repair) }] }],
                    generationConfig: { responseMimeType: 'application/json' }
                })
            }, { protocol: 'sse', fromChunk: fromParts, fromWhole: fromParts, unauthorizedHint: geminiUnauthorizedHint }, onEvent);
            return parseProposal(text);
        }
    };
}

export function createRemoteAIProviders({ fetchImpl = globalThis.fetch, operationSchema } = {}) {
    if (typeof fetchImpl !== 'function' || !operationSchema) throw new Error('Remote AI providers require fetch and an operation schema.');
    const bind = (provider) => Object.freeze({
        ...provider,
        listModels: (input) => provider.listModels({ ...input, fetchImpl, operationSchema }),
        testConnection: (input) => provider.testConnection({ ...input, fetchImpl, operationSchema }),
        generateProposal: (input) => provider.generateProposal({ ...input, fetchImpl, operationSchema })
    });
    return [
        ollamaProvider(),
        openAICompatibleProvider({ id: 'openAi', name: 'OpenAI', endpoint: defaults.openAi, schemaResponse: true }),
        openAICompatibleProvider({ id: 'nvidia', name: 'NVIDIA', endpoint: defaults.nvidia }),
        openAICompatibleProvider({ id: 'huggingFace', name: 'Hugging Face', endpoint: defaults.huggingFace }),
        geminiProvider()
    ].map(bind);
}

export const aiProviderDefaultEndpoints = defaults;
