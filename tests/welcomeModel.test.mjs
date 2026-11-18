/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { featuredLabel, releaseNotesUrl, suggestedTutorialCount, suggestedTutorials, watchLibrary, watchVisibleLimit, welcomeLinks, welcomeSectionOrder, whatsNewFor } from '../src/welcomeModel.mjs';

test('the page always has its core sections, in order, and nothing conditional until it has content', () => {
    assert.deepEqual(welcomeSectionOrder(), ['heading', 'status', 'learn', 'community', 'footer']);
});

test('conditional sections slot into their place, with Learn by doing between the highlight and the videos', () => {
    assert.deepEqual(welcomeSectionOrder({ hasRecommended: true, hasWhatsNew: true, hasHighlight: true, hasVideos: true, hasPosts: true }),
        ['heading', 'status', 'recommended', 'whatsNew', 'highlight', 'learn', 'watch', 'blog', 'community', 'footer']);
    assert.deepEqual(welcomeSectionOrder({ hasHighlight: true }), ['heading', 'status', 'highlight', 'learn', 'community', 'footer']);
    assert.deepEqual(welcomeSectionOrder({ hasPosts: true }), ['heading', 'status', 'learn', 'blog', 'community', 'footer']);
});

test('whatever else appears, Learn by doing is always there, after the highlight and before the videos', () => {
    for (let bits = 0; bits < 32; bits += 1) {
        const order = welcomeSectionOrder({
            hasRecommended: Boolean(bits & 1), hasWhatsNew: Boolean(bits & 2), hasHighlight: Boolean(bits & 4), hasVideos: Boolean(bits & 8), hasPosts: Boolean(bits & 16)
        });
        assert.ok(order.includes('learn'), `bits ${bits}`);
        if (order.includes('highlight')) assert.ok(order.indexOf('highlight') < order.indexOf('learn'));
        if (order.includes('watch')) assert.ok(order.indexOf('watch') > order.indexOf('learn'));
        assert.equal(order[0], 'heading');
        assert.equal(order.at(-1), 'footer');
        assert.equal(order.at(-2), 'community');
    }
});

const groups = [
    { id: 'start', title: 'Start here', tutorials: [{ id: 'firstModel', title: 'First' }] },
    { id: 'modelling', title: 'Modelling', tutorials: [{ id: 'm1', title: 'M1' }, { id: 'm2', title: 'M2' }] },
    { id: 'data', title: 'Data and twins', tutorials: [{ id: 'd1', title: 'D1' }] }
];

test('Learn by doing suggests the next tutorials not done, in the list\'s order, first-model tour first', () => {
    const fresh = suggestedTutorials(groups);
    assert.equal(suggestedTutorialCount, 3);
    assert.deepEqual(fresh.suggested.map((tutorial) => tutorial.id), ['firstModel', 'm1', 'm2']);
    assert.equal(fresh.suggested[1].areaTitle, 'Modelling');
    assert.deepEqual([fresh.total, fresh.completed], [4, 0]);
    const along = suggestedTutorials(groups, ['firstModel', 'm2', 'not a tutorial']);
    assert.deepEqual(along.suggested.map((tutorial) => tutorial.id), ['m1', 'd1'], 'done ones drop out, and fewer than three is fine');
    assert.equal(along.completed, 2, 'an id no longer in the list is not counted');
    assert.deepEqual(suggestedTutorials(groups, ['firstModel', 'm1', 'm2', 'd1']).suggested, [], 'all done');
});

