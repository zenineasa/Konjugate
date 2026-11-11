/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Redraws the ReadMe's downloads chart from GitHub's release download counts. Run by
// scripts/bumpVersion.mjs on every version bump, on the maintainer's own machine, before the new
// release exists -- so it counts everything published up to the previous version.
//
// What counts: the installers, .exe, .dmg, .AppImage and .deb, as GitHub counts them. That is
// downloads, not people: GitHub cannot tell a first install from an update, so an AppImage update
// or an `apt upgrade` adds to its release's count like any other download. Left out are the files
// that are fetched for reasons other than installing: the .AppImage.zsync files (checked by AppImage
// updates) and the apt repository's index and key files (Packages, InRelease, the keyring...),
// which apt fetches on every `apt update`. Each release's own CI run downloads its .deb files once
// or twice, to index them and to test the install, so the Linux count runs a little high.
//
// GitHub only reports a lifetime count per asset, never when the downloads happened, so the curve
// is release by release: each point is a release at its publish date, climbing by that release's
// lifetime downloads. It is not downloads over time -- recent releases have had less time to collect
// theirs -- and the chart says so beneath the curve.
//
// Never fails the caller: offline or rate-limited, it warns and leaves the committed files as they
// were. Set GITHUB_TOKEN to lift the unauthenticated limit of 60 requests an hour.
//
// Usage: npm run generate:release-stats

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(projectRoot, 'assets', 'ForReadme');

const repository = 'zenineasa/Konjugate';
const platforms = [
    { key: 'windows', label: 'Windows', matches: (name) => name.endsWith('.exe') },
    { key: 'macos', label: 'macOS', matches: (name) => name.endsWith('.dmg') },
    { key: 'linux', label: 'Linux', matches: (name) => name.endsWith('.AppImage') || name.endsWith('.deb') },
];

async function fetchReleases() {
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'konjugate-release-stats',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const releases = [];
    for (let page = 1; ; page++) {
        const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`GitHub API answered ${response.status} ${response.statusText}`);
        const batch = await response.json();
        releases.push(...batch);
        if (batch.length < 100) return releases.filter((release) => !release.draft);
    }
}

// Per platform totals, plus each release's installer downloads in publish order.
function summarize(releases) {
    const totals = Object.fromEntries(platforms.map((platform) => [platform.key, 0]));
    const perRelease = releases.filter((release) => release.published_at).map((release) => {
        let downloads = 0;
        for (const asset of release.assets ?? []) {
            const platform = platforms.find((candidate) => candidate.matches(asset.name));
            if (!platform) continue;
            totals[platform.key] += asset.download_count ?? 0;
            downloads += asset.download_count ?? 0;
        }
        return { tag: release.tag_name, prerelease: release.prerelease, publishedAt: Date.parse(release.published_at), downloads };
    }).sort((a, b) => a.publishedAt - b.publishedAt);
    let runningTotal = 0;
    for (const release of perRelease) release.cumulative = runningTotal += release.downloads;
    const latestRelease = perRelease.filter((release) => !release.prerelease).at(-1)?.tag ?? null;
    return { totals, total: runningTotal, perRelease, latestRelease };
}

// ---------------------------------------------------------------------------------------------
// The chart: total installer downloads in large type, the platform split as one segmented bar,
// and the release-by-release curve. Two files, one per theme, which the ReadMe picks
// between with <picture> -- GitHub follows its own theme setting for that, which a media query
// inside a single SVG would not.
// ---------------------------------------------------------------------------------------------

const themes = {
    light: {
        surface: '#fcfcfb', border: 'rgba(11,11,11,0.10)', primary: '#0b0b0b', secondary: '#52514e', muted: '#898781',
        grid: '#e1e0d9', axis: '#c3c2b7', series: ['#2a78d6', '#eb6834', '#1baf7a'],
    },
    dark: {
        surface: '#1a1a19', border: 'rgba(255,255,255,0.10)', primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781',
        grid: '#2c2c2a', axis: '#383835', series: ['#3987e5', '#d95926', '#199e70'],
    },
};

const width = 800;
const height = 320;
const font = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Helvetica, Arial, sans-serif';
const formatCount = (value) => value.toLocaleString('en-US');
const formatDate = (time) => new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A round axis ceiling: the smallest 1, 2, 2.5 or 5 times a power of ten at or above the value.
function niceCeiling(value) {
    if (value <= 0) return 10;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return [1, 2, 2.5, 5, 10].map((step) => step * magnitude).find((candidate) => candidate >= value);
}

