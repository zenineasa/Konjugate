/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The inputs in a live twin's forecast (src/inputForecast.mjs, docs/proposals/predictionActualWindow.md "The inputs in the forecast"),
// on the house (scripts/generateHouseTwin.mjs), whose heaters its thermostats switch back and forth and whose weather and sun follow
// the day. Checked:
//   - with every input held, as before, the twin's moves are what they were;
//   - the heaters' own forecasts: held at their average over the window, they come closer to what the heaters then did than held at
//     their last value, by the score, for every heater. The rooms' forecasts hardly change (within a few per cent either way, better
//     in some hours and worse in others): a thermostat answers its room, so over the next hour it does what the room and its setpoint
//     ask, not what it did on average over the last one. That is what "From the model" (the model's own thermostat) is for; the test
//     checks only that no choice makes the rooms' forecasts worse than holding by more than a little;
//   - Automatic averages the heaters: at first because it sees them switching back and forth, then because the score says so;
//   - on a second day, the last day repeated forecasts the outdoor temperature and the sun better than holding them, by the score;
//   - nothing projected is kept as a reading: each move's window runs on exactly the readings, whatever the forecast assumed.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/twinInputForecast.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { formatDataLog } from '../../src/dataLogFormat.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { suggestMapping } from '../../src/signalMatching.mjs';
import { houseDay, houseProject } from '../../scripts/generateHouseTwin.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const document = houseProject();
const heaters = ['livingRoomHeater', 'bedroomHeater', 'kitchenHeater'];
const rooms = ['livingRoomTemperature', 'bedroomTemperature', 'kitchenTemperature'];

