/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes examples/dataSources/smartHouse.kjt and examples/dataSources/smartHouse.csv: a small house for the live twin's demonstration
// with many signals (docs/proposals/controlRoom.md, "Demonstrations"). Three rooms, each with its own heater and thermostat and a
// thermometer; the weather outside and the sun through the living room's windows; and a concrete floor slab under them all that no
// sensor measures, which warms and cools slowly and which the twin infers. The recording is a day of the house as its controller
// would log it, in °C, a reading a minute: the heaters switching as the thermostats ask, a cold day with sun at midday, and the bedroom
// window left open from 14:00 to 18:00, which the model knows nothing about, so the bedroom drifts while the other rooms stay in step.
//
// The day is simulated here with the model's own equations and step (explicit Euler, one minute), the thermostats closing the loop,
// so the recording is what the model would give with the window's extra heat loss, plus a thermometer's noise and its 0.01 resolution.
//   node scripts/generateHouseTwin.mjs

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatDataLog } from '../src/dataLogFormat.mjs';
import { encodeProjectFile } from '../src/projectFile.mjs';
import { gaussianFrom, mulberry32 } from '../tests/fixtures/thermalSystemCsv.mjs';
import { exampleOwnership } from './exampleOwnership.mjs';

const root = join(import.meta.dirname, '..');
const kelvin = 273.15;

export const house = Object.freeze({
    rooms: [
        { key: 'livingRoom', name: 'Living room', capacitance: 3.0e6, heatLoss: 70, slab: 150, heater: 2000, position: [-3, 0, 0], color: '#3f8f8a' },
        { key: 'bedroom', name: 'Bedroom', capacitance: 1.5e6, heatLoss: 45, slab: 80, heater: 1200, position: [2.5, 2.2, 0], color: '#6b7fc4' },
        { key: 'kitchen', name: 'Kitchen', capacitance: 1.8e6, heatLoss: 55, slab: 90, heater: 1500, position: [2.5, -2.2, 0], color: '#c18a4a' }
    ],
    // Heat passing between rooms through their shared walls and open doors (W/K).
    walls: [['livingRoom', 'bedroom', 35], ['livingRoom', 'kitchen', 50]],
    slabCapacitance: 2.0e7,
    // The bedroom window, open from 14:00 to 18:00: its heat loss to outside three times what it is with the window shut.
    window: { room: 'bedroom', from: 14 * 3600, to: 18 * 3600, factor: 3 },
    timeStep: 60,
    duration: 24 * 3600,
    noise: 0.05,
    seed: 20261107
});

// What each room's thermostat asks for, by the hour (°C): a living room warm in the day, a bedroom warm at bedtime, a kitchen at meals.
function setpoint(key, time) {
    const hour = (time / 3600) % 24;
    if (key === 'livingRoom') return hour >= 6.5 && hour < 23 ? 21 : 17;
    if (key === 'bedroom') return hour >= 21 || hour < 7 ? 19.5 : 17;
    return (hour >= 6 && hour < 9) || (hour >= 17 && hour < 21) ? 20.5 : 16;
}
// The weather: a cold day, coldest before dawn, and the sun through the living room's south windows with a passing cloud or two.
const outdoorCelsius = (time) => 3 + 5 * Math.sin(2 * Math.PI * (time / 86400 - 9 / 24));
function solarGain(time, random) {
    const hour = time / 3600;
    if (hour < 7.5 || hour > 17.5) return 0;
    const clear = 1600 * Math.sin(Math.PI * (hour - 7.5) / 10) ** 2;
    const cloud = hour > 11.2 && hour < 12.1 ? 0.35 : hour > 15 && hour < 15.6 ? 0.5 : 1;
    return Math.round(clear * cloud * (0.97 + 0.06 * random()));
}

const sharedIds = { outdoorTemperature: 101, solarGain: 102, livingRoomHeater: 103, bedroomHeater: 104, kitchenHeater: 105 };

