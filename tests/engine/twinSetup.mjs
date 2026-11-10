/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A twin set up from a plant's names (docs/proposals/controlRoom.md): the simulated rig's recording as a plant's logger keeps it
// (examples/dataSources/simulatedTankRigPlant.csv: TK1_TT101_PV in °C, TK1_JI101_PV in kW) is matched to the rig's model by the
// suggestions alone, with the unit conversions they propose, and the live twin running on it makes the same moves as one fed the rig's
// own recording in the model's units. Matching, conversion and the twin, end to end.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/twinSetup.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { LiveTwin } from '../../src/liveTwinHost.mjs';
import { suggestMapping } from '../../src/signalMatching.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const document = tankRigProject();
const plantContent = await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRigPlant.csv'), 'utf8');
const plant = readDataLog(plantContent);
const steady = readDataLog(await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRig.csv'), 'utf8'));

// The suggestions, from the names, declared roles, units and first readings alone.
const signals = plant.header.signals.map((signal) => ({
    id: signal.name, name: signal.name, unit: signal.unit, role: signal.role,
    values: plant.observations.filter((observation) => observation.signal === signal.name && observation.quality !== 'bad').slice(0, 60).map((observation) => observation.value)
}));
const suggestions = Object.fromEntries(suggestMapping(signals, document).map((suggestion) => [suggestion.name, suggestion]));
assert.equal(suggestions.TK1_TT101_PV.target.label, 'Water tank · Water temperature');
assert.deepEqual([suggestions.TK1_TT101_PV.conversion.scale, suggestions.TK1_TT101_PV.conversion.offset], [1, 273.15]);
assert.equal(suggestions.TK1_JI101_PV.target.label, 'Shared · Heater power');
assert.deepEqual([suggestions.TK1_JI101_PV.conversion.scale, suggestions.TK1_JI101_PV.conversion.offset], [1000, 0]);
assert.ok(Object.values(suggestions).every((suggestion) => suggestion.confidence >= 0.75), 'Both are confident enough to be filled in.');

// The twin on the plant's recording, through the suggested mapping and conversions.
const mapping = Object.values(suggestions).map((suggestion) => (suggestion.role === 'input'
    ? { signal: suggestion.name, role: 'input', unit: suggestion.unit, parameterId: suggestion.target.id }
    : { signal: suggestion.name, role: 'output', unit: suggestion.unit, stateId: suggestion.target.id }));
const conversions = Object.fromEntries(Object.values(suggestions).map((suggestion) => [suggestion.name, { scale: suggestion.conversion.scale, offset: suggestion.conversion.offset, unit: suggestion.target.unit }]));
const settings = { document, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { TK1_TT101_PV: 0.5 }, keepUp: false, conversions };
const events = [];
const twin = new LiveTwin(settings, { kind: 'recording', content: plantContent, speed: Infinity }, engineOptions, (event) => events.push(event));
for (let waited = 0; waited < 120000 && !events.some((event) => event.type === 'ended'); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
const planted = twin.session.cycles;
await twin.stop();
assert.equal(planted.length, 31, 'Every move was made from the plant\'s readings.');

// The rig's own recording, in the model's units.
const direct = new WindowSession({ document, header: steady.header, mapping: guessReplayMapping(steady.header, replayTargets(document)), window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, engineOptions });
direct.push(steady.observations);
await direct.end();
await direct.close();
// The same moves: the °C readings, written to two decimals and converted back, agree with the kelvin ones to rounding.
let largest = 0;
for (const [index, cycle] of planted.entries()) {
    const other = direct.cycles[index];
    assert.equal(cycle.anchor, other.anchor);
    largest = Math.max(largest, ...cycle.restored.values.map((value, position) => Math.abs(value - other.restored.values[position])));
}
assert.ok(largest < 1e-9, `The twin's states agree with the rig's own recording's to ${largest}.`);
// What the twin infers: every state no sensor measures, from its anchor to the horizon, in each move and in the event the room reads;
// all but the heater's heat flow, which the heater's power sets at every instant: that input again, shown with the inputs.
const heatFlowStateId = 4;
const unmeasured = replayTargets(document).states.filter((state) => !mapping.some((entry) => entry.stateId === state.stateId) && state.stateId !== heatFlowStateId);
assert.ok(replayTargets(document).states.some((state) => state.stateId === heatFlowStateId), 'The rig has a heat flow its heater sets.');
assert.equal(heatFlowStateId in planted.at(-1).inferred, false, 'The heat flow is not among what the twin infers.');
assert.ok(unmeasured.length > 0, 'The rig has states no sensor measures.');
const lastCycle = planted.at(-1);
for (const state of unmeasured) {
    const series = lastCycle.inferred[state.stateId];
    assert.equal(series[0].time, lastCycle.anchor);
    assert.ok(series.at(-1).time >= lastCycle.now + 3600 - 1e-9 && series.every((point) => Number.isFinite(point.value)), `${state.label} is followed to the horizon.`);
}
const sent = events.filter((event) => event.type === 'cycle').at(-1).cycle;
assert.deepEqual(Object.keys(sent.inferred).map(Number).sort(), unmeasured.map((state) => state.stateId).sort(), 'The room is sent each of them.');
assert.ok(Object.values(sent.inferred).every((series) => series.length <= 80), 'Thinned for sending.');
assert.ok(sent.inputChanges.TK1_JI101_PV.length > 0 && sent.inputChanges.TK1_JI101_PV.every((reading, index, all) => index === 0 || reading.value !== all[index - 1].value), 'The heater\'s power is sent as its changes.');
console.log(`A twin set up from a plant's names: TK1_TT101_PV (°C) and TK1_JI101_PV (kW) matched by the suggestions with their conversions, ${planted.length} moves, the same as from the rig's own recording (largest difference ${largest.toExponential(1)}).`);
