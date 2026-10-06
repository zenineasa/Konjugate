/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fetchWelcomeFeed, maxFeaturedItems, maxMoreToWatch, parseWelcomeFeed, selectFeatured, welcomeFeedUrl, welcomeImageUrl } from '../src/welcomeFeed.mjs';

const item = (overrides = {}) => ({ id: 'launch', kind: 'announcement', title: 'Konjugate 2 is here', url: 'https://example.org/launch', ...overrides });
const feed = (featured = [], moreToWatch = []) => ({ format: 'konjugate-welcome-feed', formatVersion: 1, featured, moreToWatch });

// ---- Validation

test('a valid feed is accepted whole, with dates as instants and defaults filled in', () => {
    const result = parseWelcomeFeed(feed([
        item({ text: ' Read more. ', image: 'welcome/images/launch.webp', startsAt: '2026-11-01', endsAt: '2026-12-01T09:30:00Z', maxLaunches: 5, priority: 2 }),
        item({ id: 'plain' })
    ], [{ videoId: 'jiL0kP0VQvQ', title: ' A talk ' }]));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.featured[0], {
        id: 'launch', kind: 'announcement', title: 'Konjugate 2 is here', text: 'Read more.', image: 'welcome/images/launch.webp', url: 'https://example.org/launch',
        startsAt: Date.parse('2026-11-01T00:00:00Z'), endsAt: Date.parse('2026-12-01T09:30:00Z'), maxLaunches: 5, priority: 2
    });
    assert.deepEqual(result.featured[1], { id: 'plain', kind: 'announcement', title: 'Konjugate 2 is here', text: null, image: null, url: 'https://example.org/launch', startsAt: null, endsAt: null, maxLaunches: null, priority: 0 });
    assert.deepEqual(result.moreToWatch, [{ videoId: 'jiL0kP0VQvQ', title: 'A talk' }]);
});

test('anything that is not this format is an empty feed with a reason, never an error', () => {
    for (const raw of [null, undefined, 42, 'text', [], {}, { format: 'other', formatVersion: 1 }, { format: 'konjugate-welcome-feed', formatVersion: 2 }]) {
        const result = parseWelcomeFeed(raw);
        assert.deepEqual(result.featured, [], JSON.stringify(raw));
        assert.deepEqual(result.moreToWatch, []);
        assert.equal(result.problems.length, 1);
    }
});

test('a broken item is dropped with its reason and the others survive', () => {
    const result = parseWelcomeFeed(feed([item({ id: 'good' }), item({ id: 'bad', kind: 'advert' }), item({ id: 'also-good' })]));
    assert.deepEqual(result.featured.map((entry) => entry.id), ['good', 'also-good']);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /featured\[1\] needs a kind of announcement, video, sponsored/);
});

test('each rule on an item is enforced', () => {
    const bad = {
        'not an object': 'text', 'no id': { ...item(), id: undefined }, 'id with a space': item({ id: 'two words' }), 'id too long': item({ id: 'a'.repeat(65) }),
        'unknown kind': item({ kind: 'ad' }), 'no title': item({ title: '' }), 'long title': item({ title: 'x'.repeat(121) }), 'long text': item({ text: 'x'.repeat(401) }),
        'empty text': item({ text: '   ' }), 'http url': item({ url: 'http://example.org/x' }), 'javascript url': item({ url: 'javascript:alert(1)' }),
        'url with credentials': item({ url: 'https://user:pass@example.org/x' }), 'relative url': item({ url: '/x' }), 'long url': item({ url: `https://example.org/${'x'.repeat(2050)}` }),
        'video that is not youtube': item({ kind: 'video', url: 'https://vimeo.com/123456789' }),
        'video with a playlist': item({ kind: 'video', url: 'https://www.youtube.com/watch?v=jiL0kP0VQvQ&list=PLabc' }),
        'image elsewhere': item({ image: 'images/launch.webp' }), 'image outside the folder': item({ image: 'welcome/images/../secret.png' }),
        'image that is a url': item({ image: 'https://tracker.example/pixel.png' }), 'svg image': item({ image: 'welcome/images/a.svg' }), 'nested image': item({ image: 'welcome/images/a/b.png' }),
        'bad start': item({ startsAt: 'tomorrow' }), 'bad end': item({ endsAt: '2026-13-45' }), 'end before start': item({ startsAt: '2026-12-01', endsAt: '2026-11-01' }),
        'end equals start': item({ startsAt: '2026-12-01', endsAt: '2026-12-01' }), 'zero cap': item({ maxLaunches: 0 }), 'fractional cap': item({ maxLaunches: 2.5 }),
        'text cap': item({ maxLaunches: '3' }), 'fractional priority': item({ priority: 1.5 })
    };
    for (const [name, raw] of Object.entries(bad)) {
        const result = parseWelcomeFeed(feed([raw]));
        assert.deepEqual(result.featured, [], name);
        assert.equal(result.problems.length, 1, name);
    }
});

