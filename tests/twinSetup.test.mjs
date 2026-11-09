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

test('the engineer\'s settings, the room\'s layout and the last run\'s events are kept, what is unusable dropped', () => {
    const setup = normalizeTwinSetup({
        source: { kind: 'push' },
        mapping: [
            { source: 'a', name: 'tankT', role: 'output', target: { kind: 'state', id: 3 } },
            { source: 'b', name: 'power', role: 'input', target: { kind: 'parameter', id: 9 } }
        ],
        live: { timeStep: 30, members: 64, corrections: { tankT: { estimate: true }, power: { gain: 2 }, ghost: { gain: 0.5 } }, untracked: [10, 10, -1, 'x'] },
        layout: { order: ['tankT', 'ghost'], tall: ['tankT'], pinned: [], hidden: 'tankT', bounds: { x: 1920, y: 0, width: 1600, height: 900, maximized: true } },
        record: { startedAt: '2026-11-07T10:00:00Z', events: [{ at: '2026-11-07T10:05:00Z', kind: 'bad', text: 'Drifting', detail: 'past the warning' }, { at: 'x', kind: 'nonsense', text: 'dropped' }] }
    });
    assert.deepEqual(setup.live, { timeStep: 30, members: 64, corrections: { tankT: { estimate: true } }, untracked: [10] });
    assert.deepEqual(setup.layout, { order: ['tankT'], tall: ['tankT'], bounds: { x: 1920, y: 0, width: 1600, height: 900, maximized: true } });
    assert.deepEqual(setup.record, { startedAt: '2026-11-07T10:00:00Z', events: [{ at: '2026-11-07T10:05:00Z', kind: 'bad', text: 'Drifting', detail: 'past the warning' }] });
    assert.equal(normalizeTwinSetup({ source: { kind: 'push' }, mapping: [], layout: { bounds: { x: 0, y: 0, width: 10, height: 10 } } }).layout, undefined, 'A window too small to use is not kept.');
});

test('how much of the past the room\'s plots show is kept: everything, or a span in seconds', () => {
    const span = (value) => normalizeTwinSetup({ source: { kind: 'push' }, mapping: [], layout: { span: value } }).layout?.span;
    assert.equal(span('all'), 'all');
    assert.equal(span(3600), 3600);
    for (const unusable of [0, -60, Infinity, 'recent', '3600', null]) assert.equal(span(unusable), undefined, `${String(unusable)} is not a span.`);
});
