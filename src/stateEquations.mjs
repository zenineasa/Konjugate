/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A state's equation as a person reads it (docs/proposals/unifiedEntityEditors.md): the short names nodes go by in each
// other's equations, a relationship's part written in its reader's names, states nothing changes folded into one line,
// and several own parts on one state made one. No DOM, so `npm test` runs it; what is stored is never changed by reading.

const symbolLatex = (symbol) => (String(symbol).length === 1 ? String(symbol) : `\\mathrm{${symbol}}`);
const nodeName = (node) => node.name ?? node.title ?? '';

// A node's short name from its name: a last word that is one letter or a number (Ground pivot A → A, Pump 2 → 2), else the
// initials of its words (Battery module → BM), else its first letter.
export function derivedShortName(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'N';
    const last = words.at(-1);
    if (words.length > 1 && /^([A-Za-z]|\d+)$/.test(last)) return last.toUpperCase();
    if (words.length > 1) return words.map((word) => word[0].toUpperCase()).join('');
    return words[0][0].toUpperCase();
}

// Every node's short name, by id: the one a person gave it, else derived, made unique in the model by adding the next letter
// of its name, then a number (two "Battery module"s: BM and BMa, or BM2).
export function shortNames(nodes) {
    const names = new Map();
    const taken = new Set();
    for (const node of nodes) if (node.shortName) taken.add(node.shortName);
    for (const node of nodes) {
        if (node.shortName) {
            names.set(node.id, node.shortName);
            continue;
        }
        let name = derivedShortName(nodeName(node));
        const letters = nodeName(node).replace(/[^A-Za-z]/g, '').toLowerCase();
        for (let extra = 1; taken.has(name) && extra < letters.length; extra += 1) name = `${derivedShortName(nodeName(node))}${letters[extra]}`;
        for (let number = 2; taken.has(name); number += 1) name = `${derivedShortName(nodeName(node))}${number}`;
        taken.add(name);
        names.set(node.id, name);
    }
    return names;
}

// LaTeX with the symbols in `replacements` (symbol → LaTeX) written their new way, wherever written as \mathrm{…},
// \operatorname{…} or \text{…}, or bare when one letter long.
export function renameSymbols(latex, replacements) {
    if (!latex || !replacements.size) return latex ?? '';
    // One pass, token by token: a named symbol whole, a command kept, a lone letter renamed only when it is a symbol.
    return String(latex).replace(/\\(mathrm|operatorname|text)\{([^{}]*)\}|(\\[A-Za-z]+)|([A-Za-z])/g, (whole, _command, symbol, command, letter) => {
        if (symbol !== undefined) return replacements.get(symbol) ?? whole;
        if (command !== undefined) return whole;
        return replacements.get(letter) ?? whole;
    });
}

// How a relationship's state reference reads to whoever is reading: the reader node's own states bare (y), every other node's
// with its short name (y_A). `reader` is a node id, or null when the reader is the relationship itself (every state named).
export function stateInReaderNames(symbol, nodeId, reader, names) {
    if (nodeId === reader) return symbolLatex(symbol);
    return `${symbolLatex(symbol)}_{\\mathrm{${names.get(nodeId) ?? '?'}}}`;
}

// A relationship's stored LaTeX (`latex`, with `bindings` naming source.x as sourceX) written in its reader's names. `edge`
// gives the two ends (`source`, `target` as node ids, or `{ nodeId }`), `nodes` their states.
export function relationshipLatexInReaderNames(latex, bindings, edge, nodes, reader, names, parameters = []) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const endId = (role) => (typeof edge[role] === 'object' && edge[role] !== null ? edge[role].nodeId : edge[role]);
    const replacements = new Map();
    for (const binding of bindings ?? []) {
        if (binding.kind !== 'state' || !binding.symbol) continue;
        const nodeId = binding.nodeId ?? endId(binding.role);
        const state = nodesById.get(nodeId)?.states?.find((candidate) => Number(candidate.id) === Number(binding.stateId));
        if (!state) continue;
        replacements.set(binding.symbol, stateInReaderNames(state.symbol, nodeId, reader, names));
    }
    for (const [symbol, shown] of displaySymbols(parameters)) replacements.set(symbol, shown);
    return renameSymbols(latex, replacements);
}

// A parameter's display symbol, by its symbol, for each parameter that has one (ω for angularVelocity).
export function displaySymbols(parameters) {
    return new Map((parameters ?? []).filter((parameter) => typeof parameter.displaySymbol === 'string' && parameter.displaySymbol.trim()).map((parameter) => [parameter.symbol, parameter.displaySymbol.trim()]));
}

// LaTeX with each parameter's display symbol written back as its symbol (\omega → \mathrm{angularVelocity}): a command
// not followed by a letter, or the display symbol exactly as written, wherever it stands on its own.
export function displaySymbolsToStored(latex, parameters) {
    let stored = String(latex ?? '');
    for (const [symbol, shown] of displaySymbols(parameters)) {
        const escaped = shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(/^\\[A-Za-z]+$/.test(shown) ? `${escaped}(?![A-Za-z])` : `(?<![A-Za-z\\\\])${escaped}(?![A-Za-z])`, 'g');
        stored = stored.replace(pattern, symbol.length === 1 ? symbol : `\\mathrm{${symbol}}`);
    }
    return stored;
}

