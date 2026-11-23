/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A heat exchanger, counterflow and parallel-flow, discretised into segments as a graph.
//
// Hot water (0.5 kg/s, C_h = ṁ c = 2090 W/K, entering at 360 K) and cold water (1 kg/s, C_c = 4180 W/K, entering at 290 K) exchange heat
// through a wall of UA = 4000 W/K, so NTU = UA / C_min = 1.91 and C_r = C_min / C_max = 0.5. Each stream holds its water in N segments
// (20 kg hot, 40 kg cold in all), every segment a node; hot segment k faces cold segment k across UA/N. A stream's segments are joined by
// relationships carrying its enthalpy downstream (upwind: what leaves a segment is at the segment's temperature):
//     M_h c / N · dT_h,k/dt = C_h (T_h,k-1 - T_h,k) + UA/N (T_c,k - T_h,k)
//     M_c c / N · dT_c,k/dt = C_c (T_c,upstream - T_c,k) + UA/N (T_h,k - T_c,k)
// In counterflow the cold stream enters at segment N and leaves at segment 1; in parallel flow it enters at segment 1 beside the hot. An
// inlet node per stream holds its inlet temperature and integrates the enthalpy it carries in, C T_in; an outlet node per stream
// integrates the enthalpy carried out, C T_last. Everything starts at 290 K, and the hot stream's first water at 360 K arrives at t = 0.
//
// References:
//   transient     the model is linear, so it is exact by the matrix exponential, stepped sample to sample
//   steady state  the exact equilibrium of the discretised model (a linear solve), and the effectiveness-NTU relations of the continuous
//                 exchanger, ε = (1 - e^(-NTU (1 - C_r))) / (1 - C_r e^(-NTU (1 - C_r))) for counterflow, (1 - e^(-NTU (1 + C_r))) / (1 + C_r)
//                 for parallel flow. The discretised model's effectiveness approaches ε-NTU as N grows, at first order in 1/N: that
//                 difference is the discretisation's, not the integrator's, and is reported separately.
//   energy        Σ C_seg (T - T(0)) = E_in,h + E_in,c - E_out,h - E_out,c, from Konjugate's own states

