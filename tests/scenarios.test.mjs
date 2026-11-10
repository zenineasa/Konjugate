/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTried, draftScenario } from '../src/scenarios.mjs';

const document = { nodes: [], edges: [], sharedParameters: [] };

test('a draft is named in the system\'s terms: its input\'s name and unit, times at its scale, each value with when it applied', () => {
    const draft = draftScenario({
        id: 'a', startedAt: 11, ranFor: 9, settings: { window: 5, stride: 1, horizon: 5 }, document,
        tried: [{ time: 14, signal: 'motorVoltage', value: 12 }, { time: 17.25, signal: 'motorVoltage', value: 0 }],
        inputs: { motorVoltage: { name: 'Voltage', unit: 'V' } }
    });
    assert.equal(draft.name, 'Tried from 11 s: Voltage 12 V at 14 s, 0 V at 17.3 s');
    // A house's, in hours.
    assert.equal(draftScenario({ id: 'b', startedAt: 5 * 3600, ranFor: 3600, settings: {}, document, tried: [{ time: 5 * 3600, signal: 'heater', value: 0 }] }).name,
        'Tried from 5 h: heater 0 at 5 h');
});

test('an input moved many times, as a fader followed moves it, is named by its range and when, not every value', () => {
    const tried = Array.from({ length: 37 }, (_, index) => ({ time: 3.2 * 3600 + index * 60, signal: 'heaterPower', value: index * 2000 / 36 }));
    assert.equal(describeTried(tried, { heaterPower: { name: 'Heater power', unit: 'W' } }), 'Heater power, 37 changes between 0 and 2000 W from 3.2 h to 3.8 h');
    assert.equal(describeTried([...tried.slice(0, 1), { time: 3.2 * 3600, signal: 'valve', value: 1 }]), 'heaterPower 0 at 3.2 h; valve 1 at 3.2 h');
});

test('nothing tried keeps no draft', () => {
    assert.equal(draftScenario({ id: 'c', startedAt: 0, ranFor: 60, settings: {}, document, tried: [] }), null);
});
