/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A map of what the tests run, file by file under src/: the lines the unit tests run, the lines the interaction tests run (the
// main process and every window, the command line, and the web edition's pages), and the lines neither does. It is a map for deciding what to test next and what is
// tested twice, not a target: no number here passes or fails anything.
//
//   npm run coverage            runs both suites with coverage on (the interaction suite takes several minutes), then reports
//   node scripts/coverageReport.mjs <folder>   reports from a folder that already holds the coverage
//
// It reads V8's own coverage (NODE_V8_COVERAGE files, and the window's precise coverage written by
// tests/drivers/electronWindowDriver.mjs), so it needs no coverage package. A line counts as run when any of its code ran;
// a line with no code (blank, a comment, a lone brace) is left out. V8 reports blocks, not statements, so the counts are close
// to what a statement-level tool would say, not identical.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoot = join(root, 'src');

// Every coverage file in `folder` (and the folders in it), as V8 script entries.
async function scriptsIn(folder) {
    if (!existsSync(folder)) return [];
    const entries = [];
    for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const path = join(entry.parentPath ?? entry.path, entry.name);
        let result;
        try {
            ({ result } = JSON.parse(await readFile(path, 'utf8')));
        } catch {
            // Said, not passed over: a file left out would read as code no test runs.
            console.warn(`Left out ${relative(root, path)}: it cannot be read as coverage.`);
            continue;
        }
        if (Array.isArray(result)) entries.push(...result);
    }
    return entries;
}

// Of a script's text, which characters ran: the innermost range that holds a character says how often it ran.
function ranCharacters(length, functions) {
    const counts = new Uint32Array(length);
    const ranges = functions.flatMap((fn) => fn.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
    for (const range of ranges) counts.fill(Math.min(range.count, 0xffffffff), Math.max(0, range.startOffset), Math.min(length, range.endOffset));
    return counts;
}

// The lines of `text` that hold code, and of those, the ones where `counts` says something ran.
function lineCoverage(text, counts) {
    const lines = text.split('\n');
    const code = new Set();
    const ran = new Set();
    let offset = 0;
    let inBlockComment = false;
    lines.forEach((line, index) => {
        const trimmed = line.trim();
        let isCode = trimmed !== '' && !/^[{}()[\];,]*$/.test(trimmed);
        if (inBlockComment) { isCode = false; if (trimmed.includes('*/')) inBlockComment = false; }
        else if (trimmed.startsWith('/*')) { isCode = false; inBlockComment = !trimmed.includes('*/'); }
        else if (trimmed.startsWith('//') || trimmed.startsWith('*')) isCode = false;
        if (isCode) {
            code.add(index);
            const start = offset + (line.length - line.trimStart().length);
            for (let at = start; at < offset + line.length; at += 1) {
                if (counts[at] > 0) { ran.add(index); break; }
            }
        }
        offset += line.length + 1;
    });
    return { code, ran };
}

// For each file under src/, the lines that hold code and the lines `entries` ran, joined across every process that loaded it.
async function coverageBySource(entries) {
    const byFile = new Map();
    for (const script of entries) {
        let path;
        try { path = script.url.startsWith('file:') ? fileURLToPath(script.url.split('?')[0]) : null; } catch { path = null; }
        if (!path || !path.startsWith(sourceRoot + '/') || path.includes('/generated/')) continue;
        if (!byFile.has(path)) {
            const text = await readFile(path, 'utf8').catch(() => null);
            if (text === null) continue;
            byFile.set(path, { text, counts: new Uint32Array(text.length) });
        }
        const file = byFile.get(path);
        const counts = ranCharacters(file.text.length, script.functions);
        for (let at = 0; at < counts.length; at += 1) if (counts[at] > file.counts[at]) file.counts[at] = counts[at];
    }
    const result = new Map();
    for (const [path, { text, counts }] of byFile) result.set(path, lineCoverage(text, counts));
    return result;
}

async function sourceFiles(folder = sourceRoot) {
    const files = [];
    for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
        const path = join(entry.parentPath ?? entry.path, entry.name);
        if (entry.isFile() && /\.(mjs|js|cjs)$/.test(entry.name) && !path.includes('/generated/')) files.push(path);
    }
    return files.sort();
}

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

