/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Converting a program from the older program format (version 1 of the SDK) to version 2 (docs/proposals/programSdkV2.md, Migration from
// version 1). Works on the source text and recognises the shapes the older templates and generators produce:
//
//   convertProgramToVersion2(kind, source)   { source, complete, kind: 'relationship' | 'node', notes }
//
// describe()'s ports become declarations; each read of an input (context.inputs.at("key"), inputs["key"]) becomes x[key] / x.key; each
// addGradient / add_gradient becomes a return (a relationship) or an output (a node), several to one key their sum. A program whose
// evaluate() changes no member, reads no step size and saves no checkpoint by hand is then complete. One that does is converted as far
// as its ports, with its evaluate() body kept and a comment at each place that needs a decision, and `complete` false: nothing claims a
// conversion it did not make. A source of another shape gets the version 2 template with the ports found, and the older program kept,
// commented, below it.

import { cppMember, pythonAttribute } from './providerTemplate.mjs';

const identifier = /^[a-z][A-Za-z0-9]*$/;

// The index just past the bracket matching the one at `open` (which must be an opening bracket), skipping strings and comments.
function matchingBracket(text, open) {
    const pairs = { '(': ')', '{': '}', '[': ']' };
    const stack = [];
    for (let index = open; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"' || character === "'") {
            const quote = character;
            for (index += 1; index < text.length && text[index] !== quote; index += 1) if (text[index] === '\\') index += 1;
            continue;
        }
        if (character === '/' && text[index + 1] === '/') { index = text.indexOf('\n', index); if (index < 0) return -1; continue; }
        if (character === '/' && text[index + 1] === '*') { index = text.indexOf('*/', index + 2) + 1; if (index <= 0) return -1; continue; }
        if (pairs[character]) stack.push(pairs[character]);
        else if (character === ')' || character === '}' || character === ']') {
            if (stack.pop() !== character) return -1;
            if (!stack.length) return index + 1;
        }
    }
    return -1;
}

// Every port written in describe(): ScalarPort{"key", "name", "unit"} (C++) or ScalarPort("key", "name", "unit") (Python), each with
// the bracket group it is listed in, so a node program's inputs and outputs (two lists) can be told apart.
function describedPorts(text) {
    const ports = [];
    const pattern = /ScalarPort\s*[({]\s*(["'])([^"']*)\1\s*,\s*(["'])([^"']*)\3\s*(?:,\s*(["'])([^"']*)\5)?\s*[)}]/g;
    for (const match of text.matchAll(pattern)) {
        // The innermost list it is in: the nearest unclosed [ or { before it.
        let depth = 0;
        let group = -1;
        for (let index = match.index - 1; index >= 0; index -= 1) {
            const character = text[index];
            if (character === ']' || character === '}') depth += 1;
            else if (character === '[' || character === '{') {
                if (depth === 0) { group = index; break; }
                depth -= 1;
            }
        }
        ports.push({ key: match[2], unit: match[6] ?? '', group });
    }
    return ports;
}

// Splits ports into inputs and outputs: a relationship's last port is its output; a node's last list is its outputs.
function splitPorts(ports, node) {
    if (!ports.length) return { inputs: [], outputs: [] };
    if (!node) return { inputs: ports.slice(0, -1), outputs: ports.slice(-1) };
    const groups = [...new Set(ports.map((port) => port.group))];
    if (groups.length < 2) return { inputs: [], outputs: ports };
    const last = groups.at(-1);
    return { inputs: ports.filter((port) => port.group !== last), outputs: ports.filter((port) => port.group === last) };
}

function uniqueByKey(ports) {
    const seen = new Set();
    return ports.filter((port) => identifier.test(port.key) && !seen.has(port.key) && seen.add(port.key));
}

function className(source, kind) {
    const match = kind === 'cpp' ? /class\s+(\w+)\s*(?:final\s*)?:\s*public\s+[\w:]*(?:RelationshipProvider|NodeProvider)/.exec(source)
        : /class\s+(\w+)\s*\(\s*(?:\w+\.)?(?:RelationshipProvider|NodeProvider)\s*\)/.exec(source);
    return match?.[1] ?? 'Converted';
}

