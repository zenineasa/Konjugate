/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Playing a finished data log back as if it were arriving (src/liveTwinHost.mjs), with a clock the test moves.

import assert from 'node:assert/strict';
import test from 'node:test';
import { playRecording } from '../src/liveTwinHost.mjs';

const log = [
    '# konjugate data log: 1', '# time: seconds since start', '# inputs: u', '# outputs: y', 'time,u [-],y [-]',
    '0,1,10', '60,,11', '120,0,12', '180,,13'
].join('\n') + '\n';

test('a recording arrives at the speed asked for, in time order, and says when it is through', async () => {
    let clock = 0;
    const arrived = [];
    let header = null;
    let ended = false;
    const player = playRecording(log, 60, {
        onHeader: (value) => { header = value; },
        onObservations: (observations) => arrived.push(observations.map((observation) => `${observation.time} ${observation.signal}`)),
        onEnd: () => { ended = true; },
        tickMilliseconds: 1,
        now: () => clock
    });
    assert.deepEqual(header.signals.map((signal) => signal.name), ['u', 'y']);
    assert.deepEqual(arrived, [['0 u', '0 y']], 'At the start only the first row has arrived.');
    clock = 1000; // one wall second is a minute of the log
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(arrived.flat(), ['0 u', '0 y', '60 y']);
    clock = 3000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ended, true);
    assert.deepEqual(arrived.flat(), ['0 u', '0 y', '60 y', '120 u', '120 y', '180 y']);
    player.stop();
});

test('as fast as it can go, the whole recording arrives at once', () => {
    const arrived = [];
    let ended = false;
    playRecording(log, Infinity, { onHeader: () => {}, onObservations: (observations) => arrived.push(observations.length), onEnd: () => { ended = true; } });
    assert.deepEqual(arrived, [6]);
    assert.equal(ended, true);
});
