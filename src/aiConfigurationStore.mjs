/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const aiConfigurationStoreVersion = 1;
export const localDemonstrationConfigurationUuid = '00000000-0000-4000-8000-000000000001';
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
    return {
        uuid,
        name,
        provider,
        endpoint,
        model,
        timeoutSeconds,
        credentialUuid: existing?.credentialUuid ?? null,
        builtIn: Boolean(existing?.builtIn)
    };
}

export function createAIConfigurationStore({ directory, credentialVault, uuidFactory = randomUUID } = {}) {
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
            if (loaded.version !== aiConfigurationStoreVersion || !Array.isArray(loaded.configurations)) {
                throw new AIConfigurationError('The AI configuration file uses an unsupported format.', 'unsupportedConfigurationFormat');
            }
            state = loaded;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            state = {
                version: aiConfigurationStoreVersion,
                activeConfigurationUuid: localDemonstrationConfigurationUuid,
                configurations: [{
                    uuid: localDemonstrationConfigurationUuid,
                    name: 'Local demonstration',
                    provider: 'localDemonstration',
                    endpoint: '', model: '', timeoutSeconds: 30, credentialUuid: null, builtIn: true
                }]
            };
            await persist();
        }
    };
    const find = (uuid) => state.configurations.find((configuration) => configuration.uuid === uuid);

    return Object.freeze({
        async list() {
            await initialize();
            return {
                activeConfigurationUuid: state.activeConfigurationUuid,
                configurations: state.configurations.map(publicConfiguration),
                credentialStorage: await credentialVault.status()
            };
        },
        async save(input, credential) {
            await initialize();
            const existing = input.uuid ? find(input.uuid) : null;
            if (input.uuid && !existing) throw new AIConfigurationError('That model configuration does not exist.', 'configurationNotFound');
            if (existing?.builtIn) throw new AIConfigurationError('Built-in configurations cannot be modified.', 'builtInConfiguration');
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
            if (configuration.builtIn) throw new AIConfigurationError('Built-in configurations cannot be removed.', 'builtInConfiguration');
            state.configurations = state.configurations.filter((item) => item.uuid !== uuid);
            if (state.activeConfigurationUuid === uuid) state.activeConfigurationUuid = localDemonstrationConfigurationUuid;
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
        async resolve(uuid) {
            await initialize();
            const configuration = find(uuid || state.activeConfigurationUuid);
            if (!configuration) throw new AIConfigurationError('That model configuration does not exist.', 'configurationNotFound');
            let credential = null;
            if (configuration.credentialUuid) {
                const encrypted = await readFile(join(credentialsDirectory, `${configuration.credentialUuid}.bin`));
                credential = await credentialVault.decrypt(encrypted);
            }
            return { configuration: structuredClone(configuration), credential };
        },
        async resolveDraft(input, credential) {
            await initialize();
            const existing = input.uuid ? find(input.uuid) : null;
            const configuration = normalizeConfiguration(input, existing, uuidFactory);
            let resolvedCredential = typeof credential === 'string' && credential.trim() ? credential.trim() : null;
            if (!resolvedCredential && existing?.credentialUuid) {
                const encrypted = await readFile(join(credentialsDirectory, `${existing.credentialUuid}.bin`));
                resolvedCredential = await credentialVault.decrypt(encrypted);
            }
            return { configuration, credential: resolvedCredential };
        }
    });
}

export function createElectronCredentialVault(safeStorage, platform = process.platform) {
    return Object.freeze({
        async status() {
            const available = safeStorage.isEncryptionAvailable();
            const backend = platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
                ? safeStorage.getSelectedStorageBackend() : platform;
            return { available, backend, plainText: backend === 'basic_text' };
        },
        async encrypt(value) { return safeStorage.encryptString(value); },
        async decrypt(value) { return safeStorage.decryptString(Buffer.from(value)); }
    });
}
