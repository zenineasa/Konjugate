/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Running a model on this computer through Ollama (docs/proposals/suggestedLocalModels.md), for the main process:
// whether Ollama is running, which models it has, pulling one with progress, and finding GGUF models on Hugging Face
// that Ollama can pull. Konjugate never downloads or installs Ollama, and stores no model itself: a model is Ollama's.
// Only what was typed in the search is sent to Hugging Face. No Electron here; `fetchImpl` is given.

import { ollamaDefaultEndpoint } from './suggestedLocalModels.mjs';

export class LocalModelsError extends Error {
    constructor(message, code = 'localModelsError') {
        super(message);
        this.name = 'LocalModelsError';
        this.code = code;
    }
}

const huggingFace = 'https://huggingface.co';
const statusTimeoutMilliseconds = 3000;
const searchTimeoutMilliseconds = 15000;
const modelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

// Only Ollama on this computer: plain HTTP to anything else would carry the model names in the clear, and Ollama's
// API has no authentication.
export function ollamaEndpoint(value) {
    let url;
    try { url = new URL(value || ollamaDefaultEndpoint); } catch { throw new LocalModelsError('The Ollama endpoint is not a valid URL.', 'invalidEndpoint'); }
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    if (!local || !['http:', 'https:'].includes(url.protocol)) {
        throw new LocalModelsError('Models are run through Ollama on this computer only: the endpoint must be localhost.', 'invalidEndpoint');
    }
    return url.href.replace(/\/$/, '');
}