const onRamp = { playlistUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLx', episodes: [{ videoId: 'aaaaaaaaaaa' }, { videoId: 'bbbbbbbbbbb' }] };
const videos = (count) => Array.from({ length: count }, (_, index) => ({ videoId: `video${String(index).padStart(6, '0')}`, title: `Video ${index}` }));

test('Watch lists the videos in the feed\'s order without the highlighted one, then the On-Ramp as one playlist card', () => {
    const { shown, hidden } = watchLibrary({ moreToWatch: videos(3), onRamp, highlightedVideoId: 'video000000' });
    assert.deepEqual(shown.map((card) => card.title), ['Video 1', 'Video 2', 'Konjugate On-Ramp: the 2-episode video series']);
    assert.equal(hidden, 0);
    assert.equal(shown[0].url, 'https://www.youtube.com/watch?v=video000001');
    assert.equal(shown.at(-1).playlist, true);
    assert.equal(shown.at(-1).url, onRamp.playlistUrl);
    assert.deepEqual(watchLibrary({ moreToWatch: [], onRamp: null }).shown, [], 'nothing to watch');
});

test('Watch shows a handful, with the rest behind Show all, in order', () => {
    assert.equal(watchVisibleLimit, 9);
    const collapsed = watchLibrary({ moreToWatch: videos(11), onRamp });
    assert.equal(collapsed.shown.length, 9);
    assert.equal(collapsed.hidden, 3);
    assert.equal(watchLibrary({ moreToWatch: videos(11), onRamp }, { expanded: true }).shown.length, 12);
    assert.equal(watchLibrary({ moreToWatch: videos(8), onRamp }).hidden, 0, 'exactly the limit needs no Show all');
});

test('paid items are labelled as such, and the other kinds get plain labels', () => {
    assert.equal(featuredLabel('sponsored'), 'Sponsored');
    assert.equal(featuredLabel('video'), 'New on the channel');
    assert.equal(featuredLabel('video', { playlist: true }), 'New playlist on the channel');
    assert.equal(featuredLabel('announcement', { playlist: true }), 'Announcement');
    assert.equal(featuredLabel('announcement'), 'Announcement');
    assert.equal(featuredLabel('anything else'), 'Announcement');
});

test('What\'s new appears only after an update, once, with the release notes link', () => {
    assert.equal(whatsNewFor({ running: '1.1.8', lastSeen: null }), null, 'a first launch is not an update');
    assert.equal(whatsNewFor({ running: '1.1.8', lastSeen: '1.1.8' }), null, 'already shown for this version');
    assert.equal(whatsNewFor({ running: '1.1.7', lastSeen: '1.1.8' }), null, 'a downgrade is not news');
    const news = whatsNewFor({ running: '1.2.0', lastSeen: '1.1.8', highlights: ['A', '  ', 7, 'B'] });
    assert.deepEqual(news, { version: '1.2.0', previous: '1.1.8', highlights: ['A', 'B'], url: 'https://github.com/zenineasa/Konjugate/releases/tag/v1.2.0' });
    assert.equal(whatsNewFor({ running: '1.10.0', lastSeen: '1.9.9' }).version, '1.10.0', 'versions compare as numbers');
    assert.equal(whatsNewFor({ running: '1.2.0', lastSeen: '1.1.8', highlights: Array.from({ length: 9 }, (_, index) => `line ${index}`) }).highlights.length, 5);
});

test('the fixed links point at Konjugate\'s own places', () => {
    for (const url of [welcomeLinks.documentation, welcomeLinks.reportProblem, welcomeLinks.allReleases, releaseNotesUrl('1.2.0')]) {
        assert.ok(url.startsWith('https://github.com/zenineasa/Konjugate/'), url);
    }
    assert.ok(welcomeLinks.discord.startsWith('https://discord.gg/'));
    assert.ok(welcomeLinks.whatsapp.startsWith('https://whatsapp.com/channel/'));
    assert.equal(welcomeLinks.youtubeChannel, 'https://www.youtube.com/@Konjugate');
});

test('the page model imports nothing but the Node-free version comparison', async () => {
    const source = await readFile(new URL('../src/welcomeModel.mjs', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((match) => match[1]);
    assert.deepEqual(imports, ['./versionCompare.mjs']);
    const compare = await readFile(new URL('../src/versionCompare.mjs', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s/m.test(compare), 'versionCompare.mjs must import nothing');
});
