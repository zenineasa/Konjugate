/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { prepareGuideMarkdown } from '../src/exampleGuide/markdown.mjs';

const docsDirectory = join(import.meta.dirname, '..', 'docs');

// Parsed with the same YAML library the rest of the repo uses, so quoting, colons inside values and
// multi-line values behave the way any real OKF consumer would see them.
function parseFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!match) return null;
    const data = load(match[1]);
    return data && typeof data === 'object' ? data : null;
}

test('every non-reserved documentation file conforms to OKF specification', async () => {
    async function collectMarkdown(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        const files = [];
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...(await collectMarkdown(fullPath)));
            } else if (entry.name.endsWith('.md') && entry.name !== 'index.md' && entry.name !== 'log.md') {
                files.push(fullPath);
            }
        }
        return files;
    }

    const files = await collectMarkdown(docsDirectory);
    assert(files.length >= 30, 'Expected at least 30 concept markdown files.');

    for (const file of files) {
        const content = await readFile(file, 'utf8');
        const frontmatter = parseFrontmatter(content);
        assert(frontmatter, `${file} must contain a parseable YAML frontmatter block starting on line 1.`);
        assert(typeof frontmatter.type === 'string' && frontmatter.type.length > 0, `${file} must contain a non-empty 'type' field (OKF Rule 2).`);
        assert(typeof frontmatter.title === 'string' && frontmatter.title.length > 0, `${file} must contain a non-empty 'title' field.`);
        assert(typeof frontmatter.description === 'string' && frontmatter.description.length > 0, `${file} must contain a non-empty 'description' field.`);
        assert(Array.isArray(frontmatter.tags) && frontmatter.tags.length > 0, `${file} should contain a non-empty 'tags' array.`);
        assert(typeof frontmatter.status === 'string', `${file} should specify a 'status' field.`);
    }
});

test('index.md links point to existing files', async () => {
    for (const indexPath of [join(docsDirectory, 'index.md'), join(docsDirectory, 'proposals', 'index.md')]) {
        const content = await readFile(indexPath, 'utf8');
        const linkMatches = content.matchAll(/\* \[([^\]]+)\]\(([^)]+)\)/g);
        let linkCount = 0;
        for (const match of linkMatches) {
            linkCount++;
            const relativeTarget = match[2];
            const targetPath = join(dirname(indexPath), relativeTarget);
            try {
                await access(targetPath);
            } catch {
                assert.fail(`Broken link in ${indexPath}: ${relativeTarget} does not exist at ${targetPath}`);
            }
        }
        assert(linkCount > 0, `${indexPath} must contain index entries.`);
    }
});

test('all documentation files are indexed', async () => {
    const rootDocs = (await readdir(docsDirectory)).filter((f) => f.endsWith('.md') && f !== 'index.md');
    const rootIndex = await readFile(join(docsDirectory, 'index.md'), 'utf8');
    for (const file of rootDocs) {
        assert(rootIndex.includes(`](${file})`), `${file} is missing from docs/index.md`);
    }

    const proposalDocs = (await readdir(join(docsDirectory, 'proposals'))).filter((f) => f.endsWith('.md') && f !== 'index.md');
    const proposalIndex = await readFile(join(docsDirectory, 'proposals', 'index.md'), 'utf8');
    for (const file of proposalDocs) {
        assert(proposalIndex.includes(`](${file})`), `${file} is missing from docs/proposals/index.md`);
    }
});

test('runtime-displayed docs strip frontmatter completely before in-app display', async () => {
    for (const filename of ['welcome.md', 'causalInferenceInteractionHelp.md']) {
        const content = await readFile(join(docsDirectory, filename), 'utf8');
        const stripped = prepareGuideMarkdown(content);
        assert(!stripped.includes('type: Guide'), `${filename} should have its frontmatter stripped.`);
        assert(!stripped.startsWith('---'), `${filename} should not start with frontmatter delimiters after stripping.`);
        assert(stripped.length > 50, `${filename} content should remain non-empty.`);
    }
});

