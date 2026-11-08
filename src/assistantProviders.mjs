/* Copyright © 2026 Zenin Easa Panthakkalakath */

export class AssistantProviderError extends Error {
    constructor(message, code = 'providerError') {
        super(message);
        this.name = 'AssistantProviderError';
        this.code = code;
    }
}

export async function generateAssistantProposal(provider, request) {
    if (!provider || typeof provider.generateProposal !== 'function') {
        throw new AssistantProviderError('The selected assistant provider is unavailable.', 'providerUnavailable');
    }
    if (!request?.context || !Array.isArray(request.context.nodes)) {
        throw new AssistantProviderError('The assistant requires a valid model summary.', 'invalidContext');
    }
    return provider.generateProposal(request);
}
