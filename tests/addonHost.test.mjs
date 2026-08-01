/* Copyright © 2026 Zenin Easa Panthakkalakath */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createVisualizerSession,
    publicToolstripContributions,
    publicVisualizerContext,
    readSignalSeries,
    validateVisualizerManifest
} from '../src/addonHost.mjs';

const manifest = {
    addonId: 'konjugate.testViewer', name: 'Test viewer', version: '0.1.0',
    apiVersion: 1, kind: 'resultVisualizer', entry: 'index.html',
    permissions: ['results.read', 'timeline.seek'],
    contributes: { toolstrip: [{
        commandId: 'openViewer', label: 'Viewer', tooltip: 'Open viewer', symbol: 'V',
        when: 'resultsActive', contexts: ['resultSession']
    }] }
};

test('validates the versioned visualizer manifest and permissions', () => {
    assert.deepEqual(validateVisualizerManifest(manifest), manifest);
    assert.throws(() => validateVisualizerManifest({ ...manifest, apiVersion: 2 }), /Unsupported visualizer API/);
    assert.throws(() => validateVisualizerManifest({ ...manifest, permissions: ['model.write'] }), /unsupported permission/);
    assert.throws(() => validateVisualizerManifest({ ...manifest, entry: '../renderer/index.html' }), /inside its add-on directory/);
    assert.doesNotThrow(() => validateVisualizerManifest({
        ...manifest,
        permissions: ['results.read', 'results.live.read', 'simulation.status.read', 'simulation.pacing.read', 'simulation.pacing.control']
    }));
});

test('publishes manifest-declared toolstrip commands without add-on-specific host code', () => {
    const contributedManifest = validateVisualizerManifest(manifest);
    assert.deepEqual(publicToolstripContributions(contributedManifest), [{
        addonId: manifest.addonId, addonName: manifest.name, commandId: 'openViewer',
        label: 'Viewer', tooltip: 'Open viewer', symbol: 'V', when: 'resultsActive', contexts: ['resultSession']
    }]);
    assert.throws(() => validateVisualizerManifest({
        ...manifest,
        contributes: { toolstrip: [{ commandId: '../bad', label: 'Bad', tooltip: 'Bad', contexts: [] }] }
    }), /invalid toolstrip contribution/);
});

test('creates a public visualizer context without exposing result storage', () => {
    const session = createVisualizerSession({
        sessionId: 'session', projectName: 'vehicleStudy', selectedNodeId: 'vehicle', time: 0.5,
        nodes: [{ id: 'vehicle', title: 'Vehicle', states: [{ id: 'x', label: 'X position', symbol: 'x', unit: 'm' }] }],
        result: { configurationName: 'Default', targetTime: 1, outputInterval: 0.5, samples: [{ time: 0, states: [{ stateId: 'x', value: 2 }] }] }
    });
    const context = publicVisualizerContext(session);
    assert.equal(context.apiVersion, 1);
    assert.equal(context.projectName, 'vehicleStudy');
    assert.equal('samples' in context, false);
    assert.deepEqual(session.signals[0], {
        signalUuid: 'x', entityUuid: 'vehicle', entityName: 'Vehicle', name: 'X position', symbol: 'x', unit: 'm'
    });
});

test('publishes live run metadata without exposing the private engine job identity', () => {
    const session = createVisualizerSession({
        sessionId: 'session', engineJobId: 'private-job', projectName: 'liveStudy', selectedNodeId: null,
        nodes: [], result: {
            configurationName: 'Live', targetTime: 5, outputInterval: 0.1, lifecycle: 'running', simulationTime: 0.4,
            availableResultTime: 0.4, pacing: { mode: 'limitedRatio', simulationSecondsPerWallSecond: 2 }, samples: []
        }
    });
    const context = publicVisualizerContext(session);
    assert.equal(context.run.lifecycle, 'running');
    assert.equal(context.run.availableResultTime, 0.4);
    assert.deepEqual(context.run.pacing, { mode: 'limitedRatio', simulationSecondsPerWallSecond: 2 });
    assert.equal('engineJobId' in context, false);
    assert.equal(session.engineJobId, 'private-job');
});

test('reads only requested signal ranges and downsamples host-side', () => {
    const samples = Array.from({ length: 11 }, (_value, time) => ({
        time,
        states: [{ stateId: 'x', value: time * 2 }, { stateId: 'y', value: -time }]
    }));
    const session = createVisualizerSession({
        sessionId: 'session', projectName: 'study', selectedNodeId: 'vehicle',
        nodes: [{ id: 'vehicle', title: 'Vehicle', states: [
            { id: 'x', label: 'X', symbol: 'x', unit: 'm' },
            { id: 'y', label: 'Y', symbol: 'y', unit: 'm' }
        ] }],
        result: { configurationName: 'Default', targetTime: 10, outputInterval: 1, samples }
    });
    const [series] = readSignalSeries(session, ['x'], { startTime: 2, endTime: 8, maxPoints: 3 });
    assert.equal(series.signalUuid, 'x');
    assert.ok(series.samples.length <= 4);
    assert.equal(series.samples[0].time, 2);
    assert.equal(series.samples.at(-1).time, 8);
    assert.ok(series.samples.every((sample) => sample.value === sample.time * 2));
});
