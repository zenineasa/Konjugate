/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The house demonstration (scripts/generateHouseTwin.mjs): a twin with three rooms' thermometers, their three heaters, the weather and
// the sun, run on a day of the house's recording as the twin's window runs it. Every signal is matched to the model by the suggestions,
// the °C readings converted; each room's drift is judged on its own (src/windowSession.mjs, cycle.trends), so the bedroom, whose window
// is left open from 14:00 to 18:00, drifts past the warning while the living room and the kitchen stay in step, and comes back once it
// is shut; and the floor slab no sensor measures is followed among what the twin infers.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/houseTwin.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { defaultTolerance } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { suggestMapping } from '../../src/signalMatching.mjs';
import { readingNoise } from '../../src/stateEstimator.mjs';
import { house, houseDay, houseProject } from '../../scripts/generateHouseTwin.mjs';
import { formatDataLog } from '../../src/dataLogFormat.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

// The example shipped is the one the generator writes.
const content = await readFile(join(root, 'examples', 'dataSources', 'smartHouse.csv'), 'utf8');
assert.equal(content, formatDataLog(houseDay()), 'examples/dataSources/smartHouse.csv is as scripts/generateHouseTwin.mjs writes it.');
const log = readDataLog(content);
const document = houseProject();

// Every signal matched, confidently, with its conversion: the twin's window fills them all in.
const firstHour = (name) => log.observations.filter((observation) => observation.signal === name).slice(0, 60).map((observation) => observation.value);
const suggestions = suggestMapping(log.header.signals.map((signal) => ({ id: signal.name, name: signal.name, unit: signal.unit, role: signal.role, values: firstHour(signal.name) })), document);
const expected = {
    outdoorTemperature: 'Shared · Outdoor temperature', solarGain: 'Shared · Solar gain', livingRoomHeater: 'Shared · Living room heater', bedroomHeater: 'Shared · Bedroom heater',
    kitchenHeater: 'Shared · Kitchen heater', livingRoomTemperature: 'Living room · Air temperature', bedroomTemperature: 'Bedroom · Air temperature', kitchenTemperature: 'Kitchen · Air temperature'
};
for (const suggestion of suggestions) {
    assert.equal(suggestion.target?.label, expected[suggestion.name], `${suggestion.name} is matched to ${expected[suggestion.name]}.`);
    assert.ok(suggestion.confidence >= 0.75, `${suggestion.name} is filled in by itself: ${suggestion.confidence}.`);
}
assert.deepEqual([suggestions.find((entry) => entry.name === 'livingRoomTemperature').conversion.offset, suggestions.find((entry) => entry.name === 'outdoorTemperature').conversion.offset], [273.15, 273.15]);

// The twin, as the window sets it up: the conversions, a tolerance above each thermometer's noise, the warning at a quarter of it.
const mapping = suggestions.map((suggestion) => (suggestion.role === 'input'
    ? { signal: suggestion.name, role: 'input', unit: suggestion.unit, parameterId: suggestion.target.id }
    : { signal: suggestion.name, role: 'output', unit: suggestion.unit, stateId: suggestion.target.id }));
const conversions = Object.fromEntries(suggestions.filter((entry) => entry.conversion).map((entry) => [entry.name, { scale: entry.conversion.scale, offset: entry.conversion.offset, unit: entry.target.unit }]));
const tolerances = Object.fromEntries(suggestions.filter((entry) => entry.role === 'output').map((entry) => {
    const readings = firstHour(entry.name).map((value) => ({ value: value + 273.15 }));
    return [entry.name, Number(Math.max(defaultTolerance(readings), 4 * readingNoise(readings.map((reading) => reading.value))).toPrecision(2))];
}));
const events = [];
const twin = new LiveTwin({ document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances, alertAt: 0.25, conversions, keepUp: false }, { kind: 'recording', content, speed: Infinity }, engineOptions, (event) => events.push(event));
for (let waited = 0; waited < 300000 && !events.some((event) => event.type === 'ended' || event.type === 'error'); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
await twin.stop();
assert.equal(events.find((event) => event.type === 'error'), undefined);
const cycles = events.filter((event) => event.type === 'cycle').map((event) => event.cycle);
assert.equal(cycles.length, 139, 'A move every ten minutes from the end of the first hour to the end of the day.');

// Each room judged on its own: the bedroom drifts past the warning while its window is open (and for the moves whose window still
// holds those hours), the other rooms never.
const alarmed = (signal) => cycles.filter((cycle) => cycle.trends[signal].alarm).map((cycle) => cycle.now / 3600);
assert.deepEqual(alarmed('livingRoomTemperature'), [], 'The living room stays in step all day.');
assert.deepEqual(alarmed('kitchenTemperature'), [], 'The kitchen stays in step all day.');
const bedroom = alarmed('bedroomTemperature');
const { from, to } = house.window;
assert.ok(bedroom.length >= 6, `The bedroom drifts past the warning: at ${bedroom.join(', ')} h.`);
assert.ok(bedroom.every((hour) => hour > from / 3600 && hour < to / 3600 + 3), `Only while its window is open, and the hour or two after: at ${bedroom[0]} to ${bedroom.at(-1)} h.`);
assert.ok(cycles.at(-1).trends.bedroomTemperature.alarm === false || cycles.at(-1).now > to + 3 * 3600, 'Shut, it comes back in step.');
assert.equal(cycles.find((cycle) => cycle.now / 3600 === bedroom[0]).trend.signal, 'bedroomTemperature', 'The move\'s own trend is the bedroom\'s once it drifts.');

// The floor slab, which no sensor measures, is followed among what the twin infers.
const slabStateId = document.nodes.find((node) => node.name === 'Floor slab').states[0].id;
const slab = cycles.map((cycle) => cycle.inferred[slabStateId].find((point) => Math.abs(point.time - cycle.now) < 1e-9)?.value);
assert.ok(slab.every(Number.isFinite) && Math.max(...slab) - Math.min(...slab) > 0.2, `The slab's temperature is followed through the day: ${(Math.min(...slab) - 273.15).toFixed(2)} to ${(Math.max(...slab) - 273.15).toFixed(2)} °C.`);
console.log(`The house: eight signals matched with their conversions, 139 moves; the bedroom past the warning from ${bedroom[0].toFixed(1)} h to ${bedroom.at(-1).toFixed(1)} h (its window open from ${from / 3600} to ${to / 3600} h), the living room and the kitchen in step all day, the slab followed from ${(Math.min(...slab) - 273.15).toFixed(1)} to ${(Math.max(...slab) - 273.15).toFixed(1)} °C.`);
