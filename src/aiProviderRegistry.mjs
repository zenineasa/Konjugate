/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { generateAssistantProposal, localAssistantProvider } from './assistantProviders.mjs';
import { AssistantProposalError, validateAssistantClarification, validateAssistantProposal } from './assistantOperations.mjs';

const maximumRepairAttempts = 2;
const thinkingTailCharacters = 8000;
const outputTailCharacters = 2000;
const repairReasonCharacters = 300;
const tail = (text, limit) => (text.length > limit ? text.slice(text.length - limit) : text);

export class AIProviderRegistryError extends Error {
    constructor(message, code = 'providerError') {
        super(message);
        this.name = 'AIProviderRegistryError';
        this.code = code;
    }
}

export function createAIProviderRegistry(providers = [localAssistantProvider]) {
    const allProviders = providers.some((provider) => provider.id === localAssistantProvider.id)
        ? providers : [localAssistantProvider, ...providers];
    const registry = new Map(allProviders.map((provider) => [provider.id, provider]));
    return Object.freeze({
        descriptors() {
            return [...registry.values()].map(({ id, name, defaultEndpoint = '', defaultTimeoutSeconds = 60, credentialRequired = false, locality = 'local' }) => ({
                id, name, defaultEndpoint, defaultTimeoutSeconds, credentialRequired, locality
            }));
        },
        async testConnection({ configuration, credential, signal }) {
            const provider = registry.get(configuration.provider);
            if (!provider) throw new AIProviderRegistryError(`Provider “${configuration.provider}” is unavailable.`, 'providerUnavailable');
            if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
            if (provider.testConnection) return provider.testConnection({ configuration, credential, signal });
            return { connected: true, provider: provider.id };
        },
        async listModels({ configuration, credential, signal }) {
            const provider = registry.get(configuration.provider);
            if (!provider) throw new AIProviderRegistryError(`Provider “${configuration.provider}” is unavailable.`, 'providerUnavailable');
            if (!provider.listModels) return [];
            return provider.listModels({ configuration, credential, signal });
        },
        async generate({ configuration, credential, context, request, history, signal, onProgress }) {
            const provider = registry.get(configuration.provider);
            if (!provider) throw new AIProviderRegistryError(`Provider “${configuration.provider}” is unavailable.`, 'providerUnavailable');
            // What the panel shows while this runs: which attempt, what stage, and the latest of what the
            // model is saying. Every publish also tells the caller the request is alive.
            const progress = { attempt: 0, attempts: maximumRepairAttempts + 1, phase: 'sending', outputCharacters: 0, thinking: '', output: '', repairReason: '', attemptStartedAt: Date.now() };
            const publish = () => onProgress?.({ ...progress });
            const redact = (text) => (credential ? text.replaceAll(credential, '[redacted]') : text);
            const onEvent = (event) => {
                if (event.type === 'thinking') {
                    progress.phase = 'receiving';
                    progress.thinking = tail(progress.thinking + event.text, thinkingTailCharacters);
                } else if (event.type === 'output') {
                    progress.phase = 'receiving';
                    progress.outputCharacters += event.text.length;
                    progress.output = tail(progress.output + event.text, outputTailCharacters);
                }
                publish();
            };
            try {
                let repair = null;
                for (let attempt = 0; attempt <= maximumRepairAttempts; attempt += 1) {
                    let response;
                    Object.assign(progress, { attempt: attempt + 1, phase: 'sending', outputCharacters: 0, thinking: '', output: '', attemptStartedAt: Date.now() });
                    publish();
                    try {
                        response = await generateAssistantProposal(provider, {
                            configuration, credential, context, request, history, repair, signal, onEvent
                        });
                    } catch (error) {
                        // Only what the model itself got wrong is worth asking it to fix: JSON that does not parse, or
                        // no text at all. Transport trouble (a gateway's HTML error page, a stream that is not a
                        // stream, `invalidProviderResponse`) is not the model's doing, and a retry would only repeat
                        // it, at the cost of another request, with a correction note about something it never wrote.
                        const recoverableOutputError = ['invalidProposalJson', 'emptyProviderOutput'].includes(error.code);
                        if (!recoverableOutputError || attempt === maximumRepairAttempts) throw error;
                        repair = { error: error.message, proposal: null };
                        progress.repairReason = redact(error.message).slice(0, repairReasonCharacters);
                        continue;
                    }
                    if (JSON.stringify(response).length > 1_000_000) {
                        throw new AIProviderRegistryError('The provider response is too large.', 'responseTooLarge');
                    }
                    // A clarification isn't something to repair against the operations schema --
                    // it never reaches applyAssistantProposal/native validation either -- so it
                    // skips the repair loop and returns as soon as its own light shape check
                    // passes.
                    if (response?.responseKind === 'clarification') {
                        validateAssistantClarification(response);
                        return response;
                    }
                    progress.phase = 'validating';
                    publish();
                    try {
                        validateAssistantProposal(response);
                        return response;
                    } catch (error) {
                        if (!(error instanceof AssistantProposalError) || attempt === maximumRepairAttempts) throw error;
                        repair = { error: error.message, proposal: response };
                        progress.repairReason = redact(error.message).slice(0, repairReasonCharacters);
                    }
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                const message = credential ? error.message.replaceAll(credential, '[redacted]') : error.message;
                if (message === error.message) throw error;
                throw new AIProviderRegistryError(message, error.code);
            }
        }
    });
}
