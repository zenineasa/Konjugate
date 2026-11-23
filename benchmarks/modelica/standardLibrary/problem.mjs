/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Four examples from the Modelica Standard Library (MSL 4.1.0), rebuilt as Konjugate graphs and compared with the Modelica Association's
// published reference results and with each example's exact solution.
//
//   twoMasses     Modelica.Thermal.HeatTransfer.Examples.TwoMasses: two 15 J/K masses at 100 °C and 0 °C joined by a 10 W/K conductor.
//                 Two nodes, two relationships; the same equations as the Modelica model.
//   cauerLowPass  Modelica.Electrical.Analog.Examples.CauerLowPassAnalog: a fifth-order Cauer (elliptic) low-pass ladder, R1 = R2 = 1 Ω,
//                 L1 ∥ C2 and L2 ∥ C4 in series, C1, C3, C5 to ground, driven by a 1 V step at 1 s, for 60 s. Modelling difference:
//                 Konjugate has no acausal network solver, and C2 and C4 join two node voltages, so the node equations are C dv/dt = q
//                 with a capacitance matrix C; the matrix is inverted here, by hand, and its entries written as the relationships'
//                 coefficients. The states are the three node voltages (C1.v, C3.v, C5.v) and the two inductor currents.
//   first         Modelica.Mechanics.Rotational.Examples.First: a motor (0.1 kg m²) driven by 10 sin(2π 5 t) N m through an ideal gear
//                 of ratio 10 into an inertia of 2 kg m² with a bearing damper (10 N m s/rad), a spring of 10⁴ N m/rad and a load of
//                 2 kg m². Modelling difference: the ideal gear is a rigid constraint, which a Modelica tool removes by index reduction;
//                 here it is removed by hand, the motor's inertia reflected through the gear (2 + 10² · 0.1 = 12 kg m²) and its torque
//                 multiplied by the ratio. Compared: damper.phi_rel = -φ₂, damper.w_rel = -ω₂, inertia3.phi, inertia3.w.
//   oscillator    Modelica.Mechanics.Translational.Examples.Oscillator: two 1 kg masses on 10⁴ N/m springs driven at resonance by
//                 sin(2π 15.9155 t) N, the second with a 10 N s/m damper. The masses' positions are their centres, the springs act at
//                 their flanges half a metre away, as in the Modelica model. Undamped resonance makes the first mass's amplitude grow
//                 without bound, the hardest case here for a first-order method.
//
// The published results were made by Dymola 2020x with DASSL at a tolerance of 1e-6; they are themselves accurate to between 1e-5 and
// 5e-4 of each signal's range (measured against the exact solutions, which are linear and solved by the matrix exponential), so they bound
// how closely any simulator can be shown to agree with them. reference.json keeps every fourth published sample (every fifth for the
// filter), with the extra rows Dymola writes at events dropped (generateReference.py).

import { join } from 'node:path';
import { expm, multiplyVector, scaled, solve } from '../../lib/linearAlgebra.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { cases, createModel, difference, negate, parameter, product, quotient, state, sum, time } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = (name) => join(directory, `${name}.kjt`);

export const constants = Object.freeze({
    twoMasses: { capacity: 15, conductance: 10, initial: [373.15, 273.15] },
    cauerLowPass: { l1: 1.304, l2: 0.8586, c1: 1.072, c2: 1 / (1.704992 ** 2 * 1.304), c3: 1.682, c4: 1 / (1.179945 ** 2 * 0.8586), c5: 0.7262, r1: 1, r2: 1, stepAt: 1, stepVoltage: 1 },
    first: { amplitude: 10, frequency: 5, motorInertia: 0.1, loadInertia: 2, ratio: 10, damping: 10, gearInertia: 2, stiffness: 1e4 },
    oscillator: { mass: 1, stiffness: 10000, damping: 10, frequency: 15.9155, rest: -0.5 }
});

