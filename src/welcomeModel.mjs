/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Welcome window is made of, and in what order, as plain data (docs/proposals/welcomeWindow.md).
// Imports only the Node-free version comparison, because the Welcome window is a web page.
import { isNewerVersion } from './versionCompare.mjs';

export const onRampVisibleLimit = 8;

export const welcomeLinks = Object.freeze({
    discord: 'https://discord.gg/WPUzNyC3S',
    documentation: 'https://github.com/zenineasa/Konjugate/tree/master/docs',
    reportProblem: 'https://github.com/zenineasa/Konjugate/issues/new',
    allReleases: 'https://github.com/zenineasa/Konjugate/releases'
});

export const releaseNotesUrl = (version) => `https://github.com/zenineasa/Konjugate/releases/tag/v${version}`;

// The sections of the page, top to bottom. The heading, the status line, the On-Ramp, Community & help
// and the footer are always there; the rest appear only when they have something to show. The On-Ramp
// is never conditional and never reordered relative to the sections around it: it is the tutorial.
export function welcomeSectionOrder({ hasRecommended = false, hasWhatsNew = false, hasFeatured = false, hasMoreToWatch = false, hasPosts = false } = {}) {
    return [
        'heading',
        'status',
        hasRecommended && 'recommended',
        hasWhatsNew && 'whatsNew',
        hasFeatured && 'featured',
        'onRamp',
        hasMoreToWatch && 'moreToWatch',
        hasPosts && 'blog',
        'community',
        'footer'
    ].filter(Boolean);
}

// The first `limit` episodes, in their given order, and how many are left behind a "Show all". Past
// the limit the rest are only hidden, never dropped or reordered.
export function visibleEpisodes(episodes, expanded = false, limit = onRampVisibleLimit) {
    if (expanded || episodes.length <= limit) return { shown: episodes, hidden: 0 };
    return { shown: episodes.slice(0, limit), hidden: episodes.length - limit };
}

// The small label on a Featured item. Anything paid must say so.
export function featuredLabel(kind) {
    if (kind === 'sponsored') return 'Sponsored';
    if (kind === 'video') return 'New video';
    return 'Announcement';
}

// The "What's new" block, once per version: only after an update (a stored last-seen version that is
// older than the running one). A first-ever launch has no last-seen version and is not an update, and
// a downgrade is not news. `highlights` is the optional short list authored for this version.
export function whatsNewFor({ running, lastSeen, highlights = [] }) {
    if (!lastSeen || !isNewerVersion(running, lastSeen)) return null;
    return { version: running, previous: lastSeen, highlights: highlights.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, 5), url: releaseNotesUrl(running) };
}