// The C++ method `name`'s parameter list and body, or null.
function cppMethod(source, name) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (const match of source.matchAll(pattern)) {
        const open = source.indexOf('(', match.index);
        const close = matchingBracket(source, open);
        if (close < 0) continue;
        const brace = source.indexOf('{', close);
        const semicolon = source.indexOf(';', close);
        if (brace < 0 || (semicolon >= 0 && semicolon < brace)) continue;
        const end = matchingBracket(source, brace);
        if (end < 0) continue;
        // The declaration's start: the line it is on.
        const start = source.lastIndexOf('\n', match.index) + 1;
        return { parameters: source.slice(open + 1, close - 1), body: source.slice(brace + 1, end - 1), start, end };
    }
    return null;
}

// The Python method `name`: its parameters, its body's lines (with their indentation), and where it starts and ends.
function pythonMethod(source, name) {
    const lines = source.split('\n');
    const header = new RegExp(`^(\\s*)def\\s+${name}\\s*\\(([^)]*)\\)\\s*(->[^:]*)?:\\s*(#.*)?$`);
    for (let index = 0; index < lines.length; index += 1) {
        const match = header.exec(lines[index]);
        if (!match) continue;
        const indent = match[1].length;
        let end = index + 1;
        while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) > indent)) end += 1;
        while (end > index + 1 && lines[end - 1].trim() === '') end -= 1;
        return { parameters: match[2].split(',').map((part) => part.trim().split(/[:=]/)[0].trim()), body: lines.slice(index + 1, end), startLine: index, endLine: end, indent };
    }
    return null;
}

// `text` with every comment's characters (and a string's, when `strings`) made spaces, so a search finds code only and its positions
// are the original's.
function blankComments(text, language, strings = false) {
    let result = '';
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"' || character === "'") {
            const start = index;
            for (index += 1; index < text.length && text[index] !== character && text[index] !== '\n'; index += 1) if (text[index] === '\\') index += 1;
            const literal = text.slice(start, index + 1);
            result += strings ? literal.replace(/[^\n]/g, ' ') : literal;
            continue;
        }
        const lineComment = language === 'python' ? character === '#' : character === '/' && text[index + 1] === '/';
        if (lineComment) {
            let end = text.indexOf('\n', index);
            if (end < 0) end = text.length;
            result += ' '.repeat(end - index);
            index = end - 1;
            continue;
        }
        if (language === 'cpp' && character === '/' && text[index + 1] === '*') {
            let end = text.indexOf('*/', index + 2);
            end = end < 0 ? text.length : end + 2;
            result += text.slice(index, end).replace(/[^\n]/g, ' ');
            index = end - 1;
            continue;
        }
        result += character;
    }
    return result;
}

// The argument list of each call `name(` in `text` (outside comments), with where it starts and ends.
function callsOf(text, name, language = 'cpp') {
    const calls = [];
    const pattern = new RegExp(`${name.replace(/\./g, '\\.')}\\s*\\(`, 'g');
    for (const match of blankComments(text, language).matchAll(pattern)) {
        const open = match.index + match[0].length - 1;
        const close = matchingBracket(text, open);
        if (close < 0) continue;
        calls.push({ start: match.index, end: close, arguments: text.slice(open + 1, close - 1) });
    }
    return calls;
}

// Splits "\"key\", value" at its first top-level comma.
function splitFirstArgument(text) {
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character === '"' || character === "'") {
            const quote = character;
            for (index += 1; index < text.length && text[index] !== quote; index += 1) if (text[index] === '\\') index += 1;
        } else if ('([{'.includes(character)) depth += 1;
        else if (')]}'.includes(character)) depth -= 1;
        else if (character === ',' && depth === 0) return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
    }
    return [text.trim(), ''];
}