test('a YouTube video item is accepted in either link form', () => {
    for (const url of ['https://www.youtube.com/watch?v=jiL0kP0VQvQ', 'https://youtu.be/jiL0kP0VQvQ']) {
        assert.equal(parseWelcomeFeed(feed([item({ kind: 'video', url })])).featured.length, 1, url);
    }
});

test('repeated ids and videos are dropped, and the lists are capped', () => {
    const repeated = parseWelcomeFeed(feed([item({ id: 'same' }), item({ id: 'same' })], [{ videoId: 'jiL0kP0VQvQ', title: 'a' }, { videoId: 'jiL0kP0VQvQ', title: 'b' }]));
    assert.equal(repeated.featured.length, 1);
    assert.equal(repeated.moreToWatch.length, 1);
    assert.equal(repeated.problems.length, 2);
    const many = parseWelcomeFeed(feed(Array.from({ length: maxFeaturedItems + 3 }, (_, index) => item({ id: `item-${index}` })),
        Array.from({ length: maxMoreToWatch + 3 }, (_, index) => ({ videoId: `${String(index).padStart(11, 'a')}`, title: `v${index}` }))));
    assert.equal(many.featured.length, maxFeaturedItems);
    assert.equal(many.moreToWatch.length, maxMoreToWatch);
    assert.equal(many.problems.length, 6);
});

test('More to watch items need an 11-character video id and a title', () => {
    const result = parseWelcomeFeed(feed([], [{ videoId: 'short', title: 'x' }, { videoId: 'jiL0kP0VQvQ', title: '' }, { videoId: 'jiL0kP0VQ!Q', title: 'x' }, null, { videoId: 'jiL0kP0VQvQ', title: 'ok' }]));
    assert.deepEqual(result.moreToWatch, [{ videoId: 'jiL0kP0VQvQ', title: 'ok' }]);
    assert.equal(result.problems.length, 4);
});

test('missing lists are fine, and a feed with neither is simply empty', () => {
    const result = parseWelcomeFeed({ format: 'konjugate-welcome-feed', formatVersion: 1 });
    assert.deepEqual(result, { featured: [], moreToWatch: [], problems: [] });
});

// ---- Choosing what to show

const parsed = (...items) => parseWelcomeFeed(feed(items)).featured;
const day = (text) => Date.parse(`${text}T00:00:00Z`);

test('nothing is shown when there is nothing eligible', () => {
    assert.equal(selectFeatured({ items: [], now: 0 }), null);
});

test('an item is shown only inside its window, and a window with no dates is always open', () => {
    const items = parsed(item({ startsAt: '2026-11-01', endsAt: '2026-12-01' }));
    assert.equal(selectFeatured({ items, now: day('2026-10-31') }), null, 'not yet');
    assert.equal(selectFeatured({ items, now: day('2026-11-01') })?.id, 'launch', 'from the first instant');
    assert.equal(selectFeatured({ items, now: day('2026-11-30') })?.id, 'launch');
    assert.equal(selectFeatured({ items, now: day('2026-12-01') }), null, 'the end is exclusive');
    assert.equal(selectFeatured({ items: parsed(item()), now: 1 })?.id, 'launch');
});

