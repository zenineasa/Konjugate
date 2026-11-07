/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A tuning objective written as a program (docs/proposals/tuningEditorsAndPrograms.md, step 4), through the real engine:
//
//   - The Tank Calibration fit written as a Python program, and as a C++ program, each finds the true values, as the expression and
//     the squared error do: a program is one more kind of the engine's RunMeasure.
//   - A program that crashes on its first trial fails that trial only: it is started again and the fit goes on.
//   - A program that hangs past its time limit fails that trial only, the same way.
//   - A C++ program that does not compile stops the fit before any simulation, in the compiler's words.
//   - A limit can be a number the program reports beside its objective: held to it, the fit settles on the limit, away from the
//     unlimited best; a name the program never reports fails the trials, saying what it did report; and a reported number cannot
//     be limited when the objective is not a program.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/objectiveProgram.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fitWithEngine } from '../../src/engineAdapter.mjs';
import { decodeProjectFile } from '../../src/projectFile.mjs';
import { objectiveTemplate, objectiveTemplateIds } from '../../src/objectiveTemplates.mjs';
import { tankCalibration } from '../../scripts/generateTankCalibrationExample.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const engineParentDirectory = dirname(dirname(executable));
const engineOptions = basename(engineParentDirectory) === 'out'
    ? { applicationPath: dirname(engineParentDirectory), resourcesPath: '', packaged: false }
    : { applicationPath: '', resourcesPath: engineParentDirectory, packaged: true };
const python = ['python3', 'python'].find((candidate) => spawnSync(candidate, ['--version']).status === 0);

const project = await decodeProjectFile(await readFile(join(root, 'examples', 'tankCalibration.kjt')));
const csv = await readFile(join(root, 'examples', 'tankCalibrationMeasured.csv'), 'utf8');
const { timeStep, targetTime, truth } = tankCalibration;
const bindings = [{ key: 'temperature', kind: 'state', id: 2 }, { key: 'measured', kind: 'measured', column: 'tankTemperature' }];
const fit = (program, extra = {}) => fitWithEngine(project, csv, {
    backend: 'nlopt-bobyqa', maxIterations: 300,
    objective: { program: { bindings, ...program }, direction: 'minimise', targetTime, timeStep, variables: [], constraints: [], ...extra }
}, engineOptions);
const recovers = (report, label) => {
    const value = (parameterId) => report.finalParameters.find((entry) => entry.parameterId === parameterId).value;
    assert.ok(Math.abs(value(20) / truth.capacitance - 1) < 0.02, `${label}: capacitance ${value(20)}, truth ${truth.capacitance}.`);
    assert.ok(Math.abs(value(10) / truth.heatLoss - 1) < 0.02, `${label}: heat loss ${value(10)}, truth ${truth.heatLoss}.`);
};

