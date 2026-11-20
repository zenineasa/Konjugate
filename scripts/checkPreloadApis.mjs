/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Finds what a window's preload offers its page that the page never uses: each member of an object a preload exposes
// (contextBridge.exposeInMainWorld('engine', { start, cancel, ... })) is looked for in the code that window loads, its page's modules
// and everything they import. A member nothing there uses is left behind, and often so is the IPC handler behind it, which
// scripts/checkIpcChannels.mjs then counts as used, since the preload still asks for it.
//
// Pages pass these objects around under other names (`const api = window.twin`, `store: window.inputBindings`), which a check of text
// cannot follow; so a member counts as used wherever its name is read as a property (`.start`) or named in braces (`{ start }`). That
// misses an unused member whose name is common, never reports one that is used. An object several windows expose with the same
// members (appUpdate, in the project window and the example guide) is one interface offered in each: a member any of them uses is
// used. The preloads whose pages are add-ons' (addonPreload.cjs, launcherPreload.cjs) are interfaces for code outside this repository,
// and are not checked.
//
// Part of `npm run lint:deadcode`; exits 1 when it finds any.
//
//   node scripts/checkPreloadApis.mjs [source folder, src/ by default]

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function preloads(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const found = await Promise.all(entries.map((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'generated' ? [] : preloads(path);
        return /^(preload\.mjs|preload\.cjs|[A-Za-z]+Preload\.cjs)$/.test(entry.name) ? [path] : [];
    }));
    return found.flat();
}

// The page a preload serves: the project window's (src/preload.mjs) is src/renderer/index.html; any other's sits beside it. None, for a
// preload whose pages are add-ons'.
function pageOf(sourceRoot, preload) {
    const page = relative(sourceRoot, preload) === 'preload.mjs' ? join(sourceRoot, 'renderer', 'index.html') : join(dirname(preload), 'index.html');
    return basename(preload) !== 'preload.mjs' && basename(preload) !== 'preload.cjs' ? null : existsSync(page) ? page : null;
}

// Each object the preload exposes, with its members: the keys of the object literal handed to exposeInMainWorld, at its top level.
function exposed(text) {
    const objects = new Map();
    for (const match of text.matchAll(/exposeInMainWorld\(\s*['"](\w+)['"]\s*,\s*(?:Object\.freeze\(\s*)?\{/g)) {
        const members = [];
        let depth = 1;
        for (let index = match.index + match[0].length - 1; index < text.length && depth; index += 1) {
            const character = text[index];
            if ('{(['.includes(character) && index > match.index + match[0].length - 1) depth += 1;
            else if ('})]'.includes(character)) depth -= 1;
            // A member starts the object or follows a comma or a line break at the object's own level.
            if (depth === 1 && (index === match.index + match[0].length - 1 || character === ',' || character === '\n')) {
                const member = text.slice(index + 1).match(/^\s*(?:\/\/[^\n]*\n\s*)*(?:async\s+)?(\w+)\s*(?::|\()/);
                if (member && !members.includes(member[1])) members.push(member[1]);
            }
        }
        objects.set(match[1], members);
    }
    return objects;
}

// Every module a page loads: those its HTML names, and what they import, statically or dynamically, transitively (relative paths).
async function pageModules(page) {
    const html = await readFile(page, 'utf8');
    const queue = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].filter((match) => !/^https?:|node_modules/.test(match[1])).map((match) => resolve(dirname(page), match[1]));
    const seen = new Map();
    while (queue.length) {
        const file = queue.pop();
        if (seen.has(file) || !existsSync(file)) continue;
        const text = await readFile(file, 'utf8');
        seen.set(file, text);
        for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(resolve(dirname(file), match[1]));
    }
    return { html, code: [...seen.values()].join('\n'), count: seen.size };
}

const reads = (text, member) => new RegExp(String.raw`\.\s*${member}\b|[{,]\s*${member}\s*[,}:]|\[\s*['"]${member}['"]\s*\]`).test(text);

// What the check finds in a source folder: { findings: [{ title, entries }], checked, skipped }.
export async function preloadApiFindings(sourceRoot) {
    const windows = [];
    const skipped = [];
    for (const preload of await preloads(sourceRoot)) {
        const page = pageOf(sourceRoot, preload);
        const file = relative(dirname(sourceRoot), preload);
        if (!page) {
            skipped.push(file);
            continue;
        }
        windows.push({ file, objects: exposed(await readFile(preload, 'utf8')), page: await pageModules(page) });
    }
    // One interface offered in several windows: the same object name with the same members.
    const shape = (members) => [...members].sort().join(',');
    const unused = [];
    for (const window of windows) {
        for (const [object, members] of window.objects) {
            const sharing = windows.filter((other) => other.objects.has(object) && shape(other.objects.get(object)) === shape(members));
            for (const member of members) {
                if (!sharing.some((other) => reads(other.page.code + other.page.html, member))) unused.push(`${object}.${member}  (${window.file})`);
            }
        }
    }
    return {
        findings: unused.length ? [{ title: 'Offered to a window by its preload, used by nothing the window loads', entries: unused }] : [],
        checked: windows.map((window) => ({ file: window.file, members: [...window.objects.values()].flat().length, modules: window.page.count })),
        skipped
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { findings, checked, skipped } = await preloadApiFindings(resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'src')));
    const counted = `${checked.reduce((sum, window) => sum + window.members, 0)} members in ${checked.length} windows; ${skipped.length} add-on interfaces not checked (${skipped.join(', ')})`;
    if (findings.length) {
        console.log(findings.map(({ title, entries }) => [`${title} (${entries.length}):`, ...entries.map((entry) => `  ${entry}`), ''].join('\n')).join('\n'));
        console.log(`Preload interfaces: ${counted}.`);
        process.exit(1);
    }
    console.log(`Preload interfaces: every member used (${counted}).`);
}
