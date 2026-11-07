/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Suggests how a source's signals map to a model (docs/proposals/controlRoom.md, "Finding the matches: rules and memory"): for each
// incoming signal, the model quantity it most likely is, its role (an input driving a shared parameter, or measured against a
// state), the unit conversion, a confidence and the reasons, from evidence that can be explained, so the person can confirm it.
//
//   suggestMapping(signals, document, { memory })   one suggestion per signal, each model quantity used once
//   rememberMapping(memory, mapping, document)       the memory with these confirmed matches added
//
// signals: [{ id, name, unit, values, role }]: `name` as the source calls it (a tag, a topic, a column), `unit` as the source gives
// it, `values` a few recent readings (for plausibility and behaviour), `role` when the source declares it (a Konjugate data log says
// which signals are inputs and which measured), all optional but the name. The evidence, cheapest first:
//   1. the name, normalised (case, separators, camelCase, digits apart, decorations such as PV and Value dropped);
//   2. abbreviations and synonyms (temp, TT and T for temperature; ISA instrument tags, whose first letter is the quantity);
//   3. the unit's dimension: a pressure never maps to a temperature, and a unit's kind is evidence on its own;
//   4. plausible values: the readings, converted, against the quantity's own value;
//   5. behaviour: a signal that steps between a few values is likely an input, one that moves smoothly a measurement;
//   6. memory: a match confirmed before, for a signal of this name, offered first when its quantity is in the model.

import { replayTargets } from './dataLogReplay.mjs';
import { parseUnit, quantityName, unitConversion } from './units.mjs';

// Words that decorate a name without saying what it is (process value, measured, actual, value...).
const decorations = new Set(['pv', 'value', 'val', 'meas', 'measured', 'measurement', 'actual', 'act', 'raw', 'signal', 'sig', 'data', 'reading', 'read', 'the', 'of', 'in', 'out', 'ns', 's', 'i']);

// Each canonical word with the ways it is written.
const synonyms = {
    temperature: ['temperature', 'temp', 'tmp', 't', 'thermo', 'degc', 'degf'],
    pressure: ['pressure', 'press', 'prs', 'pres', 'p'],
    power: ['power', 'pwr', 'watts', 'w', 'kw', 'duty'],
    flow: ['flow', 'flw', 'fl', 'q', 'flowrate', 'rate'],
    level: ['level', 'lvl', 'lev', 'height'],
    speed: ['speed', 'spd', 'rpm', 'velocity', 'vel', 'rate'],
    weight: ['weight', 'wt', 'mass'],
    position: ['position', 'pos', 'opening', 'stroke'],
    current: ['current', 'amps', 'amp'],
    voltage: ['voltage', 'volt', 'volts', 'v'],
    heater: ['heater', 'htr', 'heating', 'heat', 'element'],
    tank: ['tank', 'tk', 'tnk', 'vessel', 'vsl', 'reactor', 'drum'],
    ambient: ['ambient', 'amb', 'room', 'outdoor', 'outside', 'environment', 'env', 'air', 'surroundings'],
    water: ['water', 'h2o', 'wtr', 'liquid'],
    inlet: ['inlet', 'in', 'supply', 'feed', 'sup'],
    outlet: ['outlet', 'out', 'return', 'ret', 'discharge'],
    valve: ['valve', 'vlv', 'cv', 'xv'],
    pump: ['pump', 'pmp'],
    motor: ['motor', 'mtr', 'drive'],
    setpoint: ['setpoint', 'sp', 'target', 'set']
};
const canonical = new Map();
for (const [word, forms] of Object.entries(synonyms)) for (const form of forms) if (!canonical.has(form)) canonical.set(form, word);

// ISA 5.1 instrument tags (TT101, TIC-202, JI101): the first letter is the quantity measured, the rest what the instrument does.
const isaQuantity = { T: 'temperature', P: 'pressure', F: 'flow', L: 'level', S: 'speed', W: 'weight', J: 'power', E: 'voltage', I: 'current', Z: 'position' };
// A loop number has two digits or more, so a piece such as TK1 (a tank) is not read as a tag.
const isaPattern = /^([TPFLSWJEIZ])([A-Z]{0,3})[-_ ]?(\d{2,5}[A-Z]?)$/;