import { join } from 'node:path';
import { affineEquilibrium, expm, multiplyVector, scaled } from '../../lib/linearAlgebra.mjs';
import { errorMetrics, observedOrder } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { createModel, difference, parameter, product, quotient, state } from '../../lib/project.mjs';
import { createChecks, engineRun, linePlot, methodName, referenceAgreement, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const constants = Object.freeze({
    specificHeat: 4180,
    hot: { massFlow: 0.5, holdup: 20, inlet: 360 },
    cold: { massFlow: 1.0, holdup: 40, inlet: 290 },
    conductance: 4000,
    initialTemperature: 290,
    segmentCounts: [10, 40]
});
export const arrangements = ['counterflow', 'parallel'];
const modelName = (arrangement, segments) => `${arrangement}${segments}`;
export const modelPath = (arrangement, segments) => join(directory, `${modelName(arrangement, segments)}.kjt`);

const capacityRate = (stream) => constants[stream].massFlow * constants.specificHeat;
const segmentCapacity = (stream, segments) => constants[stream].holdup * constants.specificHeat / segments;
const coldUpstream = (arrangement, segments, k) => (arrangement === 'counterflow' ? (k === segments - 1 ? null : k + 1) : (k === 0 ? null : k - 1));

export function build(arrangement, segments) {
    const model = createModel(`Benchmark: ${arrangement === 'counterflow' ? 'counterflow' : 'parallel-flow'} heat exchanger, ${segments} segments`);
    const streams = {};
    for (const [stream, y, color] of [['hot', 1.5, '#c8553d'], ['cold', -1.5, '#3f6fb0']]) {
        const label = stream === 'hot' ? 'Hot' : 'Cold';
        const inletX = stream === 'hot' || arrangement === 'parallel' ? -2 : segments + 1;
        const outletX = stream === 'hot' || arrangement === 'parallel' ? segments + 1 : -2;
        streams[stream] = {
            inlet: model.node(`${label} inlet`, { type: 'Flow boundary', position: [inletX, y, 0], color, shape: 'sphere', states: [
                ['temperature', 'Inlet temperature', constants[stream].inlet, 'K'], ['energyIn', 'Enthalpy carried in', 0, 'J']
            ] }),
            segments: Array.from({ length: segments }, (_unused, k) => model.node(`${label} segment ${k + 1}`, { type: 'Water segment', position: [k, y, 0], color, states: [
                ['temperature', 'Temperature', constants.initialTemperature, 'K']
            ] })),
            outlet: model.node(`${label} outlet`, { type: 'Flow boundary', position: [outletX, y, 0], color, shape: 'sphere', states: [['energyOut', 'Enthalpy carried out', 0, 'J']] })
        };
    }
    for (const stream of ['hot', 'cold']) {
        const { inlet, segments: nodes, outlet } = streams[stream];
        const flowRate = parameter('Capacity rate (ṁ c)', capacityRate(stream), 'W/K');
        const capacity = parameter('Segment heat capacity', segmentCapacity(stream, segments), 'J/K');
        model.sourceTerm(inlet, 'energyIn', product('flowRate', 'temperature'), { flowRate: parameter('Capacity rate (ṁ c)', capacityRate(stream), 'W/K'), temperature: state(inlet, 'temperature') });
        const order = stream === 'hot' || arrangement === 'parallel' ? nodes.map((_node, k) => k) : nodes.map((_node, k) => segments - 1 - k);
        order.forEach((k, position) => {
            const upstream = position === 0 ? inlet : nodes[order[position - 1]];
            model.edge(`${stream === 'hot' ? 'Hot' : 'Cold'} flow into segment ${k + 1}`, upstream, nodes[k], 'temperature', quotient(product('flowRate', difference('upstreamTemperature', 'temperature')), 'capacity'), {
                flowRate, upstreamTemperature: state(upstream, 'temperature'), temperature: state(nodes[k], 'temperature'), capacity
            }, { color: stream === 'hot' ? '#c8553d' : '#3f6fb0' });
        });
        const last = nodes[order.at(-1)];
        model.edge(`${stream === 'hot' ? 'Hot' : 'Cold'} flow out`, last, outlet, 'energyOut', product('flowRate', 'temperature'), {
            flowRate: parameter('Capacity rate (ṁ c)', capacityRate(stream), 'W/K'), temperature: state(last, 'temperature')
        }, { color: stream === 'hot' ? '#c8553d' : '#3f6fb0' });
    }
    for (let k = 0; k < segments; ++k) {
        for (const [from, to] of [['cold', 'hot'], ['hot', 'cold']]) {
            const source = streams[from].segments[k];
            const target = streams[to].segments[k];
            model.edge(`Wall heat into ${to} segment ${k + 1}`, source, target, 'temperature', quotient(product('wallConductance', difference('otherTemperature', 'temperature')), 'capacity'), {
                wallConductance: parameter('Wall conductance (UA / N)', constants.conductance / segments, 'W/K'), otherTemperature: state(source, 'temperature'), temperature: state(target, 'temperature'),
                capacity: parameter('Segment heat capacity', segmentCapacity(to, segments), 'J/K')
            }, { color: '#8a8a8a' });
        }
    }
    const document = model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 0.0625, outputInterval: 4 } });
    const ids = {
        temperatures: [...streams.hot.segments, ...streams.cold.segments].map((node) => node.stateIds.temperature),
        energyIn: [streams.hot.inlet.stateIds.energyIn, streams.cold.inlet.stateIds.energyIn],
        energyOut: [streams.hot.outlet.stateIds.energyOut, streams.cold.outlet.stateIds.energyOut],
        hotOutlet: streams.hot.segments.at(-1).stateIds.temperature,
        coldOutlet: streams.cold.segments[arrangement === 'counterflow' ? 0 : segments - 1].stateIds.temperature
    };
    return { document, ids };
}

export const models = Object.fromEntries(arrangements.flatMap((arrangement) => constants.segmentCounts.map((segments) => [modelName(arrangement, segments), () => build(arrangement, segments).document])));

// The segment temperatures [T_h,1..N, T_c,1..N] as x' = A x + b.
export function system(arrangement, segments) {
    const size = 2 * segments;
    const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
    const forcing = new Array(size).fill(0);
    const ua = constants.conductance / segments;
    for (const [stream, offset, other] of [['hot', 0, segments], ['cold', segments, 0]]) {
        const rate = capacityRate(stream);
        const capacity = segmentCapacity(stream, segments);
        for (let k = 0; k < segments; ++k) {
            const row = offset + k;
            const upstream = stream === 'hot' ? (k === 0 ? null : k - 1) : coldUpstream(arrangement, segments, k);
            matrix[row][row] -= (rate + ua) / capacity;
            matrix[row][other + k] += ua / capacity;
            if (upstream === null) forcing[row] += rate * constants[stream].inlet / capacity;
            else matrix[row][offset + upstream] += rate / capacity;
        }
    }
    return { matrix, forcing };
}

