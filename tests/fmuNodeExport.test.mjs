/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMI review #8: exporting a model that contains an FMU node says that FMU nodes cannot be exported yet, naming the node, in every export
// (an FMU, C++ and Python), rather than speaking of a "computational-node provider".

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFmu } from '../src/fmiExport.mjs';
import { generateStandaloneProgram } from '../src/codeExport.mjs';

const document = {
    format: 'konjugate', version: 1, metadata: { projectName: 'Has an FMU' },
    runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }], activeRunConfigurationId: 900, edges: [],
    nodes: [
        { id: 1, name: 'Tank', states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 1 }], sourceTerms: [] },
        { id: 3, name: 'Controller', states: [{ id: 4, name: 'Command', symbol: 'command', initialValue: 0 }], sourceTerms: [],
            implementation: { kind: 'fmi', fmuId: 'guid', fmuVersion: '1.0.0', bindings: [], outputs: [{ key: 'command', stateId: 4 }] } }
    ]
};
const expected = 'Node "Controller" runs an FMU, and a model with an FMU node cannot be exported yet: export blocked. Switch the node off to export the rest of the model.';

test('every export of a model with an FMU node says FMU nodes cannot be exported yet, naming the node', () => {
    for (const [what, exportIt] of [['FMI 2.0', () => describeFmu(document, 'HasFmu')], ['FMI 3.0', () => describeFmu(document, 'HasFmu', { fmiVersion: '3.0' })],
        ['C++', () => generateStandaloneProgram(document, 'cpp')], ['Python', () => generateStandaloneProgram(document, 'python')]]) {
        assert.throws(exportIt, { message: expected }, what);
    }
});

test('a switched-off FMU node does not stop the export of the rest of the model', () => {
    const off = structuredClone(document);
    off.nodes[1].enabled = false;
    assert.doesNotThrow(() => generateStandaloneProgram(off, 'cpp'));
    assert.doesNotThrow(() => describeFmu(off, 'HasFmu'));
});
