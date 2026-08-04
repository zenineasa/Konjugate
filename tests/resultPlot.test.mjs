/* Copyright © 2026 Zenin Easa Panthakkalakath */

import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestSampleIndex, nodeResultSeries, paddedRange, ResultPlot } from '../src/renderer/resultPlot.mjs';

test('nodeResultSeries produces plot-independent state histories for one node', () => {
    const node = {
        id: 1,
        states: [
            { id: 2, label: 'Temperature', symbol: 'T', unit: 'K' },
            { id: 3, label: 'Pressure', symbol: 'p', unit: 'Pa' }
        ]
    };
    const result = { samples: [
        { time: 0, states: [{ stateId: 2, value: 300 }, { stateId: 4, value: 4 }, { stateId: 3, value: 100 }] },
        { time: 1, states: [{ stateId: 2, value: 310 }, { stateId: 3, value: 120 }] }
    ] };

    assert.deepEqual(nodeResultSeries(result, node), [
        { nodeId: 1, stateId: 2, name: 'Temperature', symbol: 'T', unit: 'K', samples: [{ time: 0, value: 300 }, { time: 1, value: 310 }] },
        { nodeId: 1, stateId: 3, name: 'Pressure', symbol: 'p', unit: 'Pa', samples: [{ time: 0, value: 100 }, { time: 1, value: 120 }] }
    ]);
});

test('nearestSampleIndex selects the closest result sample', () => {
    const samples = [{ time: 0 }, { time: 0.5 }, { time: 1.5 }];
    assert.equal(nearestSampleIndex(samples, 0.31), 1);
    assert.equal(nearestSampleIndex(samples, 1.4), 2);
    assert.equal(nearestSampleIndex(samples, -1), 0);
    assert.equal(nearestSampleIndex([], 1), -1);
});

test('paddedRange keeps data away from plot boundaries', () => {
    assert.deepEqual(paddedRange([0, 10], 0.1), [-1, 11]);
    assert.deepEqual(paddedRange([5, 5], 0.1), [4, 6]);
    assert.equal(paddedRange([]), undefined);
});

test('result plots expose click-to-toggle legends even for one series', async () => {
    const previousPlotly = globalThis.Plotly;
    let renderedLayout;
    globalThis.Plotly = {
        react: async (element, traces, layout) => { renderedLayout = layout; }
    };
    try {
        await new ResultPlot({}).render([{
            name: 'Temperature', symbol: 'T', unit: 'K', samples: [{ time: 0, value: 300 }]
        }]);
    } finally {
        globalThis.Plotly = previousPlotly;
    }
    assert.equal(renderedLayout.showlegend, true);
    assert.equal(renderedLayout.legend.itemclick, 'toggle');
    assert.equal(renderedLayout.legend.itemdoubleclick, 'toggleothers');
});