export function houseProject() {
    let next = 200;
    const id = () => next++;
    const parameter = (name, symbol, value, unit, extra = {}) => ({ id: id(), name, symbol, value, unit, mode: 'constant', ...extra });
    const state = (stateId, name, symbol, initialValue) => ({ id: stateId, name, symbol, initialValue, unit: 'K' });
    const binding = (kind, stateOrParameter, symbol, nodeId) => (kind === 'state' ? { kind: 'state', ...(nodeId ? { nodeId } : {}), stateId: stateOrParameter, symbol } : { kind: 'parameter', parameterId: stateOrParameter, symbol });
    const nodes = [];
    const edges = [];
    // The outdoor air: its temperature is the weather station's, set at every instant from the shared input.
    const outdoorParameter = parameter('Outdoor temperature', 'outdoorTemperature', kelvin + 3, 'K', { sharedParameterId: sharedIds.outdoorTemperature });
    nodes.push({
        id: 1, name: 'Outdoor air', type: 'Weather', position: [0, 5, 0], appearance: { type: 'primitive', shape: 'box', color: '#52727a' },
        states: [state(2, 'Temperature', 'temperature', kelvin + 3)],
        sourceTerms: [{
            id: id(), state: 'temperature', expression: 'outdoorTemperature', setsValue: true,
            expressionModel: { latex: '\\mathrm{outdoorTemperature}', output: { stateId: 2 }, mathJson: 'outdoorTemperature', bindings: [binding('parameter', outdoorParameter.id, 'outdoorTemperature')] },
            parameters: [outdoorParameter]
        }]
    });
    // The floor slab under every room: heavy, slow, and measured by nobody.
    nodes.push({
        id: 9, name: 'Floor slab', type: 'Thermal mass', position: [0, 0, -2.5], appearance: { type: 'primitive', shape: 'box', color: '#7b6f63' },
        states: [state(10, 'Temperature', 'temperature', kelvin + 19.5)], sourceTerms: []
    });
    const roomNodes = {};
    house.rooms.forEach((room, index) => {
        const nodeId = 3 + 2 * index;
        const stateId = nodeId + 1;
        roomNodes[room.key] = { nodeId, stateId, room };
        const capacitance = () => parameter(`${room.name} thermal capacitance`, 'capacitance', room.capacitance, 'J/K');
        const heaterParameter = parameter(`${room.name} heater`, 'heaterPower', room.heater, 'W', { sharedParameterId: sharedIds[`${room.key}Heater`] });
        const heaterCapacitance = capacitance();
        const sourceTerms = [{
            id: id(), state: 'airTemperature', expression: 'heaterPower / capacitance',
            expressionModel: {
                latex: '\\frac{\\mathrm{heaterPower}}{\\mathrm{capacitance}}', output: { stateId }, mathJson: ['Divide', 'heaterPower', 'capacitance'],
                bindings: [binding('parameter', heaterParameter.id, 'heaterPower'), binding('parameter', heaterCapacitance.id, 'capacitance')]
            },
            parameters: [heaterParameter, heaterCapacitance]
        }];
        if (room.key === 'livingRoom') {
            const solar = parameter('Solar gain', 'solarGain', 0, 'W', { sharedParameterId: sharedIds.solarGain });
            const solarCapacitance = capacitance();
            sourceTerms.push({
                id: id(), state: 'airTemperature', expression: 'solarGain / capacitance',
                expressionModel: {
                    latex: '\\frac{\\mathrm{solarGain}}{\\mathrm{capacitance}}', output: { stateId }, mathJson: ['Divide', 'solarGain', 'capacitance'],
                    bindings: [binding('parameter', solar.id, 'solarGain'), binding('parameter', solarCapacitance.id, 'capacitance')]
                },
                parameters: [solar, solarCapacitance]
            });
        }
        nodes.push({
            id: nodeId, name: room.name, type: 'Room', position: room.position, appearance: { type: 'primitive', shape: 'box', color: room.color },
            states: [state(stateId, 'Air temperature', 'airTemperature', kelvin + 19)], sourceTerms
        });
    });
    // A conductance's heat flow into one end: k (T_other − T_this) / C_this. Every exchange is two directed relationships, one into each
    // end, so the heat one end loses the other gains.
    const flowInto = (name, from, to, conductanceName, conductance, capacitance, tuning = null) => {
        const k = parameter(conductanceName, 'conductance', conductance, 'W/K', tuning ? { tuning } : {});
        const c = parameter(`${to.name} thermal capacitance`, 'capacitance', capacitance, 'J/K');
        const latex = '\\frac{\\mathrm{conductance}\\cdot(\\mathrm{sourceTemperature}-\\mathrm{targetTemperature})}{\\mathrm{capacitance}}';
        edges.push({
            id: id(), name, source: { nodeId: from.nodeId, stateId: from.stateId }, target: { nodeId: to.nodeId, stateId: to.stateId }, directionality: 'directed',
            equation: latex,
            equationModel: {
                latex, output: { role: 'target', stateId: to.stateId },
                bindings: [
                    { kind: 'state', role: 'source', nodeId: from.nodeId, stateId: from.stateId, symbol: 'sourceTemperature' },
                    { kind: 'state', role: 'target', nodeId: to.nodeId, stateId: to.stateId, symbol: 'targetTemperature' },
                    binding('parameter', k.id, 'conductance'), binding('parameter', c.id, 'capacitance')
                ],
                mathJson: ['Divide', ['Multiply', 'conductance', ['Add', 'sourceTemperature', ['Negate', 'targetTemperature']]], 'capacitance']
            },
            parameters: [k, c], appearance: { color: '#73b9c2', offset: 0 }
        });
    };
    const outdoor = { nodeId: 1, stateId: 2, name: 'Outdoor air' };
    const slab = { nodeId: 9, stateId: 10, name: 'Floor slab' };
    for (const { nodeId, stateId, room } of Object.values(roomNodes)) {
        const here = { nodeId, stateId, name: room.name };
        // The heat lost to outside is what a window, a door or wet insulation changes: tunable, for a refit to find or the estimator to track.
        flowInto(`${room.name} heat loss`, outdoor, here, `${room.name} heat loss`, room.heatLoss, room.capacitance, { minimum: 5, maximum: 400 });
        flowInto(`Slab to ${room.name.toLowerCase()}`, slab, here, `${room.name} to slab`, room.slab, room.capacitance);
        flowInto(`${room.name} to slab`, here, slab, `${room.name} to slab`, room.slab, house.slabCapacitance);
    }
    for (const [a, b, conductance] of house.walls) {
        const one = roomNodes[a];
        const other = roomNodes[b];
        const oneEnd = { nodeId: one.nodeId, stateId: one.stateId, name: one.room.name };
        const otherEnd = { nodeId: other.nodeId, stateId: other.stateId, name: other.room.name };
        flowInto(`${one.room.name} to ${other.room.name.toLowerCase()}`, oneEnd, otherEnd, `${one.room.name} – ${other.room.name.toLowerCase()} wall`, conductance, other.room.capacitance);
        flowInto(`${other.room.name} to ${one.room.name.toLowerCase()}`, otherEnd, oneEnd, `${one.room.name} – ${other.room.name.toLowerCase()} wall`, conductance, one.room.capacitance);
    }
    const shared = (key, name, value, unit) => ({ id: sharedIds[key], name, symbol: key, value, unit, mode: 'constant' });
    return {
        format: 'konjugate', version: 1, ownership: exampleOwnership('Smart House'), metadata: { units: 'SI' },
        sharedParameters: [
            shared('outdoorTemperature', 'Outdoor temperature', kelvin + 3, 'K'),
            shared('solarGain', 'Solar gain', 0, 'W'),
            ...house.rooms.map((room) => shared(`${room.key}Heater`, `${room.name} heater`, room.heater, 'W'))
        ],
        runConfigurations: [{ id: 30, name: 'One day', globalTimeStep: house.timeStep, outputInterval: house.timeStep, targetTime: house.duration }],
        activeRunConfigurationId: 30,
        nodes, edges
    };
}