test('a dismissed item is never shown, and a capped item stops at its cap', () => {
    const items = parsed(item({ maxLaunches: 3 }));
    assert.equal(selectFeatured({ items, now: 1, dismissed: ['launch'] }), null);
    assert.equal(selectFeatured({ items, now: 1, shown: { launch: 2 } })?.id, 'launch');
    assert.equal(selectFeatured({ items, now: 1, shown: { launch: 3 } }), null);
    assert.equal(selectFeatured({ items, now: 1, shown: { other: 99 } })?.id, 'launch');
});

test('the highest priority wins, and ties go to the item listed first', () => {
    const items = parsed(item({ id: 'a' }), item({ id: 'b', priority: 5 }), item({ id: 'c', priority: 5 }), item({ id: 'd', priority: -1 }));
    assert.equal(selectFeatured({ items, now: 1 }).id, 'b');
    assert.equal(selectFeatured({ items, now: 1, dismissed: ['b'] }).id, 'c');
    assert.equal(selectFeatured({ items, now: 1, dismissed: ['b', 'c'] }).id, 'a');
    assert.equal(selectFeatured({ items, now: 1, dismissed: ['a', 'b', 'c'] }).id, 'd');
});

// ---- Where things come from

test('the feed comes from the repository unless a local copy is named', () => {
    assert.equal(welcomeFeedUrl({}), 'https://raw.githubusercontent.com/zenineasa/Konjugate/master/welcome/featured.json');
    assert.equal(welcomeFeedUrl({ KONJUGATE_WELCOME_FEED_URL: 'http://localhost:8123/welcome/featured.json' }), 'http://localhost:8123/welcome/featured.json');
});

test('an image is looked for next to the feed, and only inside welcome/images/', () => {
    assert.equal(welcomeImageUrl('welcome/images/launch.webp', 'https://raw.githubusercontent.com/zenineasa/Konjugate/master/welcome/featured.json'),
        'https://raw.githubusercontent.com/zenineasa/Konjugate/master/welcome/images/launch.webp');
    assert.equal(welcomeImageUrl('welcome/images/launch.png', 'http://localhost:8123/welcome/featured.json'), 'http://localhost:8123/welcome/images/launch.png');
    for (const bad of ['images/launch.webp', 'welcome/images/../x.png', 'https://evil.example/x.png', '/etc/passwd', 'welcome/images/a.svg', '', null, undefined, 42]) {
        assert.equal(welcomeImageUrl(bad), null, String(bad));
    }
});

test('fetchWelcomeFeed returns the JSON, with a timeout, and throws on a bad status, size or syntax', async () => {
    const reply = (body, ok = true, status = 200) => async (url, options) => ({ ok, status, text: async () => body, url, options });
    const good = JSON.stringify(feed([item()]));
    let seen;
    const result = await fetchWelcomeFeed({ fetchImpl: async (url, options) => { seen = { url, options }; return reply(good)(url, options); }, url: 'https://example.test/feed.json' });
    assert.equal(result.featured.length, 1);
    assert.equal(seen.url, 'https://example.test/feed.json');
    assert.ok(seen.options.signal, 'the request has a timeout');
    await assert.rejects(() => fetchWelcomeFeed({ fetchImpl: reply('', false, 404), url: 'x' }), /404/);
    await assert.rejects(() => fetchWelcomeFeed({ fetchImpl: reply('x'.repeat(70000)), url: 'x' }), /larger than 64 KB/);
    await assert.rejects(() => fetchWelcomeFeed({ fetchImpl: reply('not json'), url: 'x' }), SyntaxError);
});

test('the module imports nothing, so it can be tested and reasoned about on its own', async () => {
    const source = await readFile(new URL('../src/welcomeFeed.mjs', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s/m.test(source));
});
