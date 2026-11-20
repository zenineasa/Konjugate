/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The web edition's runs, as far as they are JavaScript (docs/proposals/webEdition.md, phases 3 and 6): the control buffer a live
// run's commands go through (src/webEngineStdinBuffer.mjs); the shim that gives the canvas a live run on a cross-origin-isolated page
// and a batch run elsewhere (src/webEngineLiveShim.mjs), with its Workers faked; and the two Workers themselves
// (src/webEngineLiveRunWorker.mjs, src/webEngineWorker.mjs), driven through their onmessage against a stand-in for the WebAssembly
// engine (tests/fixtures/fakeWebEngine.mjs). The real engine behind them is exercised in a real browser by the web interaction suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeProjectContent } from '../src/browserProjectCodec.mjs';
import { decodeResultFile, encodeEngineCommand } from '../src/engineProtocol.mjs';
import { parameterScheduleCommand } from '../src/parameterSchedule.mjs';
import { rendererResultProjection } from '../src/resultSession.mjs';
import { createStdinRingBuffer, drainStdinBytes, pushStdinBytes } from '../src/webEngineStdinBuffer.mjs';
import { concat, framedEvent, resultFile } from './fixtures/engineMessages.mjs';

const engineModuleUrl = pathToFileURL(join(import.meta.dirname, 'fixtures', 'fakeWebEngine.mjs')).href;
const content = JSON.stringify({
    format: 'konjugate', version: 1,
    sharedParameters: [{ id: 20, name: 'Heater', symbol: 'heater', value: 0, mode: 'live' }, { id: 21, name: 'Mass', symbol: 'm', value: 1 }],
    nodes: [{ id: 1, name: 'Tank', states: [{ id: 2, name: 'T', symbol: 'T', initialValue: 20 }] }], edges: []
});
const result = decodeResultFile(resultFile({ stateIds: [2], batches: [[0, 1, 2, 3]], values: (time) => [20 + time] }));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ---- the control buffer ---------------------------------------------------------------------------------------------------

test('the control buffer hands over what was pushed, in order, once', () => {
    const ring = createStdinRingBuffer(16);
    assert.deepEqual(drainStdinBytes(ring), new Uint8Array(0));
    pushStdinBytes(ring, [1, 2, 3]);
    pushStdinBytes(ring, new Uint8Array([4]));
    assert.deepEqual(drainStdinBytes(ring), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(drainStdinBytes(ring), new Uint8Array(0), 'Drained, it is empty.');
});

test('the control buffer wraps around its end, and refuses more than it can hold rather than overwrite', () => {
    const ring = createStdinRingBuffer(8);
    pushStdinBytes(ring, [1, 2, 3, 4, 5, 6]);
    drainStdinBytes(ring);
    pushStdinBytes(ring, [7, 8, 9, 10, 11]);
    assert.deepEqual(drainStdinBytes(ring), new Uint8Array([7, 8, 9, 10, 11]), 'Across the end of the storage.');
    pushStdinBytes(ring, [1, 2, 3, 4, 5, 6, 7]);
    assert.throws(() => pushStdinBytes(ring, [8]), /control buffer is full/, 'One slot is kept free to tell full from empty.');
    assert.deepEqual(drainStdinBytes(ring), new Uint8Array([1, 2, 3, 4, 5, 6, 7]), 'What was there is intact.');
});

// ---- the shim -------------------------------------------------------------------------------------------------------------

class FakeWorker {
    static created = [];
    constructor(url, options) {
        this.url = String(url);
        this.options = options;
        this.posted = [];
        this.listeners = [];
        this.terminated = false;
        FakeWorker.created.push(this);
    }
    addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener); }
    removeEventListener(type, listener) { this.listeners = this.listeners.filter((candidate) => candidate !== listener); }
    postMessage(data) { this.posted.push(data); }
    terminate() { this.terminated = true; }
    emit(data) { for (const listener of [...this.listeners]) listener({ data }); }
}

// A fresh copy of the shim, for a page that is cross-origin isolated (a live run) or not (a batch run): which it is, is read once,
// when the module loads.
async function loadShim(isolated) {
    globalThis.Worker = FakeWorker;
    globalThis.location = { href: 'https://example.test/app/index.html' };
    globalThis.crossOriginIsolated = isolated;
    const shim = await import(`../src/webEngineLiveShim.mjs?${isolated ? 'live' : 'batch'}`);
    const heard = { updates: [], completes: [], errors: [] };
    shim.onWebEngineUpdate((event) => heard.updates.push(event));
    shim.onWebEngineComplete((event) => heard.completes.push(event));
    shim.onWebEngineError((event) => heard.errors.push(event));
    return { shim, heard };
}
const live = await loadShim(true);
const batch = await loadShim(false);

