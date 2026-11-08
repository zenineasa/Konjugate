/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Version 2: no built-in configuration. Version 1 began with a built-in "Local demonstration", which is gone
// (docs/proposals/suggestedLocalModels.md); a version 1 file is read and moved forward without it.
export const aiConfigurationStoreVersion = 2;
const retiredProviders = new Set(['localDemonstration']);
const providerPattern = /^[a-z][A-Za-z0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AIConfigurationError extends Error {
    constructor(message, code = 'configurationError') {
        super(message);
        this.name = 'AIConfigurationError';
        this.code = code;
    }
}

function publicConfiguration(configuration) {
    const { credentialUuid, ...safe } = configuration;
    return { ...safe, credentialConfigured: Boolean(credentialUuid) };
}

function normalizeConfiguration(input, existing, uuidFactory) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AIConfigurationError('A model configuration is required.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
    if (!name) throw new AIConfigurationError('Configuration name is required.');
    if (!providerPattern.test(provider)) throw new AIConfigurationError('Provider must be a lower camel case identifier.');
    const timeoutSeconds = input.timeoutSeconds ?? existing?.timeoutSeconds ?? 60;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
        throw new AIConfigurationError('Timeout must be between 1 and 600 seconds.');
    }
    const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const uuid = existing?.uuid ?? input.uuid ?? uuidFactory();
    if (!uuidPattern.test(uuid)) throw new AIConfigurationError('Configuration UUID is invalid.');
    // Whether the model reasons before it answers: true, false, or null for the model's own default. Only providers
    // that can be told send it (Ollama's `think`).
    const think = input.think === true || input.think === false ? input.think : null;
    return {
        uuid,
        name,
        provider,
        endpoint,
        model,
        timeoutSeconds,
        think,
        credentialUuid: existing?.credentialUuid ?? null
    };
}

// A version 1 file, moved forward: the retired demonstration configuration is dropped, and the one in use becomes
// another configuration if there is one, or none.
function migrated(loaded) {
    const configurations = loaded.configurations
        .filter((configuration) => !retiredProviders.has(configuration.provider) && !configuration.builtIn)
        .map(({ builtIn, ...configuration }) => ({ think: null, ...configuration }));
    const active = configurations.some((configuration) => configuration.uuid === loaded.activeConfigurationUuid)
        ? loaded.activeConfigurationUuid : configurations[0]?.uuid ?? null;
    return { version: aiConfigurationStoreVersion, activeConfigurationUuid: active, configurations };
}

// What a person is told when a saved key cannot be read: the operating system's key store would not unlock it (on macOS the
// Keychain request was denied, on Linux the keyring is locked), and how to get it back.
export function unreadableCredentialMessage(platform = process.platform) {
    const how = platform === 'darwin'
        ? 'macOS\'s Keychain did not allow it. Quit and reopen Konjugate, and choose Allow when macOS asks (or allow Konjugate in Keychain Access, under “konjugate Safe Storage”).'
        : platform === 'linux'
            ? 'the system keyring did not unlock. Unlock your keyring (or sign in to your desktop session again), then quit and reopen Konjugate.'
            : 'the system would not decrypt it. Quit and reopen Konjugate.';
    return `Konjugate could not read this configuration's API key: ${how} Or enter the key again and save the configuration.`;
}

