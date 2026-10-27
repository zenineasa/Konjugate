// Copyright © 2026 Zenin Easa Panthakkalakath

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WEB_EDITION_TITLE, WEB_EDITION_DESCRIPTION, WEB_EDITION_IMAGE, WEB_EDITION_IMAGE_ALT, WEB_EDITION_DOWNLOAD_URL,
    webEditionHead, webEditionNoscript, webEditionRootPage, webEditionStructuredData
} from '../scripts/webEditionMetadata.mjs';

const url = 'https://web.konjugate.com/';

test('the title and description fit what search results display', () => {
    assert.ok(WEB_EDITION_TITLE.length <= 60, `title is ${WEB_EDITION_TITLE.length} characters`);
    assert.ok(WEB_EDITION_DESCRIPTION.length >= 70 && WEB_EDITION_DESCRIPTION.length <= 160, `description is ${WEB_EDITION_DESCRIPTION.length} characters`);
    assert.match(WEB_EDITION_TITLE, /Konjugate/);
});

test('the title and description carry the phrases people search for, since the product name alone does not', () => {
    // "Konjugate" is also the German word for "conjugate": a search for it mostly returns verb-conjugation sites.
    assert.match(WEB_EDITION_TITLE, /graph simulation/i);
    assert.match(WEB_EDITION_DESCRIPTION, /graph simulation/i);
    assert.match(WEB_EDITION_DESCRIPTION, /dynamic systems/i);
    assert.match(WEB_EDITION_DESCRIPTION, /open-source/i);
    assert.ok(WEB_EDITION_IMAGE_ALT.length <= 125, 'alt text stays short enough for screen readers and image search');
});

