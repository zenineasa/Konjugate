/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Removing an FMU from the library must not break Undo (the single FMU workflow, a reviewer's sequence): delete an FMU node, remove its FMU
// in Settings › Providers, undo. The node came back without its FMU, and saving wrote the project without the FMU it kept in its file
// ("not kept"), so the FMU was lost once its .fmu was gone too. Both ends are closed:
//   (a) an FMU that a window's Undo or Redo can bring back counts as in use, so it is not removable, and the list says why;
//   (b) saving keeps the copy the project file already holds of an FMU the library no longer has, rather than dropping it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { DocumentController } from '../src/renderer/documentController.mjs';
import { fmuLibraryRows, fmuRemovalRefusal, fmuUsage, modelFmuReferences } from '../src/fmuLibrary.mjs';
import { installFmuArchive, listInstalledFmus, projectFmuAttachments, sha256Hex, uninstallFmu } from '../src/fmuPackage.mjs';
import { decodeProjectBundle, encodeProjectFile } from '../src/projectFile.mjs';

const tankFmu = { kind: 'fmi', fmuId: 'guid-tank', fmuVersion: '1.0.0' };
const pumpFmu = { kind: 'fmi', fmuId: 'guid-pump', fmuVersion: '2.0.0' };
const library = [
    { packageId: 'guid-tank', version: '1.0.0', name: 'Tank', manifest: {} },
    { packageId: 'guid-pump', version: '2.0.0', name: 'Pump', manifest: {} }
];

// A window as the renderer keeps it: its model (a deleted node stays in it, flagged, for Undo), its history, and what it answers when the
// main process asks which FMUs it uses.
function projectWindow(nodes) {
    const model = { nodes, subsystemDefinitions: [] };
    const history = new DocumentController();
    history.reset({ references: modelFmuReferences(model) });
    const record = (command) => history.record(command, { references: modelFmuReferences(model) });
    const answer = (project) => fmuUsage(project, { nodes: model.nodes.filter((node) => !node.deleted) }, [...history.historyReferences, ...modelFmuReferences(model)]);
    return { model, history, record, answer };
}

test('an FMU node deleted in a window is held for Undo: its FMU is not removable, and the list says why', () => {
    const window = projectWindow([{ id: 1, title: 'Tank', implementation: structuredClone(tankFmu), sourceTerms: [] }]);
    const tank = window.model.nodes[0];
    tank.deleted = true;
    window.record({ undo: () => { tank.deleted = false; }, redo: () => { tank.deleted = true; } });
    const [pump, row] = fmuLibraryRows(library, [window.answer('Room.kjt')]);
    assert.deepEqual({ usedBy: row.usedBy, heldForUndoBy: row.heldForUndoBy, removable: row.removable }, { usedBy: [], heldForUndoBy: ['Room.kjt'], removable: false },
        'The deleted node is not in the model, but Undo brings it back with its FMU.');
    assert.equal(pump.removable, true, 'An FMU no state of the history uses is still removable.');
    assert.match(fmuRemovalRefusal(row), /Undo in Room\.kjt/);
    // Undone: the node is back and uses it; the reason is now that.
    window.history.undo();
    const [, after] = fmuLibraryRows(library, [window.answer('Room.kjt')]);
    assert.deepEqual({ usedBy: after.usedBy, heldForUndoBy: after.heldForUndoBy, removable: after.removable }, { usedBy: ['Room.kjt'], heldForUndoBy: [], removable: false });
});

test('an FMU a node used before it was given another is held for Undo, and Redo holds the one undone', () => {
    const window = projectWindow([{ id: 1, title: 'Machine', implementation: structuredClone(tankFmu), sourceTerms: [] }]);
    const machine = window.model.nodes[0];
    // The node editor gives the node another FMU: the one it had lives only in the Undo step.
    machine.implementation = structuredClone(pumpFmu);
    window.record({ undo: () => { machine.implementation = structuredClone(tankFmu); }, redo: () => { machine.implementation = structuredClone(pumpFmu); } });
    let rows = fmuLibraryRows(library, [window.answer('Plant.kjt')]);
    assert.deepEqual(rows.map((row) => [row.name, row.usedBy, row.heldForUndoBy]), [['Pump', ['Plant.kjt'], []], ['Tank', [], ['Plant.kjt']]]);
    window.history.undo();
    rows = fmuLibraryRows(library, [window.answer('Plant.kjt')]);
    assert.deepEqual(rows.map((row) => [row.name, row.usedBy, row.heldForUndoBy]), [['Pump', [], ['Plant.kjt']], ['Tank', ['Plant.kjt'], []]], 'Redo can bring the pump back.');
    // A new project in the window starts a new history: nothing is held any more.
    window.model.nodes.splice(0);
    window.history.reset({ references: modelFmuReferences(window.model) });
    assert.equal(fmuLibraryRows(library, [window.answer('Untitled')]).every((row) => row.removable), true);
});

test('modelFmuReferences finds FMUs in deleted nodes and in component definitions, each once', () => {
    const references = modelFmuReferences({
        nodes: [{ id: 1, implementation: tankFmu, deleted: true }, { id: 2, implementation: tankFmu }, { id: 3, implementation: { kind: 'program' } }],
        subsystemDefinitions: [{ id: 9, document: { nodes: [{ id: 4, implementation: pumpFmu }] } }]
    });
    assert.deepEqual(references, [{ guid: 'guid-tank', version: '1.0.0' }, { guid: 'guid-pump', version: '2.0.0' }]);
});

function fmuBytes() {
    const xml = `<?xml version="1.0"?>
<fmiModelDescription fmiVersion="2.0" modelName="Tank" guid="guid-tank" generationTool="Test">
    <CoSimulation modelIdentifier="tank"/>
    <ModelVariables><ScalarVariable name="x" valueReference="0" causality="output"><Real start="0"/></ScalarVariable></ModelVariables>
</fmiModelDescription>`;
    return zipSync({ 'modelDescription.xml': new TextEncoder().encode(xml), 'binaries/darwin64/tank.dylib': new TextEncoder().encode('fake-binary') }, { level: 0 });
}

test('saving keeps the FMU the project file already holds when the library no longer has it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuRemovalUndo-'));
    try {
        const archive = fmuBytes();
        await installFmuArchive(archive, { directory, version: '1.0.0' });
        const sha256 = sha256Hex(archive);
        const content = JSON.stringify({ format: 'konjugate', version: 1, nodes: [{ id: 1, name: 'Tank', implementation: { ...tankFmu, fmuSha256: sha256 } }] });
        // Saved once, keeping the FMU in the file.
        const first = await projectFmuAttachments(directory, content);
        assert.deepEqual({ kept: first.attachments.map((attachment) => attachment.name), missing: first.missing }, { kept: ['Tank.fmu'], missing: [] });
        const saved = await encodeProjectFile(content, { attachments: first.attachments });
        // The node deleted, its FMU removed from the library, the deletion undone: the project is as it was, and the library has no FMU.
        await uninstallFmu({ directory, guid: 'guid-tank', version: '1.0.0' });
        assert.equal((await listInstalledFmus(directory)).length, 0);
        assert.deepEqual((await projectFmuAttachments(directory, content)).missing, ['Tank'], 'From the library alone, it cannot be kept.');
        // Saved again over the file: the file's own copy is kept.
        const again = await projectFmuAttachments(directory, content, { kept: (await decodeProjectBundle(saved)).attachments });
        assert.deepEqual({ kept: again.attachments.map((attachment) => attachment.name), missing: again.missing }, { kept: ['Tank.fmu'], missing: [] });
        const reopened = await decodeProjectBundle(await encodeProjectFile(content, { attachments: again.attachments }));
        assert.deepEqual(reopened.attachments.map((attachment) => attachment.sha256), [sha256], 'The file still carries the same FMU, byte for byte.');
        // A copy the file holds of another archive is not taken for this one.
        const other = { kind: 'fmu', name: 'Other.fmu', sha256: '0'.repeat(64), buffer: Buffer.from('other') };
        assert.deepEqual((await projectFmuAttachments(directory, content, { kept: [other] })).missing, ['Tank']);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
