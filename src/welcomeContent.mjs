/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Best-effort fetch of recent posts from Konjugate's own blog, for the Welcome window's "Recent
// from the blog" section. Mirrors src/updateCheck.mjs's findAvailableUpdate() shape (injectable
// fetchImpl for testing, timeout-bounded), but never rejects -- any failure (network, timeout, bad
// status, malformed feed) yields an empty list, so the section is silently absent rather than
// showing an error, the same posture the update checker already uses for its own network call.
//
// The feed is parsed with a small hand-rolled regex extractor rather than adding an XML/RSS
// dependency -- consistent with this codebase's existing hand-rolled-parser precedents (the
// exampleGuide markdown converter, the streaming binary protocol parser in engineProtocol.mjs).
// Confirmed directly against the live feed (not assumed): no <item> in the real feed uses CDATA
// today, but the unescape helper below still strips it defensively in case that ever changes; the
// <media:thumbnail> tag's `url` attribute is not first in its attribute list, so the extraction
// regex must not assume attribute order.

const feedUrl = 'https://www.konjugate.com/feeds/posts/default?alt=rss';

const itemPattern = /<item>([\s\S]*?)<\/item>/g;
const titlePattern = /<title>([\s\S]*?)<\/title>/;
const linkPattern = /<link>([\s\S]*?)<\/link>/;
const thumbnailPattern = /<media:thumbnail\b[^>]*\burl="([^"]+)"/;

function decodeEntities(value) {
    return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .trim();
}

// Blogger's own `=sNN-c` resize suffix (confirmed against the live feed's own thumbnail URLs) --
// swapped for a larger crop so "Recent from the blog" cards don't show a 72x72 postage stamp.
function upsizeThumbnail(url) {
    return url ? url.replace(/=s\d+-c$/, '=s400-c') : null;
}

function parseFeed(xml, limit) {
    const posts = [];
    for (const match of xml.matchAll(itemPattern)) {
        if (posts.length >= limit) break;
        const item = match[1];
        const title = titlePattern.exec(item)?.[1];
        const link = linkPattern.exec(item)?.[1];
        if (!title || !link) continue;
        posts.push({
            title: decodeEntities(title),
            link: decodeEntities(link),
            thumbnailUrl: upsizeThumbnail(thumbnailPattern.exec(item)?.[1] ?? null)
        });
    }
    return posts;
}

export async function fetchRecentBlogPosts({ fetchImpl = fetch, limit = 4 } = {}) {
    try {
        const response = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return [];
        return parseFeed(await response.text(), limit);
    } catch {
        return [];
    }
}
