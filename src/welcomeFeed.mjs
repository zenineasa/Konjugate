/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Welcome window's Featured slot and "More to watch" row come from a small JSON file kept in this
// repository (welcome/featured.json), reviewed in git like the add-on registry: nothing promotional can
// appear or change without a commit, and an empty file switches it all off. This module validates that
// file strictly, picks what to show, and builds the URLs; the main process does the fetching, caching
// and image handling. See docs/proposals/welcomeWindow.md.
//
// No imports on purpose: everything here is pure, and it is tested without Electron.

export const feedFormat = 'konjugate-welcome-feed';
export const maxFeaturedItems = 10;
export const maxMoreToWatch = 12;
const maxFeedBytes = 64 * 1024;

const kinds = ['announcement', 'video', 'sponsored'];
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
// Images live in this repository, in welcome/images/, one file each, so they are reviewed with the item.
const imagePathPattern = /^welcome\/images\/[\w-][\w.-]*\.(png|jpe?g|webp)$/i;
const youtubeWatchPattern = /^https:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

function httpsUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
    } catch {
        return false;
    }
}

// A date or date-time as milliseconds, or NaN. A date alone means the start of that day in UTC.
function instant(value) {
    return typeof value === 'string' && isoPattern.test(value) ? Date.parse(value) : Number.NaN;
}

function featuredItem(raw) {
    if (!raw || typeof raw !== 'object') return 'is not an object';
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) return 'needs an id of letters, digits and dashes (at most 64 characters)';
    if (!kinds.includes(raw.kind)) return `needs a kind of ${kinds.join(', ')}`;
    if (!text(raw.title, 120)) return 'needs a title of at most 120 characters';
    if (raw.text !== undefined && !text(raw.text, 400)) return 'text, if present, must be 1 to 400 characters';
    if (!httpsUrl(raw.url)) return 'needs an https url';
    if (raw.kind === 'video' && !youtubeWatchPattern.test(raw.url)) return 'a video item needs a plain YouTube watch link';
    if (raw.image !== undefined && (typeof raw.image !== 'string' || !imagePathPattern.test(raw.image) || raw.image.includes('..'))) {
        return 'image, if present, must be a file in welcome/images/, e.g. "welcome/images/example.webp"';
    }
    for (const field of ['startsAt', 'endsAt']) {
        if (raw[field] !== undefined && Number.isNaN(instant(raw[field]))) return `${field}, if present, must be an ISO date such as 2026-11-01 or 2026-11-01T09:00:00Z`;
    }
    if (raw.startsAt !== undefined && raw.endsAt !== undefined && instant(raw.endsAt) <= instant(raw.startsAt)) return 'endsAt must be after startsAt';
    if (raw.maxLaunches !== undefined && !(Number.isInteger(raw.maxLaunches) && raw.maxLaunches > 0)) return 'maxLaunches, if present, must be a positive whole number';
    if (raw.priority !== undefined && !Number.isInteger(raw.priority)) return 'priority, if present, must be a whole number';
    return null;
}

// Validates the feed. A broken item is dropped with a reason, so one typo cannot take the rest down,
// and a feed that is not this format at all is treated as empty. Returns { featured, moreToWatch,
// problems }: normalized items, and a message for everything that was left out.
export function parseWelcomeFeed(raw) {
    if (!raw || typeof raw !== 'object' || raw.format !== feedFormat || raw.formatVersion !== 1) {
        return { featured: [], moreToWatch: [], problems: [`The feed is not a ${feedFormat} version 1 file.`] };
    }
    const problems = [];
    const featured = [];
    const ids = new Set();
    (Array.isArray(raw.featured) ? raw.featured : []).forEach((item, index) => {
        const problem = featuredItem(item);
        if (problem) return problems.push(`featured[${index}] ${problem}.`);
        if (ids.has(item.id)) return problems.push(`featured[${index}] repeats the id "${item.id}".`);
        if (featured.length >= maxFeaturedItems) return problems.push(`featured[${index}] is past the limit of ${maxFeaturedItems} items.`);
        ids.add(item.id);
        featured.push({
            id: item.id, kind: item.kind, title: item.title.trim(), text: item.text === undefined ? null : item.text.trim(),
            image: item.image ?? null, url: item.url,
            startsAt: item.startsAt === undefined ? null : instant(item.startsAt), endsAt: item.endsAt === undefined ? null : instant(item.endsAt),
            maxLaunches: item.maxLaunches ?? null, priority: item.priority ?? 0
        });
    });
    const moreToWatch = [];
    const videos = new Set();
    (Array.isArray(raw.moreToWatch) ? raw.moreToWatch : []).forEach((item, index) => {
        if (!item || typeof item.videoId !== 'string' || !videoIdPattern.test(item.videoId)) return problems.push(`moreToWatch[${index}] needs an 11-character YouTube videoId.`);
        if (!text(item.title, 120)) return problems.push(`moreToWatch[${index}] needs a title of at most 120 characters.`);
        if (videos.has(item.videoId)) return problems.push(`moreToWatch[${index}] repeats the video "${item.videoId}".`);
        if (moreToWatch.length >= maxMoreToWatch) return problems.push(`moreToWatch[${index}] is past the limit of ${maxMoreToWatch} items.`);
        videos.add(item.videoId);
        moreToWatch.push({ videoId: item.videoId, title: item.title.trim() });
    });
    return { featured, moreToWatch, problems };
}

// The one item to show now, or null. Eligible means: inside its start/end window, not dismissed, and
// shown on fewer launches than its cap. Highest priority wins; among equals, the one listed first.
// `shown` maps an item id to how many launches it has already been shown on.
export function selectFeatured({ items, now, dismissed = [], shown = {} }) {
    let best = null;
    for (const item of items) {
        if (item.startsAt !== null && now < item.startsAt) continue;
        if (item.endsAt !== null && now >= item.endsAt) continue;
        if (dismissed.includes(item.id)) continue;
        if (item.maxLaunches !== null && (shown[item.id] ?? 0) >= item.maxLaunches) continue;
        if (best === null || item.priority > best.priority) best = item;
    }
    return best;
}

// ---- Where the feed and its images come from

const defaultFeedUrl = 'https://raw.githubusercontent.com/zenineasa/Konjugate/master/welcome/featured.json';

// KONJUGATE_WELCOME_FEED_URL points the app at another copy of the feed (to try a promotion locally
// before committing it); images are then looked for next to it.
export function welcomeFeedUrl(env = globalThis.process?.env ?? {}) {
    return env.KONJUGATE_WELCOME_FEED_URL || defaultFeedUrl;
}

// The URL of an item's image, or null for anything that is not a file in welcome/images/. The feed
// sits in welcome/, so the repository root is one level up from it.
export function welcomeImageUrl(imagePath, feedUrl = welcomeFeedUrl()) {
    if (typeof imagePath !== 'string' || !imagePathPattern.test(imagePath) || imagePath.includes('..')) return null;
    return new URL(`../${imagePath}`, feedUrl).href;
}

// The raw feed JSON, or a thrown error (no network, a bad status, too large, not JSON).
export async function fetchWelcomeFeed({ fetchImpl = fetch, url = welcomeFeedUrl() } = {}) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`The feed returned ${response.status}`);
    const body = await response.text();
    if (body.length > maxFeedBytes) throw new Error('The feed is larger than 64 KB');
    return JSON.parse(body);
}
