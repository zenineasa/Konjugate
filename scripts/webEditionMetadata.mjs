// Copyright © 2026 Zenin Easa Panthakkalakath

// Search and link-preview metadata for the web edition (scripts/buildWebShell.mjs). The root page of a static host
// redirects client-side to renderer/index.html (see the comment in buildWebShell.mjs), and that page is a canvas
// application, so a crawler otherwise sees a bare title and nothing else -- which is exactly what search results showed
// ("We cannot provide a description for this page right now"). Everything here is plain static HTML a crawler reads
// without running the app. Pure functions of their arguments so tests/webEditionMetadata.test.mjs can check them.

export const WEB_EDITION_TITLE = 'Konjugate web edition: build dynamic systems as graphs';
export const WEB_EDITION_DESCRIPTION = 'Open-source visual modelling and simulation in your browser. Components hold state, relationships define how they interact, and results unfold over time.';
export const WEB_EDITION_IMAGE_ALT = 'The Konjugate web edition showing a system modelled as a graph of components and relationships';
export const WEB_EDITION_SITE_URL = 'https://konjugate.com/';
// The browser-tab icon, copied from assets/icons/favicon.ico to the root of the build (where browsers look for it by default).
export const WEB_EDITION_FAVICON = 'favicon.ico';
// The screenshot the README already uses, copied into the build as assets/social-preview.png.
export const WEB_EDITION_IMAGE = { path: 'assets/social-preview.png', width: 1920, height: 1080 };

const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// `url` is the public address of the root page (it ends with a slash). The same tags go on the app page and on the root
// redirect page, so whichever one a crawler or link-preview bot reads carries them, and both name the root as canonical.
// `assetPrefix` is the path from the page being written to the root of the site ('' for the root page, '../' for the app page),
// which is how the icon links reach the files at the root and under assets/. The icons are served from the site itself: the page's
// Content-Security-Policy allows images only from its own origin, so an icon on another site would be blocked, and browsers
// ask for /favicon.ico at the root when a page declares nothing, which a static host answers with a 404.
export function webEditionHead({ url, indent = '    ', assetPrefix = '' }) {
    const imageUrl = new URL(WEB_EDITION_IMAGE.path, url).href;
    const tags = [
        `<title>${escapeHtml(WEB_EDITION_TITLE)}</title>`,
        `<link rel="icon" href="${assetPrefix}${WEB_EDITION_FAVICON}" sizes="any">`,
        `<link rel="icon" type="image/png" sizes="32x32" href="${assetPrefix}assets/icons/favicon32.png">`,
        `<link rel="icon" type="image/png" sizes="16x16" href="${assetPrefix}assets/icons/favicon16.png">`,
        `<link rel="apple-touch-icon" href="${assetPrefix}assets/icons/appleTouchIcon.png">`,
        `<meta name="description" content="${escapeHtml(WEB_EDITION_DESCRIPTION)}">`,
        `<link rel="canonical" href="${escapeHtml(url)}">`,
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Konjugate">',
        `<meta property="og:title" content="${escapeHtml(WEB_EDITION_TITLE)}">`,
        `<meta property="og:description" content="${escapeHtml(WEB_EDITION_DESCRIPTION)}">`,
        `<meta property="og:url" content="${escapeHtml(url)}">`,
        `<meta property="og:image" content="${escapeHtml(imageUrl)}">`,
        `<meta property="og:image:width" content="${WEB_EDITION_IMAGE.width}">`,
        `<meta property="og:image:height" content="${WEB_EDITION_IMAGE.height}">`,
        `<meta property="og:image:alt" content="${escapeHtml(WEB_EDITION_IMAGE_ALT)}">`,
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${escapeHtml(WEB_EDITION_TITLE)}">`,
        `<meta name="twitter:description" content="${escapeHtml(WEB_EDITION_DESCRIPTION)}">`,
        `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`
    ];
    return tags.join(`\n${indent}`);
}

// Shown only when scripts are off, and read by crawlers that do not run the application.
export function webEditionNoscript() {
    return '<noscript>\n' +
        '        <h1>Konjugate web edition</h1>\n' +
        `        <p>${escapeHtml(WEB_EDITION_DESCRIPTION)}</p>\n` +
        '        <p>The web edition needs JavaScript and WebAssembly. Learn more, or download the desktop app, at ' +
        `<a href="${WEB_EDITION_SITE_URL}">konjugate.com</a>.</p>\n` +
        '    </noscript>';
}

// The page at the root of the static host: sends people straight to the application, and gives anything that does not
// follow the redirect the same metadata and a plain link.
export function webEditionRootPage({ url, target = 'renderer/index.html' }) {
    return '<!doctype html>\n' +
        '<html lang="en"><head><meta charset="utf-8">\n' +
        `<meta http-equiv="refresh" content="0; url=${target}">\n` +
        `<script>location.replace('${target}');</script>\n` +
        `${webEditionHead({ url, indent: '' })}\n` +
        '</head><body>\n' +
        `<h1>Konjugate web edition</h1>\n<p>${escapeHtml(WEB_EDITION_DESCRIPTION)}</p>\n` +
        `<p><a href="${target}">Open the web edition</a> or visit <a href="${WEB_EDITION_SITE_URL}">konjugate.com</a>.</p>\n` +
        '</body></html>\n';
}
