/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A twin's setup as a project keeps it (src/twinSetup.mjs): what is usable kept, what is not dropped, and the live twin's mapping and
// conversions made from it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTwinSetup, twinSessionMapping } from '../src/twinSetup.mjs';

test('a setup keeps its source, its usable mapping entries and its settings, and drops the rest', () => {
    const setup = normalizeTwinSetup({
        source: { kind: 'opcua', url: 'opc.tcp://plc:4840', security: 'signAndEncrypt' },
        mapping: [
            { source: 'ns=2;s=TT101', name: 'TT101', role: 'output', target: { kind: 'state', id: 2 }, unit: '°C', conversion: { scale: 1, offset: 273.15 } },
            { source: 'ns=2;s=JI101', name: 'JI101', role: 'input', target: { kind: 'parameter', id: 40 }, unit: 'kW', conversion: { scale: 1000, offset: 0 } },
            { source: 'ns=2;s=Note', name: 'note', role: null, target: null, unit: '' },
            { source: 'ns=2;s=Wrong', name: 'wrong', role: 'output', target: { kind: 'parameter', id: 40 } },
            { source: 'ns=2;s=TT101', name: 'TT101', role: 'output', target: { kind: 'state', id: 3 } },
            { source: 'x', name: '1bad', role: null },
            { source: 'y', name: 'zero', role: 'output', target: { kind: 'state', id: 5 }, conversion: { scale: 0, offset: 1 } }
        ],
        live: { window: 3600, stride: 600, horizon: -1, speed: '600', alert: 0.3 }
    });
    assert.deepEqual(setup.source, { kind: 'opcua', url: 'opc.tcp://plc:4840', security: 'signAndEncrypt' });
    assert.deepEqual(setup.mapping.map((entry) => entry.name), ['TT101', 'JI101', 'note', 'wrong', 'zero'], 'A repeated name and a name that is not an identifier are dropped.');
    assert.deepEqual(setup.mapping[3], { source: 'ns=2;s=Wrong', name: 'wrong', role: null, target: null, unit: '', conversion: null }, 'A measured signal cannot map to a parameter: kept, unmapped.');
    assert.equal(setup.mapping[4].conversion, null, 'A scale of zero is no conversion.');
    assert.deepEqual(setup.live, { window: 3600, stride: 600, speed: '600', alert: 0.3 });
    assert.equal(normalizeTwinSetup({ source: { kind: 'ftp' } }), null);
    assert.equal(normalizeTwinSetup('nonsense'), null);

    const { mapping, conversions } = twinSessionMapping(setup);
    assert.deepEqual(mapping, [
        { signal: 'TT101', role: 'output', unit: '°C', stateId: 2 },
        { signal: 'JI101', role: 'input', unit: 'kW', parameterId: 40 },
        { signal: 'zero', role: 'output', unit: '', stateId: 5 }
    ]);
    assert.deepEqual(conversions, { TT101: { scale: 1, offset: 273.15 }, JI101: { scale: 1000, offset: 0 } });
});
