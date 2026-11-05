/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The defaults a person sets for the ownership block of new projects (docs/proposals/modelOwnership.md): owner, copyright notice,
// license, contact and whether new projects start confidential. One small JSON file in the user's data folder, never sent anywhere.
// Every default starts empty. A file that cannot be read or is not what was written reads as no defaults.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeOwnershipDefaults } from './ownership.mjs';

export const ownershipDefaultsFile = (userData) => join(userData, 'ownershipDefaults.json');

export function createOwnershipDefaultsStore({ userData, uuidFactory = randomUUID }) {
    if (!userData) throw new Error('Ownership defaults need a directory.');
    const path = ownershipDefaultsFile(userData);
    return Object.freeze({
        // The defaults last kept: an object holding only what was set, empty when none were.
        async get() {
            try {
                return normalizeOwnershipDefaults(JSON.parse(await readFile(path, 'utf8')).defaults);
            } catch {
                return {};
            }
        },
        // Replaces the defaults with `defaults`, cleaned the way a project file's block is; an empty set removes the file. Returns what was kept.
        async set(defaults) {
            const kept = normalizeOwnershipDefaults(defaults);
            if (!Object.keys(kept).length) {
                await rm(path, { force: true });
                return kept;
            }
            await mkdir(dirname(path), { recursive: true });
            const temporaryPath = `${path}.${uuidFactory()}.tmp`;
            await writeFile(temporaryPath, JSON.stringify({ version: 1, defaults: kept }), { mode: 0o600 });
            try {
                await rename(temporaryPath, path);
            } catch (error) {
                await unlink(temporaryPath).catch(() => {});
                throw error;
            }
            return kept;
        }
    });
}