const directory = await mkdtemp(join(tmpdir(), 'konjugateObjectiveProgram-'));
try {
    if (python) {
        const pythonSource = `def objective(run):
    simulated = run.series("temperature")
    measured = run.series("measured")
    return sum((s - m) ** 2 for s, m in zip(simulated, measured))
`;
        const { report } = await fit({ language: 'python', source: pythonSource });
        recovers(report, 'The Python objective');
        assert.equal(report.failedTrials, 0);

        // Crashes on the first trial only (it leaves a mark the first time), then behaves: one failed trial, and the fit goes on.
        const mark = join(directory, 'crashed');
        const crashing = `import os
def objective(run):
    if not os.path.exists(${JSON.stringify(mark)}):
        open(${JSON.stringify(mark)}, "w").close()
        os._exit(3)
    simulated = run.series("temperature")
    measured = run.series("measured")
    return sum((s - m) ** 2 for s, m in zip(simulated, measured))
`;
        const crashed = await fit({ language: 'python', source: crashing });
        assert.equal(crashed.report.failedTrials, 1, 'Only the trial the program crashed on failed.');
        recovers(crashed.report, 'After a crash');

        // Hangs on the first trial past its one-second limit, then behaves.
        const hangMark = join(directory, 'hung');
        const hanging = `import os, time
def objective(run):
    if not os.path.exists(${JSON.stringify(hangMark)}):
        open(${JSON.stringify(hangMark)}, "w").close()
        time.sleep(30)
    simulated = run.series("temperature")
    measured = run.series("measured")
    return sum((s - m) ** 2 for s, m in zip(simulated, measured))
`;
        const started = performance.now();
        const hung = await fit({ language: 'python', source: hanging, timeoutSeconds: 1 });
        assert.equal(hung.report.failedTrials, 1, 'Only the trial the program hung on failed.');
        assert.ok(performance.now() - started < 20000, 'The hang was cut short at its limit, not waited out.');
        recovers(hung.report, 'After a hang');
    } else {
        console.log('The Python objective programs were skipped: no Python on this computer.');
    }

    const cppSource = `#include <konjugate/objectiveProgram.hpp>
double objective(const konjugate::Run& run) {
    const auto& simulated = run.series("temperature");
    const auto& measured = run.series("measured");
    double total = 0;
    for (std::size_t index = 0; index < simulated.size() && index < measured.size(); ++index) {
        const double difference = simulated[index] - measured[index];
        total += difference * difference;
    }
    run.report("rows", static_cast<double>(simulated.size()));
    return total;
}
`;
    const { report: cppReport } = await fit({ language: 'cpp', source: cppSource });
    recovers(cppReport, 'The C++ objective');
    assert.equal(cppReport.failedTrials, 0);

    // Every starter program, in both languages, builds and runs: a few simulations each, none failing.
    for (const id of objectiveTemplateIds) {
        for (const language of python ? ['python', 'cpp'] : ['cpp']) {
            const template = objectiveTemplate(id, language);
            const templateBindings = template.keys.map(({ key, kind }) => (kind === 'measured' ? { key, kind, column: 'tankTemperature' } : { key, kind, id: 2 }));
            const { report } = await fitWithEngine(project, csv, {
                backend: 'nlopt-bobyqa', maxIterations: 4,
                objective: { program: { language, source: template.source, bindings: templateBindings }, direction: 'minimise', targetTime, timeStep, variables: [], constraints: [] }
            }, engineOptions);
            assert.equal(report.failedTrials, 0, `The ${template.label} template in ${language} ran without failing.`);
            assert.ok(Number.isFinite(report.finalLoss), `The ${template.label} template in ${language} gave a number.`);
        }
    }

    // A limit on a number the program reports: the tank's final temperature, about 340.3 K at the best fit, held to at most 338 K.
    const reporting = cppSource.replace('run.report("rows", static_cast<double>(simulated.size()));', 'run.report("final", simulated.back());');
    const limited = await fit({ language: 'cpp', source: reporting }, { constraints: [{ report: 'final', relation: '<=', limit: 338 }] });
    assert.equal(limited.report.failedTrials, 0);
    // The same as the same limit written as an expression: a reported number is limited exactly as a formula is (a penalty, so the fit
    // settles close to the bound rather than on it: here 0.3 % over).
    const asExpression = await fit({ language: 'cpp', source: reporting }, { variables: [{ name: 'tank', kind: 'state', id: 2 }], constraints: [{ expression: 'final(tank)', relation: '<=', limit: 338 }] });
    assert.deepEqual(limited.report.finalParameters, asExpression.report.finalParameters, 'A reported limit and the same limit as an expression give the same fit.');
    assert.ok(limited.report.finalViolation < 0.005, `The fit keeps close to the reported limit: violation ${limited.report.finalViolation}.`);
    const heatLoss = limited.report.finalParameters.find((entry) => entry.parameterId === 10).value;
    assert.ok(heatLoss > truth.heatLoss * 1.02, `Held to a lower final temperature, the tank must lose heat faster than the truth: ${heatLoss} W/K.`);
    const misspelt = await fit({ language: 'cpp', source: reporting }, { constraints: [{ report: 'finale', relation: '<=', limit: 338 }] }).catch((error) => ({ error }));
    assert.ok(misspelt.error ? /finale/.test(misspelt.error.message) : misspelt.report.failedTrials === misspelt.report.evaluations, 'A name the program never reports fails every trial.');
    await assert.rejects(fitWithEngine(project, csv, {
        backend: 'nlopt-bobyqa', maxIterations: 4,
        objective: { expression: 'final(waterTankTankTemperature)', direction: 'minimise', targetTime, timeStep, variables: [{ name: 'waterTankTankTemperature', kind: 'state', id: 2 }], constraints: [{ report: 'final', relation: '<=', limit: 338 }] }
    }, engineOptions), /needs the objective to be that program/, 'Only a program reports numbers to limit.');

    await assert.rejects(fit({ language: 'cpp', source: 'double objective(const konjugate::Run& run) { return run.nonsense(); }' }),
        (error) => /objective/.test(error.message) && /error/.test(error.message), 'A program that does not compile is refused in the compiler\'s words.');
    console.log(`Objective programs: the Python and the C++ objective each find ${truth.capacitance} J/K and ${truth.heatLoss} W/K; a crash and a hang each fail one trial; a compile error is reported before the fit; a limit on a reported number holds (heat loss ${heatLoss.toFixed(2)} W/K to keep the tank at most 338 K).`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
