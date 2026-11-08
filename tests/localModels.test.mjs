/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalModels, ollamaEndpoint, quantizationOf } from '../src/localModels.mjs';
import { formatBytes, huggingFaceOllamaName, memoryFit, ollamaDownloadPage, suggestedLocalModels } from '../src/suggestedLocalModels.mjs';
import { startFakeOllama } from './fixtures/fakeOllama.mjs';

test('the suggested models are ones we measured, each with the setup it was measured with', () => {
    assert.deepEqual(suggestedLocalModels.map((entry) => entry.model), ['qwen3.5:4b', 'qwen3.5:2b']);
    assert.equal(suggestedLocalModels[0].badge, 'Recommended');
    for (const entry of suggestedLocalModels) {
        assert.equal(entry.configuration.think, false, `${entry.model} was measured with reasoning off.`);
        assert.ok(entry.title && entry.description && entry.downloadBytes > 0 && entry.memoryBytes > 0);
        assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.configuration));
    }
    assert.equal(ollamaDownloadPage, 'https://ollama.com/download', 'A page to download Ollama from, never an installer.');
});

test('whether Ollama is running, what it has, and how much memory this computer has', async () => {
    const fake = await startFakeOllama({ models: ['qwen3.5:2b'] });
    try {
        const local = createLocalModels({ totalMemory: () => 8 * 2 ** 30 });
        const status = await local.status(fake.endpoint);
        assert.equal(status.running, true);
        assert.equal(status.version, '0.12.0');
        assert.deepEqual(status.models.map((model) => model.name), ['qwen3.5:2b']);
        assert.equal(status.totalMemory, 8 * 2 ** 30);
    } finally {
        await fake.close();
    }
    const stopped = await createLocalModels().status(fake.endpoint);
    assert.equal(stopped.running, false, 'Nothing answering is Ollama not running, not an error.');
});

test('Ollama is asked only on this computer', async () => {
    assert.equal(ollamaEndpoint(''), 'http://127.0.0.1:11434');
    assert.equal(ollamaEndpoint('http://localhost:9999/'), 'http://localhost:9999');
    assert.throws(() => ollamaEndpoint('http://example.com:11434'), /localhost/);
    assert.throws(() => ollamaEndpoint('file:///etc/passwd'), /localhost/);
    await assert.rejects(() => createLocalModels().status('http://10.0.0.2:11434'), /localhost/);
    assert.throws(() => createLocalModels().pull('', 'bad name; rm -rf'), /not a model name/);
});

test('a pull reports its progress and adds the model; asking again while it runs shares it; Stop cancels it', async () => {
    const fake = await startFakeOllama({ models: [], pullSteps: 4 });
    try {
        const local = createLocalModels();
        const seen = [];
        const first = local.pull(fake.endpoint, 'qwen3.5:4b', (progress) => seen.push(progress));
        assert.equal(local.pull(fake.endpoint, 'qwen3.5:4b'), first);
        assert.deepEqual(local.pulling(), ['qwen3.5:4b']);
        assert.deepEqual(await first, { model: 'qwen3.5:4b', pulled: true });
        assert.deepEqual(local.pulling(), []);
        const layered = seen.filter((progress) => progress.total > 0);
        assert.equal(layered.at(-1).completed, layered.at(-1).total);
        assert.ok(layered.length >= 4 && layered[0].completed < layered.at(-1).completed);
        assert.ok((await local.status(fake.endpoint)).models.some((model) => model.name === 'qwen3.5:4b'));
        assert.equal(fake.requests.find((request) => request.path === '/api/pull').body.model, 'qwen3.5:4b');

        const slow = local.pull(fake.endpoint, 'qwen3.5:2b');
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(local.cancelPull('qwen3.5:2b'), true);
        assert.deepEqual(await slow, { model: 'qwen3.5:2b', pulled: false, cancelled: true });
        assert.equal(local.cancelPull('qwen3.5:2b'), false);

        await assert.rejects(() => local.pull(fake.endpoint, 'missing:latest'), /file does not exist/);
    } finally {
        await fake.close();
    }
});

