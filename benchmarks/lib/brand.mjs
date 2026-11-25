/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the published benchmark pages (the combined report, written by combine.mjs, and the site's index, written by pages.mjs) carry
// besides their data: a slim bar naming Konjugate with links to the app and its source, the tagline, link-preview metadata, the tab
// icon and a short About box at the end. Everything is inline (the logo is assets/icon.svg, the tab icon benchmarks/site/favicon32.png
// as a data: URL), so a page is still one file that works offline from a clone; nothing is loaded from another site. Only the
// link-preview image is a separate file: benchmarks/site/socialCard.png, which pages.mjs publishes at the root of the site.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dirname, '..', '..');
const escapeXml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);

// Where pages.mjs's site is published (webEdition.yml), for the absolute addresses link previews need.
export const siteUrl = 'https://web.konjugate.com/benchmarks/';
export const socialCard = { source: 'benchmarks/site/socialCard.png', path: 'socialCard.png', width: 1200, height: 1200, alt: 'Konjugate benchmarks: physical systems are networks, simulated that way' };
export const tagline = 'Physical systems are networks. Simulate them that way.';
const links = {
    home: 'https://www.konjugate.com/',
    web: 'https://web.konjugate.com/',
    // konjugate.com has no download page of its own (it installs from a dialog), so the latest release, as the README links it.
    download: 'https://github.com/zenineasa/Konjugate/releases/latest',
    source: 'https://github.com/zenineasa/Konjugate',
    reproduce: 'https://github.com/zenineasa/Konjugate/blob/master/benchmarks/README.md#reproduce-these-results',
    issues: 'https://github.com/zenineasa/Konjugate/issues'
};

// The app's icon, its ids prefixed so they cannot clash with a page's own, and hidden from screen readers: the link's text names it.
function logo() {
    const svg = readFileSync(join(repositoryRoot, 'assets', 'icon.svg'), 'utf8')
        .replace(/<!--[\s\S]*?-->\s*/g, '').replace(/<title[\s\S]*?<\/title>\s*|<desc[\s\S]*?<\/desc>\s*/g, '')
        .replace(/\bid="([^"]+)"/g, 'id="brand-$1"').replace(/url\(#([^)]+)\)/g, 'url(#brand-$1)')
        .replace(/<svg[^>]*>/, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="24" height="24" aria-hidden="true" focusable="false">');
    return svg.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
}

const favicon = () => `data:image/png;base64,${readFileSync(join(repositoryRoot, 'benchmarks', 'site', 'favicon32.png')).toString('base64')}`;

// The head's tags: tab icon, description and link preview. `url` is the page's own published address.
export function brandHead({ title, description, url }) {
    const image = new URL(socialCard.path, siteUrl).href;
    return [
        `<link rel="icon" type="image/png" sizes="32x32" href="${favicon()}">`,
        `<meta name="description" content="${escapeXml(description)}">`,
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Konjugate">',
        `<meta property="og:title" content="${escapeXml(title)}">`,
        `<meta property="og:description" content="${escapeXml(description)}">`,
        `<meta property="og:url" content="${escapeXml(url)}">`,
        `<meta property="og:image" content="${escapeXml(image)}">`,
        `<meta property="og:image:width" content="${socialCard.width}">`,
        `<meta property="og:image:height" content="${socialCard.height}">`,
        '<meta property="og:image:type" content="image/png">',
        `<meta property="og:image:alt" content="${escapeXml(socialCard.alt)}">`,
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${escapeXml(title)}">`,
        `<meta name="twitter:description" content="${escapeXml(description)}">`,
        `<meta name="twitter:image" content="${escapeXml(image)}">`,
        `<meta name="twitter:image:alt" content="${escapeXml(socialCard.alt)}">`
    ].join('\n');
}

// Colours from the page (currentColor and the text's own), so the bar and the box follow its light and dark themes.
export const brandStyles = `
.brand { border-bottom: 1px solid color-mix(in srgb, currentColor 16%, transparent); font-size: 13px; }
.brand .inner { max-width: var(--brand-width, 1200px); margin: 0 auto; padding: 8px 24px; display: flex; align-items: center; justify-content: space-between; gap: 8px 20px; flex-wrap: wrap; }
.brand a { color: inherit; text-decoration: none; } .brand a:hover, .brand a:focus-visible { text-decoration: underline; }
.brand .home { display: inline-flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; } .brand .home svg { display: block; }
.brand nav { display: flex; gap: 4px 16px; flex-wrap: wrap; } .brand nav a { opacity: 0.75; } .brand nav a:hover, .brand nav a:focus-visible { opacity: 1; }
.tagline { margin: -4px 0 12px; font-size: 16px; font-style: italic; opacity: 0.8; }
.about { max-width: var(--brand-width, 1200px); margin: 0 auto; padding: 0 24px 40px; }
.about div { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 8px; padding: 12px 16px; font-size: 14px; }
.about h2 { font-size: 15px; margin: 0 0 4px; padding: 0; border: 0; } .about p { margin: 4px 0; }
`;

export const brandBar = () => `<header class="brand"><div class="inner">
<a class="home" href="${links.home}" aria-label="Konjugate home page">${logo()}<span>Konjugate</span></a>
<nav aria-label="Konjugate"><a href="${links.web}">Try it in your browser</a><a href="${links.download}">Download</a><a href="${links.source}">Source on GitHub</a></nav>
</div></header>`;

export const taglineHtml = `<p class="tagline">${escapeXml(tagline)}</p>`;

export const aboutBox = `<footer class="about"><div>
<h2>About Konjugate</h2>
<p>Konjugate is an open-source, graph-native simulation engine: draw a system as components connected by relationships, write each one's equations, and it assembles and runs the whole system. These results can be reproduced from a clone of the repository: <a href="${links.reproduce}">Reproduce these results</a>.</p>
<p>Found a result you don't believe? <a href="${links.issues}">Open an issue</a>.</p>
</div></footer>`;