test('on an isolated page a run is live, in a Worker of its own given the page-relative engine and a control buffer', async () => {
    const { shim } = live;
    const { available, jobId } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, { targetTime: 3 });
    assert.equal(available, true);
    const worker = FakeWorker.created.at(-1);
    assert.match(worker.url, /webEngineLiveRunWorker\.mjs$/);
    assert.deepEqual(worker.options, { type: 'module' });
    const [message] = worker.posted;
    assert.equal(message.engineModuleUrl, 'https://example.test/app/engine/konjugateEngine.js');
    assert.equal(message.content, content);
    assert.deepEqual(message.configuration, { targetTime: 3 });
    const ring = message.stdinRing;

    // Each control goes into the buffer as the engine command the desktop would send, numbered in order.
    assert.deepEqual(await shim.setWebEngineLivePacing(jobId, { mode: 'limitedRatio', simulationSecondsPerWallSecond: 4 }), { mode: 'limitedRatio', simulationSecondsPerWallSecond: 4 });
    await shim.setWebEngineLiveExecutionState(jobId, 'paused', { applyAt: 2 });
    assert.deepEqual(await shim.setWebEngineLiveParameterValue(jobId, 20, '1.5'), { parameterId: 20, value: 1.5 });
    const ramp = { mode: 'ramp', startTime: 1, duration: 2, targetValue: 3, baseValue: 0 };
    await shim.scheduleWebEngineLiveParameterValue(jobId, 20, ramp);
    assert.deepEqual(drainStdinBytes(ring), concat(
        encodeEngineCommand(1, { type: 'setPacing', pacing: { mode: 'limitedRatio', simulationSecondsPerWallSecond: 4 } }),
        encodeEngineCommand(2, { type: 'setRunState', state: 'paused', applyAt: 2 }),
        encodeEngineCommand(3, { type: 'setParameterValue', parameterId: 20, value: 1.5 }),
        encodeEngineCommand(4, parameterScheduleCommand(20, ramp))
    ));

    await assert.rejects(shim.setWebEngineLivePacing(jobId, { mode: 'limitedRatio', simulationSecondsPerWallSecond: -1 }), /finite positive ratio/);
    await assert.rejects(shim.setWebEngineLiveExecutionState(jobId, 'sleeping'), /Unsupported execution state/);
    await assert.rejects(shim.setWebEngineLiveParameterValue(jobId, 21, 2), /not available for live control/, 'A parameter that is not live.');
    await assert.rejects(shim.setWebEngineLiveParameterValue(jobId, 20, 'warm'), /must be finite/);
    await assert.rejects(shim.scheduleWebEngineLiveParameterValue(jobId, 21, ramp), /not available for live control/);
    assert.deepEqual(drainStdinBytes(ring), new Uint8Array(0), 'Nothing refused reaches the engine.');
});

test('a live run\'s updates reach the canvas at most every 100 ms, as the latest sample only; its end is kept to read', async () => {
    const { shim, heard } = live;
    const { jobId } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, {});
    const worker = FakeWorker.created.at(-1);
    const updatesBefore = heard.updates.length;
    for (const time of [1, 2, 3]) worker.emit({ type: 'update', result: { ...result, samples: result.samples.slice(0, time + 1), checkpoints: [{ time }] } });
    assert.equal(heard.updates.length, updatesBefore, 'Not at once.');
    await sleep(150);
    assert.equal(heard.updates.length, updatesBefore + 1, 'Three updates, one nudge.');
    const { result: update } = heard.updates.at(-1);
    assert.deepEqual(update.samples, [result.samples[3]]);
    assert.deepEqual(update.checkpoints, []);

    worker.emit({ type: 'complete', result });
    assert.ok(worker.terminated);
    assert.deepEqual(heard.completes.at(-1), { jobId, result: rendererResultProjection(result) });
    assert.deepEqual(await shim.readWebEngineResultSeries(jobId, [2], { startTime: 1, endTime: 2 }), [{ signalId: 2, samples: [{ time: 1, value: 21 }, { time: 2, value: 22 }] }]);
    assert.equal((await shim.readWebEngineResultSample(jobId, 2.4)).time, 2);
    await assert.rejects(shim.setWebEngineLivePacing(jobId, { mode: 'fastest' }), /batch-run mode/, 'A finished run takes no more controls.');
    assert.equal(await shim.releaseWebEngineResult(jobId), true);
    assert.deepEqual(await shim.readWebEngineResultSeries(jobId, [2]), []);
    assert.equal(await shim.readWebEngineResultSample(jobId, 1), null);
});

