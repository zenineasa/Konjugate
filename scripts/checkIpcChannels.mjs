/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Matches the desktop app's IPC channels end to end, which a dead-code tool cannot: a channel is a name in a string, handled in the
// main process (ipcMain.handle / on) and asked for from a window's preload (ipcRenderer.invoke / send), or sent from the main
// process (webContents.send) and listened for in a preload (ipcRenderer.on). Reports, by channel name:
//
//   - asked for by a window, handled by nothing in the main process (a call that can only fail or hang)
//   - handled in the main process, asked for by no window (a handler left behind)
//   - sent to windows, listened for by no window (a message nobody reads)
//   - listened for by a window, sent by nothing (a listener for a message that never comes)
//   - asked for one way and handled the other (an invoke answered by ipcMain.on, a send by ipcMain.handle)
//
// Part of `npm run lint:deadcode`; exits 1 when it finds any. A channel name it cannot read (one passed in a variable) is reported as
// such, unless it goes through a one-line wrapper whose own calls name it (preload.mjs's invokePlainly, main.mjs's tellProjectWindows),
// which are found and read as the calls they wrap.
//
//   node scripts/checkIpcChannels.mjs [source folder, src/ by default]

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function sourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
        return /\.(mjs|cjs|js)$/.test(entry.name) ? [path] : [];
    }));
    return files.flat();
}

// A preload runs in a window and speaks for it; the web edition's shims and the windows' own pages never touch IPC.
const isPreload = (path) => /(^|[/\\])(preload\.mjs|[A-Za-z]*Preload\.cjs|preload\.cjs)$/.test(path);

// The source without its comment lines, which may mention a channel without using it; line numbers are kept.
const code = (text) => text.split('\n').map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line));

