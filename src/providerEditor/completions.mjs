/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's completion and hover (docs/proposals/codeEditor.md, "Writing aids"), as data: the program's own ports after x. or
// x[ (each with its unit and what the model binds it to), its memory after m., the program SDK's names (src/programSdkNames.mjs,
// generated from the SDK) after k:: or as a word, and snippets offered by completion only. Pure: the editor turns these into CodeMirror
// completions and tooltips, and a unit test reads them.

import { programSdkNames } from '../programSdkNames.mjs';

export const programDocsUrl = 'https://github.com/zenineasa/Konjugate/blob/master/docs/programs.md';

// Snippets, never inserted on their own: ${name} fields the person tabs through (CodeMirror's snippet syntax).
export const programSnippets = {
    python: [
        { label: 'memory with advance()', detail: 'a value remembered between steps', template: '${total} = Memory(${0.0})\n\ndef advance(self, step, x, m):\n\tm.${total} = x.${total} + ${step.size}' },
        { label: 'clock', detail: 'advance() every period', template: 'clock = Clock(${0.01})' },
        { label: 'OutOfDomain for a lookup', detail: 'refuse inputs outside a table', template: 'if not (${0.0} <= x.${input} <= ${1.0}):\n\traise OutOfDomain(f"${input} = {x.${input}} is outside the table")' },
        { label: 'jacobian()', detail: 'the derivatives of the outputs', template: 'def jacobian(self, t, x):\n\treturn {("${output}", "${input}"): ${1.0}}' }
    ],
    cpp: [
        { label: 'memory with advance()', detail: 'a value remembered between steps', template: 'k::Memory<double> ${total}{this, "${total}", ${0.0}};\n\nvoid advance(const k::Step& step, const k::Inputs& x, k::MemoryWriter& m) const override {\n\tm[${total}] = x[${total}] + ${step.size};\n}' },
        { label: 'clock', detail: 'advance() every period', template: 'k::Clock clock{this, ${0.01}};' },
        { label: 'OutOfDomain for a lookup', detail: 'refuse inputs outside a table', template: 'if (x[${input}] < ${0.0} || x[${input}] > ${1.0}) throw k::OutOfDomain("${input} is outside the table");' },
        { label: 'jacobian()', detail: 'the derivatives of the outputs', template: 'void jacobian(double t, const k::Inputs& x, k::Jacobian& J) const override {\n\tJ(${output}, ${input}) = ${1.0};\n}' }
    ]
};

// What a port's completion or hover says of it: its unit, what it is bound to, and its value now.
export function portDetail(port, binding) {
    const parts = [];
    if (port.unit) parts.push(port.unit);
    if (port.group !== 'memory' && port.group !== 'output') parts.push(binding?.label ? binding.label : 'not bound');
    if (binding?.value !== null && binding?.value !== undefined && Number.isFinite(Number(binding.value))) parts.push(`= ${Number(Number(binding.value).toPrecision(6))}`);
    return parts.join(' · ');
}

