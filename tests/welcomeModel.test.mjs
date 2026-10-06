/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { featuredLabel, onRampVisibleLimit, releaseNotesUrl, visibleEpisodes, welcomeLinks, welcomeSectionOrder, whatsNewFor } from '../src/welcomeModel.mjs';

test('the page always has its core sections, in order, and nothing conditional until it has content', () => {
    assert.deepEqual(welcomeSectionOrder(), ['heading', 'status', 'onRamp', 'community', 'footer']);
});

test('conditional sections slot into their place, with the On-Ramp between Featured and More to watch', () => {
    assert.deepEqual(welcomeSectionOrder({ hasRecommended: true, hasWhatsNew: true, hasFeatured: true, hasMoreToWatch: true, hasPosts: true }),
        ['heading', 'status', 'recommended', 'whatsNew', 'featured', 'onRamp', 'moreToWatch', 'blog', 'community', 'footer']);
    assert.deepEqual(welcomeSectionOrder({ hasFeatured: true }), ['heading', 'status', 'featured', 'onRamp', 'community', 'footer']);
    assert.deepEqual(welcomeSectionOrder({ hasPosts: true }), ['heading', 'status', 'onRamp', 'blog', 'community', 'footer']);
});

test('whatever else appears, the On-Ramp is always present and always after Featured, never conditional', () => {
    for (let bits = 0; bits < 32; bits += 1) {
        const order = welcomeSectionOrder({
            hasRecommended: Boolean(bits & 1), hasWhatsNew: Boolean(bits & 2), hasFeatured: Boolean(bits & 4), hasMoreToWatch: Boolean(bits & 8), hasPosts: Boolean(bits & 16)
        });
        assert.ok(order.includes('onRamp'), `bits ${bits}`);
        assert.ok(order.indexOf('onRamp') > order.indexOf('status'));
        if (order.includes('featured')) assert.ok(order.indexOf('featured') < order.indexOf('onRamp'));
        if (order.includes('moreToWatch')) assert.ok(order.indexOf('moreToWatch') > order.indexOf('onRamp'));
        assert.equal(order[0], 'heading');
        assert.equal(order.at(-1), 'footer');
        assert.equal(order.at(-2), 'community');
    }
});

test('episodes are shown whole up to the limit, and a longer series hides only the tail, in order', () => {
    const episodes = Array.from({ length: 6 }, (_, index) => ({ videoId: `ep${index + 1}` }));
    assert.deepEqual(visibleEpisodes(episodes), { shown: episodes, hidden: 0 });
    const long = Array.from({ length: 11 }, (_, index) => ({ videoId: `ep${index + 1}` }));
    const collapsed = visibleEpisodes(long);
    assert.equal(onRampVisibleLimit, 8);
    assert.deepEqual(collapsed.shown.map((entry) => entry.videoId), ['ep1', 'ep2', 'ep3', 'ep4', 'ep5', 'ep6', 'ep7', 'ep8']);
    assert.equal(collapsed.hidden, 3);
    assert.deepEqual(visibleEpisodes(long, true), { shown: long, hidden: 0 });
    assert.deepEqual(visibleEpisodes(long.slice(0, 8)), { shown: long.slice(0, 8), hidden: 0 }, 'exactly the limit needs no "Show all"');
    assert.equal(visibleEpisodes(long.slice(0, 9)).hidden, 1);
});

test('paid items are labelled as such, and the other kinds get plain labels', () => {
    assert.equal(featuredLabel('sponsored'), 'Sponsored');
    assert.equal(featuredLabel('video'), 'New video');
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
});

test('the page model imports nothing but the Node-free version comparison', async () => {
    const source = await readFile(new URL('../src/welcomeModel.mjs', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((match) => match[1]);
    assert.deepEqual(imports, ['./versionCompare.mjs']);
    const compare = await readFile(new URL('../src/versionCompare.mjs', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s/m.test(compare), 'versionCompare.mjs must import nothing');
});
