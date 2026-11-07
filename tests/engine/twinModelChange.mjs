/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A model changed while its twin runs (docs/proposals/controlRoom.md, "The engineer's view, and changing the model"), applied from
// the latest move (src/windowSession.mjs, applyModel). A parameter changed in the model takes the twin exactly where applying the same
// value as a refit does; a node added is carried in at its initial values, with every other state carried across; a change that
// removes a measured state is refused, and the twin goes on as it was.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/twinModelChange.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { readDataLog } from '../../src/dataLog.mjs';
import { guessReplayMapping, replayTargets } from '../../src/dataLogReplay.mjs';
import { WindowSession } from '../../src/windowSession.mjs';
import { heatLossParameterId, tankRigProject } from '../../scripts/generateTankRigModel.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };

const document = tankRigProject();
const log = readDataLog(await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRig.csv'), 'utf8'));
const mapping = guessReplayMapping(log.header, replayTargets(document));
const observations = [...log.observations].sort((a, b) => a.time - b.time);
const half = observations.findIndex((observation) => observation.time - observations[0].time > 3 * 3600);
const session = () => new WindowSession({ document, header: log.header, mapping, window: 3600, stride: 600, horizon: 3600, timeStep: 60, tolerances: { tankTemperature: 0.5 }, engineOptions });
const heatLoss = (model) => model.edges.flatMap((edge) => edge.parameters ?? []).find((parameter) => parameter.id === heatLossParameterId);

// The heat loss changed in the model, and the same value applied as a refit: the same twin from there on.
const changed = structuredClone(document);
heatLoss(changed).value = heatLoss(document).value * 1.25;
const byModel = session();
byModel.push(observations.slice(0, half));
await byModel.idle();
const changedAt = byModel.cycles.length;
const outcome = await byModel.applyModel(changed);
assert.deepEqual([outcome.added, outcome.removed], [[], []], 'Nothing added or removed.');
byModel.push(observations.slice(half));
await byModel.end();
const byRefit = session();
byRefit.push(observations.slice(0, half));
await byRefit.idle();
await byRefit.applyRefit({ values: [{ parameterId: heatLossParameterId, value: heatLoss(changed).value }], cycle: byRefit.cycles.at(-1).index });
byRefit.push(observations.slice(half));
await byRefit.end();
assert.equal(byModel.cycles.length, byRefit.cycles.length);
let largest = 0;
for (const [index, cycle] of byModel.cycles.entries()) {
    largest = Math.max(largest, ...cycle.restored.values.map((value, position) => Math.abs(value - byRefit.cycles[index].restored.values[position])));
}
assert.ok(largest < 1e-9, `A parameter changed in the model runs as the refit does: ${largest}.`);
assert.deepEqual(byModel.cycles[changedAt].refit.model, outcome, 'The next move records the change.');
await byModel.close();
await byRefit.close();

// A node added: carried in at its initial value, the others carried across; then a change removing the measured state, refused.
const grown = structuredClone(document);
const ambient = grown.nodes.find((node) => node.states?.length && !mapping.some((entry) => entry.stateId === node.states[0].id));
const added = { ...structuredClone(ambient), id: 9000, name: 'Second room', states: ambient.states.map((state, index) => ({ ...state, id: 9001 + index })) };
added.sourceTerms = [];
grown.nodes.push(added);
const twin = session();
twin.push(observations.slice(0, half));
await twin.idle();
const before = twin.cycles.at(-1).restored.values.length;
const grew = await twin.applyModel(grown);
assert.deepEqual(grew.added, added.states.map((state) => state.id), 'The new node\'s states are added.');
assert.equal(grew.carried.length, before, 'Every other state is carried across.');
twin.push(observations.slice(half, half + 30));
await twin.idle();
const next = twin.cycles.at(-1);
assert.ok(next.inferred[9001].every((point) => Math.abs(point.value - added.states[0].initialValue) < 1e-9), 'The new room stays at its initial temperature.');

const shrunk = structuredClone(grown);
const measured = mapping.find((entry) => entry.role === 'output').stateId;
for (const node of shrunk.nodes) node.states = (node.states ?? []).filter((state) => state.id !== measured);
const moves = twin.cycles.length;
await assert.rejects(twin.applyModel(shrunk), /tankTemperature is compared with a state the change removes\. Fix the mapping in the setup first\./);
twin.push(observations.slice(half + 30));
await twin.end();
assert.ok(twin.cycles.length > moves && twin.cycles.at(-1).inferred[9001], 'The twin goes on with the model it had.');
await twin.close();
console.log(`A model changed while its twin runs: a parameter applied as a refit would (largest difference ${largest.toExponential(1)}), a node added at its initial values with ${grew.carried.length} states carried across, a measured state's removal refused.`);
