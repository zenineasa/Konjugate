/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Compatibility, both ways (docs/proposals/unifiedEntityEditors.md, Saved format and Compatibility tests):
//   - every project a released version saved opens in this one, its nodes, relationships and subsystems coming back from the
//     codec as they were saved, and a result saved with one plays;
//   - what this version writes opens in the readers v1.4.15 shipped (kept in tests/fixtures/olderVersions/v1.4.15/readers,
//     as released, so the test does not need the release's tag), which keep the fields they do not know.
// Fixtures: the bundled examples as tagged in v1.4.15 and in v0.3.2 (the first release whose examples are .kjt), and the
// thermal example saved by v1.4.15 with the result its engine ran.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeProjectBundle, encodeProjectFile } from '../src/projectFile.mjs';
import { decodeResultFile } from '../src/engineProtocol.mjs';
import { nodeFromDocument, nodeToDocument, relationshipFromDocument, relationshipToDocument, subsystemFromDocument, subsystemToDocument } from '../src/modelCodec.mjs';
import * as releasedCodec from './fixtures/olderVersions/v1.4.15/readers/modelCodec.mjs';
import * as releasedProjectFile from './fixtures/olderVersions/v1.4.15/readers/projectFile.mjs';
import * as releasedProtocol from './fixtures/olderVersions/v1.4.15/readers/engineProtocol.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/olderVersions/', import.meta.url));

// The canvas's normalisers, replaced by stand-ins that change nothing, as in tests/modelCodec.test.mjs.
const context = {
    geometryFromDocument: (mesh) => ({ mesh }),
    serializeGeometry: (geometry) => geometry.mesh,
    stateValueText: (value) => ({ text: String(value), exact: true }),
    transformOf: (definition) => ({ position: definition.position, rotation: definition.rotation, scale: definition.scale }),
    newId: () => 9999,
    sourceTermExpressionModel: (definition, term) => term.expressionModel ?? { latex: term.expression },
    relationshipEquationModel: (definition) => definition.equationModel
};

async function projects(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await projects(path));
        else if (entry.name.endsWith('.kjt')) found.push(path);
    }
    return found.sort();
}

// A document's entities through a codec and back, as opening and saving does.
function roundTrip(document, codec) {
    return {
        nodes: (document.nodes ?? []).map((node) => codec.nodeToDocument(codec.nodeFromDocument(node, context), context)),
        edges: (document.edges ?? []).map((edge) => codec.relationshipToDocument(codec.relationshipFromDocument(edge, context), context)),
        subsystems: (document.subsystems ?? []).map((subsystem) => codec.subsystemToDocument(codec.subsystemFromDocument(subsystem)))
    };
}
const current = { nodeFromDocument, nodeToDocument, relationshipFromDocument, relationshipToDocument, subsystemFromDocument, subsystemToDocument };

test('every project v1.4.15 saved opens, and its entities come back from the codec as saved', async () => {
    const paths = await projects(join(fixtures, 'v1.4.15'));
    assert.ok(paths.length >= 20, 'The v1.4.15 fixtures are missing.');
    for (const path of paths) {
        const bundle = await decodeProjectBundle(await readFile(path));
        const document = JSON.parse(bundle.content);
        assert.ok(Array.isArray(document.nodes), `${path} has no nodes`);
        // As saved by the version that wrote it: what the released codec writes back is what this one writes back.
        assert.deepEqual(roundTrip(document, current), roundTrip(document, releasedCodec), `${path} is written back differently than v1.4.15 wrote it`);
    }
});

test('every project v0.3.2 saved opens, and saving it again is stable', async () => {
    const paths = await projects(join(fixtures, 'v0.3.2'));
    assert.equal(paths.length, 5);
    for (const path of paths) {
        const document = JSON.parse((await decodeProjectBundle(await readFile(path))).content);
        assert.ok(document.nodes.length > 0, `${path} has no nodes`);
        const once = roundTrip(document, current);
        assert.deepEqual(roundTrip(once, current), once, `${path} changes each time it is saved`);
    }
});

test('a result v1.4.15 saved with its project plays', async () => {
    const bundle = await decodeProjectBundle(await readFile(join(fixtures, 'v1.4.15/withResults/thermalManagement.kjt')));
    assert.ok(bundle.result, 'The saved result was not found in the project.');
    const result = decodeResultFile(bundle.result);
    assert.equal(result.samples.length, 21, 'Five seconds at a quarter second, start and end included.');
    assert.ok(result.samples.every((sample) => sample.states.length > 0 && sample.states.every((state) => Number.isFinite(state.value))));
    assert.equal(result.samples[0].time, 0);
    assert.equal(result.samples.at(-1).time, 5);
});