const fetchReplying = (routes) => async (url) => {
    const text = String(url);
    const route = Object.entries(routes).find(([prefix]) => text.startsWith(prefix));
    if (!route) throw new Error(`unexpected ${text}`);
    return new Response(JSON.stringify(route[1]), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('Hugging Face is searched for GGUF models, leaving out gated and private ones, sending only what was typed', async () => {
    const asked = [];
    const local = createLocalModels({
        fetchImpl: async (url, options) => {
            asked.push(new URL(url));
            return fetchReplying({
                'https://huggingface.co/api/models?': [
                    { id: 'unsloth/Qwen3.5-4B-GGUF', downloads: 1500000, tags: ['gguf', 'license:apache-2.0'] },
                    { id: 'someone/Gated-GGUF', downloads: 10, gated: 'manual', tags: [] },
                    { id: 'someone/Private-GGUF', downloads: 10, private: true, tags: [] },
                    { id: '../../escape', downloads: 1 }
                ]
            })(url, options);
        }
    });
    const results = await local.searchHuggingFace('qwen3.5 4b');
    assert.deepEqual(results, [{ repository: 'unsloth/Qwen3.5-4B-GGUF', downloads: 1500000, license: 'apache-2.0' }]);
    assert.equal(asked[0].origin, 'https://huggingface.co');
    assert.equal(asked[0].searchParams.get('filter'), 'gguf');
    assert.equal(asked[0].searchParams.get('search'), 'qwen3.5 4b');
});

test('a repository\'s files are offered by quantization, smallest first, without split files or vision projectors', async () => {
    const local = createLocalModels({
        fetchImpl: fetchReplying({
            'https://huggingface.co/api/models/unsloth/Qwen3.5-4B-GGUF/tree/main': [
                { type: 'file', path: 'Qwen3.5-4B-Q8_0.gguf', size: 100, lfs: { size: 4_400_000_000 } },
                { type: 'file', path: 'Qwen3.5-4B-UD-Q4_K_XL.gguf', lfs: { size: 2_900_000_000 } },
                { type: 'file', path: 'Qwen3.5-4B-Q4_K_M.gguf', lfs: { size: 2_700_000_000 } },
                { type: 'file', path: 'mmproj-F16.gguf', lfs: { size: 600_000_000 } },
                { type: 'file', path: 'big/Model-Q4_K_M-00001-of-00003.gguf', lfs: { size: 1 } },
                { type: 'file', path: 'README.md', size: 10 },
                { type: 'directory', path: 'big' }
            ]
        })
    });
    const files = await local.huggingFaceFiles('unsloth/Qwen3.5-4B-GGUF');
    assert.deepEqual(files.map((file) => file.quantization), ['Q4_K_M', 'UD-Q4_K_XL', 'Q8_0']);
    assert.equal(files[0].size, 2_700_000_000);
    assert.equal(huggingFaceOllamaName('unsloth/Qwen3.5-4B-GGUF', 'Q4_K_M'), 'hf.co/unsloth/Qwen3.5-4B-GGUF:Q4_K_M');
    await assert.rejects(() => local.huggingFaceFiles('../../etc'), /not a Hugging Face repository/);
});

test('names, sizes and whether a model fits are worded as the cards say them', () => {
    assert.equal(quantizationOf('Model.IQ3_XS.gguf'), 'IQ3_XS');
    assert.equal(quantizationOf('model-bf16.gguf'), 'BF16');
    assert.equal(quantizationOf('notes.gguf'), null);
    assert.equal(formatBytes(3_973_305_013), '4.0 GB');
    assert.equal(formatBytes(612_000_000), '612 MB');
    assert.deepEqual(memoryFit(8 * 2 ** 30, 16 * 2 ** 30), { fits: true, note: '' });
    assert.match(memoryFit(8 * 2 ** 30, 4 * 2 ** 30).note, /This computer has 4 GB: it may be very slow or fail to load/);
    assert.equal(memoryFit(8 * 2 ** 30, 0).fits, true, 'Not knowing is not a reason to warn.');
});