async function runTwin(days, inputForecasts, more = {}) {
    const log = houseDay({ days });
    const firstHour = (name) => log.observations.filter((observation) => observation.signal === name).slice(0, 60).map((observation) => observation.value);
    const suggestions = suggestMapping(log.header.signals.map((signal) => ({ id: signal.name, name: signal.name, unit: signal.unit, role: signal.role, values: firstHour(signal.name) })), document);
    const mapping = suggestions.map((suggestion) => (suggestion.role === 'input'
        ? { signal: suggestion.name, role: 'input', unit: suggestion.unit, parameterId: suggestion.target.id }
        : { signal: suggestion.name, role: 'output', unit: suggestion.unit, stateId: suggestion.target.id }));
    const conversions = Object.fromEntries(suggestions.filter((entry) => entry.conversion).map((entry) => [entry.name, { scale: entry.conversion.scale, offset: entry.conversion.offset, unit: entry.target.unit }]));
    const events = [];
    const twin = new LiveTwin({ document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: Object.fromEntries(rooms.map((room) => [room, 0.2])), conversions, keepUp: false, inputForecasts, ...more },
        { kind: 'recording', content: formatDataLog(log), speed: Infinity }, engineOptions, (event) => events.push(event));
    for (let waited = 0; waited < 600000 && !events.some((event) => event.type === 'ended' || event.type === 'error'); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await twin.stop();
    assert.equal(events.find((event) => event.type === 'error'), undefined);
    return { log, cycles: events.filter((event) => event.type === 'cycle').map((event) => event.cycle) };
}

// How far the rooms' forecasts were from what their thermometers then read: the root mean square over every move and every reading
// in its horizon (in kelvin, as the model has them).
function forecastMiss({ log, cycles }) {
    let squares = 0;
    let count = 0;
    for (const cycle of cycles) {
        for (const room of rooms) {
            const forecast = cycle.forecast[room];
            for (const reading of log.observations) {
                if (reading.signal !== room || reading.time <= cycle.now || reading.time > cycle.now + 3600) continue;
                const sample = forecast.find((point) => Math.abs(point.time - reading.time) < 1e-9);
                if (!sample) continue;
                squares += (sample.value - (reading.value + 273.15)) ** 2;
                count += 1;
            }
        }
    }
    return Math.sqrt(squares / count);
}

const held = await runTwin(1, {});
const averaged = await runTwin(1, Object.fromEntries(heaters.map((heater) => [heater, { choice: 'mean' }])));
const automatic = await runTwin(1, Object.fromEntries(heaters.map((heater) => [heater, { choice: 'automatic' }])));

// Held, nothing is projected; and the windows (run on the readings) are the same whatever the forecast assumed.
assert.ok(held.cycles.every((cycle) => Object.values(cycle.projections).every((projection) => projection.using === 'hold' && projection.samples.length === 0)));
const windows = (cycles) => JSON.stringify(cycles.map((cycle) => [cycle.anchor, cycle.window]));
assert.equal(windows(averaged.cycles), windows(held.cycles), 'Nothing projected reached the readings a move\'s window runs on.');

// The heaters at their average: the rooms' forecasts no worse than with them held, beyond a little.
const heldMiss = forecastMiss(held);
const averagedMiss = forecastMiss(averaged);
assert.ok(averagedMiss < 1.05 * heldMiss, `With the heaters at their average the rooms' forecasts miss by ${averagedMiss.toFixed(3)} K, held ${heldMiss.toFixed(3)} K.`);
assert.ok(averaged.cycles.some((cycle) => heaters.some((heater) => cycle.projections[heater].using === 'mean' && cycle.projections[heater].samples.length === 1)));

// The score, against what then arrived, says the average beats holding for every heater, without the twin having to use it.
const scores = held.cycles.at(-1).inputScores;
for (const heater of heaters) {
    assert.ok(scores[heater].projections > 100, `${heater} scored over ${scores[heater].projections} moves.`);
    assert.ok(scores[heater].error.mean < scores[heater].error.hold, `${heater}: the average missed by ${scores[heater].error.mean.toFixed(0)} W, holding ${scores[heater].error.hold.toFixed(0)} W.`);
}

// Automatic: at first, by what the span shows, it averages a heater it sees switching back and forth; once its forecasts have been
// scored, it goes by the score, which for every heater is the average.
const projected = automatic.cycles.flatMap((cycle) => heaters.map((heater) => ({ now: cycle.now, ...cycle.projections[heater] })));
assert.ok(projected.some((projection) => projection.using === 'mean' && /^cycling: /.test(projection.reason)), 'Before a score, Automatic averaged a heater it saw cycling.');
const scored = projected.filter((projection) => /has been closest/.test(projection.reason));
assert.ok(scored.length > 0 && projected.filter((projection) => projection.now >= 4 * 3600).every((projection) => scored.includes(projection)), 'Once scored, Automatic goes by the score.');
// (Almost always: the score is a running figure, and for a stretch of the morning holding one heater had been as close.)
const later = projected.filter((projection) => projection.now >= 6 * 3600);
assert.ok(later.filter((projection) => projection.using === 'mean').length > 0.9 * later.length, 'And the score says to average the heaters.');
const automaticMiss = forecastMiss(automatic);
assert.ok(automaticMiss < 1.05 * heldMiss, `Automatic misses by ${automaticMiss.toFixed(3)} K, held ${heldMiss.toFixed(3)} K.`);

// With the estimator, its members forecast on the inputs the twin's own forecast assumed: the band is there, the run whole.
const estimated = await runTwin(1, Object.fromEntries(heaters.map((heater) => [heater, { choice: 'mean' }])), { corrections: { livingRoomTemperature: { estimate: true } }, estimator: { members: 8 } });
assert.equal(estimated.cycles.length, held.cycles.length);
assert.ok(estimated.cycles.slice(1).every((cycle) => cycle.estimate?.band?.livingRoomTemperature?.length > 0), 'Every estimated move has its band.');
assert.equal(windows(estimated.cycles.slice(0, 1)), windows(held.cycles.slice(0, 1)));

// Two days: on the second, the last day repeated forecasts the weather and the sun better than holding them.
const twoDays = await runTwin(2, { outdoorTemperature: { choice: 'day' }, solarGain: { choice: 'day' } });
const firstDay = twoDays.cycles.filter((cycle) => cycle.now < 86400);
const secondDay = twoDays.cycles.filter((cycle) => cycle.now >= 86400);
assert.ok(firstDay.every((cycle) => cycle.projections.outdoorTemperature.using === 'hold'), 'Until a day has been read, it holds.');
assert.ok(secondDay.every((cycle) => cycle.projections.outdoorTemperature.using === 'day'), 'From the second day, it repeats the first.');
const dayScores = twoDays.cycles.at(-1).inputScores;
for (const input of ['outdoorTemperature', 'solarGain']) {
    assert.ok(dayScores[input].error.day < dayScores[input].error.hold, `${input}: the last day repeated missed by ${dayScores[input].error.day.toFixed(2)}, holding ${dayScores[input].error.hold.toFixed(2)}.`);
}

const heaterScores = heaters.map((heater) => `${scores[heater].error.mean.toFixed(0)} W against ${scores[heater].error.hold.toFixed(0)} W`).join(', ');
console.log(`Inputs in the forecast: the heaters' own forecasts missed by ${heaterScores} at their average against held; the rooms' by ${averagedMiss.toFixed(3)} K at their average, ${automaticMiss.toFixed(3)} K on Automatic, `
    + `${heldMiss.toFixed(3)} K held; on the second day the last day repeated for the weather (${dayScores.outdoorTemperature.error.day.toFixed(2)} K against ${dayScores.outdoorTemperature.error.hold.toFixed(2)} K held) and the sun.`);
