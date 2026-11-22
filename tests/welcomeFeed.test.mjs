/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fetchWelcomeFeed, highlightById, maxPinnedItems, maxVideos, parseWelcomeFeed, selectPinned, selectHighlight, welcomeFeedUrl, welcomeImageUrl } from '../src/welcomeFeed.mjs';

const item = (overrides = {}) => ({ id: 'launch', kind: 'announcement', title: 'Konjugate 2 is here', url: 'https://example.org/launch', ...overrides });
const feed = (featured = [], moreToWatch = []) => ({ format: 'konjugate-welcome-feed', formatVersion: 1, featured, moreToWatch });

// ---- Validation

test('a valid feed is accepted whole, with dates as instants and defaults filled in', () => {
    const result = parseWelcomeFeed(feed([
        item({ text: ' Read more. ', image: 'welcome/images/launch.webp', startsAt: '2026-11-01', endsAt: '2026-12-01T09:30:00Z', maxLaunches: 5, priority: 2 }),
        item({ id: 'plain' })
    ], [{ videoId: 'jiL0kP0VQvQ', title: ' A talk ' }]));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.pinned[0], {
        id: 'launch', kind: 'announcement', title: 'Konjugate 2 is here', text: 'Read more.', image: 'welcome/images/launch.webp', url: 'https://example.org/launch',
        startsAt: Date.parse('2026-11-01T00:00:00Z'), endsAt: Date.parse('2026-12-01T09:30:00Z'), maxLaunches: 5, priority: 2, thumbnailVideoId: null, playlist: false
    });
    assert.deepEqual(result.pinned[1], { id: 'plain', kind: 'announcement', title: 'Konjugate 2 is here', text: null, image: null, url: 'https://example.org/launch', startsAt: null, endsAt: null, maxLaunches: null, thumbnailVideoId: null, playlist: false, priority: 0 });
    assert.deepEqual(result.videos, [{ videoId: 'jiL0kP0VQvQ', title: 'A talk', text: null }]);
});

test('anything that is not this format is an empty feed with a reason, never an error', () => {
    for (const raw of [null, undefined, 42, 'text', [], {}, { format: 'other', formatVersion: 1 }, { format: 'konjugate-welcome-feed', formatVersion: 2 }]) {
        const result = parseWelcomeFeed(raw);
        assert.deepEqual(result.pinned, [], JSON.stringify(raw));
        assert.deepEqual(result.videos, []);
        assert.equal(result.problems.length, 1);
    }
});

test('a broken item is dropped with its reason and the others survive', () => {
    const result = parseWelcomeFeed(feed([item({ id: 'good' }), item({ id: 'bad', kind: 'advert' }), item({ id: 'also-good' })]));
    assert.deepEqual(result.pinned.map((entry) => entry.id), ['good', 'also-good']);
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
        'playlist with no thumbnail video': item({ kind: 'video', url: 'https://www.youtube.com/playlist?list=PLZdhU2VSi7Q0' }),
        'playlist with a bad thumbnail video': item({ kind: 'video', url: 'https://www.youtube.com/playlist?list=PLZdhU2VSi7Q0', thumbnailVideoId: 'short' }),
        'thumbnail video on an announcement': item({ kind: 'announcement', thumbnailVideoId: 'jiL0kP0VQvQ' }),
        'thumbnail video that is not an id': item({ kind: 'video', url: 'https://youtu.be/jiL0kP0VQvQ', thumbnailVideoId: 'jiL0kP0VQ!Q' }),
        'image elsewhere': item({ image: 'images/launch.webp' }), 'image outside the folder': item({ image: 'welcome/images/../secret.png' }),
        'image that is a url': item({ image: 'https://tracker.example/pixel.png' }), 'svg image': item({ image: 'welcome/images/a.svg' }), 'nested image': item({ image: 'welcome/images/a/b.png' }),
        'bad start': item({ startsAt: 'tomorrow' }), 'bad end': item({ endsAt: '2026-13-45' }), 'end before start': item({ startsAt: '2026-12-01', endsAt: '2026-11-01' }),
        'end equals start': item({ startsAt: '2026-12-01', endsAt: '2026-12-01' }), 'zero cap': item({ maxLaunches: 0 }), 'fractional cap': item({ maxLaunches: 2.5 }),
        'text cap': item({ maxLaunches: '3' }), 'fractional priority': item({ priority: 1.5 })
    };
    for (const [name, raw] of Object.entries(bad)) {
        const result = parseWelcomeFeed(feed([raw]));
        assert.deepEqual(result.pinned, [], name);
        assert.equal(result.problems.length, 1, name);
    }
});

test('a YouTube video item is accepted in either link form', () => {
    for (const url of ['https://www.youtube.com/watch?v=jiL0kP0VQvQ', 'https://youtu.be/jiL0kP0VQvQ']) {
        assert.equal(parseWelcomeFeed(feed([item({ kind: 'video', url })])).pinned.length, 1, url);
    }
});

