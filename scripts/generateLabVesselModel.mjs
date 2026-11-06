/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/dataSources/labVessel.kjt: the model a lab would build of the invented vessel (examples/dataSources/labVessel.py).
// One water temperature, warmed by the heater, cooled by the room and by cold water through the inlet valve:
//
//     C dT/dt = P + h (T_room - T) + m_in c_p (T_inlet - T)
//
// The heater's power, the inflow and the room temperature are what the logger records, so they are shared parameters a recording
// drives. The thermal capacitance and the heat loss are tunable, and start from a lab's first guesses (100 litres, 25 W/K) rather than
// the vessel's true 120 litres and 15 W/K, which calibrating against the log is to find. The model knows nothing of the thermometer
// pocket's lag or the heater scaling up: those are what the real thing does that the model does not.
//
//   node scripts/generateLabVesselModel.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';

const root = join(import.meta.dirname, '..');

export const labVessel = Object.freeze({
    truth: { capacitance: 120 * 4180, heatLoss: 15 },
    start: { capacitance: 100 * 4180, heatLoss: 25 },
    capacitanceBounds: { minimum: 200000, maximum: 1000000 },
    heatLossBounds: { minimum: 1, maximum: 60 },
    inletTemperature: 285.15,
    // When the real heater starts scaling up (examples/dataSources/labVessel.py): what a live twin should find, and not before.
    scalingStarts: 5 * 3600,
    waterHeatCapacity: 4180,
    ids: { water: 2, heaterPower: 40, inflow: 41, room: 42, capacitance: 43, heatLoss: 44 }
});

const parameter = (id, name, symbol, value, unit, extra = {}) => ({ id, name, symbol, value, unit, mode: 'constant', ...extra });
const linked = (id, name, symbol, sharedParameterId, unit) => ({ id, name, symbol, value: 0, unit, mode: 'constant', sharedParameterId });
const edge = (id, name, sourceNodeId, sourceStateId, latex, mathJson, bindings, parameters, color) => ({
    id, name, source: { nodeId: sourceNodeId, stateId: sourceStateId }, target: { nodeId: 1, stateId: 2 }, directionality: 'directed',
    equation: latex, equationModel: { latex, output: { role: 'target', stateId: 2 }, bindings, mathJson }, parameters, appearance: { color, offset: 0 }
});