// The Cauer ladder's node capacitance matrix and its inverse.
export function cauerInverseCapacitance() {
    const { c1, c2, c3, c4, c5 } = constants.cauerLowPass;
    const matrix = [[c1 + c2, -c2, 0], [-c2, c2 + c3 + c4, -c4], [0, -c4, c4 + c5]];
    const columns = solve(matrix, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    return columns;
}

function buildTwoMasses() {
    const c = constants.twoMasses;
    const model = createModel('Benchmark: MSL Thermal.HeatTransfer.Examples.TwoMasses');
    const masses = c.initial.map((initial, index) => model.node(`mass${index + 1}`, { type: 'Heat capacitor', position: [index * 4, 0, 0], color: '#c8553d', states: [['temperature', 'Temperature (T)', initial, 'K']] }));
    for (const [from, to] of [[masses[1], masses[0]], [masses[0], masses[1]]]) {
        model.edge(`conduction into ${to.document.name}`, from, to, 'temperature', quotient(product('conductance', difference('otherTemperature', 'temperature')), 'capacity'), {
            conductance: parameter('Thermal conductance (G)', c.conductance, 'W/K'), otherTemperature: state(from, 'temperature'), temperature: state(to, 'temperature'), capacity: parameter('Heat capacity (C)', c.capacity, 'J/K')
        }, { color: '#c8553d' });
    }
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.0005, outputInterval: 0.002 } }), ids: masses.map((node) => node.stateIds.temperature), map: (values) => values };
}

function buildCauer() {
    const c = constants.cauerLowPass;
    const inverse = cauerInverseCapacitance();
    const model = createModel('Benchmark: MSL Electrical.Analog.Examples.CauerLowPassAnalog');
    const source = model.node('V (step voltage)', { type: 'Voltage source', position: [-4, 0, 0], color: '#d98b54', shape: 'sphere', states: [['amplitude', 'Step height (V)', c.stepVoltage, 'V']] });
    const network = model.node('Node voltages (C1, C3, C5)', { type: 'Capacitor network', color: '#3f6fb0', states: [['v1', 'C1.v', 0, 'V'], ['v2', 'C3.v', 0, 'V'], ['v3', 'C5.v', 0, 'V']] });
    const inductors = [['L1', c.l1, [-2, 3, 0]], ['L2', c.l2, [2, 3, 0]]].map(([name, , position]) => model.node(name, { type: 'Inductor', position, color: '#3f6fb0', states: [['current', `${name}.i`, 0, 'A']] }));
    const voltages = ['v1', 'v2', 'v3'];
    const entry = (k, j) => parameter(`Inverse capacitance (node ${k + 1}, node ${j + 1})`, inverse[k][j], '1/F');
    voltages.forEach((voltage, k) => {
        // Own currents: through R1 from node 1 (its v1 / R1 part) and through R2 from node 3.
        model.sourceTerm(network, voltage, negate(sum(product('inverse13', quotient('v1', 'r1')), product('inverse33', quotient('v3', 'r2')))), {
            inverse13: entry(k, 0), v1: state(network, 'v1'), r1: parameter('R1', c.r1, 'Ω'), inverse33: entry(k, 2), v3: state(network, 'v3'), r2: parameter('R2', c.r2, 'Ω')
        });
        model.edge(`V through R1 into node ${k + 1}`, source, network, voltage, product('inverse', quotient(cases(['Less', 't', 'stepAt'], 0, 'True', 'amplitude'), 'r1')), {
            inverse: entry(k, 0), t: time, stepAt: parameter('V.startTime', c.stepAt, 's'), amplitude: state(source, 'amplitude'), r1: parameter('R1', c.r1, 'Ω')
        }, { color: '#d98b54' });
        // L1 carries current from node 1 to node 2; L2 from node 2 to node 3.
        model.edge(`L1 current at node ${k + 1}`, inductors[0], network, voltage, product(difference('inverseTo', 'inverseFrom'), 'current'), {
            inverseTo: entry(k, 1), inverseFrom: entry(k, 0), current: state(inductors[0], 'current')
        });
        model.edge(`L2 current at node ${k + 1}`, inductors[1], network, voltage, product(difference('inverseTo', 'inverseFrom'), 'current'), {
            inverseTo: entry(k, 2), inverseFrom: entry(k, 1), current: state(inductors[1], 'current')
        });
    });
    [['v1', 'v2', c.l1], ['v2', 'v3', c.l2]].forEach(([from, to, inductance], index) => {
        model.edge(`Voltage across ${index ? 'L2' : 'L1'}`, network, inductors[index], 'current', quotient(difference(from, to), 'inductance'), {
            [from]: state(network, from), [to]: state(network, to), inductance: parameter(index ? 'L2' : 'L1', inductance, 'H')
        });
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.00375, outputInterval: 0.06 } }), ids: [network.stateIds.v1, network.stateIds.v2, network.stateIds.v3, inductors[0].stateIds.current, inductors[1].stateIds.current], map: (values) => values };
}

