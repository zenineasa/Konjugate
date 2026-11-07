/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/dataSources/simulatedTankRigPlant.csv: the simulated rig's steady recording as a plant's logger would keep it, with
// instrument tags for names and the units a plant uses, so the twin's setup can be seen matching names that match nothing in the
// model and proposing the conversions (docs/proposals/controlRoom.md, "Demonstrations"). The heater's power is JI101 (a power
// indicator) in kW, the tank's temperature TT101 (a temperature transmitter) in °C, both on tank 1.
//
//   node scripts/generatePlantRigLog.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataLog } from '../src/dataLog.mjs';
import { formatDataLog } from '../src/dataLogWriter.mjs';

const root = join(import.meta.dirname, '..');
const steady = readDataLog(await readFile(join(root, 'examples', 'dataSources', 'simulatedTankRig.csv'), 'utf8'));
const plant = {
    heaterPower: { name: 'TK1_JI101_PV', unit: 'kW', convert: (watts) => watts / 1000 },
    tankTemperature: { name: 'TK1_TT101_PV', unit: '°C', convert: (kelvin) => Number((kelvin - 273.15).toFixed(2)) }
};
const header = {
    ...steady.header,
    source: 'Plant logger, tank 1 (the simulated rig, renamed: examples/dataSources/simulatedTankRig.csv)',
    signals: steady.header.signals.map((signal) => ({ ...signal, name: plant[signal.name].name, unit: plant[signal.name].unit }))
};
const observations = steady.observations.map((observation) => ({ ...observation, signal: plant[observation.signal].name, value: plant[observation.signal].convert(observation.value) }));
await writeFile(join(root, 'examples', 'dataSources', 'simulatedTankRigPlant.csv'), formatDataLog({ header, observations }));
console.log('Wrote examples/dataSources/simulatedTankRigPlant.csv.');
