/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A data centre's thermal behaviour, end to end: server racks, aisles, an underfloor plenum, the room and three cooling units, as a graph
// of 26 nodes and 68 relationships.
//
// Two rows of eight racks. Each rack is a node with its servers' heat capacity (100 kJ/K, at T_s) and the air passing through it (2.4 kJ/K,
// leaving at T_x); its IT load Q (6 to 12 kW) heats the servers, which pass it to the air through 2 kW/K. A rack draws its design flow
// m = Q_design / 12 K (as ṁ c, W/K) from its row's cold aisle, except a fraction r that it recirculates from its row's hot aisle (0.15 at
// the ends of a row, 0.08 next in, 0.03 in the middle):
//     C_x dT_x/dt = (1 - r) m (T_cold - T_x) + r m (T_hot - T_x) + UA (T_s - T_x)        C_s dT_s/dt = Q(t) - UA (T_s - T_x)
// Each row's cold aisle (48 kJ/K) is fed from the plenum with what its racks draw plus a bypass of 10 % that goes straight to the hot
// aisle; each hot aisle (48 kJ/K) takes its racks' exhaust and the bypass, gives back what the racks recirculate, and sends the rest to
// the room (240 kJ/K), which also gains heat from outdoors (303.15 K) through 300 W/K. Three cooling units each draw a third of the room's
// return flow over a coil (30 kJ/K) and blow it into the plenum (120 kJ/K). A unit's cooling is a feedforward and proportional controller
// on its supply temperature, clamped to its capacity of 80 kW:
//     Q_cool = min(max(F (T_room - T_set) + G (T_coil - T_set), 0), Q_max(t)),   T_set = 291.15 K, G = 5 kW/K
// Every flow in and out of every air volume balances, so each takes heat as F (T_upstream - T).
//
// The scenario: everything starts at 291.15 K with the racks at their design loads (144 kW); at 300 s a batch job lifts four racks in
// the middle of row B by half (to 168 kW); at 900 s the second cooling unit's coil fails (its fan keeps running), leaving 160 kW of
// cooling for 168 kW of load. The racks' inlet temperatures, (1 - r) T_cold + r T_hot, are what an operator watches: the hottest crosses
// ASHRAE's recommended 27 °C (300.15 K) some minutes after the failure.
//
// Energy is booked in each rack (IT heat), each cooling unit (heat removed) and the room (heat from outdoors): Σ C ΔT = Σ E_IT + E_env -
// Σ E_cool, from Konjugate's own states. The reference is a model written independently in Python from this description, as one vector
// ODE rather than a graph, solved by SciPy's DOP853 at rtol = 1e-12 (generateReference.py).

import { join } from 'node:path';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { cases, createModel, difference, negate, parameter, product, quotient, state, sum, time } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'dataCentre.kjt');

export const constants = Object.freeze({
    rows: [
        { name: 'A', loads: [6, 8, 10, 8, 8, 10, 8, 6].map((kW) => kW * 1000), boosted: [] },
        { name: 'B', loads: [8, 8, 12, 12, 12, 12, 8, 8].map((kW) => kW * 1000), boosted: [2, 3, 4, 5] }
    ],
    recirculation: [0.15, 0.08, 0.03, 0.03, 0.03, 0.03, 0.08, 0.15],
    designRise: 12, bypassFraction: 0.1, boost: 1.5, boostAt: 300,
    serverCapacity: 100e3, serverConductance: 2000, rackAirCapacity: 2400,
    aisleCapacity: 48e3, plenumCapacity: 120e3, roomCapacity: 240e3,
    envelopeConductance: 300, outdoor: 303.15,
    coolingUnits: 3, coilCapacity: 30e3, setpoint: 291.15, gain: 5000, coolingCapacity: 80e3, failedUnit: 1, failsAt: 900,
    initial: 291.15, inletLimit: 300.15
});