function buildFirst() {
    const c = constants.first;
    const reflected = c.gearInertia + c.ratio ** 2 * c.motorInertia;
    const model = createModel('Benchmark: MSL Mechanics.Rotational.Examples.First');
    const motor = model.node('torque (sine source)', { type: 'Torque source', position: [-4, 0, 0], color: '#d98b54', shape: 'sphere', states: [['amplitude', 'Torque amplitude', c.amplitude, 'N m']] });
    const gearSide = model.node('inertia2, with inertia1 through idealGear', { type: 'Inertia', color: '#5d7885', shape: 'cylinder', states: [['angle', 'inertia2.phi', 0, 'rad'], ['speed', 'inertia2.w', 0, 'rad/s']] });
    const load = model.node('inertia3', { type: 'Inertia', position: [4, 0, 0], color: '#5d7885', shape: 'cylinder', states: [['angle', 'inertia3.phi', 0, 'rad'], ['speed', 'inertia3.w', 0, 'rad/s']] });
    for (const node of [gearSide, load]) model.sourceTerm(node, 'angle', 'speed', { speed: state(node, 'speed') });
    model.edge('Motor torque through the gear', motor, gearSide, 'speed', quotient(product('ratio', 'amplitude', ['Sin', product('angularFrequency', 't')]), 'inertia'), {
        ratio: parameter('Gear ratio', c.ratio, ''), amplitude: state(motor, 'amplitude'), angularFrequency: parameter('Angular frequency (2π f)', 2 * Math.PI * c.frequency, 'rad/s'), t: time,
        inertia: parameter('Inertia, with the motor reflected', reflected, 'kg m²')
    }, { color: '#d98b54' });
    model.sourceTerm(gearSide, 'speed', quotient(negate(product('damping', 'speed')), 'inertia'), {
        damping: parameter('Bearing damping', c.damping, 'N m s/rad'), speed: state(gearSide, 'speed'), inertia: parameter('Inertia, with the motor reflected', reflected, 'kg m²')
    });
    for (const [from, to, inertia] of [[load, gearSide, reflected], [gearSide, load, c.loadInertia]]) {
        model.edge(`spring torque on ${to.document.name.split(',')[0]}`, from, to, 'speed', quotient(product('stiffness', difference('otherAngle', 'angle')), 'inertia'), {
            stiffness: parameter('Spring stiffness', c.stiffness, 'N m/rad'), otherAngle: state(from, 'angle'), angle: state(to, 'angle'), inertia: parameter('Inertia', inertia, 'kg m²')
        }, { color: '#5d7885' });
    }
    return {
        document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.0000625, outputInterval: 0.002 } }),
        ids: [gearSide.stateIds.angle, gearSide.stateIds.speed, load.stateIds.angle, load.stateIds.speed],
        map: ([phi2, w2, phi3, w3]) => [-phi2, -w2, phi3, w3]
    };
}

function buildOscillator() {
    const c = constants.oscillator;
    const model = createModel('Benchmark: MSL Mechanics.Translational.Examples.Oscillator');
    const nodes = [1, 2].map((index) => {
        const force = model.node(`force${index} (sine source)`, { type: 'Force source', position: [-4, index * 3, 0], color: '#d98b54', shape: 'sphere', states: [['amplitude', 'Force amplitude', 1, 'N']] });
        const mass = model.node(`mass${index}`, { type: 'Sliding mass', position: [0, index * 3, 0], color: '#5d7885', states: [['position', `mass${index}.s`, c.rest, 'm'], ['velocity', `mass${index}.v`, 0, 'm/s']] });
        model.sourceTerm(mass, 'position', 'velocity', { velocity: state(mass, 'velocity') });
        // The spring is relaxed with the mass's centre at -0.5 m (flange at 0, the fixed end at 1 m, unstretched length 1 m).
        model.sourceTerm(mass, 'velocity', quotient(negate(product('stiffness', difference('position', 'rest'))), 'mass'), {
            stiffness: parameter(`spring${index}.c`, c.stiffness, 'N/m'), position: state(mass, 'position'), rest: parameter('Rest position of the centre', c.rest, 'm'), mass: parameter(`mass${index}.m`, c.mass, 'kg')
        });
        if (index === 2) {
            model.sourceTerm(mass, 'velocity', quotient(negate(product('damping', 'velocity')), 'mass'), { damping: parameter('damper1.d', c.damping, 'N s/m'), velocity: state(mass, 'velocity'), mass: parameter('mass2.m', c.mass, 'kg') });
        }
        model.edge(`force${index} on mass${index}`, force, mass, 'velocity', quotient(product('amplitude', ['Sin', product('angularFrequency', 't')]), 'mass'), {
            amplitude: state(force, 'amplitude'), angularFrequency: parameter('Angular frequency (2π f)', 2 * Math.PI * c.frequency, 'rad/s'), t: time, mass: parameter(`mass${index}.m`, c.mass, 'kg')
        }, { color: '#d98b54' });
        return mass;
    });
    return {
        document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.0000625, outputInterval: 0.002 } }),
        ids: nodes.flatMap((node) => [node.stateIds.position, node.stateIds.velocity]),
        map: ([s1, v1, s2, v2]) => [s1, v1, 0.5 - s2, -v2]
    };
}

