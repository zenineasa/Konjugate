/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import reportMessages from '../src/generated/reportMessages.mjs';
import { decodeFittingReport } from '../src/reportProtocol.mjs';

const { FittingReport } = reportMessages.konjugate.protocol;

test('a fitting report from an engine before each limit\'s outcome and the starting objective reads as not reported, not as 0', () => {
    const older = decodeFittingReport(FittingReport.encode({ finalLoss: 340, finalViolation: 0 }).finish());
    assert.deepEqual(older.finalLimits, []);
    assert.equal(older.startObjective, null);
    assert.equal(older.startViolation, null);
    assert.equal(older.finalLoss, 340);
});

test('a fitting report gives each limit with what it reached, and the starting values\' objective, a 0 included', () => {
    const report = decodeFittingReport(FittingReport.encode({
        finalLoss: 340, finalLimits: [{ limit: 340, atMost: true, reached: 339.97 }], startObjective: 0, startViolation: 0.045
    }).finish());
    assert.deepEqual(report.finalLimits, [{ limit: 340, atMost: true, reached: 339.97 }]);
    assert.equal(report.startObjective, 0, 'A starting objective of 0, written, is 0.');
    assert.equal(report.startViolation, 0.045);
});
