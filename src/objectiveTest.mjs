/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's Test for a tuning objective written as a program (docs/proposals/codeEditor.md, "Tuning objectives"): the objective
// run once on one trial, as a tuning runs it, through the objective SDK's own process (python -m konjugate.objective, or a C++ program
// linked with engine/src/objectiveProgramMain.cpp) and its own messages (protocol/engineProtocol.proto: ObjectiveRunRequest in,
// ObjectiveRunResult out, each framed by its length as a 4-byte big-endian number). Pure: the desktop runs the process, the project
// window gathers the trial, and a unit test reads both ends.

// ---- The objective's Ports: its keys, each with what the tuning card binds it to -----------------------------------------------------
// bindings: the card's [{ key, kind: 'state' | 'parameter' | 'measured', id, column }]; targets: what a key can be bound to, as the card
// lists them ([{ value, label, group }] with value programBindingValue's 'state:7', 'parameter:9', 'measured:Temp').
const kindWords = { state: 'state', parameter: 'tuned parameter', measured: 'measured column' };
const bindingValue = (binding) => (binding.kind === 'measured' ? `measured:${binding.column ?? ''}` : `${binding.kind}:${binding.id ?? ''}`);

export function objectivePorts(bindings, targets) {
    return (bindings ?? []).map((binding) => {
        const target = (targets ?? []).find((candidate) => candidate.value === bindingValue(binding));
        return { key: binding.key ?? '', kind: binding.kind, kindWord: kindWords[binding.kind] ?? binding.kind, bound: target?.label ?? null,
            reads: binding.kind === 'parameter' ? 'run.value' : 'run.series' };
    });
}

// ---- Protocol buffers, as far as these two messages need ----------------------------------------------------------------------------
function varint(value) {
    const bytes = [];
    let number = value >>> 0;
    while (number > 0x7f) { bytes.push((number & 0x7f) | 0x80); number >>>= 7; }
    bytes.push(number);
    return bytes;
}
const tag = (field, wire) => varint((field << 3) | wire);
const utf8 = (text) => [...new TextEncoder().encode(String(text))];
function doubleBytes(value) {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, Number(value), true);
    return [...new Uint8Array(buffer)];
}
const lengthDelimited = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];

// ObjectiveRunRequest: times (1, packed doubles), series (2: key 1, values 2 packed), values (3: key 1, value 2).
export function encodeObjectiveRunRequest({ times = [], series = {}, values = {} }) {
    const bytes = [];
    if (times.length) bytes.push(...lengthDelimited(1, times.flatMap(doubleBytes)));
    for (const [key, numbers] of Object.entries(series)) {
        const entry = [...lengthDelimited(1, utf8(key)), ...(numbers.length ? lengthDelimited(2, numbers.flatMap(doubleBytes)) : [])];
        bytes.push(...lengthDelimited(2, entry));
    }
    for (const [key, value] of Object.entries(values)) {
        bytes.push(...lengthDelimited(3, [...lengthDelimited(1, utf8(key)), ...tag(2, 1), ...doubleBytes(value)]));
    }
    return Uint8Array.from(bytes);
}

export function frame(message) {
    const framed = new Uint8Array(4 + message.length);
    new DataView(framed.buffer).setUint32(0, message.length, false);
    framed.set(message, 4);
    return framed;
}

// The fields of a message: [{ field, wire, value }], value a number (varint), a DataView offset's double (wire 1) or bytes (wire 2).
function fields(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    let at = 0;
    const readVarint = () => {
        let result = 0;
        let shift = 0;
        for (;;) {
            const byte = bytes[at++];
            result += (byte & 0x7f) * 2 ** shift;
            if (!(byte & 0x80)) return result;
            shift += 7;
        }
    };
    while (at < bytes.length) {
        const key = readVarint();
        const field = Math.floor(key / 8);
        const wire = key % 8;
        if (wire === 0) out.push({ field, wire, value: readVarint() });
        else if (wire === 1) { out.push({ field, wire, value: view.getFloat64(at, true) }); at += 8; }
        else if (wire === 2) { const length = readVarint(); out.push({ field, wire, value: bytes.subarray(at, at + length) }); at += length; }
        else if (wire === 5) at += 4;
        else throw new Error(`An answer the objective program sent cannot be read (wire type ${wire}).`);
    }
    return out;
}

// ObjectiveRunResult: ok (1), message (2), value (3), reports (4: key 1, value 2).
export function decodeObjectiveRunResult(bytes) {
    const result = { ok: false, message: '', value: null, reports: [] };
    for (const { field, wire, value } of fields(bytes)) {
        if (field === 1 && wire === 0) result.ok = value !== 0;
        else if (field === 2 && wire === 2) result.message = new TextDecoder().decode(value);
        else if (field === 3 && wire === 1) result.value = value;
        else if (field === 4 && wire === 2) {
            const report = { key: '', value: null };
            for (const part of fields(value)) {
                if (part.field === 1 && part.wire === 2) report.key = new TextDecoder().decode(part.value);
                else if (part.field === 2 && part.wire === 1) report.value = part.value;
            }
            result.reports.push(report);
        }
    }
    return result;
}

// ---- The trial the objective is run on --------------------------------------------------------------------------------------------
// A measured column at the run's output times, as the trial reads it: interpolated linearly, held past either end.
export function measuredAt(times, columnTimes, columnValues) {
    return times.map((time) => {
        if (!columnTimes.length) return Number.NaN;
        if (time <= columnTimes[0]) return columnValues[0];
        if (time >= columnTimes.at(-1)) return columnValues.at(-1);
        let index = 0;
        while (index + 2 < columnTimes.length && time > columnTimes[index + 1]) index += 1;
        const fraction = (time - columnTimes[index]) / (columnTimes[index + 1] - columnTimes[index]);
        return columnValues[index] + fraction * (columnValues[index + 1] - columnValues[index]);
    });
}

// The line of the program an error names: the last frame of a Python traceback in the program's own file, else a "line N" in the
// message; null when neither.
export function objectiveErrorLine(text, fileName) {
    const frames = [...String(text ?? '').matchAll(/File "([^"]*)", line (\d+)/g)].filter(([, file]) => file.endsWith(fileName));
    if (frames.length) return Number(frames.at(-1)[2]);
    const said = /\bline (\d+)\b/i.exec(String(text ?? ''));
    return said ? Number(said[1]) : null;
}
