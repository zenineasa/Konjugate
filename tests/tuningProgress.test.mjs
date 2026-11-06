/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { convergenceTraces, estimateText, formatDuration, formatLoss, noImprovementWindow, summarizeTuning, tuningWarnings } from '../src/renderer/tuningProgress.mjs';

let failedSoFar = 0;
const event = (iteration, loss, bestLoss, { failed = false, elapsed = iteration * 0.5, baseline = iteration === 1 } = {}) => {
    if (failed) failedSoFar += 1;
    return { iteration, loss, bestLoss, failed, failedTrials: failedSoFar, elapsedSeconds: baseline ? 0.8 : elapsed, parameterValues: [iteration], bestParameterValues: [1], baseline };
};
const run = (losses) => {
    failedSoFar = 0;
    let best = Infinity;
    return losses.map((loss, index) => {
        const failed = loss === null;
        if (!failed) best = Math.min(best, loss);
        return event(index + 1, failed ? 1e12 : loss, best, { failed });
    });
};

test('durations read at the size they are', () => {
    assert.equal(formatDuration(0.0004), '1 ms');
    assert.equal(formatDuration(0), '0 s');
    assert.equal(formatDuration(0.85), '850 ms');
    assert.equal(formatDuration(4.26), '4.3 s');
    assert.equal(formatDuration(42.4), '42 s');
    assert.equal(formatDuration(160), '2 min 40 s');
    assert.equal(formatDuration(3900), '1 h 05 min');
    assert.equal(formatDuration(NaN), '—');
    assert.equal(formatLoss(0.123456), '0.1235');
    assert.equal(formatLoss(NaN), '—');
});

test('the estimate comes from the starting values\' time, and says only what is known', () => {
    const events = run([5]);
    assert.equal(estimateText([], { simulations: 200 }), '');
    assert.equal(estimateText(events, { simulations: 200 }), 'One simulation takes 800 ms, so up to 200 simulations is about 2 min 40 s.');
    assert.equal(estimateText(events, { simulations: 200, seconds: 60 }), 'One simulation takes 800 ms, so 200 simulations would take 2 min 40 s; your 1 min 00 s limit ends it first.');
    assert.equal(estimateText(events, { seconds: 60 }), 'One simulation takes 800 ms, so about 75 simulations fit in your 1 min 00 s limit.');
    assert.equal(estimateText(events), 'One simulation takes 800 ms.');
});

test('the summary has the numbers beside the plot', () => {
    const events = run([10, 8, 9, 4, 5]);
    const summary = summarizeTuning(events, { simulations: 10 });
    assert.equal(summary.simulations, 5);
    assert.equal(summary.baselineLoss, 10);
    assert.equal(summary.bestLoss, 4);
    assert.ok(Math.abs(summary.improvement - 0.6) < 1e-12, 'Best 4 from a start of 10 is 60% lower.');
    assert.equal(summary.sinceImprovement, 1, 'Only the last simulation was no better than the best.');
    assert.equal(summary.progress, 0.5);
    assert.ok(summary.remainingSeconds > 0);
    assert.equal(summarizeTuning([]), null);
    assert.equal(summarizeTuning(events).progress, null, 'With no limit there is no progress to show.');
    assert.equal(summarizeTuning(events).remainingSeconds, null);
});

test('an improvement of nothing but rounding is not progress', () => {
    const losses = [10, 5, ...Array.from({ length: 60 }, (_, index) => 5 - index * 1e-14)];
    const summary = summarizeTuning(run(losses));
    assert.ok(summary.sinceImprovement >= noImprovementWindow);
    assert.match(tuningWarnings(summary)[0], /No improvement in the last \d+ simulations/);
});

test('warnings appear only when there is something to say', () => {
    assert.deepEqual(tuningWarnings(summarizeTuning(run([10, 8, 6]))), []);
    assert.deepEqual(tuningWarnings(null), []);
    const failing = tuningWarnings(summarizeTuning(run([10, null, 6, null])));
    assert.equal(failing.length, 1);
    assert.match(failing[0], /^2 simulations failed/);
    assert.match(tuningWarnings(summarizeTuning(run([10, null, 6])))[0], /^1 simulation failed/);
});

test('the plot leaves out failed simulations, whose loss is a stand-in, and draws the best so far for all', () => {
    const traces = convergenceTraces(run([10, null, 6, 7]));
    assert.deepEqual(traces.attempts, { x: [1, 3, 4], y: [10, 6, 7] });
    assert.deepEqual(traces.best, { x: [1, 2, 3, 4], y: [10, 10, 6, 6] });
});

test('no improvement against a start of zero is not a division by zero', () => {
    assert.equal(summarizeTuning(run([0, 0])).improvement, null);
});

test('maximising counts a rise as progress and says so in the numbers', () => {
    const events = [1, 2, 3, 4].map((iteration) => ({ iteration, loss: 10 + iteration, bestLoss: 10 + iteration, failed: false, failedTrials: 0, elapsedSeconds: iteration, parameterValues: [1], bestParameterValues: [1], baseline: iteration === 1 }));
    const maximising = summarizeTuning(events, { simulations: 10, maximize: true });
    assert.equal(maximising.sinceImprovement, 0);
    assert.ok(Math.abs(maximising.improvement - 3 / 11) < 1e-12, 'a rise from 11 to 14 is 27% better');
    const minimising = summarizeTuning(events, { simulations: 10 });
    assert.ok(minimising.improvement < 0 && minimising.sinceImprovement === 3, 'the same values read as worse when minimising');
});
