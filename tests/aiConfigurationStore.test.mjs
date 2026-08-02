/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    createAIConfigurationStore,
    createElectronCredentialVault,
    localDemonstrationConfigurationUuid
} from '../src/aiConfigurationStore.mjs';

const uuidFactory = () => {
    let index = 10;
    return () => `00000000-0000-4000-8000-${String(index++).padStart(12, '0')}`;
};
const memoryVault = ({ available = true, plainText = false } = {}) => ({
    status: async () => ({ available, plainText, backend: plainText ? 'basic_text' : 'test' }),
    encrypt: async (value) => Buffer.from(`encrypted:${value}`),
    decrypt: async (value) => Buffer.from(value).toString().replace(/^encrypted:/, '')
});

async function withStore(task, vault = memoryVault()) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-ai-config-'));
    try {
        await task(createAIConfigurationStore({ directory, credentialVault: vault, uuidFactory: uuidFactory() }), directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('initializes with a built-in local configuration', () => withStore(async (store, directory) => {
    const result = await store.list();
    assert.equal(result.activeConfigurationUuid, localDemonstrationConfigurationUuid);
    assert.deepEqual(result.configurations.map((item) => item.provider), ['localDemonstration']);
    assert.equal(result.configurations[0].credentialConfigured, false);
    assert.equal((await store.resolve('')).configuration.uuid, localDemonstrationConfigurationUuid);
    assert.equal(JSON.parse(await readFile(join(directory, 'configurations.json'), 'utf8')).version, 1);
}));

test('stores only encrypted credentials and never returns them from public configuration methods', () => withStore(async (store, directory) => {
    const saved = await store.save({ name: 'Hosted model', provider: 'openAi', endpoint: 'https://example.test', model: 'model-a' }, 'secret-key');
    assert.equal(saved.credentialConfigured, true);
    assert.equal('credentialUuid' in saved, false);
    const configurationText = await readFile(join(directory, 'configurations.json'), 'utf8');
    assert.equal(configurationText.includes('secret-key'), false);
    const [credentialFile] = await readdir(join(directory, 'credentials'));
    assert.equal((await readFile(join(directory, 'credentials', credentialFile), 'utf8')), 'encrypted:secret-key');
    const resolved = await store.resolve(saved.uuid);
    assert.equal(resolved.credential, 'secret-key');
}));

test('updates metadata without replacing a stored credential', () => withStore(async (store) => {
    const saved = await store.save({ name: 'Hosted', provider: 'openAi', model: 'first' }, 'secret-key');
    const updated = await store.save({ ...saved, name: 'Hosted updated', model: 'second' });
    assert.equal(updated.credentialConfigured, true);
    assert.equal((await store.resolve(saved.uuid)).credential, 'secret-key');
}));

test('resolves unsaved drafts without persisting their credentials', () => withStore(async (store, directory) => {
    const draft = await store.resolveDraft({
        name: 'Draft Ollama', provider: 'ollama', endpoint: 'http://127.0.0.1:11434', timeoutSeconds: 180
    });
    assert.equal(draft.configuration.provider, 'ollama');
    assert.equal(draft.credential, null);
    const hosted = await store.resolveDraft({ name: 'Draft hosted', provider: 'openAi' }, 'transient-key');
    assert.equal(hosted.credential, 'transient-key');
    assert.equal((await readFile(join(directory, 'configurations.json'), 'utf8')).includes('transient-key'), false);
    assert.deepEqual(await readdir(join(directory, 'credentials')), []);
}));

test('removes credentials with their configuration and restores the local default', () => withStore(async (store, directory) => {
    const saved = await store.save({ name: 'Hosted', provider: 'openAi' }, 'secret-key');
    await store.setActive(saved.uuid);
    assert.equal(await store.remove(saved.uuid), true);
    assert.equal((await store.list()).activeConfigurationUuid, localDemonstrationConfigurationUuid);
    assert.deepEqual(await readdir(join(directory, 'credentials')), []);
}));

test('refuses persistent credentials when secure storage is unavailable or plaintext', async () => {
    for (const vault of [memoryVault({ available: false }), memoryVault({ plainText: true })]) {
        await withStore(async (store) => {
            await assert.rejects(() => store.save({ name: 'Hosted', provider: 'openAi' }, 'secret-key'), /Secure credential storage is unavailable/);
        }, vault);
    }
});

test('Electron credential vault reports plaintext Linux backends', async () => {
    const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text',
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
    };
    const vault = createElectronCredentialVault(safeStorage, 'linux');
    assert.deepEqual(await vault.status(), { available: true, backend: 'basic_text', plainText: true });
});
