/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/heatingRecord.csv: two days of a heated room, one reading every 10 minutes, for the "Discover equations from data"
// tutorial (src/tutorials/discoverEquations.mjs). Three columns: the temperature outside, the heater's power, and the room's temperature.
// The outside temperature and the heater's power each wander on their own (the weather, and someone turning the heater up and down); the
// room follows both a reading later, and keeps most of its own warmth from one reading to the next. Causal inference is meant to find
// exactly that: outdoorTemperature -> roomTemperature and heaterPower -> roomTemperature, both lagged, and nothing between the two causes.
// The noise is deterministic, so the file is the same every time this is run:
//   node scripts/generateHeatingRecord.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gaussianFrom, mulberry32 } from '../tests/fixtures/thermalSystemCsv.mjs';

export const heatingRecord = Object.freeze({
    rows: 288,
    intervalSeconds: 600,
    // Each wanders about its own level: value[t] = persistence·value[t-1] + (1 - persistence)·level + spread·noise.
    outdoor: { persistence: 0.9, level: 5, spread: 1.5 },
    heater: { persistence: 0.2, level: 1200, spread: 300 },
    // room[t] = keep·room[t-1] + outdoor·outdoor[t-1] + heater·heater[t-1] + noise
    room: { start: 19, keep: 0.75, outdoor: 0.25, heater: 0.002, noise: 0.05 }
});

export function heatingRecordCsv({ rows, intervalSeconds, outdoor: o, heater: h, room } = heatingRecord) {
    const random = mulberry32(4242);
    const outdoor = [o.level];
    const heater = [h.level];
    const indoor = [room.start];
    for (let t = 1; t < rows; t += 1) {
        outdoor.push(o.persistence * outdoor[t - 1] + (1 - o.persistence) * o.level + o.spread * gaussianFrom(random));
        heater.push(Math.max(0, h.persistence * heater[t - 1] + (1 - h.persistence) * h.level + h.spread * gaussianFrom(random)));
        indoor.push(room.keep * indoor[t - 1] + room.outdoor * outdoor[t - 1] + room.heater * heater[t - 1] + room.noise * gaussianFrom(random));
    }
    const lines = ['time,outdoorTemperature,heaterPower,roomTemperature'];
    for (let t = 0; t < rows; t += 1) lines.push(`${t * intervalSeconds},${outdoor[t].toFixed(3)},${heater[t].toFixed(1)},${indoor[t].toFixed(3)}`);
    return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(import.meta.dirname, '..', 'examples', 'heatingRecord.csv'), heatingRecordCsv());
}
