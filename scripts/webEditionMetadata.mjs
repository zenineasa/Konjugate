// Copyright © 2026 Zenin Easa Panthakkalakath

// Search and link-preview metadata for the web edition (scripts/buildWebShell.mjs). The root page of a static host
// redirects client-side to renderer/index.html (see the comment in buildWebShell.mjs), and that page is a canvas
// application, so a crawler otherwise sees a bare title and nothing else -- which is exactly what search results showed
// ("We cannot provide a description for this page right now"). Everything here is plain static HTML a crawler reads
// without running the app. Pure functions of their arguments so tests/webEditionMetadata.test.mjs can check them.

// The title leads with the product name and carries the phrase people search for ("graph simulation", plus "in your browser"
// for the intent this page serves). The name alone is no help: "Konjugate" is also the German word for "conjugate", so a search
// for it mostly returns verb-conjugation sites. The description holds the second phrase, "dynamic systems modeling" (US spelling,
// which is how it is searched). Keep the title to 60 characters and the description to 160 or search results cut them off.
export const WEB_EDITION_TITLE = 'Konjugate Web Edition: graph simulation in your browser';
export const WEB_EDITION_DESCRIPTION = 'Try Konjugate, open-source graph simulation software, in your browser. Model dynamic systems as components and relationships and explore results over time.';
export const WEB_EDITION_IMAGE_ALT = 'The Konjugate Web Edition showing a dynamic system modeled as a graph of components and relationships';
export const WEB_EDITION_SITE_URL = 'https://konjugate.com/';
export const WEB_EDITION_REPO_URL = 'https://github.com/zenineasa/Konjugate';
export const WEB_EDITION_DOWNLOAD_URL = 'https://github.com/zenineasa/Konjugate/releases/latest';
// The browser-tab icon, copied from assets/icons/favicon.ico to the root of the build (where browsers look for it by default).
export const WEB_EDITION_FAVICON = 'favicon.ico';
// The screenshot the README already uses, copied into the build as assets/social-preview.png.
export const WEB_EDITION_IMAGE = { path: 'assets/social-preview.png', width: 1920, height: 1080 };

const escapeHtml = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// JSON for an inline <script type="application/ld+json">: the characters that could end the script or the markup around it are
// written as \u escapes, which a JSON parser reads back as the same characters.
const jsonForScript = (value) => JSON.stringify(value)
    .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

// Structured data (schema.org) that tells a search engine this is a free, open-source application that runs in the browser,
// rather than leaving it to guess from a canvas page. The page's Content-Security-Policy does not block it: it is a data block,
// not executable script.
export function webEditionStructuredData({ url }) {
    const imageUrl = new URL(WEB_EDITION_IMAGE.path, url).href;
    return jsonForScript({
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: 'Konjugate Web Edition',
        alternateName: 'Konjugate',
        url,
        description: WEB_EDITION_DESCRIPTION,
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Graph simulation and dynamic systems modeling',
        operatingSystem: 'Any (modern web browser)',
        browserRequirements: 'Requires JavaScript and WebAssembly',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        license: 'https://www.mozilla.org/MPL/2.0/',
        image: imageUrl,
        screenshot: imageUrl,
        creator: { '@type': 'Person', name: 'Zenin Easa Panthakkalakath' },
        sameAs: [WEB_EDITION_SITE_URL, WEB_EDITION_REPO_URL]
    });
}

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
        // Index and follow, and allow the large preview image and full snippets the tags below are written for.
        '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
        `<link rel="canonical" href="${escapeHtml(url)}">`,
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Konjugate">',
        '<meta property="og:locale" content="en_US">',
        `<meta property="og:title" content="${escapeHtml(WEB_EDITION_TITLE)}">`,
        `<meta property="og:description" content="${escapeHtml(WEB_EDITION_DESCRIPTION)}">`,
        `<meta property="og:url" content="${escapeHtml(url)}">`,
        `<meta property="og:image" content="${escapeHtml(imageUrl)}">`,
        `<meta property="og:image:width" content="${WEB_EDITION_IMAGE.width}">`,
        `<meta property="og:image:height" content="${WEB_EDITION_IMAGE.height}">`,
        '<meta property="og:image:type" content="image/png">',
        `<meta property="og:image:alt" content="${escapeHtml(WEB_EDITION_IMAGE_ALT)}">`,
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${escapeHtml(WEB_EDITION_TITLE)}">`,
        `<meta name="twitter:description" content="${escapeHtml(WEB_EDITION_DESCRIPTION)}">`,
        `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`,
        `<meta name="twitter:image:alt" content="${escapeHtml(WEB_EDITION_IMAGE_ALT)}">`,
        `<script type="application/ld+json">${webEditionStructuredData({ url })}</script>`
    ];
    return tags.join(`\n${indent}`);
}

// The text a crawler can read without running the application, written as the page's visible fallback. It says what the thing
// is and how it works in plain words, and names the limits honestly: this is a preview, and the desktop app has the full feature set.
function webEditionSummary(indent) {
    return [
        `<p>${escapeHtml(WEB_EDITION_DESCRIPTION)}</p>`,
        '<h2>How it works</h2>',
        '<ul>',
        '    <li>Components hold state, such as a temperature or a stock level.</li>',
        '    <li>Relationships are equations that define how one component affects another.</li>',
        '    <li>Run the simulation to see how every state changes over time.</li>',
        '</ul>',
        '<p>This browser edition is a lightweight preview. The desktop app for macOS, Windows and Linux has the full feature set: ' +
        `<a href="${WEB_EDITION_DOWNLOAD_URL}">download the desktop app</a>, read more at <a href="${WEB_EDITION_SITE_URL}">konjugate.com</a> ` +
        `or browse the <a href="${WEB_EDITION_REPO_URL}">source code on GitHub</a>.</p>`
    ].join(`\n${indent}`);
}

// Shown only when scripts are off, and read by crawlers that do not run the application.
export function webEditionNoscript() {
    return '<noscript>\n' +
        '        <h1>Konjugate Web Edition</h1>\n' +
        `        ${webEditionSummary('        ')}\n` +
        '        <p>The web edition needs JavaScript and WebAssembly.</p>\n' +
        '    </noscript>';
}

// The page at the root of the static host: sends people straight to the application, and gives anything that does not
// follow the redirect the same metadata, the same summary and a plain link.
export function webEditionRootPage({ url, target = 'renderer/index.html' }) {
    return '<!doctype html>\n' +
        '<html lang="en"><head><meta charset="utf-8">\n' +
        `<meta http-equiv="refresh" content="0; url=${target}">\n` +
        `<script>location.replace('${target}');</script>\n` +
        `${webEditionHead({ url, indent: '' })}\n` +
        '</head><body>\n' +
        '<h1>Konjugate Web Edition</h1>\n' +
        `${webEditionSummary('')}\n` +
        `<p><a href="${target}">Open the web edition</a></p>\n` +
        '</body></html>\n';
}