// The context the cursor is in, from the text of its line before it: what is completed, and where the word being typed starts.
export function completionContext(kind, before) {
    const rules = kind === 'python'
        ? [[/\bx\.(\w*)$/, 'inputsAndMemory'], [/\bsetup\.(\w*)$/, 'constants'], [/\bm\.(\w*)$/, 'memory'], [/\bx\[\s*["'](\w*)$/, 'keys'], [/(?:^|[^\w.])([A-Za-z_]\w*)$/, 'word']]
        : [[/\bx\[\s*(\w*)$/, 'inputsAndMemory'], [/\by\[\s*(\w*)$/, 'outputs'], [/\bm\[\s*(\w*)$/, 'memory'], [/\bk::(\w*)$/, 'sdk'], [/(?:^|[^\w:.])([A-Za-z_]\w*)$/, 'word']];
    for (const [pattern, what] of rules) {
        const match = pattern.exec(before);
        if (match) return { what, prefix: match[1], from: before.length - match[1].length };
    }
    return null;
}

// The completions at the cursor: { from (the column the typed word starts at), options: [{ label, type, detail, info, snippet? }] },
// or null when there is nothing to offer. declared: { inputs, outputs, memory } as src/providerEditor/sourcePorts.mjs reads them (each
// with its name in the code and its key). bindings: { key: { label, value } }.
export function programCompletions({ kind, before, declared = {}, bindings = {}, explicit = false }) {
    const context = completionContext(kind, before);
    if (!context) return null;
    const inputs = (declared.inputs ?? []).map((port) => ({ ...port, group: port.kind ?? 'input' }));
    const outputs = (declared.outputs ?? []).map((port) => ({ ...port, group: 'output' }));
    const memory = (declared.memory ?? []).map((value) => ({ ...value, group: 'memory' }));
    const portOption = (port, label = port.name ?? port.key) => ({
        label, type: port.group === 'memory' ? 'variable' : 'property', detail: portDetail(port, bindings[port.key]),
        info: port.group === 'memory' ? `Memory ${port.key}` : `${port.group === 'output' ? 'Output' : port.group[0].toUpperCase() + port.group.slice(1)} ${port.key}`
    });
    const sdk = (programSdkNames[kind === 'python' ? 'python' : 'cpp'] ?? []).map((entry) => ({
        label: entry.name, type: entry.kind === 'function' ? 'function' : 'class', detail: 'program SDK', info: entry.doc
    }));
    let options;
    switch (context.what) {
        case 'inputsAndMemory': options = [...inputs, ...memory.filter((value) => !value.random)].map((port) => portOption(port)); break;
        case 'constants': options = inputs.filter((port) => port.group === 'constant').map((port) => portOption(port)); break;
        case 'memory': options = memory.map((port) => portOption(port)); break;
        case 'keys': options = [...inputs, ...memory.filter((value) => !value.random)].map((port) => portOption(port, port.key)); break;
        case 'outputs': options = outputs.map((port) => portOption(port)); break;
        case 'sdk': options = sdk; break;
        default: {
            // A word: the SDK's names and the snippets, once something is typed (or completion is asked for).
            if (!explicit && context.prefix.length < 2) return null;
            options = [...(kind === 'python' ? sdk : []),
                ...programSnippets[kind === 'python' ? 'python' : 'cpp'].map((snippet) => ({ label: snippet.label, type: 'text', detail: snippet.detail, snippet: snippet.template }))];
        }
    }
    return options.length ? { from: context.from, options } : null;
}

// What hovering a name says: an SDK name's one line and the section of "Writing a program" that explains it, or a port's unit, binding
// and value now. null when the name is neither.
export function programHover({ kind, name, before = '', declared = {}, bindings = {} }) {
    const language = kind === 'python' ? 'python' : 'cpp';
    const ports = [...(declared.inputs ?? []).map((port) => ({ ...port, group: port.kind ?? 'input' })),
        ...(declared.outputs ?? []).map((port) => ({ ...port, group: 'output' })),
        ...(declared.memory ?? []).map((value) => ({ ...value, group: 'memory' }))];
    const port = ports.find((candidate) => candidate.name === name || candidate.key === name);
    const throughSdk = language === 'cpp' ? /\bk::$/.test(before) : true;
    const entry = throughSdk ? programSdkNames[language].find((candidate) => candidate.name === name) : null;
    if (entry && (!port || language === 'cpp')) {
        return { title: language === 'cpp' ? `k::${entry.name}` : entry.name, text: entry.doc, link: `${programDocsUrl}${entry.section ? `#${entry.section}` : ''}`,
            linkText: 'Writing a program ›' };
    }
    if (port) {
        const kindWord = port.group === 'memory' ? 'Memory' : port.group === 'output' ? 'Output' : port.group[0].toUpperCase() + port.group.slice(1);
        return { title: `${kindWord} ${port.key}`, text: portDetail(port, bindings[port.key]) || 'no unit', link: null, linkText: null };
    }
    return null;
}