function renderChart(summary, theme) {
    const colors = themes[theme];
    const { totals, total, perRelease, latestRelease } = summary;
    const parts = [];
    const text = (x, y, content, { size = 13, fill = colors.secondary, weight = 400, anchor = 'start' } = {}) =>
        parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(content)}</text>`);

    parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${colors.surface}" stroke="${colors.border}"/>`);

    // Left column: headline figure, then the platform split.
    const left = 32;
    const columnWidth = 220;
    text(left, 48, 'Installer downloads', { size: 13, fill: colors.secondary, weight: 600 });
    text(left, 104, formatCount(total), { size: 52, fill: colors.primary, weight: 700 });
    text(left, 128, latestRelease ? `All releases up to ${latestRelease}` : 'All releases', { size: 12, fill: colors.muted });

    const barY = 156;
    let segmentX = left;
    const gap = 2;
    const visible = platforms.map((platform, index) => ({ ...platform, color: colors.series[index], count: totals[platform.key] })).filter((platform) => platform.count > 0);
    const usableWidth = columnWidth - gap * Math.max(0, visible.length - 1);
    visible.forEach((platform, index) => {
        const segmentWidth = total > 0 ? (platform.count / total) * usableWidth : 0;
        const radius = Math.min(4, segmentWidth / 2);
        // Rounded only at the bar's two outer ends.
        const roundLeft = index === 0 ? radius : 0;
        const roundRight = index === visible.length - 1 ? radius : 0;
        const x0 = segmentX;
        const x1 = segmentX + segmentWidth;
        const y0 = barY;
        const y1 = barY + 12;
        parts.push(`<path d="M${x0 + roundLeft},${y0} H${x1 - roundRight} Q${x1},${y0} ${x1},${y0 + roundRight} V${y1 - roundRight} Q${x1},${y1} ${x1 - roundRight},${y1} H${x0 + roundLeft} Q${x0},${y1} ${x0},${y1 - roundLeft} V${y0 + roundLeft} Q${x0},${y0} ${x0 + roundLeft},${y0} Z" fill="${platform.color}"/>`);
        segmentX = x1 + gap;
    });
    platforms.forEach((platform, index) => {
        const count = totals[platform.key];
        const rowY = 196 + index * 24;
        parts.push(`<rect x="${left}" y="${rowY - 9}" width="10" height="10" rx="2" fill="${colors.series[index]}"/>`);
        text(left + 18, rowY, platform.label, { size: 13, fill: colors.primary });
        const share = total > 0 ? Math.round((count / total) * 100) : 0;
        text(left + columnWidth, rowY, `${formatCount(count)} · ${share}%`, { size: 13, fill: colors.secondary, anchor: 'end' });
    });

    // Right column: the running total, release by release.
    const plot = { left: 340, right: width - 40, top: 72, bottom: height - 84 };
    text(plot.left - 28, 48, 'Total downloads, release by release', { size: 13, fill: colors.secondary, weight: 600 });
    const yMax = niceCeiling(total * 1.1);
    const yOf = (value) => plot.bottom - (value / yMax) * (plot.bottom - plot.top);
    for (const fraction of [0, 0.5, 1]) {
        const y = yOf(yMax * fraction);
        parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${y}" y2="${y}" stroke="${fraction === 0 ? colors.axis : colors.grid}" stroke-width="1"/>`);
        text(plot.left - 8, y + 4, formatCount(yMax * fraction), { size: 11, fill: colors.muted, anchor: 'end' });
    }

    const first = perRelease[0]?.publishedAt ?? Date.now();
    const last = perRelease.at(-1)?.publishedAt ?? first;
    const xOf = (time) => (last > first ? plot.left + ((time - first) / (last - first)) * (plot.right - plot.left) : plot.right);
    // Starts from zero at the first release, so its own downloads show as the first step up.
    const points = [[xOf(first), yOf(0)], ...perRelease.map((release) => [xOf(release.publishedAt), yOf(release.cumulative)])];
    const [lastX, lastY] = points.at(-1);
    const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    parts.push(`<path d="${line} L${lastX.toFixed(1)},${plot.bottom} L${points[0][0].toFixed(1)},${plot.bottom} Z" fill="${colors.series[0]}" fill-opacity="0.1"/>`);
    parts.push(`<path d="${line}" fill="none" stroke="${colors.series[0]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    parts.push(`<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${colors.series[0]}" stroke="${colors.surface}" stroke-width="2"/>`);
    text(lastX - 10, lastY - 12, formatCount(total), { size: 12, fill: colors.primary, weight: 600, anchor: 'end' });
    if (perRelease.length > 0) {
        text(plot.left, plot.bottom + 20, `${perRelease[0].tag} · ${formatDate(first)}`, { size: 11, fill: colors.muted });
        text(plot.right, plot.bottom + 20, `${perRelease.at(-1).tag} · ${formatDate(last)}`, { size: 11, fill: colors.muted, anchor: 'end' });
    }
    text(plot.left - 28, plot.bottom + 48, 'Each point is a release at its publish date, adding that release\u2019s lifetime downloads.', { size: 11, fill: colors.muted });
    text(plot.left - 28, plot.bottom + 64, 'Not downloads over time: recent releases have had less time to collect theirs.', { size: 11, fill: colors.muted });

    const description = `${formatCount(total)} installer downloads across ${perRelease.length} releases: ${platforms.map((platform) => `${platform.label} ${formatCount(totals[platform.key])}`).join(', ')}.`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="${font}">\n<title>Konjugate downloads</title>\n<desc>${escapeXml(description)}</desc>\n${parts.join('\n')}\n</svg>\n`;
}

async function main() {
    let releases;
    try {
        releases = await fetchReleases();
    } catch (error) {
        console.warn(`Release stats skipped, the downloads chart is unchanged: ${error.message}`);
        return;
    }
    const summary = summarize(releases);
    for (const theme of Object.keys(themes)) {
        await writeFile(join(outputDirectory, `downloads-${theme}.svg`), renderChart(summary, theme));
    }
    console.log(`Release stats: ${formatCount(summary.total)} installer downloads up to ${summary.latestRelease ?? 'no release'}.`);
}

await main();
