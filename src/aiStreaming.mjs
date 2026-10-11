/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading a model's streamed reply: server-sent events (OpenAI-compatible APIs and Gemini) or
// newline-delimited JSON (Ollama). Plain functions over a fetch Response, so the adapters can be
// tested with in-memory streams.

import { AssistantProviderError } from './assistantProviders.mjs';

const maximumLineLength = 5_000_000;

export const isStreamingResponse = (response) => /event-stream|ndjson/i.test(response.headers.get('content-type') ?? '');

export async function* streamLines(response, onActivity) {
    if (!response.body) throw new AssistantProviderError('The AI provider returned no response body.', 'invalidProviderResponse');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            onActivity?.();
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                yield line;
            }
            if (buffer.length > maximumLineLength) {
                throw new AssistantProviderError('The AI provider sent an unreasonably long line.', 'invalidProviderResponse');
            }
        }
        buffer += decoder.decode();
        if (buffer.trim()) yield buffer;
    } finally {
        await reader.cancel().catch(() => {});
    }
}

function parseChunk(text) {
    try { return JSON.parse(text); } catch { throw new AssistantProviderError('The AI provider sent a malformed stream event.', 'invalidProviderResponse'); }
}

// `data: {...}` lines; comments (": keep-alive"), other fields and the "[DONE]" marker carry no event.
export async function* serverSentEvents(lines) {
    for await (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        yield parseChunk(data);
    }
}

export async function* newlineDelimitedJson(lines) {
    for await (const line of lines) {
        if (line.trim()) yield parseChunk(line);
    }
}