// A channel named in a string; named groups, as the pattern is put after others and a numbered back-reference would move with them.
const name = String.raw`\s*(?<quote>['"])(?<channel>[A-Za-z][A-Za-z0-9_:.-]*)\k<quote>`;
// What the check finds in a source folder: { findings: [{ title, entries }], counts }, each entry a channel and where it is used.
export async function ipcChannelFindings(sourceRoot) {
    const channels = { handled: new Map(), asked: new Map(), sent: new Map(), heard: new Map() };
    const unreadable = [];
    const add = (map, channel, kind, where) => {
        if (!map.has(channel)) map.set(channel, []);
        map.get(channel).push({ kind, where });
    };

    for (const path of await sourceFiles(sourceRoot)) {
        const lines = code(await readFile(path, 'utf8'));
        const file = relative(dirname(sourceRoot), path);
        const preload = isPreload(path);
        // Small wrappers that pass their first parameter on as the channel, on one line or a few: `const invokePlainly = (channel, ...args) =>
        // ipcRenderer.invoke(channel, ...)`, `const tellProjectWindows = (channel, value) => { for (...) window.webContents.send(channel, value); }`.
        const wrappers = new Map();
        // Each keeps the lines it spans: only the call inside it passes its parameter on as a channel, not a variable of the same name elsewhere.
        const text = lines.join('\n');
        const lineOf = (offset) => text.slice(0, offset).split('\n').length - 1;
        for (const wrapper of text.matchAll(/(?:const|function)\s+(\w+)\s*=?\s*\(\s*(\w+)[^)]*\)\s*(?:=>)?\s*\{?[^;]{0,200}?(ipcRenderer\.(?:invoke|send|sendSync|on|once)|\.send)\(\s*\2\b/g)) {
            wrappers.set(wrapper[1], { parameter: wrapper[2], call: wrapper[3], from: lineOf(wrapper.index), to: lineOf(wrapper.index + wrapper[0].length) });
        }
        const insideWrapper = (variable, index) => [...wrappers.values()].some((wrapper) => wrapper.parameter === variable && index >= wrapper.from && index <= wrapper.to);
        lines.forEach((line, index) => {
            const where = `${file}:${index + 1}`;
            const each = (pattern, onMatch) => { for (const match of line.matchAll(new RegExp(pattern, 'g'))) onMatch(match); };
            if (preload) {
                each(String.raw`ipcRenderer\.(invoke|send|sendSync)\(${name}`, (match) => add(channels.asked, match.groups.channel, match[1] === 'invoke' ? 'invoke' : 'send', where));
                each(String.raw`ipcRenderer\.(on|once)\(${name}`, (match) => add(channels.heard, match.groups.channel, match[1], where));
                for (const [wrapper, { call }] of wrappers) {
                    each(String.raw`\b${wrapper}\(${name}`, (match) => {
                        const kind = call.endsWith('invoke') ? 'invoke' : /\.(on|once)$/.test(call) ? 'on' : 'send';
                        add(kind === 'on' ? channels.heard : channels.asked, match.groups.channel, kind, where);
                    });
                }
                each(String.raw`ipcRenderer\.(invoke|send|sendSync|on|once)\(\s*([A-Za-z_]\w*)`, (match) => {
                    if (!insideWrapper(match[2], index)) unreadable.push(`${where}: ipcRenderer.${match[1]}(${match[2]}, ...)`);
                });
            } else {
                each(String.raw`ipcMain\.(handle|handleOnce)\(${name}`, (match) => add(channels.handled, match.groups.channel, 'invoke', where));
                each(String.raw`ipcMain\.(on|once)\(${name}`, (match) => add(channels.handled, match.groups.channel, 'send', where));
                each(String.raw`\.send\(${name}`, (match) => add(channels.sent, match.groups.channel, 'send', where));
                for (const [wrapper] of wrappers) each(String.raw`\b${wrapper}\(${name}`, (match) => add(channels.sent, match.groups.channel, 'send', where));
                each(String.raw`webContents\.send\(\s*([A-Za-z_]\w*)`, (match) => {
                    if (!insideWrapper(match[1], index)) unreadable.push(`${where}: webContents.send(${match[1]}, ...)`);
                });
            }
        });
    }

    const findings = [];
    const report = (title, entries) => { if (entries.length) findings.push({ title, entries }); };
    const at = (uses) => uses.map((use) => use.where).join(', ');
    report('Asked for by a window, handled by nothing in the main process',
        [...channels.asked].filter(([channel]) => !channels.handled.has(channel)).map(([channel, uses]) => `${channel}  (${at(uses)})`));
    report('Handled in the main process, asked for by no window',
        [...channels.handled].filter(([channel]) => !channels.asked.has(channel)).map(([channel, uses]) => `${channel}  (${at(uses)})`));
    report('Sent to windows, listened for by no window',
        [...channels.sent].filter(([channel]) => !channels.heard.has(channel)).map(([channel, uses]) => `${channel}  (${at(uses)})`));
    report('Listened for by a window, sent by nothing in the main process',
        [...channels.heard].filter(([channel]) => !channels.sent.has(channel)).map(([channel, uses]) => `${channel}  (${at(uses)})`));
    report('Asked for one way and handled another (invoke needs ipcMain.handle, send needs ipcMain.on)',
        [...channels.asked].flatMap(([channel, uses]) => {
            const handled = new Set((channels.handled.get(channel) ?? []).map((use) => use.kind));
            return handled.size ? uses.filter((use) => !handled.has(use.kind)).map((use) => `${channel}: ${use.kind} at ${use.where}, handled by ipcMain.${use.kind === 'invoke' ? 'on' : 'handle'} at ${at(channels.handled.get(channel))}`) : [];
        }));
    report('Channel names this check cannot read (pass a literal, or go through a one-line wrapper)', unreadable);
    return { findings, counts: { handled: channels.handled.size, asked: channels.asked.size, sent: channels.sent.size, heard: channels.heard.size } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const { findings, counts } = await ipcChannelFindings(resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'src')));
    const counted = `${counts.handled} handled, ${counts.asked} asked for, ${counts.sent} sent, ${counts.heard} listened for`;
    if (findings.length) {
        console.log(findings.map(({ title, entries }) => [`${title} (${entries.length}):`, ...entries.map((entry) => `  ${entry}`), ''].join('\n')).join('\n'));
        console.log(`IPC channels: ${counted}.`);
        process.exit(1);
    }
    console.log(`IPC channels: every one matched (${counted}).`);
}
