// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import test from 'node:test';
import { combineOutcomes, onlyFilter, scenariosToRetry } from '../scripts/interactionRetry.mjs';

test('a failure is run again with the earlier members of its group, and a scenario of no group alone', () => {
    const outcomes = [
        { name: 'loads', status: 'passed' },
        { name: 'set up', status: 'passed', group: 'g' },
        { name: 'skipped in g', status: 'skipped', group: 'g' },
        { name: 'uses it', status: 'passed', group: 'g' },
        { name: 'after it', status: 'failed', group: 'g' },
        { name: 'other group', status: 'passed', group: 'h' },
        { name: 'alone', status: 'failed' },
        { name: 'later in g', status: 'passed', group: 'g' }
    ];
    assert.deepEqual(scenariosToRetry(outcomes), ['set up', 'uses it', 'after it', 'alone']);
    assert.deepEqual(scenariosToRetry([{ name: 'first', status: 'failed', group: 'g' }]), ['first']);
    assert.deepEqual(scenariosToRetry([{ name: 'a', status: 'passed' }]), []);
});

test('the retried names are passed as one KONJUGATE_INTERACTION_ONLY value', () => {
    assert.equal(onlyFilter(['a b', 'c']), 'a b||c');
    assert.throws(() => onlyFilter(['a||b']));
});

test('a scenario failing both passes fails the run; one passing the second time is flaky', () => {
    const first = [{ name: 'setup', status: 'passed' }, { name: 'timing', status: 'failed' }, { name: 'broken', status: 'failed' }];
    const second = [{ name: 'setup', status: 'passed' }, { name: 'timing', status: 'passed' }, { name: 'broken', status: 'failed' }];
    assert.deepEqual(combineOutcomes(first, second), { failed: ['broken'], flaky: ['timing'] });
});

test('a failure the second pass never reached still fails the run, and a group member failing there is flaky', () => {
    assert.deepEqual(combineOutcomes([{ name: 'x', status: 'failed' }], []), { failed: ['x'], flaky: [] });
    const first = [{ name: 'rotate', status: 'passed' }, { name: 'edge group', status: 'failed' }];
    const second = [{ name: 'rotate', status: 'failed' }, { name: 'edge group', status: 'failed' }];
    assert.deepEqual(combineOutcomes(first, second), { failed: ['edge group'], flaky: ['rotate'] });
});
