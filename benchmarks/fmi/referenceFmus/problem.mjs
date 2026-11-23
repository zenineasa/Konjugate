/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The FMI Reference FMUs: four FMI 3.0 FMUs published by the Modelica Association (Reference FMUs v0.0.42, fmus/, unchanged), imported
// into Konjugate as the app imports them and compared with FMPy's simulation of the same FMU.
//
//   Dahlquist     x' = -k x, k = 1, x(0) = 1, to 10 s in steps of 0.1 s (its co-simulation steps by forward Euler inside the FMU)
//   VanDerPol     the Van der Pol oscillator, μ = 1, to 20 s in steps of 0.01 s
//   BouncingBall  a ball dropped from 1 m, restitution 0.7, to 3 s in steps of 0.01 s: state events inside the FMU
//   Stair         a counter that steps every second (an Int32 output), to 10 s in steps of 0.2 s
//
// Konjugate imports an FMU as a node whose implementation drives the FMU's co-simulation interface, one fmi3DoStep per global step
// (src/fmiResolver.mjs). FMPy's co-simulation of the same FMU at the same communication step is therefore what an import should give,
// to rounding; FMPy's model exchange with CVODE (rtol 1e-10) measures how far the FMU's own fixed-step solver is from its equations.
//
// Each import is made exactly as the app makes it (install the archive, bind every parameter and output to a state, run) and compared
// with FMPy's co-simulation of the same FMU, output by output, on the outputs the import offers: an FMI 3 <Alias> (BouncingBall's h_ft,
// h in feet) is another name for a variable already compared, and Konjugate does not offer it as a port of its own. The check
// `importedAsPublished` holds the count of FMUs that import and run as published, so a change in it is noticed.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMetrics } from '../../lib/metrics.mjs';
import { repositoryRoot } from '../../lib/engine.mjs';
import { createChecks, linePlot, referenceData, resultRow, series } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const models = {};
export const fmuNames = ['Dahlquist', 'VanDerPol', 'BouncingBall', 'Stair'];
const fmuPath = (name) => join(directory, 'fmus', `${name}.fmu`);

// Imports one FMU exactly as the app does and runs it at its default experiment. Returns { outcome, reason, samples? }.
async function importAndRun(name, entry, workDirectory) {
    const { installFmuArchive } = await import('../../../src/fmuPackage.mjs');
    const { describeInstalledFmuPorts } = await import('../../../src/fmiResolver.mjs');
    const { runWithEngine } = await import('../../../src/engineAdapter.mjs');
    const fmuDirectory = join(workDirectory, name);
    let installed;
    try {
        installed = await installFmuArchive(await readFile(fmuPath(name)), { directory: fmuDirectory, version: '0.0.42' });
    } catch (error) {
        return { outcome: 'refused at install', reason: error.message };
    }
    const ports = await describeInstalledFmuPorts(fmuDirectory, installed.guid, installed.version);
    const startOf = (portName) => installed.description.variables.find((variable) => variable.name === portName)?.start ?? 0;
    let nextId = 10;
    const inputStates = ports.inputs.map((port) => ({ id: ++nextId, name: port.name, symbol: `input${nextId}`, initialValue: startOf(port.name), unit: '' }));
    const outputStates = ports.outputs.map((port) => ({ id: ++nextId, name: port.name, symbol: `output${nextId}`, initialValue: startOf(port.name), unit: '' }));
    const document = {
        format: 'konjugate', version: 1, metadata: { projectName: `Reference FMU ${name}` },
        nodes: [{
            id: 1, name, states: [...inputStates, ...outputStates], numerics: { substepsPerGlobalStep: 1 }, sourceTerms: [],
            implementation: {
                kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version, providerApiVersion: 1,
                bindings: ports.inputs.map((port, index) => ({ key: port.key, kind: 'state', stateId: inputStates[index].id })),
                outputs: ports.outputs.map((port, index) => ({ key: port.key, stateId: outputStates[index].id }))
            }
        }],
        edges: [], runConfigurations: [{ id: 900, globalTimeStep: entry.stepSize, outputInterval: entry.stepSize }], activeRunConfigurationId: 900
    };
    try {
        const run = await runWithEngine(JSON.stringify(document), { targetTime: entry.stopTime, globalTimeStep: entry.stepSize, outputInterval: entry.stepSize, pacing: { mode: 'fastest' } },
            { applicationPath: repositoryRoot, resourcesPath: '', packaged: false, fmuDirectory, disabledFmuKeys: [] });
        if (!run.available) return { outcome: 'did not run', reason: run.error ?? 'the engine was not available' };
        const byName = new Map(ports.outputs.map((port, index) => [port.name, outputStates[index].id]));
        const offered = entry.outputs.map((output, index) => [output, index]).filter(([output]) => byName.has(output));
        const samples = run.result.samples.map((sample) => offered.map(([output]) => sample.states.find((value) => value.stateId === byName.get(output)).value));
        return { outcome: 'ran', samples, offered: offered.map(([, index]) => index), skipped: entry.outputs.filter((output) => !byName.has(output)) };
    } catch (error) {
        return { outcome: error.code === 'FMU_PLATFORM_MISSING' ? 'refused: no binary where Konjugate looks' : 'failed', reason: (error.message ?? String(error)).split('\n').filter((line) => !line.startsWith('    ') && !line.startsWith('#') && line.trim()).at(-1) ?? String(error) };
    }
}