const unquote = (text) => /^(["'])(.*)\1$/.exec(text.trim())?.[2] ?? null;

// Removes the given spans (each { start, end }) from `text`, with the blank line each leaves.
function withoutSpans(text, spans) {
    let result = text;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
        let end = span.end;
        while (end < result.length && result[end] === '\n' && result[end + 1] === '\n') end += 1;
        result = result.slice(0, span.start) + result.slice(end);
    }
    return result;
}

function convertCpp(source) {
    const node = /NodeProvider\b|createNodeProvider/.test(source);
    const name = className(source, 'cpp');
    const classStart = source.search(new RegExp(`class\\s+${name}\\b`));
    const classBrace = classStart >= 0 ? source.indexOf('{', classStart) : -1;
    const classEnd = classBrace >= 0 ? matchingBracket(source, classBrace) : -1;
    if (classEnd < 0) return null;
    const inClass = (method) => method && method.start > classBrace && method.end <= classEnd;
    const describe = cppMethod(source, 'describe');
    const evaluate = cppMethod(source, 'evaluate');
    if (!inClass(evaluate)) return null;
    const ports = splitPorts(describedPorts(inClass(describe) ? describe.body : ''), node);
    const notes = [];
    const [contextName = 'context', outputName = node ? 'outputs' : 'output'] = evaluate.parameters.split(',').map((part) => /(\w+)\s*$/.exec(part.trim())?.[1]);
    let body = evaluate.body;
    const readPattern = new RegExp(`${contextName}\\s*\\.\\s*inputs\\s*\\.\\s*at\\s*\\(\\s*"([^"]+)"\\s*\\)`, 'g');
    // Inputs the body reads but describe() does not list are declared too.
    const inputs = uniqueByKey([...ports.inputs, ...[...body.matchAll(readPattern)].map((match) => ({ key: match[1], unit: '' }))]);
    let outputs = uniqueByKey(ports.outputs);
    // A port whose name a local variable of the body also takes (the older template's `const double key = context.inputs.at("key");`)
    // is read as this->key, which the local cannot hide.
    const locals = new Set([...blankComments(body, 'cpp', true).matchAll(/\b(?:double|float|int|long|auto|bool|std::size_t|size_t)\s*[&*]?\s+(\w+)\s*[=;({]/g)].map((match) => match[1]));
    body = body.replace(readPattern, (_match, key) => `x[${locals.has(cppMember(key)) ? 'this->' : ''}${cppMember(key)}]`);
    body = body.replace(new RegExp(`${contextName}\\s*\\.\\s*simulationTime\\b`, 'g'), 't');
    let impure = false;
    const marked = [];
    const code = blankComments(body, 'cpp', true).split('\n');
    for (const [index, line] of body.split('\n').entries()) {
        const indent = /^\s*/.exec(line)[0];
        if (/\b\w+_\s*(\+\+|--|[-+*/]?=(?!=))|(\+\+|--)\s*\w+_\b|\bthis\s*->\s*\w+\s*[-+*/]?=(?!=)/.test(code[index])) {
            marked.push(`${indent}// Konjugate: this member changes in evaluate(): declare it as memory (k::Memory) and change it in advance(), or make it a`);
            marked.push(`${indent}// state of the node that an output drives if it changes continuously.`);
            impure = true;
        }
        if (new RegExp(`${contextName}\\s*\\.\\s*stepSize\\b`).test(code[index])) {
            marked.push(`${indent}// Konjugate: evaluate() is given no step size: code that steps something belongs in advance(), which is given the`);
            marked.push(`${indent}// accepted step's size (step.size).`);
            impure = true;
        }
        marked.push(line);
    }
    body = marked.join('\n');
    const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '        ';
    if (node) {
        const keyed = callsOf(body, `${outputName}.addGradient`).map((call) => ({ call, parts: splitFirstArgument(call.arguments) }));
        outputs = uniqueByKey([...outputs, ...keyed.map(({ parts }) => ({ key: unquote(parts[0]) ?? '', unit: '' }))]);
        for (const { call, parts } of [...keyed].reverse()) {
            const key = unquote(parts[0]);
            if (key) body = `${body.slice(0, call.start)}y[${cppMember(key)}] += ${parts[1]}${body.slice(call.end)}`;
        }
        body = body.replace(new RegExp(`\\(void\\)\\s*${outputName}\\s*;`, 'g'), '');
        body = `\n${outputs.map((port) => `${indent}y[${cppMember(port.key)}] = 0.0;`).join('\n')}${body}`;
    } else {
        const calls = callsOf(body, `${outputName}.addGradient`);
        if (!outputs.length) outputs = [{ key: 'output', unit: '' }];
        if (calls.length === 1 && /^\s*;\s*$/.test(blankComments(body.slice(calls[0].end), 'cpp')) && !/\breturn\b/.test(blankComments(body, 'cpp', true))) {
            body = `${body.slice(0, calls[0].start)}return ${calls[0].arguments}${body.slice(calls[0].end)}`;
        } else {
            for (const call of [...calls].reverse()) body = `${body.slice(0, call.start)}result += ${call.arguments}${body.slice(call.end)}`;
            body = body.replace(/\breturn\s*;/g, 'return result;');
            body = `\n${indent}double result = 0.0;${body.trimEnd()}\n${indent}return result;\n`;
        }
    }
    const checkpoint = cppMethod(source, 'checkpoint');
    if (inClass(checkpoint) && !/^\s*return\s*\{\s*\}\s*;\s*$/.test(checkpoint.body)) {
        impure = true;
        notes.push('Its checkpoint() saved state by hand: declare what it saved as memory, which the engine saves and restores itself.');
    }
    const restore = cppMethod(source, 'restore');
    const removed = [describe, checkpoint, restore].filter(inClass);
    // Members of the class's own, besides the methods replaced: a sign the program keeps something.
    let rest = source.slice(classBrace + 1, classEnd - 1);
    for (const method of [describe, evaluate, checkpoint, restore].filter(inClass).sort((a, b) => b.start - a.start)) {
        rest = rest.slice(0, method.start - classBrace - 1) + rest.slice(method.end - classBrace - 1);
    }
    if (rest.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\b(public|private|protected)\s*:/g, '').trim()) {
        impure = true;
        notes.push('Its class has members of its own: a value it changes is memory (k::Memory); a fixed table can stay a member, set in initialize().');
    }
    if (impure) notes.unshift('It is converted as far as its ports: each place that needs a decision is marked in the code.');
    const declarations = [
        ...inputs.map((port) => `    k::Input ${cppMember(port.key)}{this, "${port.key}"${port.unit ? `, "${port.unit}"` : ''}};`),
        ...outputs.map((port) => `    k::Output ${cppMember(port.key)}{this, "${port.key}"${port.unit ? `, "${port.unit}"` : ''}};`)
    ].join('\n');
    const signature = node ? 'void evaluate(double t, const k::Inputs& x, k::Outputs& y) const override' : 'double evaluate(double t, const k::Inputs& x) const override';
    const unused = `${/\bt\b/.test(body) ? '' : `\n${indent}static_cast<void>(t);`}${/\bx\[/.test(body) ? '' : `\n${indent}static_cast<void>(x);`}`;
    const replacement = `${declarations}\n\n    ${signature} {${unused}${body.replace(/\s+$/, '')}\n    }\n`;
    let converted = withoutSpans(source.slice(0, evaluate.start) + replacement + source.slice(evaluate.end), []);
    // The methods removed come before or after evaluate(); removing them from the original positions needs the shift evaluate's
    // replacement made.
    const shift = replacement.length - (evaluate.end - evaluate.start);
    converted = withoutSpans(converted, removed.map((method) => (method.start > evaluate.start
        ? { start: method.start + shift, end: method.end + shift } : method)));
    converted = converted
        .replace(/#include\s*<konjugate\/relationshipProvider\.hpp>/, '#include <konjugate/sdk/v2/program.hpp>')
        .replace(new RegExp(`(class\\s+${name}\\s*(?:final\\s*)?:\\s*public\\s+)[\\w:]*(?:RelationshipProvider|NodeProvider)`), `$1k::${node ? 'Node' : 'Relationship'}`)
        .replace(/std::unique_ptr<\s*konjugate::sdk::v1::(?:RelationshipProvider|NodeProvider)\s*>\s*create(?:Relationship|Node)Provider\s*\(\s*\)/, 'std::unique_ptr<k::Program> createProgram()')
        .replace(/konjugate::sdk::v1::/g, 'k::');
    // The SDK's namespace, after the last #include.
    const includes = [...converted.matchAll(/^#include[^\n]*\n/gm)];
    const at = includes.length ? includes.at(-1).index + includes.at(-1)[0].length : 0;
    converted = `${converted.slice(0, at)}\nnamespace k = konjugate::sdk::v2;\n${converted.slice(at)}`;
    return { source: tidyBlankLines(converted), complete: !impure, kind: node ? 'node' : 'relationship', notes };
}

function convertPython(source) {
    const node = /\(\s*(?:\w+\.)?NodeProvider\s*\)/.test(source);
    const name = className(source, 'python');
    const evaluate = pythonMethod(source, 'evaluate');
    if (!evaluate) return null;
    const describe = pythonMethod(source, 'describe');
    const ports = splitPorts(describedPorts(describe ? describe.body.join('\n') : ''), node);
    const [, contextName = 'context', inputsName = 'inputs', outputsName = 'outputs'] = evaluate.parameters;
    const notes = [];
    let body = evaluate.body.join('\n');
    const readPattern = new RegExp(`\\b${inputsName}\\s*\\[\\s*(["'])([^"']+)\\1\\s*\\]`, 'g');
    const inputs = uniqueByKey([...ports.inputs, ...[...body.matchAll(readPattern)].map((match) => ({ key: match[2], unit: '' }))]);
    let outputs = uniqueByKey(ports.outputs);
    body = body.replace(readPattern, (_match, _quote, key) => `x.${pythonAttribute(key)}`);
    body = body.replace(new RegExp(`\\b${contextName}\\s*\\.\\s*simulation_time\\b`, 'g'), 't');
    // `del context` and the like: the older parameters are gone.
    body = body.split('\n').filter((line) => !new RegExp(`^\\s*del\\s+(${contextName}|${inputsName}|${outputsName})(\\s*,\\s*(${contextName}|${inputsName}|${outputsName}))*\\s*$`).test(line)).join('\n');
    let impure = false;
    let lines = [];
    const code = blankComments(body, 'python', true).split('\n');
    for (const [index, line] of body.split('\n').entries()) {
        const indent = /^\s*/.exec(line)[0];
        if (/\bself\s*\.\s*\w+\s*([-+*/]?=)(?!=)/.test(code[index])) {
            lines.push(`${indent}# Konjugate: this attribute changes in evaluate(): declare it as memory (Memory) and change it in advance(), or make it`);
            lines.push(`${indent}# a state of the node that an output drives if it changes continuously.`);
            impure = true;
        }
        if (new RegExp(`\\b${contextName}\\s*\\.\\s*step_size\\b`).test(code[index])) {
            lines.push(`${indent}# Konjugate: evaluate() is given no step size: code that steps something belongs in advance(), which is given the`);
            lines.push(`${indent}# accepted step's size (step.size).`);
            impure = true;
        }
        lines.push(line);
    }
    const indentOf = (line) => /^\s*/.exec(line)[0];
    const bodyIndent = indentOf(lines.find((line) => line.trim()) ?? '        ');
    if (node) {
        const keys = [];
        lines = lines.map((line) => {
            const call = callsOf(line, `${outputsName}.add_gradient`, 'python')[0] ?? null;
            if (!call) return line;
            const [keyText, value] = splitFirstArgument(call.arguments);
            const key = unquote(keyText);
            if (!key) return line;
            keys.push(key);
            return `${line.slice(0, call.start)}out_${pythonAttribute(key)} += ${value}${line.slice(call.end)}`;
        });
        outputs = uniqueByKey([...outputs, ...keys.map((key) => ({ key, unit: '' }))]);
        lines = [...outputs.map((port) => `${bodyIndent}out_${pythonAttribute(port.key)} = 0.0`), ...lines.filter((line) => line.trim() !== 'pass'),
            `${bodyIndent}return self.outputs(${outputs.map((port) => `${pythonAttribute(port.key)}=out_${pythonAttribute(port.key)}`).join(', ')})`];
    } else {
        if (!outputs.length) outputs = [{ key: 'output', unit: '' }];
        const calls = lines.map((line, index) => (callsOf(line, `${outputsName}.add_gradient`, 'python').length ? index : -1)).filter((index) => index >= 0);
        const lastCode = lines.map((line, index) => (line.trim() && !line.trim().startsWith('#') ? index : -1)).filter((index) => index >= 0).at(-1);
        if (calls.length === 1 && calls[0] === lastCode && !lines.some((line) => /^\s*return\b/.test(line)) && indentOf(lines[calls[0]]) === bodyIndent) {
            const call = callsOf(lines[calls[0]], `${outputsName}.add_gradient`, 'python')[0];
            lines[calls[0]] = `${lines[calls[0]].slice(0, call.start)}return ${call.arguments}${lines[calls[0]].slice(call.end)}`;
        } else {
            lines = lines.map((line) => {
                const call = callsOf(line, `${outputsName}.add_gradient`, 'python')[0] ?? null;
                const replaced = call ? `${line.slice(0, call.start)}result += ${call.arguments}${line.slice(call.end)}` : line;
                return replaced.replace(/^(\s*)return\s*$/, '$1return result');
            });
            lines = [`${bodyIndent}result = 0.0`, ...lines.filter((line) => line.trim() !== 'pass'), `${bodyIndent}return result`];
        }
    }
    const checkpoint = pythonMethod(source, 'checkpoint');
    if (checkpoint && !checkpoint.body.every((line) => !line.trim() || /^\s*(return\s+(b""|b''|bytes\(\))|#.*|pass)\s*$/.test(line))) {
        impure = true;
        notes.push('Its checkpoint() saved state by hand: declare what it saved as memory, which the engine saves and restores itself.');
    }
    if (pythonMethod(source, '__init__')) {
        impure = true;
        notes.push('Its __init__() sets attributes of its own: a value it changes is memory (Memory); a fixed table can be set in initialize().');
    }
    if (impure) notes.unshift('It is converted as far as its ports: each place that needs a decision is marked in the code.');
    const restore = pythonMethod(source, 'restore');
    const sourceLines = source.split('\n');
    const methodIndent = ' '.repeat(evaluate.indent);
    const declarations = [
        ...inputs.map((port) => `${methodIndent}${pythonAttribute(port.key)} = Input(${port.unit ? `"${port.unit}"` : ''})`),
        ...outputs.map((port) => `${methodIndent}${pythonAttribute(port.key)} = Output(${port.unit ? `"${port.unit}"` : ''})`)
    ];
    const evaluateLines = [...declarations, '', `${methodIndent}def evaluate(self, t, x):`,
        ...lines.map((line) => (line.trim() ? `${methodIndent}    ${line.slice(bodyIndent.length)}` : ''))];
    // Replaced and removed method spans, from the last up, so the earlier line numbers hold.
    const spans = [evaluate, describe, checkpoint, restore].filter(Boolean).map((method) => ({ start: method.startLine, end: method.endLine, method }));
    let result = sourceLines;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
        let end = span.end;
        while (end < result.length && !result[end].trim() && span.method !== evaluate) end += 1;
        result = [...result.slice(0, span.start), ...(span.method === evaluate ? evaluateLines : []), ...result.slice(span.method === evaluate ? span.end : end)];
    }
    let converted = result.join('\n');
    const imports = [...new Set(['Input', 'Output', node ? 'Node' : 'Relationship'])].sort().join(', ');
    converted = converted
        .replace(/^from\s+konjugate\s+import\s*\([\s\S]*?\)[ \t]*$/m, `from konjugate.v2 import ${imports}`)
        .replace(/^from\s+konjugate\s+import[^\n]*$/m, `from konjugate.v2 import ${imports}`)
        .replace(new RegExp(`^(class\\s+${name}\\s*\\()\\s*(?:\\w+\\.)?(?:RelationshipProvider|NodeProvider)\\s*\\)`, 'm'), `$1${node ? 'Node' : 'Relationship'})`);
    if (!/^from\s+konjugate\.v2\s+import/m.test(converted)) converted = `from konjugate.v2 import ${imports}\n${converted}`;
    return { source: tidyBlankLines(converted), complete: !impure, kind: node ? 'node' : 'relationship', notes };
}

function tidyBlankLines(text) {
    return `${text.replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').replace(/(public:|protected:|private:)\n\n+/g, '$1\n')
        .replace(/\n\n+(\s*\};)/g, '\n$1').trimEnd()}\n`;
}

// A source of no shape the converter knows: the version 2 template with the ports found in it, and the older program, commented, below.
function fallback(kind, source) {
    const ports = describedPorts(source);
    const comment = kind === 'cpp' ? '//' : '#';
    const keys = uniqueByKey(ports);
    const template = kind === 'cpp' ? `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

class Converted final : public k::Relationship {
public:
${keys.slice(0, -1).map((port) => `    k::Input ${cppMember(port.key)}{this, "${port.key}"${port.unit ? `, "${port.unit}"` : ''}};`).join('\n')}
    k::Output ${cppMember(keys.at(-1)?.key ?? 'output')}{this, "${keys.at(-1)?.key ?? 'output'}"};

    double evaluate(double t, const k::Inputs& x) const override {
        static_cast<void>(t);
        static_cast<void>(x);
        return 0.0;
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Converted>(); }
` : `from konjugate.v2 import Input, Output, Relationship


class Converted(Relationship):
${keys.slice(0, -1).map((port) => `    ${pythonAttribute(port.key)} = Input(${port.unit ? `"${port.unit}"` : ''})`).join('\n')}
    ${pythonAttribute(keys.at(-1)?.key ?? 'output')} = Output()

    def evaluate(self, t, x):
        return 0.0
`;
    return {
        source: `${template}\n${comment} The older program, to bring into the program above:\n${source.split('\n').map((line) => `${comment} ${line}`.trimEnd()).join('\n')}\n`,
        complete: false,
        kind: 'relationship',
        notes: ['This program is not of a shape the converter knows: its ports are declared above, and the older program is kept, commented, below them.']
    };
}

export function convertProgramToVersion2(kind, source) {
    const text = String(source ?? '');
    let converted = null;
    try {
        converted = kind === 'python' ? convertPython(text) : convertCpp(text);
    } catch {
        converted = null;
    }
    return converted ?? fallback(kind, text);
}

// What the code editor says of a program's format, plainly (docs/proposals/programSdkV2.md, decision 9: the person mostly does not see
// "version 2").
export const olderFormatNotice = 'Older program format: held under Runge–Kutta 4 and the adaptive methods.';

// The values a program's inputs have in the model now, by key, for Check program: a bound state's start value, a parameter's value (a
// linked or node-bound shared parameter's), and 0 for the time. `parameters` are the owner's own (a relationship's or a node's own
// part's).
export function programCheckInputs(document, implementation, parameters = []) {
    const states = new Map();
    for (const node of document?.nodes ?? []) for (const state of node.states ?? []) states.set(state.id, Number(state.initialValue) || 0);
    const shared = new Map((document?.sharedParameters ?? []).map((parameter) => [parameter.id, Number(parameter.value) || 0]));
    const own = new Map((parameters ?? []).map((parameter) => [parameter.id,
        parameter.sharedParameterId != null && shared.has(parameter.sharedParameterId) ? shared.get(parameter.sharedParameterId) : Number(parameter.value) || 0]));
    const inputs = {};
    for (const binding of implementation?.bindings ?? []) {
        if (!binding?.key) continue;
        if (binding.kind === 'time') inputs[binding.key] = 0;
        else if (binding.kind === 'parameter') inputs[binding.key] = binding.sharedParameterId != null ? shared.get(binding.sharedParameterId) ?? 0 : own.get(binding.parameterId) ?? 0;
        else if (states.has(binding.stateId)) inputs[binding.key] = states.get(binding.stateId);
    }
    return inputs;
}
