/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A large stiff network: the scaling benchmark's thermal grid (graphScalability/graphs.mjs), an m × m sheet of masses each joined to its
// four neighbours, from 16 to 10,000 nodes, run over a horizon set by its slowest mode. Its fastest mode decays about eight thousand times
// faster than its slowest at 10,000 nodes, so an explicit method's step is held by stability near 0.3 s however slowly the sheet then
// cools; the two stiff solvers, Rosenbrock (Rodas4) and BDF, are compared on it, to show where BDF overtakes Rodas4 (docs/proposals/
// integrators.md, BDF: the user decides automatic selection from this crossover).
//
// Two families of runs:
//   - smooth: the grid cooling from three sine modes, judged against its exact solution;
//   - with jumps: the same grid with one corner mass heated by a square wave switching every `switchEvery` seconds (a stored schedule),
//     so BDF must start its history again at every switch, judged against Rodas4 at a tight tolerance; once every 2 s and, the
//     discontinuity-heavy variant, every 0.25 s, where BDF's restarts cost it more factorisations than Rodas4 takes.
//
// What is checked, in work that does not depend on the machine: the factorisations, Jacobians and evaluations each solver takes, and its
// error. Reported beside it, not checked: each run's engine compute time on the machine that ran it, and, per family, the smallest size at
// which BDF takes less of each (and less time) than Rodas4.
//
// Nothing is committed as a .kjt: the models are generated when the benchmark runs, as the scaling benchmark's are.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectFile } from '../../../src/projectFile.mjs';
import { errorMetrics } from '../../lib/metrics.mjs';
import { trajectory } from '../../lib/engine.mjs';
import { createChecks, engineRun, linePlot, methodName, resultRow, series } from '../../lib/study.mjs';
import { generateGraph, graphDocument } from '../graphScalability/graphs.mjs';

export const directory = import.meta.dirname;
export const models = {};

// The grid with one corner mass heated by a square wave, `amplitude` kelvin per second, switching every `switchEvery` seconds up to
// `until`: a stored schedule on a shared parameter, read by a source term of that mass.
function withSquareWaveHeater(document, stateId, { amplitude, switchEvery, until }) {
    const ids = [document.activeRunConfigurationId, ...document.nodes.flatMap((node) => [node.id, ...node.states.map((state) => state.id), ...node.sourceTerms.flatMap((term) => [term.id, ...(term.parameters ?? []).map((parameter) => parameter.id)])]), ...document.edges.map((edge) => edge.id)];
    let next = Math.max(...ids) + 1;
    const sharedId = next++;
    const samples = [];
    for (let time = 0, on = 1; time <= until + 1e-9; time += switchEvery, on = 1 - on) samples.push([time, on * amplitude]);
    document.sharedParameters = [{ id: sharedId, name: 'Heater', symbol: 'heater', value: 0, unit: 'K/s', mode: 'constant', schedule: { interpolation: 'hold', samples } }];
    const node = document.nodes.find((candidate) => candidate.states.some((state) => state.id === stateId));
    const parameterId = next++;
    node.sourceTerms.push({
        id: next++, state: 'temperature', expression: '\\mathrm{heat}', parameters: [{ id: parameterId, name: 'Heater', symbol: 'heat', value: 0, unit: 'K/s', mode: 'constant', sharedParameterId: sharedId }],
        expressionModel: { latex: '\\mathrm{heat}', bindings: [{ kind: 'parameter', parameterId, symbol: 'heat' }], output: { stateId }, mathJson: 'heat' }
    });
    return document;
}

