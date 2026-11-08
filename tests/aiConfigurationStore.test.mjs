/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aiConfigurationStoreVersion, createAIConfigurationStore, createElectronCredentialVault, unreadableCredentialMessage } from '../src/aiConfigurationStore.mjs';

const uuidFactory = () => {
    let index = 10;
    return () => `00000000-0000-4000-8000-${String(index++).padStart(12, '0')}`;
};
const memoryVault = ({ available = true, plainText = false, onStatus = () => {} } = {}) => ({
    kind: () => ({ plainText, backend: plainText ? 'basic_text' : 'test' }),
    status: async () => {
        onStatus();
        return { available, plainText, backend: plainText ? 'basic_text' : 'test' };
    },
    encrypt: async (value) => Buffer.from(`encrypted:${value}`),
    decrypt: async (value) => Buffer.from(value).toString().replace(/^encrypted:/, '')
});

async function withStore(task, vault = memoryVault(), before = async () => {}) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-ai-config-'));
    try {
        await before(directory);
        await task(createAIConfigurationStore({ directory, credentialVault: vault, uuidFactory: uuidFactory() }), directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('a new installation has no model configuration, and asking for the one in use says to set one up', () => withStore(async (store, directory) => {
    const result = await store.list();
    assert.equal(result.activeConfigurationUuid, null);
    assert.deepEqual(result.configurations, []);
    await assert.rejects(() => store.resolve(''), (error) => error.code === 'noConfiguration' && /Settings › Model assistant/.test(error.message));
    assert.equal(JSON.parse(await readFile(join(directory, 'configurations.json'), 'utf8')).version, aiConfigurationStoreVersion);
    const first = await store.save({ name: 'Qwen3.5 4B', provider: 'ollama', model: 'qwen3.5:4b' });
    assert.equal((await store.list()).activeConfigurationUuid, first.uuid, 'The first configuration saved is the one in use.');
}));

test('a version 1 file is moved forward without the retired demonstration configuration', () => withStore(async (store, directory) => {
    const result = await store.list();
    assert.deepEqual(result.configurations.map((item) => item.name), ['My Ollama']);
    assert.equal(result.activeConfigurationUuid, '00000000-0000-4000-8000-000000000002', 'The demonstration was in use, so the one left is.');
    assert.equal(result.configurations[0].think, null);
    assert.equal('builtIn' in result.configurations[0], false);
    const written = JSON.parse(await readFile(join(directory, 'configurations.json'), 'utf8'));
    assert.equal(written.version, aiConfigurationStoreVersion);
    assert.equal(written.configurations.length, 1);
}, memoryVault(), async (directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'configurations.json'), JSON.stringify({
        version: 1,
        activeConfigurationUuid: '00000000-0000-4000-8000-000000000001',
        configurations: [
            { uuid: '00000000-0000-4000-8000-000000000001', name: 'Local demonstration', provider: 'localDemonstration', endpoint: '', model: '', timeoutSeconds: 30, credentialUuid: null, builtIn: true },
            { uuid: '00000000-0000-4000-8000-000000000002', name: 'My Ollama', provider: 'ollama', endpoint: '', model: 'qwen3.5:4b', timeoutSeconds: 180, credentialUuid: null, builtIn: false }
        ]
    }));
}));

