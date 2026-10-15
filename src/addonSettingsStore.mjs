/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A result visualizer's own settings, kept for the user rather than with a project (with the settings.store
// permission): its preferences, say, that should hold in every project. One JSON file per add-on under the user's
// data, never seen by the window as a path. Kept across reinstalls and updates; removed with the add-on's last
// installed version, as its cache is.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const maximumAddonSettingsBytes = 256 * 1024;

const safeId = (addonId) => String(addonId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);

export function addonSettingsPath(userData, addonId) {
    return join(userData, 'addonSettings', `${safeId(addonId)}.json`);
}

export function createAddonSettingsStore({ userData, uuidFactory = randomUUID }) {
    if (!userData) throw new Error('Add-on settings need a directory.');
    return Object.freeze({
        // The settings the add-on last kept, or null when it has kept none (or they cannot be read).
        async get(addonId) {
            try {
                return JSON.parse(await readFile(addonSettingsPath(userData, addonId), 'utf8')).settings ?? null;
            } catch {
                return null;
            }
        },
        // Replaces the add-on's settings with any JSON value; null removes them.
        async set(addonId, settings) {
            const path = addonSettingsPath(userData, addonId);
            if (settings === null || settings === undefined) {
                await rm(path, { force: true });
                return;
            }
            const text = JSON.stringify({ version: 1, settings });
            if (text === undefined) throw new Error('Add-on settings must be JSON.');
            if (Buffer.byteLength(text) > maximumAddonSettingsBytes) throw new Error(`An add-on's settings may be at most ${maximumAddonSettingsBytes / 1024} KB.`);
            await mkdir(join(userData, 'addonSettings'), { recursive: true });
            const temporaryPath = `${path}.${uuidFactory()}.tmp`;
            await writeFile(temporaryPath, text, { mode: 0o600 });
            try {
                await rename(temporaryPath, path);
            } catch (error) {
                await unlink(temporaryPath).catch(() => {});
                throw error;
            }
        },
        async remove(addonId) {
            await rm(addonSettingsPath(userData, addonId), { force: true });
        }
    });
}
