/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The models Settings › Model assistant suggests for running on this computer, through Ollama
// (docs/proposals/suggestedLocalModels.md), written down once. Each is one we have measured with the evaluation harness
// (docs/assistantModelFindings.md), and `configuration` is the setup it was measured with, which **Use it** creates.
// After a new measurement, this list and the findings change together, and nothing else. No DOM.

const gigabyte = 1e9;

export const ollamaDownloadPage = 'https://ollama.com/download';
export const ollamaDefaultEndpoint = 'http://127.0.0.1:11434';

export const suggestedLocalModels = Object.freeze([
    {
        model: 'qwen3.5:4b',
        title: 'Qwen3.5 4B',
        badge: 'Recommended',
        description: 'About 20 seconds an answer on a recent laptop. The best of the models we measured that runs on 8 GB.',
        downloadBytes: 4.0 * gigabyte,
        memoryBytes: 8 * 2 ** 30,
        configuration: { think: false, timeoutSeconds: 180 }
    },
    {
        model: 'qwen3.5:2b',
        title: 'Qwen3.5 2B',
        badge: 'For slower computers',
        description: 'Faster, and asks more questions it does not need to.',
        downloadBytes: 3.1 * gigabyte,
        memoryBytes: 8 * 2 ** 30,
        configuration: { think: false, timeoutSeconds: 180 }
    }
].map((entry) => Object.freeze({ ...entry, configuration: Object.freeze(entry.configuration) })));

// What turning reasoning on was measured to cost (docs/proposals/suggestedLocalModels.md#reasoning), shown under the setting.
export const reasoningCostNote = 'Much slower. In a test on an 8 GB M1, Qwen3.5 4B took about 3½ to 10 minutes an answer with reasoning on, against about 20 seconds with it off, and fixed one of two requests it had got wrong. While the model reasons, the assistant shows its reasoning as it is written.';

// Ollama names a model pulled from Hugging Face by its repository and quantization.
export const huggingFaceOllamaName = (repository, quantization) => `hf.co/${repository}${quantization ? `:${quantization}` : ''}`;

// Whether a model of `memoryBytes` is expected to fit in a computer of `totalBytes`, as the cards and the browser say it.
export function memoryFit(memoryBytes, totalBytes) {
    if (!Number.isFinite(memoryBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return { fits: true, note: '' };
    if (memoryBytes <= totalBytes) return { fits: true, note: '' };
    return { fits: false, note: `This computer has ${Math.round(totalBytes / 2 ** 30)} GB: it may be very slow or fail to load.` };
}

// The memory a GGUF file of `bytes` needs to run: the weights, plus room for the context and the runtime.
export const memoryForFile = (bytes) => Math.round(bytes * 1.2 + 1.5 * 2 ** 30);

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}
