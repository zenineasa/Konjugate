/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A version 2 program's ports as its source declares them, read without running it: what the code editor's Ports panel lists when the
// engine cannot read the program (a C++ program in the web edition, which the web engine does not run) and while the engine's answer is
// on its way. The same shape as the engine's description (describeProgram) for inputs and outputs, with each port's line; no memory or
// clock, which need the program loaded. It reads declarations written the way the SDK documents them:
//   C++:    k::Input measurement{this, "measurement", "K"};   k::Constant noise{this, "noise", "K", k::optional(0.0)};
//   Python: measurement = Input("K")                           noise = Constant("K", default=0.0)   (key: the attribute in camelCase)

const portKinds = { Input: 'input', Parameter: 'parameter', Constant: 'constant' };

// The SDK's key for a Python attribute: previous_error binds as previousError.
export function pythonPortKey(attribute) {
    const [head, ...rest] = attribute.split('_');
    return head + rest.filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

const number = (text) => {
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
};

export function sourcePorts(kind, source) {
    const inputs = [];
    const outputs = [];
    const lines = String(source ?? '').split('\n');
    lines.forEach((text, index) => {
        const line = index + 1;
        if (kind === 'python') {
            if (/^\s*#/.test(text)) return;
            // The call's arguments run to its last parenthesis (a unit may hold some: "W/(K*s)"), a trailing comment left out.
            const match = /^\s*([A-Za-z_]\w*)\s*=\s*(Input|Parameter|Constant|Output)\((.*)\)/.exec(text.replace(/\s+#[^"']*$/, ''));
            if (!match) return;
            const [, attribute, type, rawArguments] = match;
            const unit = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(rawArguments);
            const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rawArguments);
            const fallback = /\bdefault\s*=\s*([-+0-9.eE]+)/.exec(rawArguments);
            const port = { key: name ? (name[1] ?? name[2]) : pythonPortKey(attribute), name: attribute, unit: unit ? (unit[1] ?? unit[2] ?? '') : '', line };
            if (type === 'Output') outputs.push(port);
            else inputs.push({ ...port, kind: portKinds[type], ...(fallback && number(fallback[1]) !== undefined ? { default: number(fallback[1]) } : {}) });
            return;
        }
        if (/^\s*\/\//.test(text)) return;
        const pattern = /k::(Input|Parameter|Constant|Output)\s+([A-Za-z_]\w*)\s*\{\s*this\s*,\s*"([^"]*)"\s*(?:,\s*"([^"]*)")?\s*(?:,\s*k::optional\(\s*([-+0-9.eE]+)\s*\))?/g;
        for (const match of text.matchAll(pattern)) {
            const [, type, member, key, unit = '', fallback] = match;
            const port = { key, name: member, unit, line };
            if (type === 'Output') outputs.push(port);
            else inputs.push({ ...port, kind: portKinds[type], ...(fallback !== undefined && number(fallback) !== undefined ? { default: number(fallback) } : {}) });
        }
    });
    return { ok: true, fromSource: true, inputs, outputs, memory: [], clock: null, problems: [] };
}

// The memory a version 2 program declares, by the name its code uses (Python's attribute, C++'s member) and its key: for completion
// after m. or m[ (the engine's description has the memory too, once the program loads).
//   C++:    k::Memory<double> integral{this, "integral", 0.0, "K*s"};      k::Memory<k::Random> noise{this, "noise"};
//   Python: integral = Memory(0.0, unit="K*s")                              noise = Random()
export function sourceMemory(kind, source) {
    const memory = [];
    String(source ?? '').split('\n').forEach((text, index) => {
        if (kind === 'python') {
            const match = /^\s*([A-Za-z_]\w*)\s*=\s*(Memory|Random)\(/.exec(text);
            if (match && !/^\s*#/.test(text)) memory.push({ name: match[1], key: pythonPortKey(match[1]), random: match[2] === 'Random', line: index + 1 });
            return;
        }
        if (/^\s*\/\//.test(text)) return;
        for (const match of text.matchAll(/k::Memory<([^>]*>?)>\s+([A-Za-z_]\w*)\s*\{\s*this\s*,\s*"([^"]*)"/g)) {
            memory.push({ name: match[2], key: match[3], random: /Random/.test(match[1]), line: index + 1 });
        }
    });
    return memory;
}