test('a video item shows its own thumbnail, and a playlist item the one it names', () => {
    const [watched] = parseWelcomeFeed(feed([item({ kind: 'video', url: 'https://youtu.be/jiL0kP0VQvQ' })])).pinned;
    assert.equal(watched.thumbnailVideoId, 'jiL0kP0VQvQ');
    assert.equal(watched.playlist, false);
    const [playlist] = parseWelcomeFeed(feed([item({ kind: 'video', url: 'https://www.youtube.com/playlist?list=PLZdhU2VSi7Q0', thumbnailVideoId: 'X8D1G_xipbI' })])).pinned;
    assert.equal(playlist.thumbnailVideoId, 'X8D1G_xipbI');
    assert.equal(playlist.playlist, true);
    const [announcement] = parseWelcomeFeed(feed([item()])).pinned;
    assert.equal(announcement.thumbnailVideoId, null);
    assert.equal(announcement.playlist, false);
});

test('repeated ids and videos are dropped, and the lists are capped', () => {
    const repeated = parseWelcomeFeed(feed([item({ id: 'same' }), item({ id: 'same' })], [{ videoId: 'jiL0kP0VQvQ', title: 'a' }, { videoId: 'jiL0kP0VQvQ', title: 'b' }]));
    assert.equal(repeated.pinned.length, 1);
    assert.equal(repeated.videos.length, 1);
    assert.equal(repeated.problems.length, 2);
    const many = parseWelcomeFeed(feed(Array.from({ length: maxPinnedItems + 3 }, (_, index) => item({ id: `item-${index}` })),
        Array.from({ length: maxVideos + 3 }, (_, index) => ({ videoId: `${String(index).padStart(11, 'a')}`, title: `v${index}` }))));
    assert.equal(many.pinned.length, maxPinnedItems);
    assert.equal(many.videos.length, maxVideos);
    assert.equal(many.problems.length, 6);
});

test('videos need an 11-character video id and a title, and may have a short text', () => {
    const result = parseWelcomeFeed(feed([], [{ videoId: 'short', title: 'x' }, { videoId: 'jiL0kP0VQvQ', title: '' }, { videoId: 'jiL0kP0VQ!Q', title: 'x' }, null,
        { videoId: 'jiL0kP0VQvQ', title: 'x', text: '' }, { videoId: 'jiL0kP0VQvQ', title: 'ok' }, { videoId: 'kiL0kP0VQvQ', title: 'told', text: ' What it is. ' }]));
    assert.deepEqual(result.videos, [{ videoId: 'jiL0kP0VQvQ', title: 'ok', text: null }, { videoId: 'kiL0kP0VQvQ', title: 'told', text: 'What it is.' }]);
    assert.equal(result.problems.length, 5);
    assert.match(result.problems[4], /moreToWatch\[4\] text/, 'problems name the list as the file does');
});

test('missing lists are fine, and a feed with neither is simply empty', () => {
    const result = parseWelcomeFeed({ format: 'konjugate-welcome-feed', formatVersion: 1 });
    assert.deepEqual(result, { pinned: [], videos: [], problems: [] });
});

// ---- Choosing what to show

const parsed = (...items) => parseWelcomeFeed(feed(items)).pinned;
const day = (text) => Date.parse(`${text}T00:00:00Z`);

test('nothing is shown when there is nothing eligible', () => {
    assert.equal(selectPinned({ items: [], now: 0 }), null);
});

test('an item is shown only inside its window, and a window with no dates is always open', () => {
    const items = parsed(item({ startsAt: '2026-11-01', endsAt: '2026-12-01' }));
    assert.equal(selectPinned({ items, now: day('2026-10-31') }), null, 'not yet');
    assert.equal(selectPinned({ items, now: day('2026-11-01') })?.id, 'launch', 'from the first instant');
    assert.equal(selectPinned({ items, now: day('2026-11-30') })?.id, 'launch');
    assert.equal(selectPinned({ items, now: day('2026-12-01') }), null, 'the end is exclusive');
    assert.equal(selectPinned({ items: parsed(item()), now: 1 })?.id, 'launch');
});

test('a watched video leaves the highlight, nothing else is removed by being opened, and a capped item stops at its cap', () => {
    const video = parsed(item({ id: 'clip', kind: 'video', url: 'https://www.youtube.com/watch?v=abcdefghijk' }), item({ id: 'next', kind: 'video', url: 'https://youtu.be/bcdefghijkl' }));
    assert.equal(selectPinned({ items: video, now: 1 }).id, 'clip');
    assert.equal(selectPinned({ items: video, now: 1, opened: ['abcdefghijk'] }).id, 'next', 'once watched, the next one is highlighted');
    assert.equal(selectPinned({ items: video, now: 1, opened: ['abcdefghijk', 'bcdefghijkl'] }), null);
    const playlist = parsed(item({ id: 'series', kind: 'video', url: 'https://www.youtube.com/playlist?list=PLabcdefghij', thumbnailVideoId: 'abcdefghijk' }));
    assert.equal(selectPinned({ items: playlist, now: 1, opened: ['abcdefghijk'] }).id, 'series', 'one video watched is not the whole playlist');
    assert.equal(selectPinned({ items: parsed(item()), now: 1, opened: ['abcdefghijk'] }).id, 'launch', 'an announcement has no video to watch');
    const items = parsed(item({ maxLaunches: 3 }));
    assert.equal(selectPinned({ items, now: 1, shown: { launch: 2 } })?.id, 'launch');
    assert.equal(selectPinned({ items, now: 1, shown: { launch: 3 } }), null);
    assert.equal(selectPinned({ items, now: 1, shown: { other: 99 } })?.id, 'launch');
});