const withTimeout = (signal, milliseconds) => {
    const timeout = AbortSignal.timeout(milliseconds);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

async function readJson(response, what) {
    if (!response.ok) {
        let detail = '';
        try { detail = JSON.parse(await response.text()).error ?? ''; } catch { /* no detail */ }
        throw new LocalModelsError(`${what} answered HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 300)}` : '.'}`, 'httpError');
    }
    try { return await response.json(); } catch { throw new LocalModelsError(`${what} did not answer with JSON.`, 'invalidResponse'); }
}

// Each line of a newline-delimited JSON body, as it arrives.
async function* jsonLines(body) {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) if (line.trim()) yield JSON.parse(line);
    }
    if (pending.trim()) yield JSON.parse(pending);
}

// From a GGUF file's name, its quantization ("Q4_K_M", "IQ3_XS", "F16", Unsloth's "UD-Q4_K_XL"), as Ollama's
// `hf.co/<repo>:<quantization>` names it.
export function quantizationOf(fileName) {
    const match = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32))(?=\.gguf$)/i.exec(fileName);
    return match ? match[1].toUpperCase() : null;
}

export function createLocalModels({ fetchImpl = globalThis.fetch, totalMemory = () => 0 } = {}) {
    const pulls = new Map();

    async function status(endpoint) {
        const base = ollamaEndpoint(endpoint);
        const signal = AbortSignal.timeout(statusTimeoutMilliseconds);
        let version;
        try {
            version = (await readJson(await fetchImpl(`${base}/api/version`, { signal }), 'Ollama')).version ?? '';
        } catch (error) {
            if (error instanceof LocalModelsError && error.code === 'invalidEndpoint') throw error;
            return { running: false, endpoint: base, totalMemory: totalMemory(), models: [] };
        }
        const tags = await readJson(await fetchImpl(`${base}/api/tags`, { signal }), 'Ollama');
        const models = (tags.models ?? []).map((model) => ({ name: model.model ?? model.name, size: model.size ?? null }));
        return { running: true, endpoint: base, version, totalMemory: totalMemory(), models };
    }

    // Asks Ollama to pull `model`, telling `onProgress({ model, status, completed, total })` as it goes. One pull per model
    // at a time: asking again while one runs returns the same one.
    function pull(endpoint, model, onProgress = () => {}) {
        if (typeof model !== 'string' || !modelNamePattern.test(model)) throw new LocalModelsError('That is not a model name Ollama can pull.', 'invalidModel');
        const base = ollamaEndpoint(endpoint);
        if (pulls.has(model)) return pulls.get(model).done;
        const controller = new AbortController();
        const done = (async () => {
            const layers = new Map();
            try {
                const response = await fetchImpl(`${base}/api/pull`, {
                    method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, stream: true })
                });
                if (!response.ok) await readJson(response, 'Ollama');
                for await (const line of jsonLines(response.body)) {
                    if (line.error) throw new LocalModelsError(`Ollama could not download ${model}: ${String(line.error).slice(0, 300)}`, 'pullFailed');
                    if (line.digest && Number.isFinite(line.total)) layers.set(line.digest, { total: line.total, completed: line.completed ?? 0 });
                    const total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
                    const completed = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0);
                    onProgress({ model, status: line.status ?? '', completed, total });
                    if (line.status === 'success') return { model, pulled: true };
                }
                throw new LocalModelsError(`Ollama stopped before ${model} was downloaded.`, 'pullIncomplete');
            } catch (error) {
                if (controller.signal.aborted) return { model, pulled: false, cancelled: true };
                if (error instanceof LocalModelsError) throw error;
                throw new LocalModelsError(`Could not download ${model} through Ollama: ${error.message}`, 'pullFailed');
            } finally {
                pulls.delete(model);
            }
        })();
        pulls.set(model, { controller, done });
        return done;
    }

    const cancelPull = (model) => {
        const active = pulls.get(model);
        if (!active) return false;
        active.controller.abort();
        return true;
    };

    // Models on Hugging Face published as GGUF files, most downloaded first. Gated and private ones are left out: Ollama
    // would need the person's Hugging Face key to pull them.
    async function searchHuggingFace(query, { signal } = {}) {
        const text = String(query ?? '').trim().slice(0, 100);
        const url = new URL('/api/models', huggingFace);
        url.searchParams.set('filter', 'gguf');
        if (text) url.searchParams.set('search', text);
        url.searchParams.set('sort', 'downloads');
        url.searchParams.set('limit', '30');
        url.searchParams.set('full', 'false');
        url.searchParams.append('expand[]', 'downloads');
        url.searchParams.append('expand[]', 'gated');
        url.searchParams.append('expand[]', 'private');
        url.searchParams.append('expand[]', 'tags');
        let results;
        try {
            results = await readJson(await fetchImpl(url, { signal: withTimeout(signal, searchTimeoutMilliseconds) }), 'Hugging Face');
        } catch (error) {
            if (error instanceof LocalModelsError) throw error;
            throw new LocalModelsError(`Could not reach Hugging Face: ${error.message}`, 'connectionFailed');
        }
        return (Array.isArray(results) ? results : [])
            .filter((entry) => typeof entry.id === 'string' && repositoryPattern.test(entry.id) && !entry.gated && !entry.private)
            .map((entry) => ({
                repository: entry.id,
                downloads: entry.downloads ?? 0,
                license: (entry.tags ?? []).find((tag) => tag.startsWith('license:'))?.slice('license:'.length) ?? null
            }));
    }

    // A repository's GGUF files that Ollama can pull by quantization, smallest first. Split files and vision projectors
    // are left out.
    async function huggingFaceFiles(repository, { signal } = {}) {
        if (typeof repository !== 'string' || !repositoryPattern.test(repository)) throw new LocalModelsError('That is not a Hugging Face repository.', 'invalidRepository');
        let entries;
        try {
            entries = await readJson(await fetchImpl(new URL(`/api/models/${repository}/tree/main`, huggingFace), { signal: withTimeout(signal, searchTimeoutMilliseconds) }), 'Hugging Face');
        } catch (error) {
            if (error instanceof LocalModelsError) throw error;
            throw new LocalModelsError(`Could not reach Hugging Face: ${error.message}`, 'connectionFailed');
        }
        const seen = new Set();
        return (Array.isArray(entries) ? entries : [])
            .filter((entry) => entry.type === 'file' && /\.gguf$/i.test(entry.path) && !/-\d{5}-of-\d{5}\.gguf$/i.test(entry.path) && !/mmproj/i.test(entry.path))
            .map((entry) => ({ file: entry.path, quantization: quantizationOf(entry.path.split('/').pop()), size: entry.lfs?.size ?? entry.size ?? null }))
            .filter((entry) => entry.quantization && !seen.has(entry.quantization) && seen.add(entry.quantization))
            .sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    }

    return Object.freeze({ status, pull, cancelPull, pulling: () => [...pulls.keys()], searchHuggingFace, huggingFaceFiles });
}
