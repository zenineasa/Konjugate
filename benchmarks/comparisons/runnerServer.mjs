/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

// A runner that serves commands, one JSON line each way (scipyRunner.py --serve, julia/juliaRunner.jl). Its progress goes to our stderr.
// A line on its stdout that is not a JSON object (something a child of the runner printed there) is passed to our stderr and skipped.
export function protocolMessage(line) {
    if (!line.trimStart().startsWith('{')) return null;
    try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

export async function startServer(command, args, { env = process.env } = {}) {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async () => {
        for (;;) {
            const { value, done } = await lines.next();
            if (done) throw new Error(`${command} stopped serving`);
            const message = protocolMessage(value);
            if (message) return message;
            if (value.trim()) process.stderr.write(`${value}\n`);
        }
    };
    const started = performance.now();
    const hello = await next();
    return {
        hello: { ...hello, readySeconds: (performance.now() - started) / 1000 },
        async ask(message) { child.stdin.write(`${JSON.stringify(message)}\n`); return next(); },
        stop() { child.stdin.end(); }
    };
}