// The quantity a canonical word names, when it names one.
const wordQuantity = { temperature: 'temperature', pressure: 'pressure', power: 'power', flow: 'volume flow', level: 'length', speed: 'speed', weight: 'mass', current: 'current', voltage: 'voltage' };
// What units of a quantity are called by units.mjs, for comparing a word's quantity with a unit's.
const unitKind = { temperature: 'temperature', pressure: 'pressure', power: 'power', 'volume flow': 'volume flow', flow: 'volume flow', length: 'length', level: 'length', speed: 'speed', mass: 'mass', weight: 'mass', current: 'current', voltage: 'voltage', position: 'length' };

// A name's words: split at separators, camelCase, letters and digits, lower case, decorations dropped, ISA tags read.
export function nameWords(text) {
    // An instrument tag written with a separator (TIC-202, JI_204) is joined first, so splitting at separators keeps it whole.
    const raw = String(text ?? '').replace(/(^|[^A-Za-z0-9])([TPFLSWJEIZ][A-Z]{0,3})[-_ ](\d{2,5}[A-Z]?)(?=$|[^A-Za-z0-9])/g, '$1$2$3');
    const pieces = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const words = [];
    const quantities = [];
    let instrument = null;
    for (const piece of pieces) {
        const isa = isaPattern.exec(piece);
        const known = canonical.has(piece.replace(/\d+$/, '').toLowerCase());
        if (isa && piece === piece.toUpperCase() && !known) {
            quantities.push(isaQuantity[isa[1]]);
            instrument = { quantity: isaQuantity[isa[1]], functions: isa[2], loop: isa[3] };
            words.push(isaQuantity[isa[1]]);
            continue;
        }
        for (const part of piece.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)) {
            const word = part.toLowerCase();
            if (!word || decorations.has(word) || /^\d+$/.test(word)) continue;
            words.push(canonical.get(word) ?? word);
        }
    }
    for (const word of words) if (wordQuantity[word]) quantities.push(wordQuantity[word]);
    return { words: [...new Set(words)], quantities: [...new Set(quantities)], instrument };
}

// How much two sets of words share: the share of the signal's words found in the candidate's, and of the candidate's in the signal's.
function wordOverlap(signalWords, candidateWords) {
    if (!signalWords.length || !candidateWords.length) return 0;
    const candidate = new Set(candidateWords);
    const shared = signalWords.filter((word) => candidate.has(word)).length;
    return shared ? (shared / signalWords.length + shared / candidateWords.length) / 2 : 0;
}

// Whether readings step between a few values (what an operator does) rather than move smoothly (what a sensor measures).
function stepsLikeAnInput(values) {
    if (!values || values.length < 6) return null;
    const distinct = new Set(values.map((value) => Number(value.toPrecision(6)))).size;
    // A signal that never changed says nothing about which it is.
    if (distinct === 1) return null;
    const changes = values.slice(1).filter((value, index) => value !== values[index]).length;
    return distinct <= Math.max(3, values.length / 10) || changes <= values.length / 5;
}

// The model's quantities a signal can map to, with what they are called and measured in.
export function mappingCandidates(document) {
    const targets = replayTargets(document);
    const descriptions = new Map((document.nodes ?? []).map((node) => [node.id, node.description ?? '']));
    const states = targets.states.map((state) => ({
        kind: 'state', role: 'output', id: state.stateId, label: state.label, unit: state.unit, symbol: state.symbol,
        words: nameWords(`${state.nodeName} ${state.name} ${state.symbol} ${descriptions.get(state.nodeId) ?? ''}`).words,
        initial: (document.nodes ?? []).find((node) => node.id === state.nodeId)?.states?.find((candidate) => candidate.id === state.stateId)?.initialValue
    }));
    const parameters = targets.parameters.map((parameter) => ({
        kind: 'parameter', role: 'input', id: parameter.parameterId, label: parameter.label, unit: parameter.unit, symbol: parameter.symbol,
        words: nameWords(`${parameter.name} ${parameter.symbol}`).words,
        initial: (document.sharedParameters ?? []).find((candidate) => candidate.id === parameter.parameterId)?.value
    }));
    return [...states, ...parameters];
}

