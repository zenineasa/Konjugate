/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const welcomeStateVersion = 1;
const maxDismissed = 200;
const maxOpenedEpisodes = 100;
const maxShownEntries = 200;

export const emptyWelcomeState = () => ({ version: welcomeStateVersion, dismissedFeatured: [], featuredShown: {}, openedEpisodes: [], lastSeenVersion: null });

const strings = (value, max) => (Array.isArray(value) ? [...new Set(value.filter((entry) => typeof entry === 'string' && entry !== ''))].slice(-max) : []);

// Keeps whatever part of a stored file is valid and drops the rest, so a damaged or older file costs
// at most the damaged part, never a failure. Used on every read and write.
export function normalizeWelcomeState(raw) {
    const state = emptyWelcomeState();
    if (!raw || typeof raw !== 'object' || raw.version !== welcomeStateVersion) return state;
    state.dismissedFeatured = strings(raw.dismissedFeatured, maxDismissed);
    state.openedEpisodes = strings(raw.openedEpisodes, maxOpenedEpisodes);
    if (raw.featuredShown && typeof raw.featuredShown === 'object' && !Array.isArray(raw.featuredShown)) {
        for (const [id, count] of Object.entries(raw.featuredShown).slice(-maxShownEntries)) {
            if (Number.isInteger(count) && count > 0) state.featuredShown[id] = count;
        }
    }
    if (typeof raw.lastSeenVersion === 'string' && raw.lastSeenVersion !== '') state.lastSeenVersion = raw.lastSeenVersion;
    return state;
}

// ---- Changes, as pure functions from a state to a new state

export const withDismissed = (state, id) => ({ ...state, dismissedFeatured: strings([...state.dismissedFeatured, id], maxDismissed) });
export const withEpisodeOpened = (state, videoId) => ({ ...state, openedEpisodes: strings([...state.openedEpisodes, videoId], maxOpenedEpisodes) });
export const withFeaturedShown = (state, id) => ({ ...state, featuredShown: { ...state.featuredShown, [id]: (state.featuredShown[id] ?? 0) + 1 } });
export const withLastSeenVersion = (state, version) => ({ ...state, lastSeenVersion: version });

// What the Welcome window remembers between launches, in one small file in the user data folder: which
// Featured items were dismissed, how many launches each has been shown on, which tutorial episodes
// were opened, and the last version whose "What's new" was shown. It stays on this computer and
// identifies no one. Updates are applied one after another, so two changes made close together cannot
// overwrite each other.
export function createWelcomeStateStore({ directory, uuidFactory = randomUUID } = {}) {
    if (!directory) throw new Error('The Welcome state store requires a directory.');
    const path = join(directory, 'welcomeState.json');
    let queue = Promise.resolve();

    async function read() {
        try {
            return normalizeWelcomeState(JSON.parse(await readFile(path, 'utf8')));
        } catch {
            return emptyWelcomeState();
        }
    }

    async function write(state) {
        await mkdir(directory, { recursive: true });
        const temporaryPath = `${path}.${uuidFactory()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
        try {
            await rename(temporaryPath, path);
        } catch (error) {
            await unlink(temporaryPath).catch(() => {});
            throw error;
        }
    }

    return {
        get: read,

        // `change` takes the current state and returns the new one (the withX functions above).
        update(change) {
            const run = queue.then(async () => {
                const next = normalizeWelcomeState(change(await read()));
                await write(next);
                return next;
            });
            queue = run.catch(() => {});
            return run;
        }
    };
}