test('a live run that fails says so, and one cancelled is asked to stop, then torn down if it does not', async (t) => {
    const { shim, heard } = live;
    const { jobId: failing } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, {});
    const failingWorker = FakeWorker.created.at(-1);
    failingWorker.emit({ type: 'error', message: 'The model has no states.' });
    assert.ok(failingWorker.terminated);
    assert.deepEqual(heard.errors.at(-1), { jobId: failing, message: 'The model has no states.' });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { jobId } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, {});
    const worker = FakeWorker.created.at(-1);
    assert.equal(await shim.cancelWebEngineRun(jobId), true);
    assert.deepEqual(drainStdinBytes(worker.posted[0].stdinRing), encodeEngineCommand(1, { type: 'setRunState', state: 'stopped' }));
    assert.equal(worker.terminated, false, 'Given a moment to stop on its own.');
    t.mock.timers.tick(1000);
    assert.equal(worker.terminated, true);
    await assert.rejects(shim.setWebEngineLivePacing(jobId, { mode: 'fastest' }), /batch-run mode/);
});

test('without isolation a run is played back whole from one shared Worker, and live controls are refused with the reason', async () => {
    const { shim, heard } = batch;
    const created = FakeWorker.created.length;
    const { available, jobId } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, { targetTime: 3 });
    assert.equal(available, true);
    const worker = FakeWorker.created.at(-1);
    assert.equal(FakeWorker.created.length, created + 1);
    assert.match(worker.url, /webEngineWorker\.mjs$/);
    const [request] = worker.posted;
    assert.equal(request.engineModuleUrl, 'https://example.test/app/engine/konjugateEngine.js');
    worker.emit({ requestId: request.requestId + 99, ok: true, outcome: { available: true, result } });
    assert.equal(heard.completes.length, 0, 'An answer to another request is not this run\'s.');
    worker.emit({ requestId: request.requestId, ok: true, outcome: { available: true, result } });
    await sleep(0);
    assert.deepEqual(heard.completes, [{ jobId, result: rendererResultProjection(result) }]);
    assert.equal(heard.updates.length, 0, 'A batch run sends no updates.');
    assert.equal((await shim.readWebEngineResultSample(jobId, 0.9)).time, 1);

    await assert.rejects(shim.setWebEngineLivePacing(jobId, { mode: 'realTime' }), /Live pacing isn't available in the web edition's batch-run mode/);
    await assert.rejects(shim.setWebEngineLiveExecutionState(jobId, 'paused'), /Pausing or stopping a run isn't available/);
    await assert.rejects(shim.setWebEngineLiveParameterValue(jobId, 20, 1), /Live parameter control isn't available/);
    await assert.rejects(shim.scheduleWebEngineLiveParameterValue(jobId, 20, { mode: 'step' }), /Live parameter control isn't available/);
    assert.equal(await shim.cancelWebEngineRun(jobId), true, 'Cancelling a finished batch run releases its result.');
    assert.equal(await shim.cancelWebEngineRun(jobId), false);

    const { jobId: second } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, {});
    assert.equal(FakeWorker.created.length, created + 1, 'The same Worker runs the next.');
    worker.emit({ requestId: worker.posted[1].requestId, ok: true, outcome: { available: false } });
    const { jobId: third } = await shim.startWebEngineLiveRun('./engine/konjugateEngine.js', content, {});
    worker.emit({ requestId: worker.posted[2].requestId, ok: false, message: 'Out of memory.' });
    await sleep(0);
    assert.deepEqual(heard.errors, [{ jobId: second, message: 'The C++ simulation engine is unavailable.' }, { jobId: third, message: 'Out of memory.' }]);
});

test('a result embedded in a loaded project is read like one that was run', async () => {
    const { shim } = batch;
    shim.registerCompletedResult('embedded', result);
    assert.deepEqual((await shim.readWebEngineResultSeries('embedded', [2], { maxPoints: 2 }))[0].samples.map((sample) => sample.time), [0, 3]);
});

// ---- the Workers ----------------------------------------------------------------------------------------------------------

const posted = [];
globalThis.self = { postMessage: (message) => posted.push(message) };
await import('../src/webEngineLiveRunWorker.mjs');
const liveRunWorker = globalThis.self.onmessage;
await import('../src/webEngineWorker.mjs');
const batchWorker = globalThis.self.onmessage;
const engine = globalThis.fakeWebEngine = { callMain: () => 0 };
const liveSnapshot = (lastTime) => resultFile({ stateIds: [2], batches: [[0]], values: () => [20], metadata: { snapshotMode: 'live', lifecycle: 'running', availableResultTime: lastTime } });

test('the live-run Worker posts each new state of the run as it goes, from the events and the file the engine keeps writing', async () => {
    posted.length = 0;
    const ring = createStdinRingBuffer();
    pushStdinBytes(ring, encodeEngineCommand(1, { type: 'setRunState', state: 'paused' }));
    const drained = [];
    let inputs = null;
    engine.callMain = (Module, argv) => {
        inputs = { argv, input: Module.FS.readFile('/live/input.kjt'), configuration: Module.FS.readFile('/live/runConfiguration.json', { encoding: 'utf8' }) };
        Module.emitEngineEvent(framedEvent({ stateTable: { states: [{ stateId: 2 }] } }));
        assert.equal(posted.length, 0, 'Nothing to post before the engine has written its file.');
        Module.FS.writeFile('/live/result.bin', new Uint8Array([1, 2, 3]));
        Module.emitEngineEvent(framedEvent({ sampleBatch: { times: [0.5], stateCount: 1, values: [20.5] } }));
        assert.equal(posted.length, 0, 'A file caught mid-write is passed over.');
        Module.FS.writeFile('/live/result.bin', liveSnapshot(1));
        const event = framedEvent({ sampleBatch: { times: [1], stateCount: 1, values: [21] } });
        Module.emitEngineEvent(event.subarray(0, 5));
        Module.emitEngineEvent(event.subarray(5));
        Module.emitEngineEvent(new Uint8Array(0));
        drained.push(Module.drainControlStreamBytes());
        Module.FS.writeFile('/live/result.bin', resultFile({ stateIds: [2], batches: [[0, 1, 2]], values: (time) => [20 + time], metadata: { lifecycle: 'completed' } }));
        return 0;
    };
    await liveRunWorker({ data: { engineModuleUrl, content, configuration: { targetTime: 2 }, stdinRing: ring } });
    assert.deepEqual(inputs.argv, ['run', '/live/input.kjt', '--configuration', '/live/runConfiguration.json', '--output', '/live/result.bin', '--control-stream', 'protobuf', '--event-stream', 'protobuf']);
    assert.equal((await decodeProjectContent(inputs.input)).content, content);
    assert.deepEqual(JSON.parse(inputs.configuration), { targetTime: 2 });
    assert.deepEqual(drained, [encodeEngineCommand(1, { type: 'setRunState', state: 'paused' })], 'The control the page pushed reaches the engine.');
    // The first half of a frame brings no event, but the file is now readable: the sample already known (0.5 s) is posted; the second
    // half brings 1 s. The empty event and the control poll after it change nothing, so post nothing.
    assert.deepEqual(posted.map((message) => message.type), ['update', 'update', 'complete'], 'Unchanged states are not posted again.');
    assert.deepEqual(posted.slice(0, 2).map((message) => message.result.samples), [[{ time: 0.5, states: [{ stateId: 2, value: 20.5 }] }], [{ time: 1, states: [{ stateId: 2, value: 21 }] }]],
        'A live snapshot carries the latest samples from the event stream, not the file\'s.');
    assert.deepEqual(posted[2].result.samples.map((sample) => sample.time), [0, 1, 2], 'The end is the whole result, from the file.');
});

test('the live-run Worker reports an engine that fails, in its own words where it has some', async () => {
    posted.length = 0;
    engine.callMain = (Module) => { Module.options.print('The model has no states.'); return 1; };
    await liveRunWorker({ data: { engineModuleUrl, content, configuration: {}, stdinRing: createStdinRingBuffer() } });
    assert.deepEqual(posted, [{ type: 'error', message: 'The model has no states.' }]);
});

test('the batch Worker answers each run by its request id, whether it finished or failed', async () => {
    posted.length = 0;
    engine.callMain = (Module, argv) => { Module.FS.writeFile(argv[5], resultFile({ stateIds: [2], batches: [[0, 1]], values: (time) => [20 + time] })); return 0; };
    await batchWorker({ data: { requestId: 7, engineModuleUrl, content, configuration: {} } });
    assert.equal(posted[0].requestId, 7);
    assert.equal(posted[0].ok, true);
    assert.deepEqual(posted[0].outcome.result.samples.map((sample) => sample.states[0].value), [20, 21]);
    engine.callMain = () => 4;
    await batchWorker({ data: { requestId: 8, engineModuleUrl, content, configuration: {} } });
    assert.deepEqual(posted[1], { requestId: 8, ok: false, message: 'The engine exited with code 4.' });
});