test('what this version writes opens in the readers v1.4.15 shipped, which keep the fields they do not know', async () => {
    const fresh = JSON.parse((await decodeProjectBundle(await readFile(join(fixtures, 'v1.4.15/examples/thermalManagement.kjt')))).content);
    // The fields this version may add (docs/proposals/unifiedEntityEditors.md, Saved format).
    fresh.nodes[0].shortName = 'BM';
    fresh.nodes[0].states[0].kind = 'rate';
    const parameter = fresh.edges.find((edge) => edge.parameters?.length).parameters[0];
    parameter.displaySymbol = '\\alpha';
    const file = await encodeProjectFile(JSON.stringify(fresh));
    const opened = JSON.parse(await releasedProjectFile.decodeProjectFile(file));
    const written = roundTrip(opened, releasedCodec);
    assert.equal(written.nodes[0].shortName, 'BM', 'v1.4.15 drops a node\'s short name.');
    assert.equal(written.nodes[0].states[0].kind, 'rate', 'v1.4.15 drops a state\'s kind.');
    assert.equal(written.edges.find((edge) => edge.parameters?.length).parameters[0].displaySymbol, '\\alpha', 'v1.4.15 drops a parameter\'s display symbol.');
});

test('a result with fields this version may add still plays in the reader v1.4.15 shipped', async () => {
    const bundle = await decodeProjectBundle(await readFile(join(fixtures, 'v1.4.15/withResults/thermalManagement.kjt')));
    const before = releasedProtocol.decodeResultFile(bundle.result);
    const after = releasedProtocol.decodeResultFile(withUnknownFields(bundle.result));
    assert.deepEqual(after.samples, before.samples, 'Unknown fields changed what v1.4.15 reads.');
});

// The result with an unknown field added to its header and to every sample batch (field 15, a varint, and field 14, a packed run
// of doubles): what an additive field of a later version looks like to an older reader.
function withUnknownFields(buffer) {
    const bytes = Buffer.from(buffer);
    const headerLength = bytes.readUInt32BE(4);
    const header = bytes.subarray(8, 8 + headerLength);
    const footerLength = bytes.readUInt32BE(bytes.length - 8);
    const indexStart = bytes.length - 8 - footerLength;
    const extra = Buffer.from([15 << 3 | 0, 7, 14 << 3 | 2, 16, ...new Uint8Array(new Float64Array([1.5, -2.25]).buffer)]);
    const batches = [];
    for (let offset = 8 + headerLength; offset < indexStart;) {
        const length = bytes.readUInt32BE(offset);
        batches.push(Buffer.concat([bytes.subarray(offset + 4, offset + 4 + length), extra]));
        offset += 4 + length;
    }
    // Lay the file out again with its index pointing at the longer batches.
    const index = releasedProtocol.decodeResultIndexPayload(bytes.subarray(indexStart, indexStart + footerLength));
    const newHeader = Buffer.concat([header, extra]);
    const parts = [bytes.subarray(0, 4), uint32(newHeader.length), newHeader];
    let offset = 8 + newHeader.length;
    index.batches.forEach((entry, position) => {
        entry.offset = offset;
        entry.length = batches[position].length;
        parts.push(uint32(batches[position].length), batches[position]);
        offset += 4 + batches[position].length;
    });
    const newIndex = encodeResultIndex(index);
    parts.push(newIndex, uint32(newIndex.length), Buffer.from('KJIX'));
    return Buffer.concat(parts);
}
// ResultIndex (protocol/engineProtocol.proto): result_version, sample_count, and each batch's start and end time, offset,
// length and sample count.
function encodeResultIndex(index) {
    const varint = (value) => {
        const bytes = [];
        let rest = BigInt(value);
        do {
            let byte = Number(rest & 0x7fn);
            rest >>= 7n;
            if (rest) byte |= 0x80;
            bytes.push(byte);
        } while (rest);
        return Buffer.from(bytes);
    };
    const double = (value) => Buffer.from(new Float64Array([value]).buffer);
    const batch = (entry) => Buffer.concat([
        Buffer.from([1 << 3 | 1]), double(entry.startTime), Buffer.from([2 << 3 | 1]), double(entry.endTime),
        Buffer.from([3 << 3]), varint(entry.offset), Buffer.from([4 << 3]), varint(entry.length), Buffer.from([5 << 3]), varint(entry.sampleCount)
    ]);
    return Buffer.concat([
        Buffer.from([1 << 3]), varint(index.resultVersion), Buffer.from([2 << 3]), varint(index.sampleCount),
        ...index.batches.flatMap((entry) => { const body = batch(entry); return [Buffer.from([3 << 3 | 2]), varint(body.length), body]; })
    ]);
}
function uint32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return buffer;
}
