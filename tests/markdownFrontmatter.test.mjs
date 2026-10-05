/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareGuideMarkdown, stripFrontmatter } from '../src/exampleGuide/markdown.mjs';

const frontmatter = `---
type: Guide
title: Welcome to Konjugate
description: Overview of Konjugate
tags: [welcome, overview]
---
`;

test('strips standard YAML frontmatter from start of document', () => {
    const raw = `${frontmatter}
# Welcome

Body text here.`;

    assert.equal(stripFrontmatter(raw).trim(), `# Welcome\n\nBody text here.`);
});

test('strips frontmatter followed by the copyright comment, the shape the real docs use', () => {
    const raw = `${frontmatter}
<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Help topic`;

    assert.equal(stripFrontmatter(raw).trim(), `<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->\n\n# Help topic`);
    assert.equal(prepareGuideMarkdown(raw).trim(), `# Help topic`);
});

test('strips frontmatter preceded by a leading HTML comment', () => {
    const raw = `<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->
${frontmatter}
# Help topic`;

    assert.equal(prepareGuideMarkdown(raw).trim(), `# Help topic`);
    assert.equal(stripFrontmatter(raw).trim(), `<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->\n\n# Help topic`);
});

test('strips frontmatter in a file with CRLF line endings', () => {
    const raw = `${frontmatter}\n# Windows file\n\nBody.`.replace(/\n/g, '\r\n');

    assert.equal(stripFrontmatter(raw).trim(), `# Windows file\r\n\r\nBody.`);
    assert.equal(prepareGuideMarkdown(raw).trim(), `# Windows file\n\nBody.`);
});

test('leaves markdown without frontmatter unchanged', () => {
    const raw = `# Just Markdown\n\nNo frontmatter here.`;
    assert.equal(stripFrontmatter(raw), raw);
    assert.equal(prepareGuideMarkdown(raw), raw);
});

test('does not mistake a leading horizontal rule for frontmatter', () => {
    const raw = `---\n\nA guide that opens with a rule.\n\n---\n\nAnd carries on after a second one.`;
    assert.equal(stripFrontmatter(raw), raw);

    const rawWithText = `---\nNot a key line\n---\nBody`;
    assert.equal(stripFrontmatter(rawWithText), rawWithText);
});

test('prepareGuideMarkdown removes comments anywhere and carriage returns', () => {
    assert.equal(prepareGuideMarkdown('a\r\n<!-- note -->b'), 'a\nb');
});

test('handles non-string or empty input safely', () => {
    for (const strip of [stripFrontmatter, prepareGuideMarkdown]) {
        assert.equal(strip(''), '');
        assert.equal(strip(null), '');
        assert.equal(strip(undefined), '');
    }
});
