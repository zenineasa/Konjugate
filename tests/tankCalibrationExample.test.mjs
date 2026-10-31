/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { decodeProjectFile } from '../src/projectFile.mjs';
import { exampleDescription } from '../src/exampleCatalog.mjs';
import { tankCalibration, tankProject } from '../scripts/generateTankCalibrationExample.mjs';

const examples = join(import.meta.dirname, '..', 'examples');

test('the guide shows exactly the measurements the file holds, since nothing else gets them to the person', async () => {
    const file = (await readFile(join(examples, 'tankCalibrationMeasured.csv'), 'utf8')).trim();
    const guide = await readFile(join(examples, 'tankCalibration.md'), 'utf8');
    const shown = guide.match(/```csv\n([\s\S]+?)\n```/)?.[1];
    assert.equal(shown, file);
    const rows = file.split('\n');
    assert.equal(rows[0], 'time,tankTemperature');
    assert.equal(rows.length, 1 + tankCalibration.targetTime / tankCalibration.timeStep + 1);
    const times = rows.slice(1).map((row) => Number(row.split(',')[0]));
    assert.ok(times.every((time, index) => time === index * tankCalibration.timeStep), 'The readings must be on an even grid, which tuning pairs row by row.');
});

test('the saved model is the generator\'s: wrong starting guesses, both unknowns tunable, one shared parameter', async () => {
    const saved = JSON.parse(await decodeProjectFile(await readFile(join(examples, 'tankCalibration.kjt'))));
    assert.deepEqual(saved, JSON.parse(JSON.stringify(tankProject({ ...tankCalibration.start, tuned: true }))));
    assert.deepEqual(saved.sharedParameters[0].tuning, tankCalibration.capacitanceBounds);
    const loss = saved.edges.flatMap((edge) => edge.parameters).find((parameter) => parameter.symbol === 'heatLossCoefficient');
    assert.deepEqual(loss.tuning, tankCalibration.heatLossBounds);
    assert.ok(tankCalibration.start.capacitance !== tankCalibration.truth.capacitance && tankCalibration.start.heatLoss !== tankCalibration.truth.heatLoss);
    for (const [name, value] of [['capacitance', tankCalibration.truth.capacitance], ['heat loss', tankCalibration.truth.heatLoss]]) {
        const bounds = name === 'capacitance' ? tankCalibration.capacitanceBounds : tankCalibration.heatLossBounds;
        assert.ok(value > bounds.minimum && value < bounds.maximum, `The true ${name} must lie inside its tuning range.`);
    }
    // Both edges that use the capacitance are linked to the one shared parameter, so tuning it moves both.
    const linked = saved.edges.flatMap((edge) => edge.parameters).filter((parameter) => parameter.symbol === 'waterThermalCapacitance');
    assert.equal(linked.length, 2);
    assert.ok(linked.every((parameter) => parameter.sharedParameterId === saved.sharedParameters[0].id));
});

test('the explorer card describes it from the guide\'s overview', async () => {
    const description = await exampleDescription(examples, 'tankCalibration');
    assert.match(description, /Parameter tuning/);
    const manifest = JSON.parse(await readFile(join(examples, 'manifest.json'), 'utf8'));
    assert.ok(manifest.examples.some((entry) => entry.id === 'tankCalibration'));
});