test('the head carries a title, description, canonical link and Open Graph and Twitter tags', () => {
    const head = webEditionHead({ url });
    assert.match(head, /<title>Konjugate Web Edition: graph simulation in your browser<\/title>/);
    assert.match(head, /<meta name="description" content="Try Konjugate, open-source graph simulation software/);
    assert.match(head, /<link rel="canonical" href="https:\/\/web\.konjugate\.com\/">/);
    assert.match(head, /<meta property="og:url" content="https:\/\/web\.konjugate\.com\/">/);
    assert.match(head, /<meta property="og:image" content="https:\/\/web\.konjugate\.com\/assets\/social-preview\.png">/);
    assert.match(head, new RegExp(`og:image:width" content="${WEB_EDITION_IMAGE.width}"`));
    assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
    assert.equal((head.match(/<title>/g) ?? []).length, 1);
});

test('the head tells crawlers the page may be indexed with a large preview, and describes the preview image', () => {
    const head = webEditionHead({ url });
    assert.match(head, /<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">/);
    assert.ok(!/noindex|nofollow/.test(head), 'nothing in the head keeps the page out of search');
    assert.match(head, /<meta property="og:locale" content="en_US">/);
    assert.match(head, /<meta property="og:image:type" content="image\/png">/);
    assert.match(head, /<meta name="twitter:image:alt" content="The Konjugate Web Edition/);
});

const structuredDataOf = (head) => {
    const match = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(match, 'the head carries a JSON-LD block');
    return JSON.parse(match[1]);
};

test('the head carries schema.org data describing a free, open-source web application', () => {
    const data = structuredDataOf(webEditionHead({ url }));
    assert.equal(data['@context'], 'https://schema.org');
    assert.equal(data['@type'], 'WebApplication');
    assert.equal(data.url, url);
    assert.equal(data.description, WEB_EDITION_DESCRIPTION);
    assert.equal(data.isAccessibleForFree, true);
    assert.equal(data.offers.price, '0');
    assert.match(data.license, /MPL/);
    assert.equal(data.image, 'https://web.konjugate.com/assets/social-preview.png');
    assert.ok(data.sameAs.includes('https://konjugate.com/'));
    assert.match(data.browserRequirements, /WebAssembly/);
});

test('the structured data cannot break out of its script block or the markup around it', () => {
    const hostile = 'https://example.org/a?x=1&y="2"&z=</script><script>alert(1)</script>/';
    const json = webEditionStructuredData({ url: hostile });
    assert.ok(!/[<>&]/.test(json), 'angle brackets and ampersands are written as \\u escapes');
    assert.equal(JSON.parse(json).url, hostile, 'a JSON parser still reads the original address back');
    const head = webEditionHead({ url: hostile });
    assert.equal((head.match(/<script/g) ?? []).length, 1, 'only the one JSON-LD script block');
    assert.equal(structuredDataOf(head).url, hostile);
});

test('the head declares the tab icon, resolved from the page that carries it', () => {
    const root = webEditionHead({ url });
    assert.match(root, /<link rel="icon" href="favicon\.ico" sizes="any">/);
    assert.match(root, /<link rel="icon" type="image\/png" sizes="32x32" href="assets\/icons\/favicon32\.png">/);
    assert.match(root, /<link rel="icon" type="image\/png" sizes="16x16" href="assets\/icons\/favicon16\.png">/);
    assert.match(root, /<link rel="apple-touch-icon" href="assets\/icons\/appleTouchIcon\.png">/);
    const app = webEditionHead({ url, assetPrefix: '../' });
    assert.match(app, /<link rel="icon" href="\.\.\/favicon\.ico" sizes="any">/);
    assert.match(app, /href="\.\.\/assets\/icons\/favicon32\.png"/);
    assert.ok(!/href="https?:/.test(app.replace(/<link rel="canonical"[^>]*>/, '')), 'icons come from the site itself, never another origin (the page\'s CSP blocks them)');
});

test('the root page carries the icon links too', () => {
    assert.match(webEditionRootPage({ url }), /<link rel="icon" href="favicon\.ico" sizes="any">/);
});

test('the image address follows the base URL, including a path prefix', () => {
    assert.match(webEditionHead({ url: 'https://example.org/konjugate/' }), /og:image" content="https:\/\/example\.org\/konjugate\/assets\/social-preview\.png"/);
});

test('attribute values are escaped', () => {
    const head = webEditionHead({ url: 'https://example.org/a?x=1&y="2"/' });
    assert.ok(!head.includes('"2"'));
    assert.match(head, /x=1&amp;y=&quot;2&quot;/);
});

test('the noscript fallback names the product, explains it and links to the main site, the source and the desktop download', () => {
    const noscript = webEditionNoscript();
    assert.match(noscript, /^<noscript>/);
    assert.match(noscript, /<h1>Konjugate Web Edition<\/h1>/);
    assert.match(noscript, /graph simulation/);
    assert.match(noscript, /<h2>How it works<\/h2>/);
    assert.match(noscript, /href="https:\/\/konjugate\.com\/"/);
    assert.ok(noscript.includes(`href="${WEB_EDITION_DOWNLOAD_URL}"`));
    assert.match(noscript, /href="https:\/\/github\.com\/zenineasa\/Konjugate"/);
    assert.match(noscript, /lightweight preview/, 'it is honest that the desktop app has more');
    assert.match(noscript, /JavaScript and WebAssembly/);
    assert.match(noscript, /<\/noscript>$/);
    assert.equal((noscript.match(/<h1>/g) ?? []).length, 1, 'one h1');
});

test('the root page still redirects, and also carries the metadata and a plain link', () => {
    const page = webEditionRootPage({ url });
    assert.match(page, /<meta http-equiv="refresh" content="0; url=renderer\/index\.html">/);
    assert.match(page, /location\.replace\('renderer\/index\.html'\)/);
    assert.match(page, /<title>Konjugate Web Edition: graph simulation/);
    assert.match(page, /<h2>How it works<\/h2>/);
    assert.equal((page.match(/<h1>/g) ?? []).length, 1, 'one h1');
    assert.match(page, /<link rel="canonical" href="https:\/\/web\.konjugate\.com\/">/);
    assert.match(page, /<a href="renderer\/index\.html">Open the web edition<\/a>/);
    assert.ok(page.startsWith('<!doctype html>'));
});
