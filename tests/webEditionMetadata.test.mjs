// Copyright © 2026 Zenin Easa Panthakkalakath

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    WEB_EDITION_TITLE, WEB_EDITION_DESCRIPTION, WEB_EDITION_IMAGE, webEditionHead, webEditionNoscript, webEditionRootPage
} from '../scripts/webEditionMetadata.mjs';

const url = 'https://web.konjugate.com/';

test('the title and description fit what search results display', () => {
    assert.ok(WEB_EDITION_TITLE.length <= 60, `title is ${WEB_EDITION_TITLE.length} characters`);
    assert.ok(WEB_EDITION_DESCRIPTION.length >= 70 && WEB_EDITION_DESCRIPTION.length <= 160, `description is ${WEB_EDITION_DESCRIPTION.length} characters`);
    assert.match(WEB_EDITION_TITLE, /Konjugate/);
});

test('the head carries a title, description, canonical link and Open Graph and Twitter tags', () => {
    const head = webEditionHead({ url });
    assert.match(head, /<title>Konjugate web edition: build dynamic systems as graphs<\/title>/);
    assert.match(head, /<meta name="description" content="Open-source visual modelling/);
    assert.match(head, /<link rel="canonical" href="https:\/\/web\.konjugate\.com\/">/);
    assert.match(head, /<meta property="og:url" content="https:\/\/web\.konjugate\.com\/">/);
    assert.match(head, /<meta property="og:image" content="https:\/\/web\.konjugate\.com\/assets\/social-preview\.png">/);
    assert.match(head, new RegExp(`og:image:width" content="${WEB_EDITION_IMAGE.width}"`));
    assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
    assert.equal((head.match(/<title>/g) ?? []).length, 1);
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

test('the noscript fallback names the product and links to the main site', () => {
    const noscript = webEditionNoscript();
    assert.match(noscript, /^<noscript>/);
    assert.match(noscript, /<h1>Konjugate web edition<\/h1>/);
    assert.match(noscript, /href="https:\/\/konjugate\.com\/"/);
    assert.match(noscript, /<\/noscript>$/);
});

test('the root page still redirects, and also carries the metadata and a plain link', () => {
    const page = webEditionRootPage({ url });
    assert.match(page, /<meta http-equiv="refresh" content="0; url=renderer\/index\.html">/);
    assert.match(page, /location\.replace\('renderer\/index\.html'\)/);
    assert.match(page, /<title>Konjugate web edition/);
    assert.match(page, /<link rel="canonical" href="https:\/\/web\.konjugate\.com\/">/);
    assert.match(page, /<a href="renderer\/index\.html">Open the web edition<\/a>/);
    assert.ok(page.startsWith('<!doctype html>'));
});
