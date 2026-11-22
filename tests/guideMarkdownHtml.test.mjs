/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { guideTutorialCards, renderGuideMarkdown } from '../src/exampleGuide/markdownHtml.mjs';

// Stands in for mathlive's convertLatexToMarkup, which needs a browser: what it was given, and how.
const latex = (source, options = {}) => `<m${options.mathstyle ? ` data-style="${options.mathstyle}"` : ''}>${source}</m>`;

test('a guide renders as the guide window shows it: headings, paragraphs, lists, code and equations', () => {
    const html = renderGuideMarkdown('<!-- Copyright © 2026 Someone -->\n\n# Title\n\nA **bold** word and `code`.\n\n- one\n- two\n\n```\nraw <b>\n```\n\n$$x = 1$$\n\nInline $y$ here.', latex);
    assert.equal(html, '<h1>Title</h1><p>A <strong>bold</strong> word and <code>code</code>.</p><ul><li>one</li><li>two</li></ul>'
        + '<pre><code>raw &lt;b&gt;\n</code></pre><div class="equation"><m data-style="displaystyle">x = 1</m></div><p>Inline <span class="inlineMath"><m>y</m></span> here.</p>');
});

test('only https links become links, and they are marked as leading out of the app', () => {
    const html = renderGuideMarkdown('[site](https://konjugate.com) and [local](other.md) and [script](javascript:alert(1))', latex);
    assert.match(html, /<a href="https:\/\/konjugate\.com" data-external-link>site<\/a>/);
    assert.doesNotMatch(html, /href="other\.md"|href="javascript:/);
});

test('text in a guide is never taken as HTML', () => {
    assert.equal(renderGuideMarkdown('<img src=x onerror=alert(1)>', latex), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('every bundled example guide renders without a raw heading or frontmatter left in it', async () => {
    const manifest = JSON.parse(await readFile(new URL('../examples/manifest.json', import.meta.url), 'utf8'));
    for (const { id } of manifest.examples) {
        const markdown = await readFile(new URL(`../examples/${id}.md`, import.meta.url), 'utf8');
        const html = renderGuideMarkdown(markdown, latex);
        assert.match(html, /^<h1>/, `${id}.md starts with its title`);
        assert.doesNotMatch(html, /<p>#{1,3} |Copyright ©/, `${id}.md left markdown or its copyright comment in the page`);
    }
});

test('an example\'s tutorials are offered as cards whose button names the tutorial to start, their text escaped', () => {
    const html = guideTutorialCards([{ id: 'calibrateTank', title: 'Calibrate <a> tank', summary: 'Fit two numbers.', minutes: 4 }]);
    assert.equal(html, '<section class="tourCard"><div><strong>Calibrate &lt;a&gt; tank</strong><p>Fit two numbers. A 4-minute tutorial on this example, step by step, right in the app.</p></div>'
        + '<button type="button" data-start-tutorial="calibrateTank">Take the tutorial</button></section>');
    assert.equal(guideTutorialCards([]), '');
});

test('the guide window and the web edition\'s guide panel style a guide with the one stylesheet', async () => {
    const [windowPage, panel, build] = await Promise.all(['../src/exampleGuide/index.html', '../src/renderer/webShims/guidePanel.mjs', '../scripts/buildWebShell.mjs']
        .map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    assert.match(windowPage, /<link rel="stylesheet" href="guideContent\.css">/);
    assert.match(windowPage, /<main id="content" class="guideContent"/);
    assert.match(panel, /exampleGuide\/guideContent\.css/);
    assert.match(panel, /class="guidePanelContent guideContent"/);
    assert.match(build, /'exampleGuide', 'guideContent\.css'/);
});
