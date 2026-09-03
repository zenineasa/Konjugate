/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRecentBlogPosts } from '../src/welcomeContent.mjs';

const realFeedItem = `<item>
<pubDate>Fri, 28 Aug 2026 10:06:13 +0000</pubDate>
<title>Scatter and distribution plots in the Results Analysis add-on</title>
<link>https://www.konjugate.com/2026/08/scatter-and-distribution-plots-in.html</link>
<media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="https://blogger.googleusercontent.com/img/a/example=s72-c" height="72" width="72"/>
</item>`;

const cdataItem = `<item>
<title><![CDATA[Tuning &amp; measured data]]></title>
<link>https://www.konjugate.com/2026/08/tuning.html</link>
</item>`;

const noThumbnailItem = `<item>
<title>Running Konjugate from the command line</title>
<link>https://www.konjugate.com/2026/08/running-konjugate-from-command-line.html</link>
</item>`;

function feedOf(...items) {
    return `<?xml version='1.0' encoding='UTF-8'?><rss><channel>${items.join('')}</channel></rss>`;
}

function fakeFetch(body, { ok = true, status = 200 } = {}) {
    return async () => ({ ok, status, statusText: 'status', text: async () => body });
}

test('parses title, link and an upsized thumbnail URL from a real-shaped feed item', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: fakeFetch(feedOf(realFeedItem)) });
    assert.deepEqual(posts, [{
        title: 'Scatter and distribution plots in the Results Analysis add-on',
        link: 'https://www.konjugate.com/2026/08/scatter-and-distribution-plots-in.html',
        thumbnailUrl: 'https://blogger.googleusercontent.com/img/a/example=s400-c'
    }]);
});

test('decodes CDATA and HTML entities in title/link', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: fakeFetch(feedOf(cdataItem)) });
    assert.equal(posts[0].title, 'Tuning & measured data');
    assert.equal(posts[0].link, 'https://www.konjugate.com/2026/08/tuning.html');
});

test('items without a media:thumbnail yield a null thumbnailUrl, not a crash', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: fakeFetch(feedOf(noThumbnailItem)) });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thumbnailUrl, null);
});

test('respects the limit option across multiple items', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: fakeFetch(feedOf(realFeedItem, cdataItem, noThumbnailItem)), limit: 2 });
    assert.equal(posts.length, 2);
});

test('a non-ok response yields an empty list, not a rejection', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: fakeFetch('', { ok: false, status: 500 }) });
    assert.deepEqual(posts, []);
});

test('a throwing fetch (network failure, timeout) yields an empty list, not a rejection', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: async () => { throw new Error('network down'); } });
    assert.deepEqual(posts, []);
});

test('malformed/empty XML yields an empty list, not a crash', async () => {
    const posts = await fetchRecentBlogPosts({ fetchImpl: fakeFetch('not xml at all') });
    assert.deepEqual(posts, []);
});
