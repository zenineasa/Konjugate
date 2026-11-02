/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { groupStabilityFindings, isEarlyStabilityFinding, stabilityFindingsTitle, stabilityGroupWhen } from '../src/stabilityFindingGroups.mjs';

const finding = (nodeId, stateId, code, globalTime) => ({ nodeId, stateId, code, message: `${code} message`, globalTime });
const format = (time) => `${time} s`;

test('findings of one kind on one state become one entry with a count and a time span', () => {
    const groups = groupStabilityFindings([
        finding(1, 11, 'duringRunGrowthTrend', 0.06), finding(1, 11, 'duringRunGrowthTrend', 0.5), finding(1, 11, 'duringRunGrowthTrend', 2)
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual([groups[0].count, groups[0].firstTime, groups[0].lastTime, groups[0].globalTime], [3, 0.06, 2, 0.06]);
    assert.equal(groups[0].message, 'duringRunGrowthTrend message');
});

test('a different state, node or kind of finding is its own entry, in the order first raised', () => {
    const groups = groupStabilityFindings([
        finding(1, 11, 'duringRunGrowthTrend', 0.1), finding(1, 12, 'duringRunGrowthTrend', 0.2), finding(2, 11, 'duringRunGrowthTrend', 0.3),
        finding(1, 11, 'duringRunPotentiallyUnstable', 0.4), finding(1, 12, 'duringRunGrowthTrend', 0.9)
    ]);
    assert.deepEqual(groups.map((group) => [group.nodeId, group.stateId, group.code, group.count]), [
        [1, 11, 'duringRunGrowthTrend', 1], [1, 12, 'duringRunGrowthTrend', 2], [2, 11, 'duringRunGrowthTrend', 1], [1, 11, 'duringRunPotentiallyUnstable', 1]
    ]);
});

test('findings out of time order still give the earliest and latest, and one with no time does not spoil them', () => {
    const [group] = groupStabilityFindings([finding(1, 1, 'c', 5), finding(1, 1, 'c', undefined), finding(1, 1, 'c', 1), finding(1, 1, 'c', 3)]);
    assert.deepEqual([group.count, group.firstTime, group.lastTime, group.globalTime], [4, 1, 5, 1]);
});

test('post-run findings, which have no time, group per state too', () => {
    const groups = groupStabilityFindings([finding(1, 11, 'postRunGrowthFingerprint', undefined), finding(1, 12, 'postRunGrowthFingerprint', undefined)]);
    assert.equal(groups.length, 2);
    assert.equal(stabilityGroupWhen(groups[0], format), 'across the run');
});

test('a node-level finding (state 0, or none) is one entry per node', () => {
    const groups = groupStabilityFindings([finding(1, 0, 'duringRunPotentiallyUnstable', 1), finding(1, undefined, 'duringRunPotentiallyUnstable', 2)]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
});

test('the title counts entries, and occurrences too when some repeat', () => {
    assert.equal(stabilityFindingsTitle(groupStabilityFindings([finding(1, 1, 'c', 1)])), '1 finding');
    assert.equal(stabilityFindingsTitle(groupStabilityFindings([finding(1, 1, 'c', 1), finding(1, 2, 'c', 1)])), '2 findings');
    assert.equal(stabilityFindingsTitle(groupStabilityFindings([finding(1, 1, 'c', 1), finding(1, 1, 'c', 2), finding(1, 2, 'c', 1)])), '2 findings · 3 occurrences');
});

test('when a group happened reads as one time, a span, or the whole run', () => {
    const [one] = groupStabilityFindings([finding(1, 1, 'c', 0.06)]);
    const [many] = groupStabilityFindings([finding(1, 1, 'c', 0.06), finding(1, 1, 'c', 9.99)]);
    assert.equal(stabilityGroupWhen(one, format), 'at 0.06 s');
    assert.equal(stabilityGroupWhen(many, format), '2 times, from 0.06 s to 9.99 s');
});

test('only the monitor\'s first, cheap check is an early finding; the checks that confirm instability are not', () => {
    assert.equal(isEarlyStabilityFinding({ code: 'duringRunGrowthTrend' }), true);
    for (const code of ['duringRunPotentiallyUnstable', 'postRunGrowthFingerprint', 'postRunSawtoothFingerprint', 'numericsPotentiallyUnstable']) {
        assert.equal(isEarlyStabilityFinding({ code }), false, code);
    }
});