const builders = { twoMasses: buildTwoMasses, cauerLowPass: buildCauer, first: buildFirst, oscillator: buildOscillator };
export const models = Object.fromEntries(Object.entries(builders).map(([name, build]) => [name, () => build().document]));

// Exact solutions, in the compared signals.
function linear(matrix, forcing, start, times, begin = 0) {
    const size = start.length;
    const augmented = [...matrix.map((row, i) => [...row, forcing[i]]), new Array(size + 1).fill(0)];
    return times.map((t) => (t > begin ? multiplyVector(expm(scaled(augmented, t - begin)), [...start, 1]).slice(0, size) : [...start]));
}

export const exact = {
    twoMasses(times) {
        const { capacity: c, conductance: g, initial } = constants.twoMasses;
        return linear([[-g / c, g / c], [g / c, -g / c]], [0, 0], initial, times);
    },
    cauerLowPass(times) {
        const c = constants.cauerLowPass;
        const inverse = cauerInverseCapacitance();
        const q = [[-1 / c.r1, 0, 0, -1, 0], [0, 0, 0, 1, -1], [0, 0, -1 / c.r2, 0, 1]];
        const matrix = [0, 1, 2].map((k) => [0, 1, 2, 3, 4].map((j) => inverse[k].reduce((total, value, m) => total + value * q[m][j], 0)));
        matrix.push([1 / c.l1, -1 / c.l1, 0, 0, 0], [0, 1 / c.l2, -1 / c.l2, 0, 0]);
        const forcing = [...[0, 1, 2].map((k) => inverse[k][0] * c.stepVoltage / c.r1), 0, 0];
        return linear(matrix, forcing, [0, 0, 0, 0, 0], times, c.stepAt);
    },
    first(times) {
        const c = constants.first;
        const j = c.gearInertia + c.ratio ** 2 * c.motorInertia;
        const w = 2 * Math.PI * c.frequency;
        const matrix = [
            [0, 1, 0, 0, 0, 0], [-c.stiffness / j, -c.damping / j, c.stiffness / j, 0, c.ratio * c.amplitude / j, 0],
            [0, 0, 0, 1, 0, 0], [c.stiffness / c.loadInertia, 0, -c.stiffness / c.loadInertia, 0, 0, 0],
            [0, 0, 0, 0, 0, w], [0, 0, 0, 0, -w, 0]
        ];
        return linear(matrix, new Array(6).fill(0), [0, 0, 0, 0, 0, 1], times).map(([phi2, w2, phi3, w3]) => [-phi2, -w2, phi3, w3]);
    },
    oscillator(times) {
        const c = constants.oscillator;
        const w = 2 * Math.PI * c.frequency;
        const k = c.stiffness / c.mass;
        const matrix = [[0, 1, 0, 0, 0, 0], [-k, 0, 0, 0, 1 / c.mass, 0], [0, 0, 0, 1, 0, 0], [0, 0, -k, -c.damping / c.mass, 1 / c.mass, 0], [0, 0, 0, 0, 0, w], [0, 0, 0, 0, -w, 0]];
        return linear(matrix, [0, k * c.rest, 0, k * c.rest, 0, 0], [c.rest, 0, c.rest, 0, 0, 1], times).map(([s1, v1, s2, v2]) => [s1, v1, 0.5 - s2, -v2]);
    }
};

