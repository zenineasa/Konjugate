/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const providerToolchainStoreVersion = 1;

// '' means "automatic": let the engine pick (currently sharedMemoryWorker, see
// ProviderExecutionMode in the engine). The other three mirror the engine's enum exactly.
export const providerExecutionModes = ['', 'pipeWorker', 'sharedMemoryWorker', 'inProcess'];

function defaultState() {
    return { version: providerToolchainStoreVersion, cpp: { compilerPath: '' }, python: { interpreterPath: '' }, executionMode: '' };
}

function validState(candidate) {
    // executionMode is intentionally not required here: a toolchains.json written before this
    // field existed must still validate, so its compiler/interpreter overrides survive an
    // upgrade instead of being silently reset to defaultState(). normalizeState() below fills
    // in a default for whatever this leaves out.
    return candidate?.version === providerToolchainStoreVersion &&
        typeof candidate.cpp?.compilerPath === 'string' &&
        typeof candidate.python?.interpreterPath === 'string';
}

function normalizeState(candidate) {
    return {
        ...candidate,
        executionMode: providerExecutionModes.includes(candidate.executionMode) ? candidate.executionMode : ''
    };
}

// Machine-local override paths for the C++ compiler and Python interpreter used to build and
// run inline relationship/source-term providers. Kept outside the project file (like the
// AI configuration store) because a path only makes sense on the machine that resolved it.
export function createProviderToolchainStore({ directory, uuidFactory = randomUUID } = {}) {
    if (!directory) throw new Error('Provider toolchain storage requires a directory.');
    const settingsPath = join(directory, 'toolchains.json');
    let state = null;

    const writeAtomically = async (path, content) => {
        const temporaryPath = `${path}.${uuidFactory()}.tmp`;
        await writeFile(temporaryPath, content, { mode: 0o600 });
        try {
            await rename(temporaryPath, path);
        } catch (error) {
            await unlink(temporaryPath).catch(() => {});
            throw error;
        }
    };
    const persist = () => writeAtomically(settingsPath, `${JSON.stringify(state, null, 4)}\n`);
    const initialize = async () => {
        if (state) return;
        await mkdir(directory, { recursive: true });
        try {
            const loaded = JSON.parse(await readFile(settingsPath, 'utf8'));
            state = validState(loaded) ? normalizeState(loaded) : defaultState();
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            state = defaultState();
        }
    };

    return Object.freeze({
        async get() {
            await initialize();
            return structuredClone(state);
        },
        async set(kind, value) {
            await initialize();
            if (kind === 'executionMode') {
                const trimmed = (value ?? '').trim();
                if (!providerExecutionModes.includes(trimmed)) {
                    throw new Error(`Unsupported provider execution mode: "${trimmed}".`);
                }
                state.executionMode = trimmed;
            } else {
                const trimmed = (value ?? '').trim();
                if (kind === 'python') state.python = { interpreterPath: trimmed };
                else state.cpp = { compilerPath: trimmed };
            }
            await persist();
            return structuredClone(state);
        }
    });
}