const unitKindOf = (unit) => parseUnit(unit ?? '')?.kind ?? null;

// The evidence for one signal being one candidate: a score from 0 to 1 and the reasons, or null where it cannot be (two kinds of
// quantity, two units that do not convert).
const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function judge(signal, words, candidate) {
    // A role the source declares is the source's word: a measured signal never drives a parameter, nor an input a state.
    if (signal.role && signal.role !== candidate.role) return null;
    // The same name (the candidate's symbol, its name, or its node's name and its own together) is the strongest evidence there is.
    const name = squash(signal.name);
    if (name && [candidate.symbol, candidate.label.split(' · ').pop(), candidate.label.replace(' · ', ''), candidate.label.replace(/^Shared · /, '')].some((form) => squash(form) === name)) {
        const conversion = signal.unit && candidate.unit ? unitConversion(signal.unit, candidate.unit) : null;
        if (!conversion?.error || !(parseUnit(signal.unit) && parseUnit(candidate.unit))) return { score: 0.97, reasons: ['the same name'], conversion: conversion?.error ? null : conversion };
    }
    const reasons = [];
    let score = 0;
    let weight = 0;
    // The name.
    const overlap = wordOverlap(words.words, candidate.words);
    score += 0.45 * overlap;
    weight += 0.45;
    if (overlap > 0) reasons.push(`the name shares ${words.words.filter((word) => candidate.words.includes(word)).join(', ')}`);
    // The kind of quantity: from the signal's unit and its name, against the candidate's unit.
    const candidateKind = unitKindOf(candidate.unit);
    const signalKind = unitKindOf(signal.unit);
    const namedKinds = words.quantities.map((quantity) => unitKind[quantity]).filter(Boolean);
    let conversion = null;
    if (signal.unit && candidate.unit) {
        const found = unitConversion(signal.unit, candidate.unit);
        if (found.error && parseUnit(signal.unit) && parseUnit(candidate.unit)) return null;
        if (!found.error) {
            conversion = found;
            score += 0.25;
            reasons.push(found.identity ? `both in ${candidate.unit}` : `${signal.unit} converts to ${candidate.unit}`);
        }
    } else if (candidateKind && namedKinds.length) {
        if (namedKinds.includes(candidateKind)) {
            score += 0.2;
            reasons.push(`the name says ${words.quantities[0]}, as ${candidate.unit} is`);
        } else if (!signalKind) {
            return null;
        }
    }
    weight += 0.25;
    if (candidateKind && namedKinds.length && signal.unit && !namedKinds.includes(signalKind ?? candidateKind)) score -= 0.1;
    if (candidateKind && namedKinds.length && namedKinds.includes(candidateKind) && signal.unit) {
        score += 0.1;
        if (words.instrument) reasons.push(`${words.instrument.quantity} instrument tag`);
    }
    weight += 0.1;
    // Plausible values: the readings, converted, against the candidate's own value; the nearest of them, since an input may be off
    // (zero) when it is looked at and on at the model's value at other times.
    if (signal.values?.length && Number.isFinite(candidate.initial)) {
        const scale = Math.max(Math.abs(candidate.initial), 1);
        const near = Math.min(...signal.values.map((value) => Math.abs(value * (conversion?.scale ?? 1) + (conversion?.offset ?? 0) - candidate.initial))) / scale;
        if (near < 0.5) {
            score += 0.1;
            reasons.push('its values are of the right size');
        } else if (near > 10) {
            score -= 0.15;
            reasons.push('its values are far from the model\'s');
        }
    }
    weight += 0.1;
    // The role the source declares, when it agrees (one that disagrees was refused above).
    if (signal.role === candidate.role) {
        score += 0.1;
        reasons.push(`declared ${signal.role === 'input' ? 'an input' : 'measured'} by the source`);
    }
    // Behaviour: an input steps, a measurement moves smoothly.
    const steps = signal.role ? null : stepsLikeAnInput(signal.values);
    if (steps !== null) {
        if ((steps && candidate.role === 'input') || (!steps && candidate.role === 'output')) {
            score += 0.1;
            reasons.push(steps ? 'it steps, as an input does' : 'it moves smoothly, as a measurement does');
        } else {
            score -= 0.05;
        }
    }
    weight += 0.1;
    return { score: Math.max(0, Math.min(1, score / weight)), reasons, conversion };
}

