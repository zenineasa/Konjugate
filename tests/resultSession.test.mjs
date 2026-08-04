/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { downsampleSamples, nearestResultSample, rendererResultProjection, resultSignalSeries, suggestedPlaybackRate } from '../src/resultSession.mjs';

function samples(count) {
    return Array.from({ length: count }, (_value, index) => ({
        time: index * 0.25,
        states: [{ stateId: 2, value: index }, { stateId: 3, value: index * 2 }]
    }));
}

test('bounds renderer playback samples while retaining both time boundaries', () => {
    const source = samples(10001);
    const selected = downsampleSamples(source, 4000);
    assert.equal(selected.length, 4000);
    assert.equal(selected[0], source[0]);
    assert.equal(selected.at(-1), source.at(-1));

    const projection = rendererResultProjection({ samples: source, checkpoints: [{ time: 0 }, { time: 2500 }] });
    assert.equal(projection.sampleCount, source.length);
    assert.equal(projection.samples.length, 4000);
    assert.deepEqual(projection.checkpoints, [{ time: 2500 }]);

    const wideProjection = rendererResultProjection({
        samples: Array.from({ length: 100 }, (_value, index) => ({
            time: index,
            states: Array.from({ length: 10000 }, (_state, stateIndex) => ({ stateId: stateIndex + 1, value: index }))
        })),
        checkpoints: []
    });
    assert.equal(wideProjection.samples.length, 25);
});

test('reads bounded state series from the retained full result', () => {
    const [series] = resultSignalSeries({ samples: samples(10001) }, [3], {
        startTime: 500,
        endTime: 1500,
        maxPoints: 100
    });
    assert.equal(series.signalId, 3);
    assert.equal(series.samples.length, 100);
    assert.deepEqual(series.samples[0], { time: 500, value: 4000 });
    assert.deepEqual(series.samples.at(-1), { time: 1500, value: 12000 });
});

test('suggests bounded playback rates from explicit duration bands', () => {
    assert.equal(suggestedPlaybackRate(1.5), 1);
    assert.equal(suggestedPlaybackRate(300), 1);
    assert.equal(suggestedPlaybackRate(301), 2);
    assert.equal(suggestedPlaybackRate(600), 2);
    assert.equal(suggestedPlaybackRate(601), 5);
    assert.equal(suggestedPlaybackRate(1800), 5);
    assert.equal(suggestedPlaybackRate(1801), 10);
    assert.equal(suggestedPlaybackRate(10000), 10);
});

test('selects exact retained samples around a playback time', () => {
    const result = { samples: samples(5) };
    assert.equal(nearestResultSample(result, 0.24).time, 0.25);
    assert.equal(nearestResultSample(result, 0.6).time, 0.5);
    assert.equal(nearestResultSample(result, -1).time, 0);
    assert.equal(nearestResultSample(result, 10).time, 1);
});
