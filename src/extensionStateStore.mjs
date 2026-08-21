/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const extensionStateStoreVersion = 1;

function validState(candidate) {
    return candidate?.version === extensionStateStoreVersion && Array.isArray(candidate.disabled)
        && candidate.disabled.every((key) => typeof key === 'string');
}

// Tracks which installed/bundled add-ons and plugins are disabled, keyed by packageKey(). Unlike
// install/uninstall, toggling this never adds or removes files, so consumers (discoverAddons's
// callers, discoverComponentLibrary, pluginResolver.mjs) can honor it live without a restart.
export function createExtensionStateStore({ directory, defaultDisabled = [], uuidFactory = randomUUID } = {}) {
    if (!directory) throw new Error('Extension state storage requires a directory.');
    const settingsPath = join(directory, 'extensionState.json');
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
            state = validState(loaded) ? loaded : { version: extensionStateStoreVersion, disabled: [] };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            // First-ever run only: seed the default-disabled set and persist it immediately, so
            // this branch never runs again for this userData directory -- a user who later
            // re-enables a default-disabled item stays re-enabled across restarts.
            state = { version: extensionStateStoreVersion, disabled: [...new Set(defaultDisabled)].sort() };
            await persist();
        }
    };

    return Object.freeze({
        async list() {
            await initialize();
            return [...state.disabled];
        },
        async setEnabled(key, enabled) {
            await initialize();
            const disabled = new Set(state.disabled);
            if (enabled) disabled.delete(key); else disabled.add(key);
            state.disabled = [...disabled].sort();
            await persist();
            return [...state.disabled];
        }
    });
}