// One suggestion for each signal: { signalId, name, role, target: { kind, id, label, unit } | null, confidence, reasons, conversion,
// alternatives: the next best, each { target, confidence } }. Each model quantity is suggested for one signal at most, the most
// confident pairs first. A suggestion below `floor` is left as no match. memory: what rememberMapping keeps.
export function suggestMapping(signals, document, { memory = {}, floor = 0.35 } = {}) {
    const candidates = mappingCandidates(document);
    const findByLabel = (entry) => candidates.find((candidate) => candidate.kind === entry.kind && (candidate.label === entry.label || candidate.symbol === entry.symbol));
    const options = signals.map((signal) => {
        const words = nameWords(signal.name);
        const remembered = memory[signal.name] ? findByLabel(memory[signal.name]) : null;
        const judged = candidates.flatMap((candidate) => {
            if (remembered && candidate === remembered) {
                const conversion = memory[signal.name].conversion ?? (signal.unit && candidate.unit ? unitConversion(signal.unit, candidate.unit) : null);
                return [{ candidate, score: 0.99, reasons: ['matched to it before'], conversion: conversion?.error ? null : conversion }];
            }
            const result = judge(signal, words, candidate);
            return result ? [{ candidate, ...result }] : [];
        }).sort((a, b) => b.score - a.score);
        return { signal, judged };
    });
    // The most confident pairs first, each candidate taken once.
    const pairs = options.flatMap(({ signal, judged }) => judged.map((entry) => ({ signal, ...entry }))).sort((a, b) => b.score - a.score);
    const chosen = new Map();
    const taken = new Set();
    for (const pair of pairs) {
        if (pair.score < floor || chosen.has(pair.signal.id) || taken.has(`${pair.candidate.kind}:${pair.candidate.id}`)) continue;
        chosen.set(pair.signal.id, pair);
        taken.add(`${pair.candidate.kind}:${pair.candidate.id}`);
    }
    const target = (candidate) => ({ kind: candidate.kind, id: candidate.id, label: candidate.label, unit: candidate.unit });
    return options.map(({ signal, judged }) => {
        const pick = chosen.get(signal.id);
        return {
            signalId: signal.id, name: signal.name, unit: signal.unit ?? '',
            role: pick ? pick.candidate.role : null, target: pick ? target(pick.candidate) : null,
            confidence: pick ? Number(pick.score.toFixed(2)) : 0, reasons: pick ? pick.reasons : ['nothing in the model looks like it'],
            conversion: pick?.conversion && !pick.conversion.identity ? { scale: pick.conversion.scale, offset: pick.conversion.offset, from: pick.conversion.from, to: pick.conversion.to, note: pick.conversion.note ?? null } : null,
            alternatives: judged.filter((entry) => entry !== pick && entry.score >= floor / 2).slice(0, 3).map((entry) => ({ target: target(entry.candidate), confidence: Number(entry.score.toFixed(2)) }))
        };
    });
}

// The memory with a mapping's confirmed matches added: by the signal's own name, the quantity it was matched to by its label and
// symbol (ids differ from one project to another), and the conversion confirmed. mapping: [{ name, role, target, conversion }].
export function rememberMapping(memory, mapping, document) {
    const candidates = mappingCandidates(document);
    const next = { ...memory };
    for (const entry of mapping) {
        if (!entry.target) continue;
        const candidate = candidates.find((item) => item.kind === entry.target.kind && item.id === entry.target.id);
        if (!candidate) continue;
        next[entry.name] = { kind: candidate.kind, label: candidate.label, symbol: candidate.symbol, ...(entry.conversion ? { conversion: { scale: entry.conversion.scale, offset: entry.conversion.offset } } : {}) };
    }
    return next;
}

export { quantityName };