// A day of the house, a reading a minute: the model's own equations with the window's extra loss, the thermostats switching the heaters.
export function houseDay() {
    const random = mulberry32(house.seed);
    const temperature = Object.fromEntries(house.rooms.map((room) => [room.key, kelvin + 19]));
    let slab = kelvin + 19.5;
    const on = Object.fromEntries(house.rooms.map((room) => [room.key, false]));
    const observations = [];
    const last = {};
    const record = (time, signal, value, digits) => {
        const rounded = Number(value.toFixed(digits));
        // A controller logs an input when it changes; a thermometer every minute.
        if (signal.endsWith('Heater') || signal === 'solarGain' || signal === 'outdoorTemperature') {
            if (last[signal] === rounded && time % 3600 !== 0) return;
            last[signal] = rounded;
        }
        observations.push({ time, signal, value: rounded, quality: 'good', revision: 0 });
    };
    for (let time = 0; time <= house.duration; time += house.timeStep) {
        const outdoor = kelvin + outdoorCelsius(time);
        const sun = solarGain(time, random);
        // The thermostats, with half a degree either side, read the room as it is.
        for (const room of house.rooms) {
            const wanted = kelvin + setpoint(room.key, time);
            if (temperature[room.key] < wanted - 0.4) on[room.key] = true;
            else if (temperature[room.key] > wanted + 0.4) on[room.key] = false;
        }
        record(time, 'outdoorTemperature', outdoor - kelvin, 1);
        record(time, 'solarGain', sun, 0);
        for (const room of house.rooms) record(time, `${room.key}Heater`, on[room.key] ? room.heater : 0, 0);
        for (const room of house.rooms) record(time, `${room.key}Temperature`, temperature[room.key] - kelvin + house.noise * gaussianFrom(random), 2);
        // One step on, explicit Euler, as the model is run.
        const rate = {};
        let slabRate = 0;
        for (const room of house.rooms) {
            const open = room.key === house.window.room && time >= house.window.from && time < house.window.to ? house.window.factor : 1;
            let flow = (on[room.key] ? room.heater : 0) + (room.key === 'livingRoom' ? sun : 0)
                + room.heatLoss * open * (outdoor - temperature[room.key]) + room.slab * (slab - temperature[room.key]);
            for (const [a, b, conductance] of house.walls) {
                if (a === room.key) flow += conductance * (temperature[b] - temperature[a]);
                if (b === room.key) flow += conductance * (temperature[a] - temperature[b]);
            }
            rate[room.key] = flow / room.capacitance;
            slabRate += room.slab * (temperature[room.key] - slab) / house.slabCapacitance;
        }
        for (const room of house.rooms) temperature[room.key] += house.timeStep * rate[room.key];
        slab += house.timeStep * slabRate;
    }
    const signals = [
        { name: 'outdoorTemperature', role: 'input', unit: '°C' },
        { name: 'solarGain', role: 'input', unit: 'W' },
        ...house.rooms.map((room) => ({ name: `${room.key}Heater`, role: 'input', unit: 'W' })),
        ...house.rooms.map((room) => ({ name: `${room.key}Temperature`, role: 'output', unit: '°C' }))
    ];
    return { header: { source: 'Smart house controller (simulated)', epoch: Date.parse('2026-11-09T00:00:00Z'), signals }, observations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await writeFile(join(root, 'examples', 'dataSources', 'smartHouse.kjt'), await encodeProjectFile(`${JSON.stringify(houseProject(), null, 4)}\n`));
    await writeFile(join(root, 'examples', 'dataSources', 'smartHouse.csv'), formatDataLog(houseDay()));
    console.log('Wrote examples/dataSources/smartHouse.kjt and smartHouse.csv.');
}
