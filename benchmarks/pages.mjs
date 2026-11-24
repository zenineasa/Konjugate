/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The published benchmark reports as a static site, put on the web edition's site at web.konjugate.com/benchmarks/ with each release
// (.github/workflows/webEdition.yml) and built and checked on every push of new results (.github/workflows/benchmarkReports.yml):
//
//   node benchmarks/pages.mjs <site directory>
//
// writes an index.html listing each computer's combined report, its data, the sessions combined into it and the superseded ones (from
// each computer's combined.json, written by combine.mjs), and beside it only the files of benchmarks/results/ those pages need: the files
// the index links to and, page by page, every file they link to in turn, under the same paths as in results/. So the combined report, its
// data and plots, and every combined session's own reports are published; a superseded session's report only when it is at most
// largestSupersededPage, and otherwise the index links to it in the repository. Every link is relative, so the site works at any address,
// and a link to a file that is not there stops the build, naming it. Nothing in the repository changes and nothing is timed; the copy
// differs from results/ only in one correction to old sessions' links, below. No dependencies, so a CI job runs it without npm ci.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

const repositoryRoot = join(import.meta.dirname, '..');
const results = join(repositoryRoot, 'benchmarks', 'results');
// A superseded session's own report larger than this (a problems report, with every plot inside it, is about 9 MB) is left in the repository.
export const largestSupersededPage = 2 ** 20;
const toPosix = (path) => path.split(sep).join('/');
const escapeXml = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const utc = (iso) => (iso ? `${iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '')} UTC` : 'not recorded');
const repositoryUrl = (() => {
    const repository = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).repository;
    const url = typeof repository === 'string' ? repository : repository?.url;
    return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null;
})();

const commitLink = (entry) => (entry?.commitUrl ? `<a href="${escapeXml(entry.commitUrl)}"><code>${escapeXml(entry.gitCommit)}</code></a>` : `<code>${escapeXml(entry?.gitCommit ?? 'not recorded')}</code>`);
function commitText(entry, base) {
    if (entry.provenance) {
        return `built from ${commitLink(entry.provenance.builtFrom)} with uncommitted changes${entry.provenance.committedAs ? `, committed as ${commitLink(entry.provenance.committedAs)}` : ''} (<a href="${escapeXml(`${base}/${entry.provenance.file}`)}">provenance</a>)`;
    }
    const dirty = entry.workingTreeChanges && !(Array.isArray(entry.uncommittedSources) && !entry.uncommittedSources.length);
    return `${commitLink(entry)}${dirty ? ' (uncommitted changes)' : ''}`;
}

// A session part's own report, where it wrote one.
const partReports = { problems: 'problems/report.html', scaling: 'scaling/report.html', comparisons: 'comparisons/performance.html', openmodelica: 'openmodelica/performance.html' };
function partLink(machine, entry, combined) {
    const path = `${machine}/sessions/${entry.session}/${partReports[entry.part] ?? ''}`;
    if (!partReports[entry.part] || !existsSync(join(results, path))) return escapeXml(entry.part);
    if (combined || statSync(join(results, path)).size <= largestSupersededPage) return `<a href="${escapeXml(path)}">${escapeXml(entry.part)}</a>`;
    const size = `${(statSync(join(results, path)).size / 2 ** 20).toFixed(1)} MB`;
    return repositoryUrl ? `<a href="${escapeXml(`${repositoryUrl}/blob/master/benchmarks/results/${path}`)}">${escapeXml(entry.part)}</a> (${size}, in the repository)` : `${escapeXml(entry.part)} (${size}, in the repository)`;
}

function machineSection(machine) {
    const combined = JSON.parse(readFileSync(join(results, machine, 'combined.json'), 'utf8'));
    const m = combined.machine;
    const description = m ? [m.model, m.chip ?? m.cpu, `${m.logicalProcessors} cores`, `${Math.round(m.memoryBytes / 2 ** 30)} GiB`, m.operatingSystem].filter(Boolean).join(' · ') : machine;
    const data = ['combined.json', 'timings.csv', 'comparisons/comparisons.csv', 'comparisons/performance.html'].filter((file) => existsSync(join(results, machine, file)))
        .map((file) => `<a href="${escapeXml(`${machine}/${file}`)}">${escapeXml(file)}</a>`).join(' · ');
    const row = (combinedPart) => (entry) => `<tr><td>${escapeXml(entry.session)}</td><td>${partLink(machine, entry, combinedPart)}</td><td>${escapeXml(utc(entry.startedAt))}</td><td>${escapeXml(entry.konjugateVersion ?? 'not recorded')}, ${commitText(entry, machine)}</td></tr>`;
    const table = (entries, combinedParts) => `<div class="scroll"><table><thead><tr><th>Session</th><th>Part (its own report)</th><th>Started</th><th>Konjugate, commit</th></tr></thead><tbody>${entries.map(row(combinedParts)).join('')}</tbody></table></div>`;
    return `<section><h2>${escapeXml(description)}</h2>
<p><strong><a href="${escapeXml(`${machine}/report.html`)}">The combined report</a></strong>${combined.source ? `, timed from Konjugate ${escapeXml(combined.source.konjugateVersion ?? 'version not recorded')}, the engine ${combined.source.provenance ? commitText(combined.source, machine) : `built from commit ${commitText(combined.source, machine)}`}` : ''}. Its data: ${data}; every session's own results are in ${repositoryUrl ? `<a href="${escapeXml(`${repositoryUrl}/tree/master/benchmarks/results/${machine}/sessions`)}">the repository</a>` : 'the repository'}.</p>
<h3>Combined sessions</h3>${table(combined.sessionParts ?? [], true)}
${combined.supersededSessions?.length ? `<h3>Superseded sessions</h3><p>Timed from an older source, so not combined: kept for the record, none of their numbers are in the combined report.</p>${table(combined.supersededSessions, false)}` : ''}
</section>`;
}