// The lines a node's Equations tab shows, in the node's order: each state on its own, except states nothing changes
// (`unchanged(state)`), which fold together while they come one after another with the same start value and unit.
export function foldStates(states, unchanged) {
    const lines = [];
    for (const state of states) {
        const previous = lines.at(-1);
        if (unchanged(state) && previous?.folded && previous.states[0].initialValue === state.initialValue && (previous.states[0].unit ?? '') === (state.unit ?? '')) {
            previous.states.push(state);
        } else {
            lines.push(unchanged(state) ? { folded: true, states: [state] } : { folded: false, states: [state] });
        }
    }
    return lines;
}

// Several names as one: a shared last word written once (X velocity, Y velocity → X, Y velocity), else each after the first
// in lower case unless it is an abbreviation (Roll, Pitch, Yaw → Roll, pitch, yaw).
export function foldedName(names) {
    if (names.length === 1) return names[0];
    const split = names.map((name) => String(name).trim().split(/\s+/));
    const tail = split[0].slice(1).join(' ');
    if (tail && split.every((words) => words.length === split[0].length && words.slice(1).join(' ') === tail)) {
        return `${split.map((words) => words[0]).join(', ')} ${tail}`;
    }
    return names.map((name, index) => (index && /^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name)).join(', ');
}

// Several of a node's own parts on one state, made one: their LaTeX added (each bracketed when it has a sum of its own), their
// references together, and their parameters together, one that clashes with another's symbol (but is not the same) given a
// new one, written into its part's LaTeX. `terms`: [{ latex, bindings, parameters }]. Returns { latex, bindings, parameters }.
export function mergeOwnParts(terms) {
    const parameters = [];
    const bindings = [];
    const pieces = [];
    for (const term of terms) {
        const renames = new Map();
        const renamed = new Map();
        for (const parameter of term.parameters ?? []) {
            const same = parameters.find((existing) => existing.symbol === parameter.symbol);
            if (same && same.value === parameter.value && (same.unit ?? '') === (parameter.unit ?? '') && same.mode === parameter.mode) continue;
            if (!same) {
                parameters.push(structuredClone(parameter));
                continue;
            }
            let number = 2;
            while (parameters.some((existing) => existing.symbol === `${parameter.symbol}${number}`)) number += 1;
            const symbol = `${parameter.symbol}${number}`;
            renames.set(parameter.symbol, symbolLatex(symbol));
            renamed.set(parameter.symbol, symbol);
            parameters.push({ ...structuredClone(parameter), symbol, name: `${parameter.name} (${number})` });
        }
        for (const binding of term.bindings ?? []) {
            const symbol = renamed.get(binding.symbol) ?? binding.symbol;
            if (!bindings.some((existing) => existing.symbol === symbol)) bindings.push({ ...structuredClone(binding), symbol });
        }
        const latex = renameSymbols(String(term.latex ?? '').trim(), renames);
        if (!latex || latex === '0') continue;
        pieces.push(terms.length > 1 && /[+-]/.test(latex.replace(/^[+-]/, '')) ? `\\left(${latex}\\right)` : latex);
    }
    return { latex: pieces.length ? pieces.join('+') : '0', bindings, parameters };
}

// The other way: LaTeX a person typed in a reader's names (y_B − y_A on a relationship's card) written back in the stored
// names its bindings give (targetY − sourceY), so what is stored never changes form. Each state reference is matched however
// it is written -- y_B, y_{B}, \mathrm{y}_{\mathrm{B}} -- and a bare one only when it is the reader node's own (reader not null).
export function readerLatexToStored(latex, bindings, edge, nodes, reader, names, parameters = []) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const endId = (role) => (typeof edge[role] === 'object' && edge[role] !== null ? edge[role].nodeId : edge[role]);
    const stored = new Map();
    for (const binding of bindings ?? []) {
        if (binding.kind !== 'state' || !binding.symbol) continue;
        const nodeId = binding.nodeId ?? endId(binding.role);
        const state = nodesById.get(nodeId)?.states?.find((candidate) => Number(candidate.id) === Number(binding.stateId));
        if (!state) continue;
        stored.set(`${state.symbol}|${nodeId === reader ? '' : names.get(nodeId) ?? ''}`, binding.symbol);
    }
    const symbol = String.raw`(?:\\(?:mathrm|operatorname|text)\{([A-Za-z][A-Za-z0-9]*)\}|([A-Za-z]))`;
    const subscript = String.raw`(?:\{\s*(?:\\(?:mathrm|text)\{([A-Za-z0-9]+)\}|([A-Za-z0-9]+))\s*\}|([A-Za-z0-9]))`;
    const pattern = new RegExp(String.raw`(\\[A-Za-z]+(?![A-Za-z]))(?<!\\(?:mathrm|operatorname|text))|${symbol}(?:\s*_\s*${subscript})?`, 'g');
    return displaySymbolsToStored(latex, parameters).replace(pattern, (whole, command, named, letter, braced, bracedPlain, single) => {
        if (command) return whole;
        const name = named ?? letter;
        const short = braced ?? bracedPlain ?? single ?? '';
        const target = stored.get(`${name}|${short}`);
        return target ? `\\mathrm{${target}}` : whole;
    });
}