export function createAIConfigurationStore({ directory, credentialVault, uuidFactory = randomUUID, platform = process.platform } = {}) {
    if (!directory || !credentialVault) throw new AIConfigurationError('Configuration storage requires a directory and credential vault.');
    const configurationPath = join(directory, 'configurations.json');
    const credentialsDirectory = join(directory, 'credentials');
    let state = null;

    const writeAtomically = async (path, content, options) => {
        const temporaryPath = `${path}.${uuidFactory()}.tmp`;
        await writeFile(temporaryPath, content, options);
        try {
            await rename(temporaryPath, path);
        } catch (error) {
            await unlink(temporaryPath).catch(() => {});
            throw error;
        }
    };
    const persist = () => writeAtomically(configurationPath, `${JSON.stringify(state, null, 4)}\n`, { mode: 0o600 });
    const initialize = async () => {
        if (state) return;
        await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
        try {
            const loaded = JSON.parse(await readFile(configurationPath, 'utf8'));
            if (![1, aiConfigurationStoreVersion].includes(loaded.version) || !Array.isArray(loaded.configurations)) {
                throw new AIConfigurationError('The AI configuration file uses an unsupported format.', 'unsupportedConfigurationFormat');
            }
            if (loaded.version === aiConfigurationStoreVersion) state = loaded;
            else {
                state = migrated(loaded);
                await persist();
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            state = { version: aiConfigurationStoreVersion, activeConfigurationUuid: null, configurations: [] };
            await persist();
        }
    };
    const find = (uuid) => state.configurations.find((configuration) => configuration.uuid === uuid);
    // A configuration's saved key, decrypted; a key the operating system will not decrypt is said plainly.
    const storedCredential = async (configuration) => {
        if (!configuration?.credentialUuid) return null;
        const encrypted = await readFile(join(credentialsDirectory, `${configuration.credentialUuid}.bin`));
        try {
            return await credentialVault.decrypt(encrypted);
        } catch {
            throw new AIConfigurationError(unreadableCredentialMessage(platform), 'credentialUnreadable');
        }
    };

    return Object.freeze({
        async list() {
            await initialize();
            return {
                activeConfigurationUuid: state.activeConfigurationUuid,
                configurations: state.configurations.map(publicConfiguration),
                credentialStorage: credentialVault.kind()
            };
        },
        async save(input, credential) {
            await initialize();
            const existing = input.uuid ? find(input.uuid) : null;
            if (input.uuid && !existing) throw new AIConfigurationError('That model configuration does not exist.', 'configurationNotFound');
            const configuration = normalizeConfiguration(input, existing, uuidFactory);
            if (credential !== undefined) {
                if (typeof credential !== 'string' || !credential.trim()) throw new AIConfigurationError('The API key cannot be empty.', 'emptyCredential');
                const status = await credentialVault.status();
                if (!status.available || status.plainText) {
                    throw new AIConfigurationError('Secure credential storage is unavailable. The API key was not saved.', 'secureStorageUnavailable');
                }
                configuration.credentialUuid ??= uuidFactory();
                const encrypted = await credentialVault.encrypt(credential);
                await writeAtomically(join(credentialsDirectory, `${configuration.credentialUuid}.bin`), encrypted, { mode: 0o600 });
            }
            if (existing) state.configurations.splice(state.configurations.indexOf(existing), 1, configuration);
            else state.configurations.push(configuration);
            state.activeConfigurationUuid ??= configuration.uuid;
            await persist();
            return publicConfiguration(configuration);
        },
        async remove(uuid) {
            await initialize();
            const configuration = find(uuid);
            if (!configuration) return false;
            state.configurations = state.configurations.filter((item) => item.uuid !== uuid);
            if (state.activeConfigurationUuid === uuid) state.activeConfigurationUuid = state.configurations[0]?.uuid ?? null;
            if (configuration.credentialUuid) await unlink(join(credentialsDirectory, `${configuration.credentialUuid}.bin`)).catch((error) => {
                if (error.code !== 'ENOENT') throw error;
            });
            await persist();
            return true;
        },
        async setActive(uuid) {
            await initialize();
            if (!find(uuid)) throw new AIConfigurationError('That model configuration does not exist.', 'configurationNotFound');
            state.activeConfigurationUuid = uuid;
            await persist();
            return uuid;
        },
        // `useCredential: false` for a provider that needs no key, so its saved key (if any) is not decrypted, which on macOS
        // would ask the Keychain.
        async resolve(uuid, { useCredential = true } = {}) {
            await initialize();
            if (!uuid && !state.activeConfigurationUuid) {
                throw new AIConfigurationError('No model is set up for the assistant yet. Set one up in Settings › Model assistant.', 'noConfiguration');
            }
            const configuration = find(uuid || state.activeConfigurationUuid);
            if (!configuration) throw new AIConfigurationError('That model configuration does not exist.', 'configurationNotFound');
            const credential = useCredential ? await storedCredential(configuration) : null;
            return { configuration: structuredClone(configuration), credential };
        },
        async resolveDraft(input, credential, { useCredential = true } = {}) {
            await initialize();
            const existing = input.uuid ? find(input.uuid) : null;
            const configuration = normalizeConfiguration(input, existing, uuidFactory);
            let resolvedCredential = typeof credential === 'string' && credential.trim() ? credential.trim() : null;
            if (!resolvedCredential && useCredential) resolvedCredential = await storedCredential(existing);
            return { configuration, credential: resolvedCredential };
        }
    });
}

export function createElectronCredentialVault(safeStorage, platform = process.platform) {
    const kind = () => {
        const backend = platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
            ? safeStorage.getSelectedStorageBackend() : platform;
        return { backend, plainText: backend === 'basic_text' };
    };
    return Object.freeze({
        kind,
        // Whether the operating system will actually unlock its store. On macOS this reads the Keychain item
        // and can prompt, so it is asked only when a key is about to be saved, not when configurations are listed.
        async status() { return { available: safeStorage.isEncryptionAvailable(), ...kind() }; },
        async encrypt(value) { return safeStorage.encryptString(value); },
        async decrypt(value) { return safeStorage.decryptString(Buffer.from(value)); }
    });
}
