/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The FMI compatibility page (examples/fmi/README.md) as a web page, put on the web edition's site at web.konjugate.com/fmi/ with each
// release (.github/workflows/webEdition.yml), beside the benchmark reports:
//
//   node scripts/fmiPage.mjs <site directory>
//
// writes an index.html rendered from the README, under the same Konjugate bar, tab icon and About box as the benchmark reports
// (benchmarks/lib/brand.mjs), and beside it each example's four files, under the same paths as in examples/fmi/, so they download from
// the page. The README's table of examples becomes a card per example with its downloads; its links to the rest of the repository
// become links to it on GitHub, and a link to a file that is not there stops the build, naming it. The README stays the one source:
// it is what GitHub shows, and what this page shows. Only the Markdown the README uses is understood (headings, paragraphs, lists,
// tables, fenced code, inline code, links, bold); anything else stops the build rather than showing wrongly. No dependencies.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { aboutFooter, brandBar, brandHead, brandStyles, links, logo, taglineHtml } from '../benchmarks/lib/brand.mjs';

const repositoryRoot = join(import.meta.dirname, '..');
const examplesDirectory = join(repositoryRoot, 'examples', 'fmi');
const source = 'examples/fmi';
export const pageUrl = 'https://web.konjugate.com/fmi/';
const escapeXml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const slug = (text) => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const size = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// The examples' folders and their files, in the order a reader wants them.
const fileOrder = [['.fmu', 'FMU'], ['_ref.csv', 'Reference result'], ['_ref.opt', 'Experiment'], ['Readme.txt', 'Readme']];
export function exampleFolders() {
    return readdirSync(examplesDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => {
        const files = readdirSync(join(examplesDirectory, name)).map((file) => {
            const kind = fileOrder.findIndex(([ending]) => file === (ending === 'Readme.txt' ? ending : `${name}${ending}`));
            if (kind < 0) throw new Error(`${source}/${name}/${file} is not one of an example's four files.`);
            return { file, kind, label: fileOrder[kind][1], bytes: statSync(join(examplesDirectory, name, file)).size };
        }).sort((a, b) => a.kind - b.kind);
        return { name, files };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

// The README as blocks: { type: 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'html', ... }.
export function parseMarkdown(markdown) {
    const lines = markdown.replace(/<!--[\s\S]*?-->/g, '').split('\n');
    const blocks = [];
    const startsBlock = (line) => /^(```|#{1,6} |\||- |<)/.test(line);
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
        } else if (line.startsWith('```')) {
            const end = lines.indexOf('```', i + 1);
            if (end < 0) throw new Error('A fenced code block in the README is not closed.');
            blocks.push({ type: 'code', text: lines.slice(i + 1, end).join('\n') });
            i = end + 1;
        } else if (/^#{1,6} /.test(line)) {
            const [, hashes, text] = line.match(/^(#{1,6}) (.*)$/);
            blocks.push({ type: 'heading', level: hashes.length, text });
            i++;
        } else if (line.startsWith('|')) {
            const rows = [];
            while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
            if (rows.length < 2 || !rows[1].every((cell) => /^:?-+:?$/.test(cell))) throw new Error(`A README table lacks its separator row: ${rows[0].join(' | ')}`);
            blocks.push({ type: 'table', head: rows[0], rows: rows.slice(2) });
        } else if (line.startsWith('- ')) {
            const items = [];
            while (i < lines.length && (lines[i].startsWith('- ') || (/^\s+\S/.test(lines[i]) && items.length))) {
                if (lines[i].startsWith('- ')) items.push(lines[i].slice(2));
                else items[items.length - 1] += ` ${lines[i].trim()}`;
                i++;
            }
            blocks.push({ type: 'list', items });
        } else if (line.startsWith('<')) {
            const start = i;
            while (i < lines.length && lines[i].trim()) i++;
            blocks.push({ type: 'html', text: lines.slice(start, i).join('\n') });
        } else {
            const start = i;
            while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) i++;
            blocks.push({ type: 'paragraph', text: lines.slice(start, i).join(' ') });
        }
    }
    return blocks;
}

// Where a README link goes on the page: an address elsewhere as it is, an example's folder to its card, an example's file to the copy
// beside the page, and anything else in the repository to it on GitHub.
function resolveLink(href, examples) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href;
    const [path, fragment] = href.split('#');
    const target = posix.normalize(posix.join(source, path)).replace(/\/$/, '');
    if (target.startsWith('..') || !existsSync(join(repositoryRoot, target))) throw new Error(`${source}/README.md links to ${href}, which is not in the repository.`);
    const inExamples = target.startsWith(`${source}/`) ? target.slice(source.length + 1) : null;
    if (inExamples && examples.some(({ name }) => name === inExamples)) return `#example-${slug(inExamples)}`;
    if (inExamples && examples.some(({ name, files }) => files.some(({ file }) => `${name}/${file}` === inExamples))) return inExamples;
    const kind = statSync(join(repositoryRoot, target)).isDirectory() ? 'tree' : 'blob';
    return `${links.source}/${kind}/master/${target}${fragment ? `#${fragment}` : ''}`;
}

// Inline Markdown: code spans, links (whose text may hold code) and bold; everything else is text.
function inline(text, examples) {
    let html = '';
    let last = 0;
    for (const match of text.matchAll(/`([^`]+)`|\[((?:[^\]`]|`[^`]*`)+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g)) {
        html += escapeXml(text.slice(last, match.index));
        const [, code, linkText, href, bold] = match;
        if (code !== undefined) html += `<code>${escapeXml(code)}</code>`;
        else if (linkText !== undefined) html += `<a href="${escapeXml(resolveLink(href, examples))}">${inline(linkText, examples)}</a>`;
        else html += `<strong>${inline(bold, examples)}</strong>`;
        last = match.index + match[0].length;
    }
    if (/[*_]{2}|\]\(|<[a-z]/i.test(text.slice(last))) throw new Error(`Markdown this page does not render, in: ${text}`);
    return html + escapeXml(text.slice(last));
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const cell = (text, examples) => (text === 'yes' || text === 'no' ? `<span class="badge ${text}">${text}</span>` : inline(text, examples));

function table({ head, rows }, examples) {
    return `<div class="scroll"><table><thead><tr>${head.map((text) => `<th>${inline(text, examples)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row) => `<tr>${row.map((text, column) => `<${column || head[0] ? 'td' : 'th scope="row"'}>${cell(text, examples)}</${column || head[0] ? 'td' : 'th'}>`).join('')}</tr>`).join('\n')}</tbody></table></div>`;
}

// The README's table of examples (its first column, Folder, links each example's folder) as a card per example, with its downloads.
function exampleCards({ head, rows }, examples) {
    const column = (name) => head.indexOf(name);
    if (['Folder', 'Model', 'FMI features it tests', 'Experiment'].some((name) => column(name) < 0)) throw new Error(`The README's table of examples has changed its columns: ${head.join(' | ')}`);
    if (rows.length !== examples.length) throw new Error(`The README's table of examples lists ${rows.length} examples; ${source} holds ${examples.length}.`);
    return `<div class="cards">${rows.map((row) => {
        const name = row[column('Folder')].match(/^\[([^\]]+)\]/)?.[1];
        const example = examples.find((candidate) => candidate.name === name);
        if (!example) throw new Error(`The README's table of examples names ${row[column('Folder')]}, which is not a folder of ${source}.`);
        const downloads = example.files.map(({ file, label, bytes }, index) => `<a class="${index ? 'file' : 'file primary'}" href="${escapeXml(`${name}/${file}`)}" download><span>${escapeXml(label)} <small>${size(bytes)}</small></span><code>${escapeXml(file)}</code></a>`).join('');
        return `<article class="card" id="example-${slug(name)}">
<h4>${escapeXml(name)}</h4>
<p>${inline(sentence(row[column('Model')]), examples)}</p>
<dl><dt>Tests</dt><dd>${inline(row[column('FMI features it tests')], examples)}</dd><dt>Experiment</dt><dd>${inline(row[column('Experiment')], examples)}</dd></dl>
<div class="downloads">${downloads}</div>
</article>`;
    }).join('\n')}</div>`;
}

export function renderPage() {
    const examples = exampleFolders();
    const blocks = parseMarkdown(readFileSync(join(examplesDirectory, 'README.md'), 'utf8'));
    const title = blocks.find((block) => block.type === 'heading' && block.level === 1)?.text;
    if (!title) throw new Error('The README has no title.');
    const description = 'Which FMI features Konjugate supports, with which tools its FMI import and export have been checked, how to repeat each check, and example FMUs exported by Konjugate with their reference results.';
    const sections = blocks.filter((block) => block.type === 'heading' && block.level === 2);
    const body = [];
    let contentsWritten = false;
    for (const block of blocks) {
        if (block.type === 'heading' && block.level === 1) continue;
        // The README's own logo: the page has the bar's, and the hero's.
        if (block.type === 'html' && /^<p><img src="[^"]*icon\.svg"[^>]*><\/p>$/.test(block.text)) continue;
        if (block.type === 'html') throw new Error(`HTML in the README this page does not render: ${block.text}`);
        if (block.type === 'heading' && block.level === 2 && !contentsWritten) {
            body.push(`<nav class="contents" aria-label="On this page"><span>On this page</span>${sections.map(({ text }) => `<a href="#${slug(text)}">${inline(text, examples)}</a>`).join('')}</nav>`);
            contentsWritten = true;
        }
        if (block.type === 'heading') body.push(`<h${block.level} id="${slug(block.text)}">${inline(block.text, examples)}</h${block.level}>`);
        else if (block.type === 'paragraph') body.push(`<p>${inline(block.text, examples)}</p>`);
        else if (block.type === 'list') body.push(`<ul>${block.items.map((item) => `<li>${inline(item, examples)}</li>`).join('\n')}</ul>`);
        else if (block.type === 'code') body.push(`<pre><code>${escapeXml(block.text)}</code></pre>`);
        else if (block.head[0] === 'Folder') body.push(exampleCards(block, examples));
        else body.push(table(block, examples));
    }
    if (!body.some((html) => html.startsWith('<div class="cards">'))) throw new Error('The README has no table of examples (its first column named Folder).');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeXml(title)}</title>
${brandHead({ title, description, url: pageUrl, image: null })}
<style>
:root { color-scheme: light dark; --brand-width: 960px; --accent: #1a9e8f; --line: color-mix(in srgb, currentColor 14%, transparent); --tint: color-mix(in srgb, currentColor 4%, transparent); }
@media (prefers-color-scheme: dark) { :root { --accent: #5fd3c4; } }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, sans-serif; } main { max-width: 960px; margin: 0 auto; padding: 8px 24px 32px; }
a { color: var(--accent); } a:hover { text-decoration-thickness: 2px; }
.hero { display: flex; align-items: center; gap: 20px; margin: 32px 0 20px; } .hero svg { flex: none; border-radius: 18px; }
.hero h1 { margin: 0; font-size: clamp(28px, 5vw, 40px); line-height: 1.15; letter-spacing: -0.01em; } .hero .tagline { margin: 6px 0 0; }
.eyebrow { margin: 0 0 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
h2 { margin: 48px 0 12px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 26px; scroll-margin-top: 16px; } h3 { margin: 32px 0 8px; font-size: 20px; scroll-margin-top: 16px; }
h2 + p, h3 + p { margin-top: 0; }
.contents { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 28px 0 8px; font-size: 14px; } .contents span { opacity: 0.65; margin-right: 4px; }
.contents a { padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; color: inherit; } .contents a:hover { border-color: var(--accent); color: var(--accent); }
.scroll { overflow-x: auto; margin: 16px 0; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; line-height: 1.45; } th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { background: var(--tint); font-weight: 600; white-space: nowrap; } tbody tr:last-child > * { border-bottom: 0; } tbody th { font-weight: 500; }
.badge { display: inline-block; min-width: 2.6em; padding: 1px 8px; border-radius: 999px; font-size: 13px; font-weight: 600; text-align: center; }
.badge.yes { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); } .badge.no { background: var(--tint); opacity: 0.6; }
code { font: 0.88em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 1px 3px; border-radius: 4px; background: var(--tint); overflow-wrap: anywhere; }
pre { margin: 16px 0; padding: 14px 16px; overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--tint); } pre code { padding: 0; background: none; font-size: 13px; overflow-wrap: normal; }
ul { padding-left: 22px; } li { margin: 6px 0; }
.cards { display: grid; gap: 16px; margin: 16px 0 24px; }
.card { padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; scroll-margin-top: 16px; } .card:target { border-color: var(--accent); }
.card h4 { margin: 0 0 4px; font-size: 18px; } .card p { margin: 0 0 10px; }
.card dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0 0 14px; font-size: 14px; } .card dt { opacity: 0.65; } .card dd { margin: 0; }
.downloads { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.file { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; color: inherit; text-decoration: none; font-size: 14px; min-width: 0; }
.file:hover, .file:focus-visible { border-color: var(--accent); } .file span { font-weight: 600; } .file small { font-weight: 400; opacity: 0.6; margin-left: 4px; }
.file code { background: none; padding: 0; font-size: 12px; opacity: 0.85; overflow-wrap: anywhere; }
.file.primary { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); } .file.primary span { color: var(--accent); }
.source { margin-top: 40px; font-size: 14px; opacity: 0.75; }
${brandStyles}</style></head>
<body>
${brandBar({ homeLink: true })}
<main>
<header class="hero">${logo({ size: 72, prefix: 'hero' })}<div><p class="eyebrow">FMI · Functional Mock-up Interface</p><h1>${inline(title, examples)}</h1>${taglineHtml}</div></header>
${body.join('\n')}
<p class="source">This page is <a href="${escapeXml(`${links.source}/blob/master/${source}/README.md`)}">${source}/README.md</a> in Konjugate's repository, as of this release.</p>
</main>
${aboutFooter(`Get it from the <a href="${links.home}">Konjugate home page</a>, <a href="${links.web}">try it in your browser</a> or read <a href="${links.source}">its source</a>.</p>
<p>Something on this page you could not reproduce? <a href="${links.issues}">Open an issue</a>.`)}
</body></html>
`;
}

// Writes the page and the examples' files into `site`; returns the files written (site-relative).
export function writeFmiSite(site) {
    const html = renderPage();
    rmSync(site, { recursive: true, force: true });
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), html);
    const files = ['index.html'];
    for (const { name, files: exampleFiles } of exampleFolders()) {
        mkdirSync(join(site, name), { recursive: true });
        for (const { file } of exampleFiles) {
            copyFileSync(join(examplesDirectory, name, file), join(site, name, file));
            files.push(`${name}/${file}`);
        }
    }
    return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const site = process.argv[2];
    if (!site) {
        console.error('Name the site directory: node scripts/fmiPage.mjs <site directory>');
        process.exitCode = 1;
    } else {
        const files = writeFmiSite(site);
        console.log(`Wrote ${join(site, 'index.html')} and the ${files.length - 1} files of the examples.`);
    }
}
