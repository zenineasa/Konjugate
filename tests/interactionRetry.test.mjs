// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import test from 'node:test';
import { combineOutcomes, onlyFilter, scenariosToRetry } from '../scripts/interactionRetry.mjs';

test('a failed scenario is retried with the scenario that ran before it, skipped ones passed over', () => {
    const outcomes = [
        { name: 'a', status: 'passed' },
        { name: 'rotate', status: 'passed' },
        { name: 'b', status: 'skipped' },
        { name: 'edge group', status: 'failed' },
        { name: 'c', status: 'passed' },
        { name: 'd', status: 'failed' },
        { name: 'e', status: 'failed' }
    ];
    assert.deepEqual(scenariosToRetry(outcomes), ['rotate', 'edge group', 'c', 'd', 'e']);
    assert.deepEqual(scenariosToRetry([{ name: 'first', status: 'failed' }]), ['first']);
    assert.deepEqual(scenariosToRetry([{ name: 'a', status: 'passed' }]), []);
});

test('a scenario failing both passes fails the run; one passing the second time is flaky', () => {
    const first = [{ name: 'setup', status: 'passed' }, { name: 'timing', status: 'failed' }, { name: 'broken', status: 'failed' }];
    const second = [{ name: 'setup', status: 'passed' }, { name: 'timing', status: 'passed' }, { name: 'broken', status: 'failed' }];
    assert.deepEqual(combineOutcomes(first, second), { failed: ['broken'], flaky: ['timing'] });
});

test('a failure the second pass never reached still fails the run, and a setup scenario failing there is flaky', () => {
    assert.deepEqual(combineOutcomes([{ name: 'x', status: 'failed' }], []), { failed: ['x'], flaky: [] });
    const first = [{ name: 'rotate', status: 'passed' }, { name: 'edge group', status: 'failed' }];
    const second = [{ name: 'rotate', status: 'failed' }, { name: 'edge group', status: 'failed' }];
    assert.deepEqual(combineOutcomes(first, second), { failed: ['edge group'], flaky: ['rotate'] });
});

test('the retried names are passed as one KONJUGATE_INTERACTION_ONLY value', () => {
    assert.equal(onlyFilter(['a b', 'c']), 'a b||c');
    assert.throws(() => onlyFilter(['a||b']));
});