export async function evaluate({ config }) {
    const { add, checks } = createChecks(config.thresholds);
    const rows = [];
    const plots = [];
    const notes = [];
    const data = referenceData(directory);
    if (!data) throw new Error('fmi/referenceFmus needs its reference.json (generateReference.py).');
    const workDirectory = await mkdtemp(join(tmpdir(), 'konjugateReferenceFmus-'));
    let imported = 0;
    try {
        for (const name of fmuNames) {
            const entry = data.fmus[name];
            const digest = createHash('sha256').update(await readFile(fmuPath(name))).digest('hex');
            add(`${name}Unchanged`, digest === entry.sha256 ? 1 : 0, `${name}.fmu is the published Reference FMU (its SHA-256 matches reference.json)`);
            // The FMU's own solver against its equations: FMPy co-simulation against model exchange with CVODE, on the samples both have.
            const shared = Math.min(entry.coSimulation.length, entry.modelExchange.length);
            const ownSolver = errorMetrics(entry.coSimulation.slice(0, shared), entry.modelExchange.slice(0, shared));
            rows.push({ ...resultRow({ caseName: `${name}: FMPy co-simulation against model exchange (CVODE)`, model: `${name}.fmu`, run: { globalTimeStep: entry.stepSize, targetTime: entry.stopTime }, errors: ownSolver, unit: entry.outputs.join(', '),
                note: 'the FMU\'s own fixed-step solver against its equations solved accurately; not Konjugate\'s error' }), method: 'FMPy' });
            add(`${name}OwnSolverError`, ownSolver.relativeError, `${name}: FMPy's co-simulation of the FMU against its model exchange with CVODE, largest error relative to range (the FMU's internal solver)`);
            if (entry.exact) {
                const againstExact = errorMetrics(entry.modelExchange.slice(0, shared), entry.exact.slice(0, shared));
                add(`${name}ModelExchangeAgainstExact`, againstExact.relativeError, `${name}: FMPy's model exchange with CVODE against the closed form, relative to range`);
            }
            const attempt = await importAndRun(name, entry, workDirectory);
            if (attempt.outcome === 'ran') {
                imported += 1;
                const length = Math.min(attempt.samples.length, entry.coSimulation.length);
                const fmpy = entry.coSimulation.map((values) => attempt.offered.map((index) => values[index]));
                // Sample 0 is the state's initial value, before the FMU has reported; compared from the first step on.
                const fidelity = errorMetrics(attempt.samples.slice(1, length), fmpy.slice(1, length));
                rows.push({ ...resultRow({ caseName: `${name}: Konjugate's import against FMPy co-simulation`, model: `${name}.fmu`, run: { globalTimeStep: entry.stepSize, targetTime: entry.stopTime }, errors: fidelity,
                    unit: attempt.offered.map((index) => entry.outputs[index]).join(', '),
                    note: `the same FMU stepped the same way, one fmi3DoStep per global step${attempt.skipped.length ? `; ${attempt.skipped.join(', ')} not compared (an FMI 3 alias, not a port of its own)` : ''}` }), method: 'imported FMU (co-simulation)' });
                add(`${name}ImportAgainstFmpy`, fidelity.maxAbsError, `${name}: Konjugate's import against FMPy's co-simulation of the same FMU, largest difference over every compared output and sample`);
                plots.push(linePlot({
                    id: `referenceFmu${name}`, title: `Reference FMU ${name}: ${entry.outputs[0]}`, subtitle: 'FMPy against Konjugate\'s import of the same FMU', xLabel: 'Time (s)', yLabel: entry.outputs[0],
                    series: [
                        series('FMPy, model exchange (CVODE)', 'reference', entry.times.slice(0, shared), entry.modelExchange.slice(0, shared).map((values) => values[0])),
                        series('FMPy, co-simulation', 'semiImplicit', entry.times.slice(0, length), entry.coSimulation.slice(0, length).map((values) => values[0])),
                        series('Konjugate, imported', 'explicit', entry.times.slice(0, length), attempt.samples.slice(0, length).map((values) => values[0]))
                    ]
                }));
            } else {
                rows.push({ ...resultRow({ caseName: `${name}: Konjugate's import as published`, model: `${name}.fmu`, note: `${attempt.outcome}: ${attempt.reason}` }), method: 'import (FMI 3.0)' });
                notes.push(`${name}: ${attempt.outcome}. ${attempt.reason}`);
            }
        }
    } finally {
        await rm(workDirectory, { recursive: true, force: true });
    }
    add('importedAsPublished', imported, 'Reference FMUs that Konjugate imports and runs as published, of four (held at its current value, so a change to the importer is noticed)');
    const vanDerPol = data.fmus.VanDerPol;
    const bouncing = data.fmus.BouncingBall;
    plots.push(linePlot({
        id: 'referenceFmusFmpy', title: 'Reference FMUs: FMPy\'s co-simulation and model exchange', subtitle: 'What an import should reproduce (co-simulation), and the FMU\'s equations solved accurately (model exchange)', xLabel: 'Time (s)', yLabel: 'Value',
        series: [
            series('VanDerPol x0, model exchange', 'reference', vanDerPol.times, vanDerPol.modelExchange.map((values) => values[0])),
            series('VanDerPol x0, co-simulation', 'semiImplicit', vanDerPol.times, vanDerPol.coSimulation.map((values) => values[0])),
            series('BouncingBall h, model exchange', 'extra', bouncing.times, bouncing.modelExchange.map((values) => values[0])),
            series('BouncingBall h, co-simulation', 'explicit', bouncing.times, bouncing.coSimulation.map((values) => values[0]))
        ]
    }));
    if (imported === fmuNames.length) notes.unshift('Every Reference FMU imports as published and gives FMPy\'s co-simulation of it to the bit. The difference between co-simulation and model exchange (CVODE) is the FMU\'s own fixed-step solver, not Konjugate\'s: a bouncing ball whose bounces fall between communication steps is the largest.');
    return { rows, checks, plots, notes };
}