export const rackFlow = (load) => load / constants.designRise;
export const coldAisleFlow = (row) => row.loads.reduce((total, load, j) => total + (1 - constants.recirculation[j]) * rackFlow(load), 0) + bypassFlow(row);
export const bypassFlow = (row) => constants.bypassFraction * row.loads.reduce((total, load) => total + rackFlow(load), 0);
export const unitFlow = () => constants.rows.reduce((total, row) => total + coldAisleFlow(row), 0) / constants.coolingUnits;

export function build() {
    const c = constants;
    const model = createModel('Benchmark: data centre cooling, two rows of racks');
    const air = '#3f6fb0';
    const hotAir = '#c8553d';
    const outdoor = model.node('Outdoors', { type: 'Thermal: ambient', position: [0, 14, 0], color: '#8a8a8a', shape: 'sphere', states: [['temperature', 'Outdoor temperature', c.outdoor, 'K']] });
    const room = model.node('Room return air', { type: 'Air volume', position: [0, 10, 0], color: hotAir, states: [['temperature', 'Return air temperature', c.initial, 'K'], ['envelopeHeat', 'Heat from outdoors', 0, 'J']] });
    const plenum = model.node('Underfloor plenum', { type: 'Air volume', position: [0, -10, 0], color: air, states: [['temperature', 'Supply air temperature', c.initial, 'K']] });
    const units = Array.from({ length: c.coolingUnits }, (_unused, k) => model.node(`Cooling unit ${k + 1}`, { type: 'Cooling unit', position: [-12, 6 - 6 * k, 0], color: '#1baf7a', shape: 'cylinder', states: [
        ['temperature', 'Coil outlet temperature', c.initial, 'K'], ['heatRemoved', 'Heat removed', 0, 'J']
    ] }));
    const capacity = (label, value) => parameter(label, value, 'J/K');
    const flowParameter = (label, value) => parameter(label, value, 'W/K');
    const advect = (name, from, to, flow, toCapacity, color = air) => model.edge(name, from, to, 'temperature', quotient(product('flow', difference('upstream', 'temperature')), 'capacity'), {
        flow: flowParameter('Air flow (ṁ c)', flow), upstream: state(from, 'temperature'), temperature: state(to, 'temperature'), capacity: capacity('Heat capacity', toCapacity)
    }, { color });

    model.edge('Envelope gain', outdoor, room, 'temperature', quotient(product('conductance', difference('outdoorTemperature', 'temperature')), 'capacity'), {
        conductance: parameter('Envelope conductance', c.envelopeConductance, 'W/K'), outdoorTemperature: state(outdoor, 'temperature'), temperature: state(room, 'temperature'), capacity: capacity('Room air heat capacity', c.roomCapacity)
    }, { color: '#8a8a8a' });
    model.edge('Heat from outdoors', outdoor, room, 'envelopeHeat', product('conductance', difference('outdoorTemperature', 'temperature')), {
        conductance: parameter('Envelope conductance', c.envelopeConductance, 'W/K'), outdoorTemperature: state(outdoor, 'temperature'), temperature: state(room, 'temperature')
    }, { color: '#8a8a8a' });

    const flow = unitFlow();
    units.forEach((unit, k) => {
        advect(`Return air into cooling unit ${k + 1}`, room, unit, flow, c.coilCapacity, hotAir);
        const available = k === c.failedUnit
            ? cases(['Less', 't', 'failsAt'], 'coolingCapacity', 'True', 0)
            : 'coolingCapacity';
        const cooling = ['Min', ['Max', sum(product('flow', difference('returnTemperature', 'setpoint')), product('gain', difference('temperature', 'setpoint'))), 0], available];
        const coolingUses = () => ({
            flow: flowParameter('Air flow (ṁ c)', flow), returnTemperature: state(room, 'temperature'), setpoint: parameter('Supply setpoint', c.setpoint, 'K'),
            gain: parameter('Controller gain', c.gain, 'W/K'), temperature: state(unit, 'temperature'), coolingCapacity: parameter('Cooling capacity', c.coolingCapacity, 'W'),
            ...(k === c.failedUnit ? { t: time, failsAt: parameter('Coil fails at', c.failsAt, 's') } : {})
        });
        model.edge(`Coil cooling, unit ${k + 1}`, room, unit, 'temperature', quotient(negate(cooling), 'capacity'), { ...coolingUses(), capacity: capacity('Coil heat capacity', c.coilCapacity) }, { color: '#1baf7a' });
        model.edge(`Heat removed, unit ${k + 1}`, room, unit, 'heatRemoved', cooling, coolingUses(), { color: '#1baf7a' });
        advect(`Supply air from cooling unit ${k + 1}`, unit, plenum, flow, c.plenumCapacity);
    });

    const racks = [];
    c.rows.forEach((row, rowIndex) => {
        const y = rowIndex === 0 ? 4 : -4;
        const cold = model.node(`Row ${row.name} cold aisle`, { type: 'Air volume', position: [0, y - 1.5, 0], color: air, states: [['temperature', 'Cold aisle temperature', c.initial, 'K']] });
        const hot = model.node(`Row ${row.name} hot aisle`, { type: 'Air volume', position: [0, y + 1.5, 0], color: hotAir, states: [['temperature', 'Hot aisle temperature', c.initial, 'K']] });
        advect(`Plenum supply to row ${row.name}`, plenum, cold, coldAisleFlow(row), c.aisleCapacity);
        advect(`Bypass in row ${row.name}`, cold, hot, bypassFlow(row), c.aisleCapacity);
        advect(`Row ${row.name} hot aisle to the room`, hot, room, coldAisleFlow(row), c.roomCapacity, hotAir);
        row.loads.forEach((load, j) => {
            const m = rackFlow(load);
            const r = c.recirculation[j];
            const rack = model.node(`Rack ${row.name}${j + 1}`, { type: 'Server rack', position: [-8 + 2.2 * j, y, 0], color: '#5d7885', states: [
                ['serverTemperature', 'Server temperature', c.initial, 'K'], ['temperature', 'Exhaust air temperature', c.initial, 'K'], ['itEnergy', 'IT energy', 0, 'J']
            ] });
            const boosted = row.boosted.includes(j);
            const itLoad = boosted ? cases(['Less', 't', 'boostAt'], 'designLoad', 'True', product('boost', 'designLoad')) : 'designLoad';
            const loadUses = () => ({ designLoad: parameter('IT load', load, 'W'), ...(boosted ? { t: time, boostAt: parameter('Batch job starts', c.boostAt, 's'), boost: parameter('Batch load factor', c.boost, '') } : {}) });
            model.sourceTerm(rack, 'serverTemperature', quotient(difference(itLoad, product('conductance', difference('serverTemperature', 'temperature'))), 'serverCapacity'), {
                ...loadUses(), conductance: parameter('Server-to-air conductance', c.serverConductance, 'W/K'), serverTemperature: state(rack, 'serverTemperature'), temperature: state(rack, 'temperature'),
                serverCapacity: capacity('Server heat capacity', c.serverCapacity)
            });
            model.sourceTerm(rack, 'temperature', quotient(product('conductance', difference('serverTemperature', 'temperature')), 'airCapacity'), {
                conductance: parameter('Server-to-air conductance', c.serverConductance, 'W/K'), serverTemperature: state(rack, 'serverTemperature'), temperature: state(rack, 'temperature'),
                airCapacity: capacity('Rack air heat capacity', c.rackAirCapacity)
            });
            model.sourceTerm(rack, 'itEnergy', itLoad, loadUses());
            advect(`Cold air into rack ${row.name}${j + 1}`, cold, rack, (1 - r) * m, c.rackAirCapacity);
            advect(`Recirculation into rack ${row.name}${j + 1}`, hot, rack, r * m, c.rackAirCapacity, hotAir);
            advect(`Exhaust of rack ${row.name}${j + 1}`, rack, hot, m, c.aisleCapacity, hotAir);
            racks.push({ rack, cold, hot, row: rowIndex, position: j });
        });
        racks.filter((entry) => entry.row === rowIndex).forEach((entry) => { entry.coldId = cold.stateIds.temperature; entry.hotId = hot.stateIds.temperature; });
    });

    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.25, outputInterval: 10 } });
    // The compared temperatures, in the reference's order: for each rack (row A then B) server and exhaust; each row's cold and hot aisle;
    // the plenum; the room; each cooling unit's coil.
    const rowAisles = c.rows.map((_row, rowIndex) => racks.find((entry) => entry.row === rowIndex));
    const ids = {
        temperatures: [
            ...racks.flatMap(({ rack }) => [rack.stateIds.serverTemperature, rack.stateIds.temperature]),
            ...rowAisles.flatMap(({ cold, hot }) => [cold.stateIds.temperature, hot.stateIds.temperature]),
            plenum.stateIds.temperature, room.stateIds.temperature, ...units.map((unit) => unit.stateIds.temperature)
        ],
        itEnergy: racks.map(({ rack }) => rack.stateIds.itEnergy),
        heatRemoved: units.map((unit) => unit.stateIds.heatRemoved),
        envelopeHeat: room.stateIds.envelopeHeat
    };
    return { document, ids };
}