// The exact transient at uniformly spaced samples: one propagator for the interval, applied sample to sample, about the ambient.
export function transient(arrangement, segments, interval, count) {
    const { matrix, forcing } = system(arrangement, segments);
    const size = matrix.length;
    const offset = constants.initialTemperature;
    const shifted = forcing.map((value, i) => value + matrix[i].reduce((total, entry) => total + entry * offset, 0));
    const augmented = [...matrix.map((row, i) => [...row, shifted[i]]), new Array(size + 1).fill(0)];
    const propagator = expm(scaled(augmented, interval));
    let z = [...new Array(size).fill(0), 1];
    const samples = [z.slice(0, size).map((value) => value + offset)];
    for (let k = 1; k < count; ++k) {
        z = multiplyVector(propagator, z);
        samples.push(z.slice(0, size).map((value) => value + offset));
    }
    return samples;
}

export function effectivenessNtu(arrangement) {
    const cMin = Math.min(capacityRate('hot'), capacityRate('cold'));
    const ratio = cMin / Math.max(capacityRate('hot'), capacityRate('cold'));
    const ntu = constants.conductance / cMin;
    return arrangement === 'counterflow'
        ? (1 - Math.exp(-ntu * (1 - ratio))) / (1 - ratio * Math.exp(-ntu * (1 - ratio)))
        : (1 - Math.exp(-ntu * (1 + ratio))) / (1 + ratio);
}

