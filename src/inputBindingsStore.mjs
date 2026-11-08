/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The controller bindings a person keeps (docs/proposals/humanInputBinding.md): which gamepad, MIDI or keyboard control drives which
// live parameter, by its symbol, and how. One small JSON file in the user's data folder, never in a project, so a person's controller
// and how they like it set up go with them from one project to the next. A file that cannot be read reads as no bindings.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeInputBindings } from './inputBindings.mjs';

export const inputBindingsFile = (userData) => join(userData, 'inputBindings.json');

export function createInputBindingsStore({ userData, uuidFactory = randomUUID }) {
    if (!userData) throw new Error('Controller bindings need a directory.');
    const path = inputBindingsFile(userData);
    return Object.freeze({
        async get() {
            try {
                return normalizeInputBindings(JSON.parse(await readFile(path, 'utf8')));
            } catch {
                return normalizeInputBindings(null);
            }
        },
        // Replaces what is kept with `document`, cleaned; returns what was kept.
        async set(document) {
            const kept = normalizeInputBindings(document);
            await mkdir(dirname(path), { recursive: true });
            const temporaryPath = `${path}.${uuidFactory()}.tmp`;
            await writeFile(temporaryPath, JSON.stringify(kept), { mode: 0o600 });
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
