/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading an MQTT payload as a reading (src/mqttSource.mjs), and writing what a source sent as a data log that reads back
// (src/dataLogWriter.mjs).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readDataLog } from '../src/dataLog.mjs';
import { DataLogWriter } from '../src/dataLogWriter.mjs';
import { parseMqttPayload } from '../src/mqttSource.mjs';

const arrived = 1793955600; // 2026-11-06T09:00:00Z

test('a payload is a number, or JSON with a value and perhaps its own time and quality', () => {
    assert.deepEqual(parseMqttPayload('301.25', arrived), { value: 301.25, time: arrived, quality: 'good' });
    assert.deepEqual(parseMqttPayload(Buffer.from(' 7 '), arrived), { value: 7, time: arrived, quality: 'good' });
    assert.deepEqual(parseMqttPayload('{"value": 3, "time": 1793955660, "quality": "uncertain"}', arrived), { value: 3, time: 1793955660, quality: 'uncertain' });
    assert.deepEqual(parseMqttPayload('{"v": 3, "t": 1793955660500}', arrived), { value: 3, time: 1793955660.5, quality: 'good' }, 'Milliseconds are told from seconds by their size.');
    assert.deepEqual(parseMqttPayload('{"value": 3, "timestamp": "2026-11-06T09:01:00Z"}', arrived), { value: 3, time: 1793955660, quality: 'good' });
    assert.equal(parseMqttPayload('{"value": 3, "quality": "shaky"}', arrived).quality, 'good', 'An unknown quality is not trusted to mean anything.');
    for (const unusable of ['', 'on', '{"state": 1}', '[1, 2]', 'null', '{"value": "high"}']) assert.equal(parseMqttPayload(unusable, arrived), null, unusable);
});

test('what a source sent is written as a data log that reads back as it was sent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateWriter-'));
    try {
        const path = join(directory, 'broker.csv');
        const writer = await DataLogWriter.create(path, {
            source: 'MQTT mqtt://lab', epoch: Date.parse('2026-11-06T09:00:00Z'),
            signals: [{ name: 'heaterPower', unit: 'W', role: 'input' }, { name: 'tankTemperature', unit: 'K', role: 'output' }]
        });
        writer.append([{ time: 0, signal: 'heaterPower', value: 1000, quality: 'good' }, { time: 0, signal: 'tankTemperature', value: 293.15, quality: 'good' }]);
        writer.append([{ time: 60.5, signal: 'tankTemperature', value: 293.4, quality: 'bad' }]);
        await writer.close();
        const { header, observations } = readDataLog(await readFile(path, 'utf8'));
        assert.equal(header.epoch, Date.parse('2026-11-06T09:00:00Z'));
        assert.equal(header.source, 'MQTT mqtt://lab');
        assert.deepEqual(header.signals, [{ name: 'heaterPower', unit: 'W', role: 'input' }, { name: 'tankTemperature', unit: 'K', role: 'output' }]);
        assert.deepEqual(observations.map(({ time, signal, value, quality }) => [time, signal, value, quality]), [
            [0, 'heaterPower', 1000, 'good'], [0, 'tankTemperature', 293.15, 'good'], [60.5, 'tankTemperature', 293.4, 'bad']
        ]);
        // A recording is never written over.
        await assert.rejects(DataLogWriter.create(path, { epoch: 0, signals: [{ name: 'x', unit: '', role: 'output' }] }), /EEXIST/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