// Effectiveness from the outlet temperatures: the hot stream is C_min here.
const effectiveness = (hotOutlet) => (constants.hot.inlet - hotOutlet) / (constants.hot.inlet - constants.cold.inlet);
const variantOf = (method) => (method === 'rungeKutta4' ? { method: 'rungeKutta4' } : { integration: 'explicit' });
const methodKey = (method) => (method === 'explicit' ? 'Explicit' : 'RungeKutta4');
const title = (arrangement, segments) => `${arrangement === 'counterflow' ? 'Counterflow' : 'Parallel flow'}, ${segments} segments`;

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const data = referenceData(directory);
    const runFor = (method) => engineRun(config.run, { globalTimeStep: config.globalTimeStep[method] });
    const run = runFor('explicit');
    const sampleCount = Math.round(run.targetTime / run.outputInterval) + 1;
    const epsilonErrors = {};
    const traces = {};
    for (const arrangement of arrangements) {
        const exactEpsilon = effectivenessNtu(arrangement);
        for (const segments of constants.segmentCounts) {
            const { ids } = build(arrangement, segments);
            const exact = transient(arrangement, segments, run.outputInterval, sampleCount);
            const { matrix, forcing } = system(arrangement, segments);
            const equilibrium = affineEquilibrium(matrix, forcing);
            const discreteEpsilon = effectiveness(equilibrium[segments - 1]);
            const capacities = ids.temperatures.map((_id, index) => segmentCapacity(index < segments ? 'hot' : 'cold', segments));
            for (const method of ['explicit', 'rungeKutta4']) {
                const methodRun = runFor(method);
                const result = await engine.run(modelPath(arrangement, segments), variantOf(method), methodRun);
                const numeric = trajectory(result, ids.temperatures);
                const metrics = errorMetrics(numeric, exact);
                const final = numeric.at(-1);
                const steadyStateError = Math.max(...final.map((value, index) => Math.abs(value - equilibrium[index])));
                const konjugateEpsilon = effectiveness(result.values.get(ids.hotOutlet).at(-1));
                const values = result.values;
                // Energy stored against energy carried in less carried out, from Konjugate's own states; relative to the heat exchanged.
                const stored = (k) => numeric[k].reduce((total, value, index) => total + capacities[index] * (value - constants.initialTemperature), 0);
                const net = (k) => ids.energyIn.reduce((total, id) => total + values.get(id)[k], 0) - ids.energyOut.reduce((total, id) => total + values.get(id)[k], 0);
                const exchanged = capacityRate('hot') * (constants.hot.inlet - equilibrium[segments - 1]) * run.targetTime;
                const balanceDefect = Math.max(...result.times.map((_t, k) => Math.abs(stored(k) - net(k)))) / exchanged;
                const name = `${arrangement}${segments}${methodKey(method)}`;
                rows.push(resultRow({
                    caseName: `${title(arrangement, segments)}: segment temperatures`, model: modelName(arrangement, segments), variant: variantOf(method), run: methodRun, errors: metrics,
                    conservationError: balanceDefect, steadyStateError, work: result.work, unit: 'K',
                    note: `ε Konjugate ${konjugateEpsilon.toFixed(6)}, discretised exact ${discreteEpsilon.toFixed(6)}, ε-NTU ${exactEpsilon.toFixed(6)}; conservation = energy-balance defect / heat exchanged`
                }));
                add(`${name}RelativeError`, metrics.relativeError, `${title(arrangement, segments)}: largest transient temperature error relative to range, ${methodName(variantOf(method))}, h = ${methodRun.globalTimeStep} s`);
                add(`${name}SteadyStateError`, steadyStateError, `${title(arrangement, segments)}: final temperatures against the discretised model's exact equilibrium (K), ${methodName(variantOf(method))}`);
                add(`${name}EnergyBalanceDefect`, balanceDefect, `${title(arrangement, segments)}: energy stored against enthalpy in less out, from Konjugate's own states, relative to the heat exchanged, ${methodName(variantOf(method))}`);
                if (method === 'explicit') {
                    epsilonErrors[`${arrangement}${segments}`] = Math.abs(konjugateEpsilon - exactEpsilon);
                    add(`${arrangement}${segments}EffectivenessError`, Math.abs(konjugateEpsilon - exactEpsilon), `${title(arrangement, segments)}: Konjugate's steady effectiveness against ε-NTU (the discretisation error of ${segments} segments)`);
                }
                traces[`${arrangement}${segments}:${method}`] = { result, numeric, exact, equilibrium };
            }
            const independent = data?.steadyStates?.[modelName(arrangement, segments)];
            add(`${arrangement}${segments}ReferenceAgreement`, independent ? referenceAgreement([equilibrium], [independent]) : NaN, `${title(arrangement, segments)}: this equilibrium against SciPy's (reference.json), largest difference relative to the temperatures' magnitude`);
        }
        const [coarse, fine] = constants.segmentCounts;
        add(`${arrangement}EffectivenessErrorRatio`, epsilonErrors[`${arrangement}${coarse}`] / epsilonErrors[`${arrangement}${fine}`], `${title(arrangement, coarse).split(',')[0]}: effectiveness error at ${coarse} segments over that at ${fine}, about ${fine / coarse} for a first-order discretisation`);
        rows.push({ ...resultRow({ caseName: `${title(arrangement, coarse).split(',')[0]}: ε-NTU (continuous)`, model: '', note: `ε = ${exactEpsilon.toFixed(6)}; NTU = ${(constants.conductance / capacityRate('hot')).toFixed(4)}, C_r = 0.5` }), method: 'analytic' });
    }
    if (data) {
        add('effectivenessReferenceAgreement', Math.max(...arrangements.map((arrangement) => Math.abs(effectivenessNtu(arrangement) - data.effectivenessNtu[arrangement]))), 'ε-NTU here against the independent Python evaluation (reference.json)');
        const transientCase = data.transient;
        const ours = transient(transientCase.arrangement, transientCase.segments, transientCase.interval, transientCase.temperatures.length);
        add('transientReferenceAgreement', referenceAgreement(ours, transientCase.temperatures), `${title(transientCase.arrangement, transientCase.segments)}: this exact transient against SciPy's expm at each sample (reference.json)`);
    }

    // The integrator's order on the transient, counterflow with the coarser segmentation.
    const [orderSegments] = constants.segmentCounts;
    const { ids } = build('counterflow', orderSegments);
    for (const method of ['explicit', 'rungeKutta4']) {
        const steps = config.orderGlobalTimeSteps[method];
        const errors = [];
        for (const step of steps) {
            const stepRun = engineRun(config.orderRun, { globalTimeStep: step });
            const result = await engine.run(modelPath('counterflow', orderSegments), variantOf(method), stepRun);
            const exact = transient('counterflow', orderSegments, stepRun.outputInterval, result.times.length);
            errors.push(errorMetrics(trajectory(result, ids.temperatures), exact).relativeError);
        }
        const order = observedOrder(steps, errors);
        rows.push(resultRow({ caseName: `${title('counterflow', orderSegments)}: error order in h`, model: modelName('counterflow', orderSegments), variant: variantOf(method), observedOrder: order.fitted,
            note: `errors ${errors.map((value) => value.toExponential(2)).join(', ')}; pairwise ${order.pairwise.map((value) => value.toFixed(3)).join(', ')}` }));
        add(`transientOrder${methodKey(method)}`, order.fitted, `${title('counterflow', orderSegments)}: observed order of the transient error in h, ${methodName(variantOf(method))} (fitted over every h)`);
    }

    // Plots: the steady profiles of the finer models against the continuous exchanger, and an outlet transient.
    const fine = constants.segmentCounts.at(-1);
    for (const arrangement of arrangements) {
        const { equilibrium, numeric } = traces[`${arrangement}${fine}:explicit`];
        const positions = Array.from({ length: fine }, (_unused, k) => (k + 0.5) / fine);
        const continuous = continuousProfile(arrangement, positions);
        plots.push(linePlot({
            id: `${arrangement}Profile`, title: `${arrangement === 'counterflow' ? 'Counterflow' : 'Parallel flow'}: steady temperatures along the exchanger`, subtitle: `${fine} segments: Konjugate's final state against the discretised equilibrium and the continuous exchanger`, xLabel: 'Position along the exchanger (fraction of its length)', yLabel: 'Temperature (K)',
            series: [
                series('Continuous exchanger, hot', 'reference', positions, continuous.hot),
                series('Continuous exchanger, cold', 'reference', positions, continuous.cold),
                series('Konjugate, hot segments', 'explicit', positions, numeric.at(-1).slice(0, fine)),
                series('Konjugate, cold segments', 'semiImplicit', positions, numeric.at(-1).slice(fine)),
                series('Discretised equilibrium', 'guide', positions, equilibrium.slice(0, fine))
            ]
        }));
    }
    const outlet = traces[`counterflow${constants.segmentCounts[0]}:explicit`];
    const outletRk = traces[`counterflow${constants.segmentCounts[0]}:rungeKutta4`];
    const segmentsCoarse = constants.segmentCounts[0];
    plots.push(linePlot({
        id: 'counterflowOutletTransient', title: `Counterflow, ${segmentsCoarse} segments: outlet temperatures`, subtitle: `Exact (matrix exponential) against Konjugate, h = ${run.globalTimeStep} s (explicit Euler), ${config.globalTimeStep.rungeKutta4} s (Runge–Kutta 4)`, xLabel: 'Time (s)', yLabel: 'Temperature (K)',
        series: [
            series('Exact, hot outlet', 'reference', outlet.result.times, outlet.exact.map((sample) => sample[segmentsCoarse - 1])),
            series('Exact, cold outlet', 'reference', outlet.result.times, outlet.exact.map((sample) => sample[segmentsCoarse])),
            series('Konjugate, hot outlet, explicit Euler', 'explicit', outlet.result.times, outlet.numeric.map((sample) => sample[segmentsCoarse - 1])),
            series('Konjugate, cold outlet, explicit Euler', 'semiImplicit', outlet.result.times, outlet.numeric.map((sample) => sample[segmentsCoarse])),
            series('Konjugate, hot outlet, Runge–Kutta 4', 'rungeKutta4', outletRk.result.times, outletRk.numeric.map((sample) => sample[segmentsCoarse - 1]))
        ]
    }));
    return {
        rows, checks, plots,
        notes: [`The segmented exchanger is a first-order (upwind) discretisation of the continuous one: its steady effectiveness approaches ε-NTU as the segments grow (error ${epsilonErrors[`counterflow${constants.segmentCounts[0]}`].toExponential(2)} at ${constants.segmentCounts[0]} segments, ${epsilonErrors[`counterflow${fine}`].toExponential(2)} at ${fine}, counterflow). That error is the model's, set by how finely it is divided; the integrator reaches the discretised equilibrium to rounding.`]
    };
}