test('whether a model reasons before answering is kept: on, off, or the model\'s own default', () => withStore(async (store) => {
    const on = await store.save({ name: 'Reasoning', provider: 'ollama', model: 'qwen3.5:4b', think: true });
    const off = await store.save({ name: 'Quick', provider: 'ollama', model: 'qwen3.5:4b', think: false });
    const unset = await store.save({ name: 'Default', provider: 'ollama', model: 'qwen3.5:4b', think: 'yes' });
    assert.equal((await store.resolve(on.uuid)).configuration.think, true);
    assert.equal((await store.resolve(off.uuid)).configuration.think, false);
    assert.equal((await store.resolve(unset.uuid)).configuration.think, null, 'Anything but true or false leaves it to the model.');
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

test('removes credentials with their configuration, and the one in use becomes another, or none', () => withStore(async (store, directory) => {
    const local = await store.save({ name: 'Local', provider: 'ollama' });
    const saved = await store.save({ name: 'Hosted', provider: 'openAi' }, 'secret-key');
    await store.setActive(saved.uuid);
    assert.equal(await store.remove(saved.uuid), true);
    assert.equal((await store.list()).activeConfigurationUuid, local.uuid);
    assert.deepEqual(await readdir(join(directory, 'credentials')), []);
    assert.equal(await store.remove(local.uuid), true);
    assert.equal((await store.list()).activeConfigurationUuid, null);
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

test('listing configurations never asks the operating system to unlock secure storage; saving a key does', async () => {
    let asked = 0;
    await withStore(async (store) => {
        await store.list();
        const listed = await store.list();
        assert.equal(asked, 0, 'listing must not call status()');
        assert.deepEqual(listed.credentialStorage, { backend: 'test', plainText: false });
        await store.save({ name: 'Hosted', provider: 'openAi' }, 'secret-key');
        assert.equal(asked, 1, 'saving a key checks that secure storage is available');
    }, memoryVault({ onStatus: () => { asked += 1; } }));
});

test('Electron credential vault describes its storage without touching the Keychain, and asks only in status()', async () => {
    let probes = 0;
    const safeStorage = {
        isEncryptionAvailable: () => { probes += 1; return true; },
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
    };
    const darwin = createElectronCredentialVault(safeStorage, 'darwin');
    assert.deepEqual(darwin.kind(), { backend: 'darwin', plainText: false });
    const linux = createElectronCredentialVault(safeStorage, 'linux');
    assert.deepEqual(linux.kind(), { backend: 'gnome_libsecret', plainText: false });
    assert.equal(probes, 0, 'kind() must not call isEncryptionAvailable');
    assert.deepEqual(await darwin.status(), { available: true, backend: 'darwin', plainText: false });
    assert.equal(probes, 1);
    const plain = createElectronCredentialVault({ ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }, 'linux');
    assert.deepEqual(plain.kind(), { backend: 'basic_text', plainText: true });
});

test('a key the operating system will not decrypt is said plainly, with how to get it back', async () => {
    const decrypts = [];
    const locked = { ...memoryVault(), decrypt: async () => { decrypts.push(1); throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.'); } };
    const directory = await mkdtemp(join(tmpdir(), 'konjugate-ai-config-'));
    try {
        const store = createAIConfigurationStore({ directory, credentialVault: locked, uuidFactory: uuidFactory(), platform: 'darwin' });
        const saved = await store.save({ name: 'Gemini', provider: 'gemini', model: 'flash' }, 'secret-key');
        await assert.rejects(() => store.resolve(saved.uuid), (error) => error.code === 'credentialUnreadable'
            && /could not read this configuration's API key: macOS's Keychain did not allow it\. Quit and reopen Konjugate, and choose Allow/.test(error.message)
            && /enter the key again/.test(error.message) && !/safeStorage/.test(error.message));
        await assert.rejects(() => store.resolveDraft({ ...saved, provider: 'gemini' }), (error) => error.code === 'credentialUnreadable');
        // A provider that needs no key never decrypts one, so the Keychain is never asked for it.
        decrypts.length = 0;
        assert.equal((await store.resolve(saved.uuid, { useCredential: false })).credential, null);
        assert.equal((await store.resolveDraft({ ...saved, provider: 'ollama' }, undefined, { useCredential: false })).credential, null);
        assert.equal(decrypts.length, 0);
        // A key typed into the draft is used as it is, with nothing decrypted.
        assert.equal((await store.resolveDraft({ ...saved }, 'typed-key')).credential, 'typed-key');
        assert.equal(decrypts.length, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
    assert.match(unreadableCredentialMessage('linux'), /Unlock your keyring/);
    assert.match(unreadableCredentialMessage('win32'), /Quit and reopen Konjugate/);
});
