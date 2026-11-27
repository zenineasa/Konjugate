/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { generateAssistantProposal } from './assistantProviders.mjs';
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

export function createAIProviderRegistry(providers = []) {
    const registry = new Map(providers.map((provider) => [provider.id, provider]));
    return Object.freeze({
        descriptors() {
            // `reasoningSetting`: whether the provider can be told to reason before answering, or not (a configuration's `think`).
            // `signIn`: whether a person can sign in to it in their browser instead of pasting a key, described by
            // `vendorTool`: the vendor's own tool it runs ('claude', 'copilot'), which signs in by itself and has no endpoint or key.
            // `signInDescription`; `signInOnly` when a key cannot be typed in for it (ChatGPT plan usage). `keyPage`: where its keys are made, for a person who will paste one, offered as `keyPageLabel`.
            return [...registry.values()].map(({ id, name, defaultEndpoint = '', defaultTimeoutSeconds = 60, credentialRequired = false, locality = 'local', reasoningSetting = false, signIn, signInOnly = false, signInDescription = '', keyPage = '', keyPageLabel = '', vendorTool = '' }) => ({
                id, name, defaultEndpoint, defaultTimeoutSeconds, credentialRequired, locality, reasoningSetting,
                signIn: typeof signIn === 'function', signInOnly, signInDescription, keyPage, keyPageLabel: keyPage ? keyPageLabel || `Get a key from ${name} ›` : '',
                vendorTool
            }));
        },
        // Signs in to a provider in the person's browser; resolves to { credential, account? }. `openExternal` opens the browser,
        // `hostId` names this installation, and `previous` is the credential of an earlier sign-in being renewed, if any.
        async signIn({ provider: id, openExternal, signal, hostId, previous }) {
            const provider = registry.get(id);
            if (typeof provider?.signIn !== 'function') throw new AIProviderRegistryError(`Signing in to “${id}” is not available.`, 'signInUnavailable');
            const result = await provider.signIn({ openExternal, signal, hostId, previous });
            if (typeof result?.credential !== 'string' || !result.credential) throw new AIProviderRegistryError('The provider did not return a credential.', 'invalidProviderResponse');
            return result;
        },
        // The model a configuration starts with when the person has not chosen one: the provider's pick from `models`, or the first.
        // What each vendor-tool provider finds on this computer: { provider, name, installed, signedIn (true, false or null for
        // unknown), account, plan }. A tool that cannot be asked is reported as installed with its sign-in unknown.
        async detectTools() {
            const tools = [...registry.values()].filter((provider) => typeof provider.detect === 'function');
            return Promise.all(tools.map(async (provider) => ({
                provider: provider.id, name: provider.name, account: '', plan: '', signedIn: null,
                description: provider.toolDescription ?? '', installable: typeof provider.install === 'function',
                ...(await provider.detect().catch(() => ({ installed: false })))
            })));
        },
        // What installing a vendor tool will do, for the person to agree to first: { name, notice, source }, or null.
        toolInstaller(id, platform = process.platform) {
            const provider = registry.get(id);
            if (typeof provider?.install !== 'function') return null;
            const plan = provider.installer?.(platform);
            return plan ? { name: provider.name, notice: provider.installNotice ?? '', source: plan.source ?? '' } : null;
        },
        // Runs a vendor tool's own installer, or its own sign-in; `onOutput(line)` hears what it prints.
        async installTool({ provider: id, signal, onOutput }) {
            const provider = registry.get(id);
            if (typeof provider?.install !== 'function') throw new AIProviderRegistryError('That tool cannot be installed from Konjugate.', 'installUnavailable');
            return provider.install({ signal, onOutput });
        },
        async signInWithTool({ provider: id, signal, onOutput }) {
            const provider = registry.get(id);
            if (typeof provider?.signInWithTool !== 'function') throw new AIProviderRegistryError('That tool cannot be signed in to from Konjugate.', 'signInUnavailable');
            return provider.signInWithTool({ signal, onOutput });
        },
        // Ends a sign-in at the provider as well, where it can; false where there is nothing to end.
        async signOut({ provider: id, credential, signal }) {
            const provider = registry.get(id);
            if (typeof provider?.signOut !== 'function' || !credential) return false;
            return provider.signOut({ credential, signal });
        },
        suggestModel(id, models) {
            const provider = registry.get(id);
            return provider?.suggestModel ? provider.suggestModel(models) : models[0]?.id ?? '';
        },
        // `onCredential(value)`, where given, saves a credential the provider renewed on the way (a refreshed sign-in).
        async testConnection({ configuration, credential, onCredential, signal }) {
            const provider = registry.get(configuration.provider);
            if (!provider) throw new AIProviderRegistryError(`Provider “${configuration.provider}” is unavailable.`, 'providerUnavailable');
            if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
            if (provider.testConnection) return provider.testConnection({ configuration, credential, onCredential, signal });
            return { connected: true, provider: provider.id };
        },
        async listModels({ configuration, credential, onCredential, signal }) {
            const provider = registry.get(configuration.provider);
            if (!provider) throw new AIProviderRegistryError(`Provider “${configuration.provider}” is unavailable.`, 'providerUnavailable');
            if (!provider.listModels) return [];
            return provider.listModels({ configuration, credential, onCredential, signal });
        },
        async generate({ configuration, credential, onCredential, context, request, history, signal, onProgress }) {
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
                            configuration, credential, onCredential, context, request, history, repair, signal, onEvent
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