// The continuous exchanger's steady temperatures along its length (x from the hot inlet), by integrating the two linear ODEs exactly.
function continuousProfile(arrangement, positions) {
    const ch = capacityRate('hot');
    const cc = capacityRate('cold');
    const ua = constants.conductance;
    const { hot, cold } = constants;
    // d(T_h)/dx = -UA/C_h (T_h - T_c); d(T_c)/dx = ±UA/C_c (T_h - T_c) (+ for parallel flow, - for counterflow, x from the hot inlet).
    const sign = arrangement === 'parallel' ? 1 : -1;
    const matrix = [[-ua / ch, ua / ch], [sign * ua / cc, -sign * ua / cc]];
    // Parallel: both inlets at x = 0. Counterflow: T_c(1) = cold inlet; find T_c(0) by linearity.
    const at = (start, x) => multiplyVector(expm(scaled(matrix, x)), start);
    let start = [hot.inlet, cold.inlet];
    if (arrangement === 'counterflow') {
        const base = at([hot.inlet, 0], 1)[1];
        const unit = at([0, 1], 1)[1];
        start = [hot.inlet, (cold.inlet - base) / unit];
    }
    const values = positions.map((x) => at(start, x));
    return { hot: values.map((value) => value[0]), cold: values.map((value) => value[1]) };
}
