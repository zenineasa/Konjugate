/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Welcome window is made of, and in what order, as plain data (docs/proposals/welcomeWindow.md).
// Imports only the Node-free version comparison, because the Welcome window is a web page.
import { isNewerVersion } from './versionCompare.mjs';

// How many videos the Watch section shows before a "Show all", and how many tutorials Learn by doing suggests.
export const watchVisibleLimit = 9;
export const suggestedTutorialCount = 3;

export const welcomeLinks = Object.freeze({
    discord: 'https://discord.gg/WPUzNyC3S',
    whatsapp: 'https://whatsapp.com/channel/0029Vb8dF8EKgsNs7dydEG1x',
    documentation: 'https://github.com/zenineasa/Konjugate/tree/master/docs',
    reportProblem: 'https://github.com/zenineasa/Konjugate/issues/new',
    allReleases: 'https://github.com/zenineasa/Konjugate/releases',
    youtubeChannel: 'https://www.youtube.com/@Konjugate'
});

export const releaseNotesUrl = (version) => `https://github.com/zenineasa/Konjugate/releases/tag/v${version}`;

// The sections of the page, top to bottom. The heading, the status line, Learn by doing, Community & help and the
// footer are always there; the rest appear only when they have something to show. Learn by doing comes before the
// videos: a tutorial ends with a model the person built, a video with one they watched being built.
export function welcomeSectionOrder({ hasRecommended = false, hasWhatsNew = false, hasHighlight = false, hasVideos = false, hasPosts = false } = {}) {
    return [
        'heading',
        'status',
        hasRecommended && 'recommended',
        hasWhatsNew && 'whatsNew',
        hasHighlight && 'highlight',
        'learn',
        hasVideos && 'watch',
        hasPosts && 'blog',
        'community',
        'footer'
    ].filter(Boolean);
}

// Learn by doing: the next tutorials not yet completed, in the order the Tutorials list gives them (Start here
// first, then each area in turn), so a new person is offered the first-model tour and someone further along
// the next thing they have not done. `groups` is groupTutorials()'s shape.
export function suggestedTutorials(groups, completed = [], count = suggestedTutorialCount) {
    const done = new Set(completed);
    const all = groups.flatMap((group) => group.tutorials.map((tutorial) => ({ ...tutorial, areaTitle: group.title })));
    return { suggested: all.filter((tutorial) => !done.has(tutorial.id)).slice(0, count), total: all.length, completed: all.filter((tutorial) => done.has(tutorial.id)).length };
}

// The Watch section: the feed's videos, newest first as the feed lists them, without the one the highlight above
// is showing, and the On-Ramp video series as one card for its playlist at the end. `limit` are shown, the rest
// behind a "Show all".
export function watchLibrary({ videos: feedVideos = [], onRamp = null, highlightedVideoId = null }, { expanded = false, limit = watchVisibleLimit } = {}) {
    const videos = feedVideos.filter((video) => video.videoId !== highlightedVideoId)
        .map((video) => ({ title: video.title, videoId: video.videoId, url: `https://www.youtube.com/watch?v=${video.videoId}`, thumbnailUrl: `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg` }));
    const first = onRamp?.episodes?.[0];
    if (onRamp?.playlistUrl && first) {
        videos.push({ title: `Konjugate On-Ramp: the ${onRamp.episodes.length}-episode video series`, url: onRamp.playlistUrl, thumbnailUrl: first.thumbnailUrl ?? `https://img.youtube.com/vi/${first.videoId}/hqdefault.jpg`, playlist: true });
    }
    if (expanded || videos.length <= limit) return { shown: videos, hidden: 0 };
    return { shown: videos.slice(0, limit), hidden: videos.length - limit };
}

// The small label on the highlight. Anything paid must say so. A video taking its turn may be any age, so it is
// not called new; a pinned one is there because it is.
export function highlightLabel(kind, { playlist = false, rotated = false } = {}) {
    if (kind === 'sponsored') return 'Sponsored';
    if (kind === 'video' && rotated) return 'From the channel';
    if (kind === 'video') return playlist ? 'New playlist on the channel' : 'New on the channel';
    return 'Announcement';
}

// The "What's new" block, once per version: only after an update (a stored last-seen version that is
// older than the running one). A first-ever launch has no last-seen version and is not an update, and
// a downgrade is not news. `highlights` is the optional short list authored for this version.
export function whatsNewFor({ running, lastSeen, highlights = [] }) {
    if (!lastSeen || !isNewerVersion(running, lastSeen)) return null;
    return { version: running, previous: lastSeen, highlights: highlights.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 5), url: releaseNotesUrl(running) };
}