// The relative links of an HTML page: href and src values that name a file, not a page elsewhere or a place on this one.
export function relativeLinks(html) {
    return [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map(([, value]) => value.replaceAll('&amp;', '&').split('#')[0])
        .filter((value) => value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//'));
}

// The copy of a results file the site publishes: sessions' own performance.html, written before comparisons/report.mjs linked a
// standalone page's data from plots/, link it from comparisons/plots/, which from inside comparisons/ is not there.
function publishedCopy(path) {
    const bytes = readFileSync(join(results, path));
    return /^[^/]+\/sessions\/[^/]+\/comparisons\/performance\.html$/.test(path) ? Buffer.from(bytes.toString('utf8').replaceAll('href="comparisons/plots/', 'href="plots/')) : bytes;
}

// Writes the site; returns its files (site-relative) and their bytes in all.
export function writeSite(site) {
    if (resolve(site).startsWith(resolve(results))) throw new Error('The site directory must be outside benchmarks/results/.');
    const machines = readdirSync(results).filter((name) => statSync(join(results, name)).isDirectory() && existsSync(join(results, name, 'combined.json'))).sort();
    if (!machines.length) throw new Error(`No combined results under ${results}: run npm run benchmark:combine.`);
    rmSync(site, { recursive: true, force: true });
    mkdirSync(site, { recursive: true });
    const index = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Konjugate benchmark reports</title>
<style>
:root { color-scheme: light dark; } body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; } main { max-width: 1100px; margin: 0 auto; padding: 24px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #8884; vertical-align: top; } .scroll { overflow-x: auto; }
h2 { margin-top: 36px; padding-top: 12px; border-top: 1px solid #8884; }
</style></head>
<body><main>
<h1>Konjugate benchmark reports</h1>
<p>Konjugate evaluated against established benchmarks and tools, reproducibly: timing sessions on one documented computer each, combined into one report per computer. These pages are the reports committed under <code>benchmarks/results/</code>${repositoryUrl ? ` in <a href="${escapeXml(`${repositoryUrl}/tree/master/benchmarks/results`)}">the repository</a>` : ''}, unchanged, as of this release, where all the raw data is; how they were measured, and how to reproduce them, is in ${repositoryUrl ? `<a href="${escapeXml(`${repositoryUrl}/blob/master/benchmarks/README.md`)}">benchmarks/README.md</a>` : 'benchmarks/README.md'}. Timings are of that computer only.</p>
${machines.map(machineSection).join('\n')}
</main></body></html>
`;
    writeFileSync(join(site, 'index.html'), index);
    // Every file the index links to, and every file those link to in turn, copied under its path in results/.
    const published = new Map([['index.html', Buffer.byteLength(index)]]);
    const missing = [];
    const pending = relativeLinks(index).map((link) => ({ from: 'index.html', path: toPosix(normalize(link)) }));
    while (pending.length) {
        const { from, path } = pending.shift();
        if (published.has(path)) continue;
        if (path.startsWith('..') || !existsSync(join(results, path)) || statSync(join(results, path)).isDirectory()) {
            missing.push(`${from} links to ${path}`);
            continue;
        }
        const bytes = publishedCopy(path);
        mkdirSync(join(site, dirname(path)), { recursive: true });
        writeFileSync(join(site, path), bytes);
        published.set(path, bytes.length);
        if (path.endsWith('.html')) {
            for (const link of relativeLinks(bytes.toString('utf8'))) pending.push({ from: path, path: toPosix(normalize(join(dirname(path), link))) });
        }
    }
    if (missing.length) throw new Error(`Links to files that are not in benchmarks/results/:\n  ${missing.join('\n  ')}`);
    return { files: [...published.keys()].sort(), bytes: [...published.values()].reduce((sum, size) => sum + size, 0) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const site = process.argv[2];
    if (!site) {
        console.error('Name the site directory: node benchmarks/pages.mjs <site directory>');
        process.exitCode = 1;
    } else {
        const { files, bytes } = writeSite(site);
        console.log(`Wrote ${join(site, 'index.html')} and the ${files.length - 1} files of benchmarks/results/ it needs: ${(bytes / 2 ** 20).toFixed(1)} MiB in all.`);
    }
}
