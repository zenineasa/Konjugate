/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    createWelcomeStateStore, emptyWelcomeState, normalizeWelcomeState, withEpisodeOpened, withHighlightShown, withLastSeenVersion, withTourCompleted, withTourOffered, withTutorialCompleted
} from '../src/welcomeStateStore.mjs';

async function withDirectory(run) {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateWelcome-'));
    try {
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('a fresh store is empty, and what is changed survives a restart', async () => {
    await withDirectory(async (directory) => {
        assert.deepEqual(await createWelcomeStateStore({ directory }).get(), emptyWelcomeState());
        await createWelcomeStateStore({ directory }).update((state) => withHighlightShown(withLastSeenVersion(state, '1.2.0'), 'launch'));
        const reopened = await createWelcomeStateStore({ directory }).get();
        assert.deepEqual(reopened.highlightShown, { launch: 1 });
        assert.equal(reopened.lastSeenVersion, '1.2.0');
    });
});

test('each change does what it says', () => {
    let state = emptyWelcomeState();
    state = withEpisodeOpened(state, 'eDHksSqKhFs');
    state = withEpisodeOpened(state, 'eDHksSqKhFs');
    assert.deepEqual(state.openedEpisodes, ['eDHksSqKhFs'], 'opening twice is one tick');
    state = withHighlightShown(withHighlightShown(withHighlightShown(state, 'a'), 'a'), 'b');
    assert.deepEqual(state.highlightShown, { a: 2, b: 1 });
    assert.equal(withLastSeenVersion(state, '1.3.0').lastSeenVersion, '1.3.0');
    assert.deepEqual(emptyWelcomeState(), { version: 1, highlightShown: {}, openedEpisodes: [], lastSeenVersion: null, tourOffered: false, tourCompleted: false, tutorialsCompleted: [] }, 'the original is untouched');
});

test('a damaged or wrong-version file means an empty state, never an error', async () => {
    await withDirectory(async (directory) => {
        const store = createWelcomeStateStore({ directory });
        const path = join(directory, 'welcomeState.json');
        for (const content of ['', 'not json', '[]', 'null', '{}', '{"version":2,"lastSeenVersion":"1.0.0"}', '{"version":"1"}']) {
            await writeFile(path, content);
            assert.deepEqual(await store.get(), emptyWelcomeState(), JSON.stringify(content));
        }
    });
});

test('the valid parts of a partly damaged file are kept', () => {
    const state = normalizeWelcomeState({
        version: 1, dismissedFeatured: ['a'], openedEpisodes: 'oops', highlightShown: { x: 3, y: -1, z: 1.5, w: '2', v: 1 }, lastSeenVersion: 7
    });
    assert.equal('dismissedFeatured' in state, false, 'a list from when highlights could be dismissed is dropped');
    assert.deepEqual(state.openedEpisodes, []);
    assert.deepEqual(state.highlightShown, { x: 3, v: 1 });
    assert.equal(state.lastSeenVersion, null);
    assert.deepEqual(normalizeWelcomeState({ version: 1, highlightShown: [1, 2] }).highlightShown, {});
    assert.deepEqual(normalizeWelcomeState({ version: 1, featuredShown: { launch: 2 } }).highlightShown, { launch: 2 }, 'counts kept under the old name carry over');
});

test('the lists are capped, keeping the most recent entries', () => {
    const opened = normalizeWelcomeState({ version: 1, openedEpisodes: Array.from({ length: 150 }, (_, index) => `ep${index}`) }).openedEpisodes;
    assert.equal(opened.length, 100);
    assert.equal(opened.at(-1), 'ep149');
    assert.equal(opened[0], 'ep50');
});

test('two changes made together both land, instead of one overwriting the other', async () => {
    await withDirectory(async (directory) => {
        const store = createWelcomeStateStore({ directory });
        await Promise.all([
            store.update((state) => withEpisodeOpened(state, 'eDHksSqKhFs')),
            store.update((state) => withHighlightShown(state, 'a')),
            store.update((state) => withHighlightShown(state, 'a')),
            store.update((state) => withLastSeenVersion(state, '1.2.0'))
        ]);
        const state = await store.get();
        assert.deepEqual(state.openedEpisodes, ['eDHksSqKhFs']);
        assert.deepEqual(state.highlightShown, { a: 2 });
        assert.equal(state.lastSeenVersion, '1.2.0');
    });
});

test('a change that throws is reported, and the next change still works', async () => {
    await withDirectory(async (directory) => {
        const store = createWelcomeStateStore({ directory });
        await assert.rejects(() => store.update(() => { throw new Error('boom'); }), /boom/);
        await store.update((state) => withHighlightShown(state, 'a'));
        assert.deepEqual((await store.get()).highlightShown, { a: 1 });
    });
});

test('the file is written whole, owner-only, and no temporary file is left', async () => {
    await withDirectory(async (directory) => {
        const store = createWelcomeStateStore({ directory: join(directory, 'new', 'folder'), uuidFactory: () => 'fixed' });
        await store.update((state) => withHighlightShown(state, 'a'));
        assert.deepEqual(await readdir(join(directory, 'new', 'folder')), ['welcomeState.json']);
        assert.deepEqual(JSON.parse(await readFile(join(directory, 'new', 'folder', 'welcomeState.json'), 'utf8')).highlightShown, { a: 1 });
    });
});

test('a directory is required', () => {
    assert.throws(() => createWelcomeStateStore(), /requires a directory/);
});

test('the tour is offered once, completing it counts as having been offered, and damaged flags read as not set', () => {
    assert.deepEqual([emptyWelcomeState().tourOffered, emptyWelcomeState().tourCompleted], [false, false]);
    const offered = withTourOffered(emptyWelcomeState());
    assert.deepEqual([offered.tourOffered, offered.tourCompleted], [true, false]);
    const completed = withTourCompleted(emptyWelcomeState());
    assert.deepEqual([completed.tourOffered, completed.tourCompleted], [true, true]);
    assert.equal(normalizeWelcomeState({ ...completed }).tourCompleted, true);
    assert.deepEqual([normalizeWelcomeState({ version: 1, tourOffered: 'yes' }).tourOffered, normalizeWelcomeState({ version: 1, tourCompleted: 1 }).tourCompleted], [false, false]);
});

test('finished tutorials are kept by id, once each, and the first-model tutorial and the tour are one', () => {
    let state = withTutorialCompleted(withTutorialCompleted(emptyWelcomeState(), 'calibrateTank'), 'calibrateTank');
    assert.deepEqual(state.tutorialsCompleted, ['calibrateTank']);
    assert.equal(state.tourCompleted, false, 'Another tutorial is not the tour.');
    state = withTutorialCompleted(state, 'firstModel');
    assert.deepEqual([state.tourOffered, state.tourCompleted], [true, true]);
    assert.deepEqual(withTourCompleted(emptyWelcomeState()).tutorialsCompleted, ['firstModel']);
    assert.deepEqual(normalizeWelcomeState({ version: 1, tourCompleted: true }).tutorialsCompleted, ['firstModel'], 'A tour finished before tutorials were kept by name counts.');
    assert.deepEqual(normalizeWelcomeState({ version: 1, tutorialsCompleted: ['a', 3, '', 'a', null, 'b'] }).tutorialsCompleted, ['a', 'b']);
    assert.deepEqual(normalizeWelcomeState({ version: 1, tutorialsCompleted: 'a' }).tutorialsCompleted, []);
});