export function labVesselProject({ capacitance = labVessel.start.capacitance, heatLoss = labVessel.start.heatLoss } = {}) {
    const { ids, inletTemperature, waterHeatCapacity, capacitanceBounds, heatLossBounds } = labVessel;
    const state = (id, name, symbol, initialValue, unit) => ({ id, name, symbol, initialValue, unit });
    const c = { kind: 'parameter', symbol: 'thermalCapacitance' };
    return {
        format: 'konjugate', version: 1, ownership: exampleOwnership('Lab Vessel'), metadata: { units: 'SI' },
        sharedParameters: [
            parameter(ids.heaterPower, 'Heater power', 'heaterPower', 0, 'W'),
            parameter(ids.inflow, 'Inflow', 'inflowRate', 0, 'kg/s'),
            parameter(ids.room, 'Room temperature', 'roomTemperature', 291.15, 'K'),
            parameter(ids.capacitance, 'Thermal capacitance', 'thermalCapacitance', capacitance, 'J/K', { tuning: capacitanceBounds }),
            parameter(ids.heatLoss, 'Heat loss coefficient', 'heatLossCoefficient', heatLoss, 'W/K', { tuning: heatLossBounds })
        ],
        runConfigurations: [{ id: 30, name: 'Eight hours', globalTimeStep: 5, outputInterval: 5 }],
        activeRunConfigurationId: 30,
        nodes: [
            { id: 1, name: 'Vessel water', type: 'Lumped thermal mass', position: [0, 0, 0], sourceTerms: [], states: [state(ids.water, 'Water temperature', 'waterTemperature', 288.15, 'K')], appearance: { type: 'primitive', shape: 'cylinder', color: '#2e7591' } },
            { id: 3, name: 'Heater', type: 'Heat source', position: [-4, -2.5, 0], sourceTerms: [], states: [state(4, 'Setting', 'setting', 0, '-')], appearance: { type: 'primitive', shape: 'sphere', color: '#c16f55' } },
            { id: 5, name: 'Room', type: 'Temperature boundary', position: [4, 1, 0], sourceTerms: [], states: [state(6, 'Air', 'air', 0, '-')], appearance: { type: 'primitive', shape: 'box', color: '#52727a' } },
            { id: 7, name: 'Cold inlet', type: 'Flow boundary', position: [0, 3.5, 0], sourceTerms: [], states: [state(8, 'Supply', 'supply', 0, '-')], appearance: { type: 'primitive', shape: 'box', color: '#3f6fb0' } }
        ],
        edges: [
            edge(10, 'Heater input', 3, 4, '\\frac{\\mathrm{heaterPower}}{\\mathrm{thermalCapacitance}}', ['Divide', 'heaterPower', 'thermalCapacitance'],
                [{ kind: 'parameter', parameterId: 11, symbol: 'heaterPower' }, { ...c, parameterId: 12 }],
                [linked(11, 'Heater power', 'heaterPower', ids.heaterPower, 'W'), linked(12, 'Thermal capacitance', 'thermalCapacitance', ids.capacitance, 'J/K')], '#d98b54'),
            edge(13, 'Loss to the room', 5, 6, '\\frac{\\mathrm{heatLossCoefficient}\\cdot(\\mathrm{roomTemperature}-\\mathrm{targetWaterTemperature})}{\\mathrm{thermalCapacitance}}',
                ['Divide', ['Multiply', 'heatLossCoefficient', ['Add', 'roomTemperature', ['Negate', 'targetWaterTemperature']]], 'thermalCapacitance'],
                [{ kind: 'parameter', parameterId: 14, symbol: 'heatLossCoefficient' }, { kind: 'parameter', parameterId: 15, symbol: 'roomTemperature' },
                    { kind: 'state', role: 'target', nodeId: 1, stateId: 2, symbol: 'targetWaterTemperature' }, { ...c, parameterId: 16 }],
                [linked(14, 'Heat loss coefficient', 'heatLossCoefficient', ids.heatLoss, 'W/K'), linked(15, 'Room temperature', 'roomTemperature', ids.room, 'K'),
                    linked(16, 'Thermal capacitance', 'thermalCapacitance', ids.capacitance, 'J/K')], '#73b9c2'),
            edge(17, 'Cold inflow', 7, 8, '\\frac{\\mathrm{inflowRate}\\cdot\\mathrm{waterHeatCapacity}\\cdot(\\mathrm{inletTemperature}-\\mathrm{targetWaterTemperature})}{\\mathrm{thermalCapacitance}}',
                ['Divide', ['Multiply', 'inflowRate', 'waterHeatCapacity', ['Add', 'inletTemperature', ['Negate', 'targetWaterTemperature']]], 'thermalCapacitance'],
                [{ kind: 'parameter', parameterId: 18, symbol: 'inflowRate' }, { kind: 'parameter', parameterId: 19, symbol: 'waterHeatCapacity' },
                    { kind: 'parameter', parameterId: 20, symbol: 'inletTemperature' }, { kind: 'state', role: 'target', nodeId: 1, stateId: 2, symbol: 'targetWaterTemperature' },
                    { ...c, parameterId: 21 }],
                [linked(18, 'Inflow', 'inflowRate', ids.inflow, 'kg/s'), parameter(19, 'Water heat capacity', 'waterHeatCapacity', waterHeatCapacity, 'J/(kg K)'),
                    parameter(20, 'Inlet temperature', 'inletTemperature', inletTemperature, 'K'), linked(21, 'Thermal capacitance', 'thermalCapacitance', ids.capacitance, 'J/K')], '#5b8fd6')
        ]
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(root, 'examples', 'dataSources', 'labVessel.kjt'), await encodeProjectFile(`${JSON.stringify(labVesselProject(), null, 4)}\n`));
    console.log('Wrote examples/dataSources/labVessel.kjt.');
}