test('the highest priority wins, and ties go to the item listed first', () => {
    const items = parsed(item({ id: 'a' }), item({ id: 'b', priority: 5 }), item({ id: 'c', priority: 5 }), item({ id: 'd', priority: -1 }));
    assert.equal(selectPinned({ items, now: 1 }).id, 'b');
    const capped = parsed(item({ id: 'a' }), item({ id: 'b', priority: 5, maxLaunches: 1 }), item({ id: 'c', priority: 5 }), item({ id: 'd', priority: -1 }));
    assert.equal(selectPinned({ items: capped, now: 1, shown: { b: 1 } }).id, 'c');
    assert.equal(selectPinned({ items: parsed(item({ id: 'a' }), item({ id: 'd', priority: -1 })), now: 1 }).id, 'a');
});

const list = (...ids) => parseWelcomeFeed(feed([], ids.map((videoId) => ({ videoId, title: `Video ${videoId}` })))).videos;

test('with nothing pinned, the videos take turns, newest first, one step on per launch shown', () => {
    const videos = list('aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc');
    assert.deepEqual(selectHighlight({ videos, now: 1 }), {
        id: 'video-aaaaaaaaaaa', kind: 'video', title: 'Video aaaaaaaaaaa', text: null, image: null, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        thumbnailVideoId: 'aaaaaaaaaaa', playlist: false, rotated: true
    }, 'the newest goes first, shaped like a pinned video');
    const shown = {};
    const turns = [];
    for (let launch = 0; launch < 6; launch += 1) {
        const { id } = selectHighlight({ videos, now: 1, shown });
        turns.push(id.slice('video-'.length, 'video-'.length + 1));
        shown[id] = (shown[id] ?? 0) + 1;
    }
    assert.deepEqual(turns, ['a', 'b', 'c', 'a', 'b', 'c']);
    const added = list('ddddddddddd', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc');
    assert.equal(selectHighlight({ videos: added, now: 1, shown }).id, 'video-ddddddddddd', 'a video just added comes up next');
    assert.equal(selectHighlight({ videos: [], now: 1 }), null);
});

test('opened videos sit out until every one is opened, and a pinned item goes ahead of them all', () => {
    const videos = list('aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc');
    assert.equal(selectHighlight({ videos, now: 1, opened: ['aaaaaaaaaaa'] }).id, 'video-bbbbbbbbbbb');
    assert.equal(selectHighlight({ videos, now: 1, opened: ['aaaaaaaaaaa', 'bbbbbbbbbbb'], shown: { 'video-ccccccccccc': 9 } }).id, 'video-ccccccccccc', 'however often it has been shown');
    const all = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'];
    assert.equal(selectHighlight({ videos, now: 1, opened: all, shown: { 'video-aaaaaaaaaaa': 1 } }).id, 'video-bbbbbbbbbbb', 'all opened: they take turns again');
    const pinned = parsed(item({ endsAt: '2026-12-01' }));
    assert.equal(selectHighlight({ pinned, videos, now: day('2026-11-01') }).id, 'launch');
    assert.equal(selectHighlight({ pinned, videos, now: day('2026-12-01') }).id, 'video-aaaaaaaaaaa', 'and once it ages out, the videos have the slot back');
});

test('a highlight is found by its id, pinned or a video, so the page can open it by id alone', () => {
    const feedItems = { pinned: parsed(item()), videos: list('aaaaaaaaaaa') };
    assert.equal(highlightById(feedItems, 'launch').url, 'https://example.org/launch');
    assert.equal(highlightById(feedItems, 'video-aaaaaaaaaaa').url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
    assert.equal(highlightById(feedItems, 'video-zzzzzzzzzzz'), null);
    assert.equal(highlightById(feedItems, 'aaaaaaaaaaa'), null);
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
    assert.equal(result.featured.length, 1, 'the raw file, as fetched');
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

test('the repository welcome/featured.json parses cleanly with no problems', async () => {
    const raw = JSON.parse(await readFile(new URL('../welcome/featured.json', import.meta.url), 'utf8'));
    const result = parseWelcomeFeed(raw);
    assert.deepEqual(result.problems, []);
    assert.ok(result.videos.length > 0, 'there are videos to take turns in the highlight');
    for (const pinned of result.pinned) assert.ok(pinned.endsAt !== null, `the pinned ${pinned.id} is given an end date, so it ages out`);
    assert.ok(Array.isArray(raw.moreToWatch), 'the videos stay under the name older installed copies read them by');
});
