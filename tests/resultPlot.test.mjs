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

test('nodeResultSeries only attaches branchLabel when the caller actually passes one', () => {
    const node = { id: 1, states: [{ id: 2, label: 'Temperature', symbol: 'T', unit: 'K' }] };
    const result = { samples: [{ time: 0, states: [{ stateId: 2, value: 300 }] }] };
    assert.equal('branchLabel' in nodeResultSeries(result, node)[0], false);
    assert.equal(nodeResultSeries(result, node, 'Baseline')[0].branchLabel, 'Baseline');
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

test('a single-branch render leaves trace naming and coloring exactly as before branches existed', async () => {
    const previousPlotly = globalThis.Plotly;
    let renderedTraces;
    globalThis.Plotly = { react: async (element, traces) => { renderedTraces = traces; } };
    try {
        await new ResultPlot({}).render([
            { name: 'Temperature', symbol: 'T', unit: 'K', samples: [{ time: 0, value: 300 }] }
        ]);
    } finally {
        globalThis.Plotly = previousPlotly;
    }
    assert.equal(renderedTraces[0].name, 'T');
    assert.equal(renderedTraces[0].line.color, undefined);
});

test('a multi-branch render colors and labels traces by branch, from the supplied branchColors map', async () => {
    const previousPlotly = globalThis.Plotly;
    let renderedTraces;
    globalThis.Plotly = { react: async (element, traces) => { renderedTraces = traces; } };
    const branchColors = new Map([['Baseline', '#3987e5'], ['Fork at 2 s', '#d95926']]);
    try {
        await new ResultPlot({}).render([
            { name: 'Angle', symbol: 'θ', unit: 'rad', samples: [{ time: 0, value: 1 }], branchLabel: 'Baseline' },
            { name: 'Angle', symbol: 'θ', unit: 'rad', samples: [{ time: 0, value: 1.5 }], branchLabel: 'Fork at 2 s' }
        ], 0, { branchColors });
    } finally {
        globalThis.Plotly = previousPlotly;
    }
    assert.deepEqual(renderedTraces.map((trace) => trace.name), ['θ (Baseline)', 'θ (Fork at 2 s)']);
    assert.deepEqual(renderedTraces.map((trace) => trace.line.color), ['#3987e5', '#d95926']);
});
