// Copyright © 2026 Zenin Easa Panthakkalakath

// Writes src/programSdkNames.mjs: the public names of program SDK version 2 with their one-line documentation, for the code editor's
// completion and hover (docs/proposals/codeEditor.md, "Writing aids"). Read from the SDK itself, so the editor cannot drift from it:
// C++ from engine/include/konjugate/sdk/v2/program.hpp (the classes, structs and functions of konjugate::sdk::v2, each with the comment
// above it), Python from engine/sdk/python/konjugate/v2/__init__.py (__all__, each with its docstring). tests/programSdkNames.test.mjs
// fails when the file is not what this writes. Run: node scripts/generateProgramSdkNames.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
export const programSdkSources = {
    cpp: join(rootDirectory, 'engine', 'include', 'konjugate', 'sdk', 'v2', 'program.hpp'),
    python: join(rootDirectory, 'engine', 'sdk', 'python', 'konjugate', 'v2', '__init__.py')
};
const outputPath = join(rootDirectory, 'src', 'programSdkNames.mjs');

// The section of docs/programs.md ("Writing a program") each name is explained in, by its anchor; a name not listed goes to the page.
const sections = {
    Input: 'ports-defaults-and-units', Parameter: 'ports-defaults-and-units', Constant: 'ports-defaults-and-units', Output: 'ports-defaults-and-units',
    Port: 'ports-defaults-and-units', Default: 'ports-defaults-and-units', optional: 'ports-defaults-and-units', Inputs: 'ports-defaults-and-units',
    Outputs: 'ports-defaults-and-units', Setup: 'memory-advance-and-clocks-a-digital-pid-controller',
    Memory: 'memory-advance-and-clocks-a-digital-pid-controller', MemoryWriter: 'memory-advance-and-clocks-a-digital-pid-controller',
    Clock: 'memory-advance-and-clocks-a-digital-pid-controller', Step: 'memory-advance-and-clocks-a-digital-pid-controller',
    Random: 'randomness', random_seed: 'randomness', randomSeed: 'randomness', seedRandom: 'randomness',
    OutOfDomain: 'errors-and-outofdomain', Failure: 'errors-and-outofdomain', fail: 'errors-and-outofdomain',
    Jacobian: 'jacobians-for-stiff', Dependencies: 'jacobians-for-stiff', dependsOn: 'jacobians-for-stiff',
    Node: 'the-two-kinds', Relationship: 'the-two-kinds', Program: 'the-two-kinds'
};

// The first sentence of a comment or docstring, on one line.
function firstSentence(text) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    const end = flat.search(/[.:](\s|$)/);
    return (end >= 0 ? flat.slice(0, end + 1) : flat).replace(/:$/, '.');
}

// C++: what konjugate::sdk::v2 declares at its own level (not in detail, not a forward declaration), with the // comment just above.
function cppNames(header) {
    const names = [];
    const lines = header.split('\n');
    let depth = 0;
    let inV2 = false;
    let detailDepth = null;
    let comment = [];
    // A declaration written right after another with no blank line between (optional after Default, dependsOn after Dependencies)
    // shares its comment.
    let adjacentDoc = '';
    for (const raw of lines) {
        const line = raw.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
        const trimmed = raw.trim();
        if (!inV2 && /^namespace konjugate::sdk::v2\s*\{/.test(trimmed)) {
            inV2 = true;
            depth = 1;
            comment = [];
            continue;
        }
        if (!inV2) continue;
        if (depth === 1 && /^namespace detail\s*\{/.test(trimmed)) detailDepth = depth;
        if (depth === 1 && detailDepth === null) {
            if (trimmed.startsWith('//')) {
                comment.push(trimmed.replace(/^\/\/\s?/, ''));
            } else if (trimmed === '') {
                comment = [];
                adjacentDoc = '';
            } else if (!trimmed.startsWith('template')) {
                const type = /^(class|struct)\s+([A-Z]\w*)\b(?!\s*;)/.exec(trimmed);
                const fn = /^(?:\[\[\w+\]\]\s*)?(?:inline\s+|constexpr\s+)*[\w:<>]+\s+([a-z]\w*)\(/.exec(trimmed);
                const doc = firstSentence(comment.join(' ')) || adjacentDoc;
                if (type && !/;\s*$/.test(trimmed)) names.push({ name: type[2], kind: type[1], doc });
                else if (fn) names.push({ name: fn[1], kind: 'function', doc });
                if (type || fn) adjacentDoc = doc;
                comment = [];
            }
        }
        for (const character of line) {
            if (character === '{') depth += 1;
            if (character === '}') {
                depth -= 1;
                if (detailDepth !== null && depth === detailDepth) detailDepth = null;
            }
        }
        if (depth === 0) inV2 = false;
    }
    const seen = new Set();
    return names.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));
}

// Python: konjugate.v2's __all__, each with the first sentence of its docstring.
function pythonNames(module) {
    const all = /__all__\s*=\s*\[([\s\S]*?)\]/.exec(module);
    if (!all) throw new Error('konjugate.v2 has no __all__.');
    return [...all[1].matchAll(/"(\w+)"/g)].map(([, name]) => {
        const definition = new RegExp(`^(class|def) ${name}\\b[^\\n]*:\\n[ \\t]+(?:"""([\\s\\S]*?)"""|'''([\\s\\S]*?)''')?`, 'm').exec(module);
        return { name, kind: definition?.[1] === 'def' ? 'function' : 'class', doc: firstSentence(definition?.[2] ?? definition?.[3] ?? '') };
    });
}

export function programSdkNamesFromSources({ cpp, python }) {
    const withSection = (entry) => ({ ...entry, section: sections[entry.name] ?? '' });
    const python_ = pythonNames(python);
    // A C++ name the header leaves without a comment says what its Python namesake's docstring says.
    const pythonDoc = new Map(python_.map((entry) => [entry.name, entry.doc]));
    return { cpp: cppNames(cpp).map((entry) => ({ ...entry, doc: entry.doc || pythonDoc.get(entry.name) || '' })).map(withSection), python: python_.map(withSection) };
}

export function programSdkNamesModule(names) {
    return '/* Copyright © 2026 Zenin Easa Panthakkalakath */\n\n'
        + '// Generated by scripts/generateProgramSdkNames.mjs from the program SDK (engine/include/konjugate/sdk/v2/program.hpp and\n'
        + '// engine/sdk/python/konjugate/v2/__init__.py); do not edit. tests/programSdkNames.test.mjs fails when it is out of date.\n\n'
        + `export const programSdkNames = ${JSON.stringify(names, null, 4)};\n`;
}

export async function generatedProgramSdkNamesModule() {
    const [cpp, python] = await Promise.all([readFile(programSdkSources.cpp, 'utf8'), readFile(programSdkSources.python, 'utf8')]);
    return programSdkNamesModule(programSdkNamesFromSources({ cpp, python }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await writeFile(outputPath, await generatedProgramSdkNamesModule());
    console.log(`Wrote ${outputPath}.`);
}