export const models = { dataCentre: () => build().document };

// The heat capacity of each compared temperature, in the same order.
export function capacities() {
    const c = constants;
    const rackCount = c.rows.reduce((total, row) => total + row.loads.length, 0);
    return [
        ...Array.from({ length: rackCount }, () => [c.serverCapacity, c.rackAirCapacity]).flat(),
        ...c.rows.flatMap(() => [c.aisleCapacity, c.aisleCapacity]), c.plenumCapacity, c.roomCapacity, ...Array.from({ length: c.coolingUnits }, () => c.coilCapacity)
    ];
}

// Each rack's inlet temperature from a sample of the compared temperatures: (1 - r) T_cold + r T_hot of its row.
export function inletTemperatures(sample) {
    const c = constants;
    const rackCount = c.rows.reduce((total, row) => total + row.loads.length, 0);
    const inlets = [];
    let rack = 0;
    c.rows.forEach((row, rowIndex) => {
        const cold = sample[2 * rackCount + 2 * rowIndex];
        const hot = sample[2 * rackCount + 2 * rowIndex + 1];
        row.loads.forEach((_load, j) => {
            inlets.push((1 - c.recirculation[j]) * cold + c.recirculation[j] * hot);
            rack += 1;
        });
    });
    return inlets;
}

// When the hottest rack inlet first crosses the limit, interpolated between samples.
export function crossingTime(times, hottest, limit) {
    for (let k = 1; k < times.length; ++k) {
        if (hottest[k - 1] < limit && hottest[k] >= limit) return times[k - 1] + (limit - hottest[k - 1]) / (hottest[k] - hottest[k - 1]) * (times[k] - times[k - 1]);
    }
    return NaN;
}

