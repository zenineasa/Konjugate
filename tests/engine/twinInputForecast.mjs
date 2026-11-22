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
//   - nothing projected is kept as a reading: each move's window runs on exactly the readings, whatever the forecast assumed;
//   - with the house's thermostats in the model and its setpoints logged: each heater handed to its thermostat past now (From the
//     model: the engine has the heater follow the thermostat's command, which starts from the heater's last reading) and each setpoint
//     to its programme by the clock (From a plan), the rooms' forecasts come clearly closer than with everything held, the heaters'
//     own forecasts too, and the setpoints' exactly;
//   - with the estimator, the inputs' own uncertainty (how far their forecasts have been off) widens the forecast's band, and turned
//     off it does not.
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

const heaters = ['livingRoomHeater', 'bedroomHeater', 'kitchenHeater'];
const rooms = ['livingRoomTemperature', 'bedroomTemperature', 'kitchenTemperature'];

async function runTwin(days, inputForecasts, more = {}, { thermostats = false } = {}) {
    const document = houseProject({ thermostats });
    const log = houseDay({ days, setpoints: thermostats });
    const firstHour = (name) => log.observations.filter((observation) => observation.signal === name).slice(0, 60).map((observation) => observation.value);
    const suggestions = suggestMapping(log.header.signals.map((signal) => ({ id: signal.name, name: signal.name, unit: signal.unit, role: signal.role, values: firstHour(signal.name) })), document);
    // The setpoints, in °C, onto the thermostats' shared setpoints, in kelvin (mapped by hand: what the suggestions make of them is not
    // what is checked here).
    const setpointIds = { livingRoomSetpoint: 106, bedroomSetpoint: 107, kitchenSetpoint: 108 };
    const mapping = suggestions.map((suggestion) => (setpointIds[suggestion.name] ? { signal: suggestion.name, role: 'input', unit: '°C', parameterId: setpointIds[suggestion.name] }
        : suggestion.role === 'input'
        ? { signal: suggestion.name, role: 'input', unit: suggestion.unit, parameterId: suggestion.target.id }
        : { signal: suggestion.name, role: 'output', unit: suggestion.unit, stateId: suggestion.target.id }));
    const conversions = Object.fromEntries([
        ...suggestions.filter((entry) => entry.conversion && !setpointIds[entry.name]).map((entry) => [entry.name, { scale: entry.conversion.scale, offset: entry.conversion.offset, unit: entry.target.unit }]),
        ...Object.keys(setpointIds).filter(() => thermostats).map((name) => [name, { scale: 1, offset: 273.15, unit: 'K' }])
    ]);
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
// ---- The house's thermostats in the model, its setpoints logged -----------------------------------------------------------------
// Each room's thermostat: its node's Heater command state (scripts/generateHouseTwin.mjs, houseProject({ thermostats: true })).
const thermostatOf = { livingRoomHeater: 21, bedroomHeater: 23, kitchenHeater: 25 };
const kelvin = 273.15;
const plans = {
    livingRoomSetpoint: [[6.5, 21], [23, 17]], bedroomSetpoint: [[7, 17], [21, 19.5]], kitchenSetpoint: [[6, 20.5], [9, 16], [17, 20.5], [21, 16]]
};
const planOf = (name) => ({ repeat: 'daily', timeZone: 'UTC', points: plans[name].map(([hour, celsius]) => ({ at: hour * 3600, value: celsius + kelvin })) });
const allHeld = await runTwin(1, {}, {}, { thermostats: true });
const handed = await runTwin(1, {
    ...Object.fromEntries(heaters.map((heater) => [heater, { choice: 'model', state: thermostatOf[heater] }])),
    ...Object.fromEntries(Object.keys(plans).map((name) => [name, { choice: 'plan', plan: planOf(name) }]))
}, {}, { thermostats: true });
assert.equal(windows(handed.cycles), windows(allHeld.cycles), 'Following the thermostats past now changed nothing before it.');
const allHeldMiss = forecastMiss(allHeld);
const handedMiss = forecastMiss(handed);
assert.ok(handedMiss < 0.8 * allHeldMiss, `With each heater handed to its thermostat and each setpoint to its plan, the rooms' forecasts miss by ${handedMiss.toFixed(3)} K, held ${allHeldMiss.toFixed(3)} K.`);
const followed = handed.cycles.at(-1).projections.livingRoomHeater;
assert.equal(followed.using, 'model');
assert.ok(followed.samples.length > 50 && followed.samples.every((sample) => Math.abs(sample.value) < 1e-6 || Math.abs(sample.value - 2000) < 1e-6), 'What the thermostat did past now is read back: on or off.');
const handedScores = handed.cycles.at(-1).inputScores;
for (const heater of heaters) {
    assert.ok(handedScores[heater].error.model < handedScores[heater].error.hold, `${heater}: its thermostat missed by ${handedScores[heater].error.model.toFixed(0)} W, holding ${handedScores[heater].error.hold.toFixed(0)} W.`);
}
for (const name of Object.keys(plans)) assert.ok(handedScores[name].error.plan < 1e-9, `${name}: its plan is what then came (missed by ${handedScores[name].error.plan}).`);

// With the estimator, every member's forecast hands the heaters to the thermostats too: the engine goes over the same stretch once a
// member, each time replacing what the heater followed on the pass before.
const handedEstimated = await runTwin(1, Object.fromEntries(heaters.map((heater) => [heater, { choice: 'model', state: thermostatOf[heater] }])),
    { corrections: { livingRoomTemperature: { estimate: true } }, estimator: { members: 8 } }, { thermostats: true });
assert.ok(handedEstimated.cycles.slice(1).every((cycle) => cycle.estimate?.band?.livingRoomTemperature?.length > 0), 'Every estimated move has its band.');
assert.ok(forecastMiss(handedEstimated) < 0.8 * allHeldMiss, `Estimated, with the heaters handed to their thermostats: ${forecastMiss(handedEstimated).toFixed(3)} K.`);

// ---- The inputs' own uncertainty in the estimator's band --------------------------------------------------------------------------
const bandWidth = ({ cycles }) => {
    const widths = cycles.filter((cycle) => cycle.estimate?.band?.livingRoomTemperature?.length).map((cycle) => { const end = cycle.estimate.band.livingRoomTemperature.at(-1); return end.high - end.low; });
    return widths.reduce((sum, width) => sum + width, 0) / widths.length;
};
// How many of the living room's later readings fell inside the band its forecast drew (from now to the horizon): about 80% for an
// honest 10th-to-90th percentile band.
const coverage = ({ log, cycles }) => {
    let inside = 0;
    let all = 0;
    for (const cycle of cycles.filter((entry) => entry.estimate?.band?.livingRoomTemperature?.length)) {
        const band = cycle.estimate.band.livingRoomTemperature;
        for (const reading of log.observations) {
            if (reading.signal !== 'livingRoomTemperature' || reading.time <= cycle.now || reading.time > cycle.now + 3600) continue;
            const point = band.find((entry) => Math.abs(entry.time - reading.time) < 1e-9);
            if (!point) continue;
            all += 1;
            if (reading.value + kelvin >= point.low && reading.value + kelvin <= point.high) inside += 1;
        }
    }
    return inside / all;
};
const estimating = { corrections: { livingRoomTemperature: { estimate: true } }, estimator: { members: 16 } };
const withInputs = await runTwin(1, {}, estimating);
const withoutInputs = await runTwin(1, {}, { ...estimating, estimator: { ...estimating.estimator, inputUncertainty: false } });
assert.ok(bandWidth(withInputs) > 1.2 * bandWidth(withoutInputs), `The band at the horizon is ${bandWidth(withInputs).toFixed(3)} K wide with the inputs' uncertainty, ${bandWidth(withoutInputs).toFixed(3)} K without.`);
assert.ok(coverage(withInputs) > coverage(withoutInputs), `The forecast band holds ${(100 * coverage(withInputs)).toFixed(0)}% of the later readings with the inputs' uncertainty, ${(100 * coverage(withoutInputs)).toFixed(0)}% without.`);
assert.ok(withInputs.cycles.at(-1).inputSpreads.livingRoomHeater > 0, 'Each input is moved by how far its forecasts have been off.');
assert.equal(windows(withInputs.cycles), windows(withoutInputs.cycles), 'The inputs\' uncertainty reaches only the forecast.');

console.log(`Thermostats in the model: the rooms' forecasts missed by ${handedMiss.toFixed(3)} K with the heaters handed to them and the setpoints to their plans, ${allHeldMiss.toFixed(3)} K held. `
    + `The band ${bandWidth(withInputs).toFixed(3)} K wide with the inputs' uncertainty, holding ${(100 * coverage(withInputs)).toFixed(0)}% of the later readings; ${bandWidth(withoutInputs).toFixed(3)} K and ${(100 * coverage(withoutInputs)).toFixed(0)}% without.`);
console.log(`Inputs in the forecast: the heaters' own forecasts missed by ${heaterScores} at their average against held; the rooms' by ${averagedMiss.toFixed(3)} K at their average, ${automaticMiss.toFixed(3)} K on Automatic, `
    + `${heldMiss.toFixed(3)} K held; on the second day the last day repeated for the weather (${dayScores.outdoorTemperature.error.day.toFixed(2)} K against ${dayScores.outdoorTemperature.error.hold.toFixed(2)} K held) and the sun.`);