const titles = { twoMasses: 'TwoMasses', cauerLowPass: 'CauerLowPassAnalog', first: 'Rotational First', oscillator: 'Translational Oscillator' };
const variantOf = (method) => ({ explicit: { integration: 'explicit' }, semiImplicit: { integration: 'semiImplicit' }, rungeKutta4: { method: 'rungeKutta4' } })[method];
const methodKey = (method) => ({ explicit: 'Explicit', semiImplicit: 'SemiImplicit', rungeKutta4: 'RungeKutta4' })[method];

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    if (!data) throw new Error('modelica/standardLibrary needs its reference.json (generateReference.py).');
    for (const [name, build] of Object.entries(builders)) {
        const published = data.examples[name];
        const settings = config.examples[name];
        const { ids, map } = build();
        const exactSamples = exact[name](published.times);
        const publishedAgainstExact = errorMetrics(published.values, exactSamples);
        rows.push({ ...resultRow({ caseName: `${titles[name]}: published result against exact`, model: name, errors: publishedAgainstExact, unit: published.signals.join(', '),
            note: `${published.generationTool}, DASSL, tolerance ${published.tolerance}: the published reference's own error` }), method: 'published (Dymola)' });
        add(`${name}PublishedAccuracy`, publishedAgainstExact.relativeError, `${titles[name]}: the published reference against the exact solution, largest error relative to range (how far it can be trusted)`);
        add(`${name}ExactAgreement`, referenceAgreement(exactSamples, published.exact), `${titles[name]}: this exact solution against SciPy's (reference.json)`);
        const traces = {};
        for (const method of settings.methods) {
            const run = engineRun({ targetTime: published.times.at(-1), outputInterval: published.interval, globalTimeStep: settings.globalTimeStep[method] });
            const result = await engine.run(modelPath(name), variantOf(method), run);
            if (result.times.length !== published.times.length || result.times.some((t, k) => Math.abs(t - published.times[k]) > 1e-9 * Math.max(1, t))) {
                throw new Error(`${name}: Konjugate's samples are not at the published results' times.`);
            }
            const numeric = trajectory(result, ids).map(map);
            const againstPublished = errorMetrics(numeric, published.values);
            const againstExact = errorMetrics(numeric, exactSamples);
            traces[method] = numeric;
            rows.push(resultRow({
                caseName: `${titles[name]}: against the published result`, model: name, variant: variantOf(method), run, errors: againstPublished, work: result.work, unit: published.signals.join(', '),
                note: `against the exact solution ${againstExact.relativeError.toExponential(2)} of range`
            }));
            add(`${name}Published${methodKey(method)}`, againstPublished.relativeError, `${titles[name]}: Konjugate against the published reference, largest error relative to range, ${methodName(variantOf(method))}, h = ${run.globalTimeStep} s`);
            add(`${name}Exact${methodKey(method)}`, againstExact.relativeError, `${titles[name]}: Konjugate against the exact solution, largest error relative to range, ${methodName(variantOf(method))}`);
        }
        // Each method's order, from its own steps, against the exact solution.
        for (const method of Object.keys(settings.orderSteps ?? {})) {
            const steps = settings.orderSteps[method];
            const errors = [];
            for (const step of steps) {
                const result = await engine.run(modelPath(name), variantOf(method), engineRun({ targetTime: published.times.at(-1), outputInterval: published.interval, globalTimeStep: step }));
                errors.push(errorMetrics(trajectory(result, ids).map(map), exactSamples).relativeError);
            }
            const order = observedOrder(steps, errors);
            rows.push(resultRow({ caseName: `${titles[name]}: error order in h`, model: name, variant: variantOf(method), observedOrder: order.fitted, note: `errors ${errors.map((value) => value.toExponential(2)).join(', ')}; pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
            add(`${name}Order${methodKey(method)}`, order.fitted, `${titles[name]}: observed order of the error against the exact solution in h, ${methodName(variantOf(method))} (fitted over every h)`);
        }
        const signal = settings.plotSignal;
        plots.push(linePlot({
            id: `msl${name[0].toUpperCase()}${name.slice(1)}`, title: `MSL ${published.modelName.replace('Modelica.', '')}: ${published.signals[signal]}`,
            subtitle: `The Modelica Association's published result (${published.generationTool.split(' (')[0]}) against Konjugate`, xLabel: 'Time (s)', yLabel: published.signals[signal],
            series: [
                series('Published reference (Dymola, DASSL)', 'reference', published.times, published.values.map((values) => values[signal])),
                ...settings.methods.map((method) => series(`Konjugate, ${methodName(variantOf(method))}`, method === 'semiImplicit' ? 'semiImplicit' : method, published.times, traces[method].map((values) => values[signal])))
            ]
        }));
    }
    return {
        rows, checks, plots,
        notes: [
            'The published results are accurate to between 1e-5 and 5e-4 of each signal\'s range (DASSL at a tolerance of 1e-6); Runge–Kutta 4 agrees with the exact solutions far more closely than that, so its agreement with the published results is the published results\' own error.',
            'The Cauer filter is driven by a step at 1 s, a condition on time in its equation, which Runge–Kutta 4 locates and steps to (docs/proposals/integrators.md, Event location): it keeps its fourth order on this example, as on the other three.',
            'Two modelling differences: Konjugate has no acausal network solver or index reduction, so the Cauer filter\'s capacitance matrix is inverted by hand, and the drive train\'s rigid ideal gear is removed by hand by reflecting the motor\'s inertia through it. Both give the same equations the Modelica tool derives; neither is automatic in Konjugate.'
        ]
    };
}