async function report(folder) {
    const unit = await coverageBySource(await scriptsIn(join(folder, 'unit')));
    const interaction = await coverageBySource(await scriptsIn(join(folder, 'interaction')));
    const rows = [];
    for (const path of await sourceFiles()) {
        const text = await readFile(path, 'utf8');
        const { code } = lineCoverage(text, new Uint32Array(text.length));
        const unitRan = unit.get(path)?.ran ?? new Set();
        const interactionRan = interaction.get(path)?.ran ?? new Set();
        const either = new Set([...unitRan, ...interactionRan]);
        const both = [...unitRan].filter((line) => interactionRan.has(line)).length;
        const neither = [...code].filter((line) => !either.has(line));
        rows.push({ file: relative(root, path), lines: code.size, unit: unitRan.size, interaction: interactionRan.size, either: either.size, both, neither });
    }
    const total = (key) => rows.reduce((sum, row) => sum + (Array.isArray(row[key]) ? row[key].length : row[key]), 0);
    const width = Math.max(...rows.map((row) => row.file.length), 4);
    const line = (file, lines, unitText, interactionText, eitherText, neitherCount) => `${file.padEnd(width)}  ${String(lines).padStart(6)}  ${unitText.padStart(5)}  ${interactionText.padStart(11)}  ${eitherText.padStart(6)}  ${String(neitherCount).padStart(7)}`;
    const out = [
        `Coverage of src/, by line of code (blank lines and comments left out). "Run by neither" is the number of lines no test runs.`,
        '',
        line('file', 'lines', 'unit', 'interaction', 'either', 'neither'),
        ...rows.map((row) => line(row.file, row.lines, percent(row.unit, row.lines), percent(row.interaction, row.lines), percent(row.either, row.lines), row.neither.length)),
        '',
        line('all of src/', total('lines'), percent(total('unit'), total('lines')), percent(total('interaction'), total('lines')), percent(total('either'), total('lines')), total('neither')),
        `Run by both suites: ${percent(total('both'), total('lines'))} of the lines.`,
        '',
        'Files no test runs at all:',
        ...rows.filter((row) => row.lines && !row.either).map((row) => `  ${row.file} (${row.lines} lines)`),
        '',
        'The most lines run by neither:',
        ...[...rows].sort((a, b) => b.neither.length - a.neither.length).slice(0, 15).map((row) => `  ${String(row.neither.length).padStart(5)}  ${row.file}`)
    ];
    const text = out.join('\n');
    await writeFile(join(folder, 'report.txt'), `${text}\n`);
    // Every line run by neither, by file, for looking at what they are.
    await writeFile(join(folder, 'notRun.json'), JSON.stringify(Object.fromEntries(rows.filter((row) => row.neither.length).map((row) => [row.file, row.neither.map((index) => index + 1)])), null, 1));
    console.log(text);
    console.log(`\nWritten to ${relative(root, join(folder, 'report.txt'))}, and each line run by neither to notRun.json.`);
}

const [folderArgument] = process.argv.slice(2);
if (folderArgument) {
    await report(resolve(folderArgument));
} else {
    const folder = join(root, 'out', 'coverage');
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    console.log('Unit tests, with coverage…');
    const unit = spawnSync('node', ['--test'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: join(folder, 'unit') } });
    console.log('Interaction tests, with coverage (several minutes)…');
    const interaction = spawnSync('node', [join(root, 'scripts', 'runInteractionTests.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, KONJUGATE_INTERACTION_COVERAGE: join(folder, 'interaction') } });
    // The command line runs the app itself, so it is counted with the interaction tests.
    console.log('Command-line tests, with coverage…');
    const cli = spawnSync('node', ['--test', join(root, 'tests', 'cliMode.e2e.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: join(folder, 'interaction', 'cli') } });
    // The web edition's suite, counted with the interaction tests, when its shell has been built (npm run build:web:threads, then
    // npm run build:webShell:threads; not done here, as building the web engine takes minutes). A shell built from older sources
    // than src/ is measured only where its files still match.
    let web = { status: 0 };
    if (existsSync(join(root, 'out', 'webShellThreads', 'renderer', 'index.html'))) {
        console.log('Interaction tests in the web edition, with coverage (several minutes)…');
        web = spawnSync('node', [join(root, 'scripts', 'runWebInteractionTests.mjs')], { cwd: root, stdio: 'inherit', env: { ...process.env, KONJUGATE_INTERACTION_COVERAGE: join(folder, 'interaction', 'web') } });
    } else {
        console.log('No web shell built, so the web edition is not measured: npm run build:web:threads && npm run build:webShell:threads.');
    }
    if (unit.status || interaction.status || cli.status || web.status) console.log('\nSome tests failed; the coverage is of what ran.');
    await report(folder);
}