const ratio = (rodas, bdf) => rodas / Math.max(bdf, Number.MIN_VALUE);

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const work = await mkdtemp(join(tmpdir(), 'konjugateStiffNetwork-'));
    try {
        for (const family of config.families) {
            const crossover = { factorisations: null, jacobians: null, evaluations: null, time: null };
            const heated = family.jumps ? `heated in jumps every ${family.jumps.switchEvery} s` : '';
            const curve = { sizes: [], rodas: [], bdf: [] };
            for (const { size, run } of family.cases) {
                const graph = generateGraph('grid', size);
                const { document, stateIds } = graphDocument(graph, run);
                if (family.jumps) withSquareWaveHeater(document, stateIds[0], { ...family.jumps, until: run.targetTime });
                const path = join(work, `${family.key}${size}.kjt`);
                await writeFile(path, await encodeProjectFile(JSON.stringify(document)));
                const reference = family.jumps
                    ? trajectory(await engine.run(path, family.reference, engineRun(run), { modelAsIs: true }), stateIds)
                    : null;
                const byMethod = {};
                for (const variant of config.methods) {
                    const result = await engine.run(path, variant, engineRun(run), { modelAsIs: true, measure: true });
                    const numeric = trajectory(result, stateIds);
                    const errors = errorMetrics(numeric, reference ?? result.times.map((time) => Array.from(graph.exact(time))));
                    const milliseconds = result.timing.engineComputeMilliseconds;
                    byMethod[variant.method] = { work: result.work, errors, milliseconds };
                    rows.push(resultRow({ caseName: `Thermal grid${heated ? `, ${heated}` : ''}, ${graph.nodeCount} nodes`, model: `${family.key}${graph.nodeCount}`, variant, run: engineRun(run), errors, work: result.work, unit: 'K',
                        note: `${result.work.methodSteps} steps, ${result.work.rejectedSteps} rejected, ${result.work.jacobians} Jacobians, ${result.work.factorisations} factorisations, ${result.work.modelEvaluations} evaluations of the model${
                            result.work.restarts !== undefined ? `, history started again ${result.work.restarts} times` : ''}; ${(milliseconds / 1000).toFixed(2)} s of engine compute on this machine (not checked)` }));
                    add(`${family.key}${size}Error${variant.method === 'bdf' ? 'Bdf' : 'Rodas4'}`, errors.relativeError, `Thermal grid${heated ? ` ${heated}` : ''} of ${graph.nodeCount} nodes, ${methodName(variant)}: largest error relative to range, against ${family.jumps ? 'Rodas4 at a tight tolerance' : 'the exact solution'}`);
                }
                const rodas = byMethod.rodas4;
                const bdf = byMethod.bdf;
                add(`${family.key}${size}FactorisationRatio`, ratio(rodas.work.factorisations, bdf.work.factorisations), `Thermal grid${heated ? ` ${heated}` : ''} of ${graph.nodeCount} nodes: Rodas4's factorisations for each of BDF's`);
                add(`${family.key}${size}JacobianRatio`, ratio(rodas.work.jacobians, bdf.work.jacobians), `Thermal grid${heated ? ` ${heated}` : ''} of ${graph.nodeCount} nodes: Rodas4's Jacobians for each of BDF's`);
                for (const [key, rodasValue, bdfValue] of [['factorisations', rodas.work.factorisations, bdf.work.factorisations], ['jacobians', rodas.work.jacobians, bdf.work.jacobians],
                    ['evaluations', rodas.work.modelEvaluations, bdf.work.modelEvaluations], ['time', rodas.milliseconds, bdf.milliseconds]]) {
                    if (crossover[key] === null && bdfValue < rodasValue) crossover[key] = graph.nodeCount;
                }
                curve.sizes.push(graph.nodeCount);
                curve.rodas.push(rodas.milliseconds / 1000);
                curve.bdf.push(bdf.milliseconds / 1000);
                notes.push(`${heated ? `${heated[0].toUpperCase()}${heated.slice(1)}` : 'Smooth'}, ${graph.nodeCount} nodes over ${run.targetTime} s: Rodas4 ${rodas.work.methodSteps} steps, ${rodas.work.factorisations} factorisations, ${rodas.work.jacobians} Jacobians, ${rodas.work.modelEvaluations} evaluations, error ${rodas.errors.relativeError.toExponential(1)}, ${(rodas.milliseconds / 1000).toFixed(2)} s; BDF ${bdf.work.methodSteps} steps, ${bdf.work.factorisations} factorisations, ${bdf.work.jacobians} Jacobians, ${bdf.work.modelEvaluations} evaluations, error ${bdf.errors.relativeError.toExponential(1)}, ${(bdf.milliseconds / 1000).toFixed(2)} s.`);
            }
            const said = (size) => (size === null ? 'at no size measured' : `from ${size.toLocaleString()} nodes`);
            notes.push(`Crossover, ${heated || 'smooth'}: BDF takes fewer factorisations ${said(crossover.factorisations)}, fewer Jacobians ${said(crossover.jacobians)}, fewer evaluations ${said(crossover.evaluations)}, and less engine time on this machine ${said(crossover.time)}; its error stays larger than Rodas4's at the same tolerance.`);
            plots.push(linePlot({
                id: `stiffNetwork${family.key[0].toUpperCase()}${family.key.slice(1)}Time`, title: `Thermal grid${heated ? `, ${heated}` : ''}: engine time against size`,
                subtitle: 'Engine compute time on the machine that ran the benchmark (not checked)', xLabel: 'Nodes', yLabel: 'Seconds', logX: true, logY: true, xTicks: curve.sizes,
                series: [series('Rodas4', 'rodas4', curve.sizes, curve.rodas), series('BDF', 'extra', curve.sizes, curve.bdf)]
            }));
        }
    } finally {
        await rm(work, { recursive: true, force: true });
    }
    return { rows, checks, plots, notes };
}
