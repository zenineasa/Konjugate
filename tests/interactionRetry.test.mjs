// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import test from 'node:test';
import { combineOutcomes } from '../scripts/interactionRetry.mjs';

test('a scenario failing both passes fails the run; one passing the second time is flaky', () => {
    const first = [{ name: 'setup', status: 'passed' }, { name: 'timing', status: 'failed' }, { name: 'broken', status: 'failed' }];
    const second = [{ name: 'setup', status: 'passed' }, { name: 'timing', status: 'passed' }, { name: 'broken', status: 'failed' }];
    assert.deepEqual(combineOutcomes(first, second), { failed: ['broken'], flaky: ['timing'] });
});

test('a failure the second pass never reached still fails the run, and one that only failed the second time is flaky', () => {
    assert.deepEqual(combineOutcomes([{ name: 'x', status: 'failed' }], []), { failed: ['x'], flaky: [] });
    const first = [{ name: 'rotate', status: 'passed' }, { name: 'edge group', status: 'failed' }];
    const second = [{ name: 'rotate', status: 'failed' }, { name: 'edge group', status: 'failed' }];
    assert.deepEqual(combineOutcomes(first, second), { failed: ['edge group'], flaky: ['rotate'] });
});
