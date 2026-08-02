/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { AssistantProviderError } from './assistantProviders.mjs';

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

async function responseJson(fetchImpl, url, options = {}) {
    let response;
    try { response = await fetchImpl(url, options); } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new AssistantProviderError(`Could not connect to the AI provider: ${error.message}`, 'connectionFailed');
    }
    const text = await response.text();
    if (!response.ok) {
        let detail = text.slice(0, 500);
        try { detail = JSON.parse(text).error?.message ?? JSON.parse(text).message ?? detail; } catch { /* use bounded text */ }
        throw new AssistantProviderError(`The AI provider returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`, 'providerHttpError');
    }
    try { return JSON.parse(text); } catch { throw new AssistantProviderError('The AI provider returned invalid JSON.', 'invalidProviderResponse'); }
}

function proposalPrompt(operationSchema, context, request, repair) {
    const correction = repair ? `\n\nCORRECTION REQUIRED:\nYour previous proposal was rejected: ${repair.error}\nPrevious rejected proposal:\n${JSON.stringify(repair.proposal)}\nReturn a complete corrected proposal, not a patch or explanation.` : '';
    return `Create a Konjugate model-operation proposal for the user's request. Return only JSON matching the supplied schema. Use existing UUIDs exactly. Use lower camel case for temporary refs and symbols. Do not invent existing entities. State engineering assumptions explicitly.\n\nOPERATION SCHEMA:\n${JSON.stringify(operationSchema)}\n\nMODEL CONTEXT:\n${JSON.stringify(context)}\n\nUSER REQUEST:\n${request}${correction}`;
}

function parseProposal(text) {
    if (typeof text !== 'string') throw new AssistantProviderError('The AI provider did not return proposal text.', 'invalidProviderResponse');
    const normalized = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(normalized); } catch { throw new AssistantProviderError('The AI provider returned malformed proposal JSON.', 'invalidProposalJson'); }
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
        async generateProposal({ configuration, credential, context, request, repair, signal, fetchImpl, operationSchema }) {
            requireCredential(credential, name);
            if (!configuration.model) throw new AssistantProviderError('Select a model before generating a proposal.', 'modelRequired');
            const responseFormat = schemaResponse
                ? { type: 'json_schema', json_schema: { name: 'konjugate_proposal', strict: false, schema: operationSchema } }
                : { type: 'json_object' };
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: id, endpoint: configuration.endpoint || endpoint })}/v1/chat/completions`, {
                method: 'POST', signal,
                headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: configuration.model,
                    messages: [
                        { role: 'system', content: 'You are the Konjugate modelling assistant. Return only the requested JSON proposal.' },
                        { role: 'user', content: proposalPrompt(operationSchema, context, request, repair) }
                    ],
                    response_format: responseFormat,
                    stream: false
                })
            });
            return parseProposal(result.choices?.[0]?.message?.content);
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
        async generateProposal({ configuration, context, request, repair, signal, fetchImpl, operationSchema }) {
            if (!configuration.model) throw new AssistantProviderError('Select an installed Ollama model before generating a proposal.', 'modelRequired');
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: 'ollama' })}/api/chat`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: configuration.model, stream: false, format: 'json',
                    messages: [{ role: 'user', content: proposalPrompt(operationSchema, context, request, repair) }]
                })
            });
            return parseProposal(result.message?.content);
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
            });
            return (result.models ?? []).filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
                .map((model) => ({ id: model.name.replace(/^models\//, ''), name: model.displayName ?? model.name }));
        },
        async testConnection(input) {
            const models = await this.listModels(input);
            return { connected: true, provider: 'gemini', modelCount: models.length };
        },
        async generateProposal({ configuration, credential, context, request, repair, signal, fetchImpl, operationSchema }) {
            requireCredential(credential, 'Google Gemini');
            if (!configuration.model) throw new AssistantProviderError('Select a Gemini model before generating a proposal.', 'modelRequired');
            const model = encodeURIComponent(configuration.model.replace(/^models\//, ''));
            const result = await responseJson(fetchImpl, `${baseUrl({ ...configuration, provider: 'gemini' })}/v1beta/models/${model}:generateContent`, {
                method: 'POST', signal, headers: { 'x-goog-api-key': credential, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: proposalPrompt(operationSchema, context, request, repair) }] }],
                    generationConfig: { responseMimeType: 'application/json' }
                })
            });
            return parseProposal(result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join(''));
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
