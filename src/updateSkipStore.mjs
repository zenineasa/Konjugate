/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const updateSkipStoreVersion = 1;

// The one thing about updates that is kept across restarts: the version the person chose to skip, so
// its badge stays away until a newer version appears (docs/updates.md). Everything else the update
// check knows lives in memory only. A missing, unreadable or malformed file simply means "nothing
// skipped" -- losing it costs the person one badge, never a failure.
export function createUpdateSkipStore({ directory, uuidFactory = randomUUID } = {}) {
    if (!directory) throw new Error('The update skip store requires a directory.');
    const path = join(directory, 'updateSkipped.json');

    return {
        async get() {
            try {
                const state = JSON.parse(await readFile(path, 'utf8'));
                return state?.version === updateSkipStoreVersion && typeof state.skippedVersion === 'string' && state.skippedVersion !== ''
                    ? state.skippedVersion : null;
            } catch {
                return null;
            }
        },

        // A version string, or null to clear. Written atomically, like the other stores here.
        async set(version) {
            if (version !== null && (typeof version !== 'string' || version === '')) throw new Error('A skipped version must be a non-empty string, or null to clear it.');
            await mkdir(directory, { recursive: true });
            const temporaryPath = `${path}.${uuidFactory()}.tmp`;
            await writeFile(temporaryPath, JSON.stringify({ version: updateSkipStoreVersion, skippedVersion: version }), { mode: 0o600 });
            try {
                await rename(temporaryPath, path);
            } catch (error) {
                await unlink(temporaryPath).catch(() => {});
                throw error;
            }
        }
    };
}
