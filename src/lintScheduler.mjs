/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's check as you type, without a pile-up (docs/proposals/codeEditor.md, "Compiler lint without a pile-up"): one check
// process per editor at a time; a newer request stops the one running (and waits for it to be gone before starting); a check still
// running after the time limit is stopped and says so; and answers are kept by a hash of what they depend on (the source, the compiler
// and its flags), the last 32, so going back to a source already checked starts nothing. Used by the desktop (a compiler or Python
// process) and the web edition (the in-browser clang, or Pyodide), each handing it the way it runs one check.
//
// run(request, signal) → a promise of the check's answer; when `signal` aborts it must stop its process (it may still settle later).
// key(request) → (a promise of) the string the answer is kept under, or null not to keep it.

export const lintTimeoutMessage = 'Check took too long; it will run again when you pause.';

export function createLintScheduler({ run, key = () => null, timeoutMs = 10000, cacheSize = 32, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const cache = new Map();
    let running = null; // { controller, settled: Promise }
    let latest = 0;
    const stats = { started: 0, cacheHits: 0, superseded: 0, timedOut: 0, active: 0, maxActive: 0 };

    function remember(cacheKey, answer) {
        if (cacheKey === null || cacheKey === undefined) return;
        cache.delete(cacheKey);
        cache.set(cacheKey, answer);
        while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    }

    // The answer for `request`, or { superseded: true } when a newer request came before it finished.
    async function schedule(request) {
        const ticket = ++latest;
        const cacheKey = await key(request);
        if (ticket !== latest) { stats.superseded += 1; return { superseded: true }; }
        if (cacheKey !== null && cacheKey !== undefined && cache.has(cacheKey)) {
            stats.cacheHits += 1;
            const answer = cache.get(cacheKey);
            remember(cacheKey, answer); // Most recently used.
            return answer;
        }
        // Stop the check running, and wait until it has gone, so no two run at once.
        while (running) {
            running.controller.abort();
            await running.settled;
            if (ticket !== latest) { stats.superseded += 1; return { superseded: true }; }
        }
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimer(() => { timedOut = true; controller.abort(); }, timeoutMs);
        stats.started += 1;
        stats.active += 1;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        const work = Promise.resolve().then(() => run(request, controller.signal));
        const settled = work.then(() => {}, () => {}).finally(() => {
            clearTimer(timer);
            stats.active -= 1;
            if (running?.controller === controller) running = null;
        });
        running = { controller, settled };
        let answer;
        try {
            answer = await work;
        } catch (error) {
            if (!controller.signal.aborted) throw error;
        }
        await settled;
        if (timedOut) {
            stats.timedOut += 1;
            return { valid: null, timedOut: true, message: lintTimeoutMessage };
        }
        if (controller.signal.aborted || ticket !== latest) {
            stats.superseded += 1;
            return { superseded: true };
        }
        remember(cacheKey, answer);
        return answer;
    }

    return { schedule, stats, get cacheSize() { return cache.size; } };
}

// A short, stable hash of text (FNV-1a, 64 bits as two 32-bit halves), for cache keys: no crypto module needed on either host.
export function lintHash(text) {
    let low = 0x811c9dc5;
    let high = 0xcbf29ce4;
    const string = String(text ?? '');
    for (let index = 0; index < string.length; index += 1) {
        const code = string.charCodeAt(index);
        low = Math.imul(low ^ code, 0x01000193) >>> 0;
        high = Math.imul(high ^ (code >>> 8) ^ low, 0x01000193) >>> 0;
    }
    return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}:${string.length}`;
}
