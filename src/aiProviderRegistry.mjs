/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { generateAssistantProposal, localAssistantProvider } from './assistantProviders.mjs';
import { AssistantProposalError, validateAssistantClarification, validateAssistantProposal } from './assistantOperations.mjs';

const maximumRepairAttempts = 2;

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
        async generate({ configuration, credential, context, request, history, signal }) {
            const provider = registry.get(configuration.provider);
            if (!provider) throw new AIProviderRegistryError(`Provider “${configuration.provider}” is unavailable.`, 'providerUnavailable');
            try {
                let repair = null;
                for (let attempt = 0; attempt <= maximumRepairAttempts; attempt += 1) {
                    let response;
                    try {
                        response = await generateAssistantProposal(provider, {
                            configuration, credential, context, request, history, repair, signal
                        });
                    } catch (error) {
                        const recoverableOutputError = ['invalidProposalJson', 'invalidProviderResponse'].includes(error.code);
                        if (!recoverableOutputError || attempt === maximumRepairAttempts) throw error;
                        repair = { error: error.message, proposal: null };
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
                    try {
                        validateAssistantProposal(response);
                        return response;
                    } catch (error) {
                        if (!(error instanceof AssistantProposalError) || attempt === maximumRepairAttempts) throw error;
                        repair = { error: error.message, proposal: response };
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
