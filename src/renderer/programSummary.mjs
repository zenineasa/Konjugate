/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What a card shows of a program (docs/proposals/codeEditor.md, "The card: a summary, a preview and one button"): its declared name and
// language, at most one status, what it reads and sets in the model's names, and its first lines as a read-only, highlighted preview.
// Pure: the card (programSourceSection.mjs) draws it, and a unit test reads it.

import { programSourceVersion } from '../providerTemplate.mjs';

const previewLineCount = 6;

// The name a program declares itself by: its class (C++ `class PidController : public k::Node`, Python `class PidController(Node):`), or
// '' when none is found.
export function declaredProgramName(kind, source) {
    const text = String(source ?? '');
    const match = kind === 'python'
        ? /^\s*class\s+([A-Za-z_]\w*)\s*(?:\(|:)/m.exec(text)
        : /^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?:\s*public\b/m.exec(text) ?? /^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?\{/m.exec(text);
    return match?.[1] ?? '';
}

export function programLanguageName(kind) {
    return kind === 'python' ? 'Python' : 'C++';
}

// The lines the preview shows, with their numbers in the source: from the program's class declaration (what a person recognises it by),
// or from its first line when it declares none; at most six.
export function programPreviewLines(kind, source, count = previewLineCount) {
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    if (!String(source ?? '').trim()) return [];
    const name = declaredProgramName(kind, source);
    let start = name ? lines.findIndex((line) => new RegExp(`^\\s*(?:class|struct)\\s+${name}\\b`).test(line)) : -1;
    if (start < 0) start = Math.max(0, lines.findIndex((line) => line.trim() !== ''));
    return lines.slice(start, start + count).map((text, index) => ({ number: start + index + 1, text }));
}

const keywords = {
    cpp: new Set(['auto', 'bool', 'break', 'case', 'class', 'const', 'constexpr', 'continue', 'default', 'double', 'else', 'false', 'final', 'for', 'if',
        'int', 'namespace', 'nullptr', 'override', 'private', 'protected', 'public', 'return', 'static', 'struct', 'switch', 'this', 'throw', 'true',
        'using', 'virtual', 'void', 'while', 'std', 'size_t']),
    python: new Set(['and', 'as', 'class', 'def', 'elif', 'else', 'False', 'for', 'from', 'if', 'import', 'in', 'is', 'lambda', 'None', 'not', 'or',
        'pass', 'raise', 'return', 'self', 'True', 'while', 'with', 'yield'])
};

// One line in tokens for the preview's highlighting: { text, type } with type 'comment', 'string', 'number', 'keyword', 'preprocessor' or ''
// (plain). A plain line-by-line pass; a preview needs no more (a string or comment across lines is shown plain past its first line).
export function highlightProgramLine(kind, text) {
    const language = kind === 'python' ? 'python' : 'cpp';
    const tokens = [];
    const push = (value, type = '') => {
        if (!value) return;
        const last = tokens.at(-1);
        if (last && last.type === type) last.text += value;
        else tokens.push({ text: value, type });
    };
    if (language === 'cpp' && /^\s*#/.test(text)) return [{ text, type: 'preprocessor' }];
    const pattern = language === 'python'
        ? /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d*)?(?:[eE][-+]?\d+)?\b)|([A-Za-z_]\w*)/g
        : /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d*)?(?:[eE][-+]?\d+)?\b)|([A-Za-z_]\w*)/g;
    let index = 0;
    for (const match of text.matchAll(pattern)) {
        push(text.slice(index, match.index));
        const [whole, comment, string, number, word] = match;
        if (comment) push(whole, 'comment');
        else if (string) push(whole, 'string');
        else if (number) push(whole, 'number');
        else push(whole, keywords[language].has(word) ? 'keyword' : '');
        index = match.index + whole.length;
    }
    push(text.slice(index));
    return tokens;
}

// What the card's reads or sets line says: each binding in the model's names ("Room · Temperature"), or "measurement · not bound".
// entries: [{ key, label }], label null or '' for a port bound to nothing.
export function bindingsLine(entries) {
    return (entries ?? []).map((entry) => ({
        text: entry.label ? entry.label : `${entry.key} · not bound`,
        unbound: !entry.label
    }));
}

// The one status a card shows of a program, at most: an older program's way out, a problem the last lint or Check found on this exact
// source (with its line), or that Check passed on it. null when nothing is known. `record`: what the editor last said of this source,
// { problems: [{ line, message }], checkPassed }, or null.
export function programStatus(kind, source, record) {
    if (!String(source ?? '').trim()) return null;
    if (programSourceVersion(kind, source) === 1) return { kind: 'older', text: 'older format · Convert to version 2 ›' };
    const problems = record?.problems ?? [];
    if (problems.length) {
        const line = problems.find((problem) => Number.isInteger(problem.line) && problem.line >= 1)?.line ?? null;
        const count = `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`;
        return { kind: 'problem', text: line ? `${count} · line ${line} ›` : `${count} ›`, line };
    }
    if (record?.checkPassed) return { kind: 'passed', text: '✓ passed Check' };
    return null;
}

// The key a status is kept under: a status belongs to one exact source, and is not kept in the project.
export function programStatusKey(kind, source) {
    return `${kind}\u0000${source ?? ''}`;
}

// Everything the card shows of a program.
export function programSummary({ kind, source, reads = [], sets = [], record = null }) {
    const empty = !String(source ?? '').trim();
    return {
        empty,
        name: declaredProgramName(kind, source),
        language: programLanguageName(kind),
        status: programStatus(kind, source, record),
        reads: bindingsLine(reads),
        sets: bindingsLine(sets),
        preview: programPreviewLines(kind, source).map((line) => ({ ...line, tokens: highlightProgramLine(kind, line.text) }))
    };
}