const variantOf = (method) => (method === 'rungeKutta4' ? { method: 'rungeKutta4' } : { integration: 'explicit' });
const methodKey = (method) => (method === 'explicit' ? 'Explicit' : 'RungeKutta4');
const kelvinToCelsius = (value) => value - 273.15;

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    if (!data) throw new Error('showcase/dataCentre needs its reference.json (generateReference.py).');
    const c = constants;
    const { ids, document } = build();
    const reference = data.temperatures;
    const heat = capacities();
    const referenceInlets = reference.map(inletTemperatures);
    const referenceHottest = referenceInlets.map((inlets) => Math.max(...inlets));
    const referenceTimes = reference.map((_sample, k) => k * config.run.outputInterval);
    const referenceCrossing = crossingTime(referenceTimes, referenceHottest, c.inletLimit);
    const traces = {};
    for (const method of ['explicit', 'rungeKutta4']) {
        const steps = config.globalTimeSteps[method];
        const errors = [];
        for (const step of steps) {
            const run = engineRun(config.run, { globalTimeStep: step });
            const result = await engine.run(modelPath, variantOf(method), run);
            if (result.times.length !== reference.length) throw new Error('The data centre\'s samples do not match its reference.json.');
            const numeric = trajectory(result, ids.temperatures);
            const metrics = errorMetrics(numeric, reference);
            const inlets = numeric.map(inletTemperatures);
            const inletMetrics = errorMetrics(inlets, referenceInlets);
            const hottest = inlets.map((values) => Math.max(...values));
            const crossing = crossingTime(result.times, hottest, c.inletLimit);
            const value = (id, k) => result.values.get(id)[k];
            const stored = (k) => numeric[k].reduce((total, temperature, index) => total + heat[index] * (temperature - c.initial), 0);
            const booked = (k) => ids.itEnergy.reduce((total, id) => total + value(id, k), 0) + value(ids.envelopeHeat, k) - ids.heatRemoved.reduce((total, id) => total + value(id, k), 0);
            const itTotal = ids.itEnergy.reduce((total, id) => total + value(id, result.times.length - 1), 0);
            const balanceDefect = Math.max(...result.times.map((_t, k) => Math.abs(stored(k) - booked(k)))) / itTotal;
            const removed = ids.heatRemoved.map((id) => value(id, result.times.length - 1));
            const removedError = Math.max(...removed.map((joules, unit) => Math.abs(joules - data.heatRemoved[unit]))) / Math.max(...data.heatRemoved);
            errors.push(metrics.relativeError);
            rows.push(resultRow({
                caseName: 'Every temperature (servers, exhaust, aisles, plenum, room, coils)', model: 'dataCentre', variant: variantOf(method), run, errors: metrics, conservationError: balanceDefect, work: result.work, unit: 'K',
                note: `rack inlets ${inletMetrics.maxAbsError.toExponential(2)} K at most; hottest inlet crosses 27 °C at ${crossing.toFixed(2)} s (reference ${referenceCrossing.toFixed(2)} s); heat removed per unit within ${removedError.toExponential(2)}; conservation = energy-balance defect / IT energy`
            }));
            if (step === config.run.globalTimeStep) {
                traces[method] = { result, numeric, inlets, hottest };
                const name = methodKey(method);
                add(`relativeError${name}`, metrics.relativeError, `Every temperature: largest error relative to range, ${methodName(variantOf(method))}, h = ${step} s`);
                add(`inletError${name}`, inletMetrics.maxAbsError, `Rack inlet temperatures: largest error (K), ${methodName(variantOf(method))}`);
                add(`crossingTimeError${name}`, Math.abs(crossing - referenceCrossing), `When the hottest rack inlet crosses 27 °C, against the reference (s), ${methodName(variantOf(method))}`);
                add(`heatRemovedError${name}`, removedError, `Heat each cooling unit removed over the run, against the reference, relative to the largest, ${methodName(variantOf(method))}`);
                add(`energyBalance${name}`, balanceDefect, `Energy stored against IT heat + envelope gain - heat removed, from Konjugate's own states, relative to the IT energy, ${methodName(variantOf(method))}`);
            }
        }
        const order = observedOrder(steps, errors);
        rows.push(resultRow({ caseName: 'Error order in h', model: 'dataCentre', variant: variantOf(method), observedOrder: order.fitted, note: `pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
        add(`order${methodKey(method)}`, order.fitted, `Observed order of the error in h, ${methodName(variantOf(method))} (fitted over every h)`);
    }
    add('referenceSelfAgreement', referenceAgreement(data.radau, reference), 'The reference (DOP853, rtol 1e-12) against Radau at rtol 1e-9, largest difference relative to each temperature\'s magnitude');
    add('graphSize', document.nodes.length, 'Nodes in the model (racks, aisles, plenum, room, cooling units, outdoors)');

    const times = traces.explicit.result.times.map((t) => t / 60);
    const rackNames = c.rows.flatMap((row) => row.loads.map((_load, j) => `${row.name}${j + 1}`));
    const hottestRack = rackNames[referenceInlets.at(-1).indexOf(Math.max(...referenceInlets.at(-1)))];
    const hottestIndex = rackNames.indexOf(hottestRack);
    plots.push(linePlot({
        id: 'dataCentreInlets', title: 'Data centre: rack inlet temperatures', subtitle: `Batch job at 5 min, cooling unit 2 fails at 15 min; independent Python model against Konjugate, h = ${config.run.globalTimeStep} s`, xLabel: 'Time (min)', yLabel: 'Inlet temperature (°C)',
        series: [
            series(`Reference, hottest rack (${hottestRack})`, 'reference', times, referenceInlets.map((inlets) => kelvinToCelsius(inlets[hottestIndex]))),
            series(`Konjugate, rack ${hottestRack}, explicit Euler`, 'explicit', times, traces.explicit.inlets.map((inlets) => kelvinToCelsius(inlets[hottestIndex]))),
            series(`Konjugate, rack ${hottestRack}, Runge–Kutta 4`, 'rungeKutta4', times, traces.rungeKutta4.inlets.map((inlets) => kelvinToCelsius(inlets[hottestIndex]))),
            series('Reference, rack A4 (mid-row)', 'reference', times, referenceInlets.map((inlets) => kelvinToCelsius(inlets[3]))),
            series('Konjugate, rack A4, explicit Euler', 'semiImplicit', times, traces.explicit.inlets.map((inlets) => kelvinToCelsius(inlets[3]))),
            series('ASHRAE recommended limit, 27 °C', 'guide', times, times.map(() => 27))
        ]
    }));
    const rackCount = rackNames.length;
    plots.push(linePlot({
        id: 'dataCentreAir', title: 'Data centre: supply, aisles and return', subtitle: 'Konjugate (explicit Euler) against the reference', xLabel: 'Time (min)', yLabel: 'Temperature (°C)',
        series: [
            series('Reference, room return', 'reference', times, reference.map((sample) => kelvinToCelsius(sample[2 * rackCount + 5]))),
            series('Room return', 'explicit', times, traces.explicit.numeric.map((sample) => kelvinToCelsius(sample[2 * rackCount + 5]))),
            series('Row B hot aisle', 'semiImplicit', times, traces.explicit.numeric.map((sample) => kelvinToCelsius(sample[2 * rackCount + 3]))),
            series('Underfloor plenum', 'extra', times, traces.explicit.numeric.map((sample) => kelvinToCelsius(sample[2 * rackCount + 4]))),
            series('Reference, row B hot aisle', 'reference', times, reference.map((sample) => kelvinToCelsius(sample[2 * rackCount + 3]))),
            series('Reference, plenum', 'reference', times, reference.map((sample) => kelvinToCelsius(sample[2 * rackCount + 4])))
        ]
    }));
    const power = (id) => {
        const joules = traces.explicit.result.values.get(id);
        return joules.map((value, k) => (k === 0 ? NaN : (value - joules[k - 1]) / config.run.outputInterval / 1000));
    };
    plots.push(linePlot({
        id: 'dataCentreCooling', title: 'Data centre: cooling against IT load', subtitle: 'Average power over each sample interval, from Konjugate\'s energy accounts (explicit Euler)', xLabel: 'Time (min)', yLabel: 'Power (kW)',
        series: [
            series('IT load', 'reference', times.slice(1), ids.itEnergy.map(power).reduce((total, values) => total.map((value, k) => value + values[k])).slice(1)),
            ...ids.heatRemoved.map((id, unit) => series(`Cooling unit ${unit + 1}`, ['explicit', 'semiImplicit', 'extra'][unit], times.slice(1), power(id).slice(1)))
        ]
    }));
    return {
        rows, checks, plots,
        notes: [
            `The model is ${document.nodes.length} nodes and ${document.edges.length} relationships, built as an ordinary project (dataCentre.kjt opens in Konjugate). The reference is the same physics written independently as one vector ODE in Python.`,
            `After the cooling unit fails, the two left can remove 160 kW of the 168 kW load: the hottest rack inlet (${hottestRack}, at the end of a row, where recirculation is greatest) crosses 27 °C at ${(referenceCrossing / 60).toFixed(2)} min in the reference.`
        ]
    };
}
