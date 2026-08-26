/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Regression guard for continuous-time causal inference's one documented limitation: a fitted
// rate is calibrated to a single Euler step at the CSV's own sampling interval, and running
// Konjugate at a much finer step than that drifts -- substantially (see
// docs/causalInference.md's "From a candidate to a real equation" section for the full,
// quantified writeup), but the drift must stay BOUNDED (converge to a finite multiple) rather
// than diverge. That's the property this test actually guards: not "the drift is small" (it
// isn't), but "the drift doesn't blow up" -- which is exactly what would happen if a future
// change broke the self-lag-keeping logic or the rate transform and reintroduced something
// closer to the pre-existing discrete-coefficient-as-rate behavior this feature replaced (that
// approach hits RMS error around 1e18 on this same system; see the session history in
// docs/proposals/causalInference.md and docs/proposals/continuousTimeConversion.md).
//
// Uses the real compiled engine binary (via `infer`), not a reimplementation of the fitting
// logic -- only the forward-simulation step (plain Euler, matching Konjugate's own
// x(t+Δt) = x(t) + rate(x(t))·Δt) is done here in JS, since that's the property under test, not
// Konjugate's own solver (which has its own separate numerical regression tests in this
// directory).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildThermalSystemCsv } from '../fixtures/thermalSystemCsv.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

const MIN_SCORE = 0.5; // matches the "a real reviewer would deselect this" convention used
                        // throughout the causal-inference tests and docs.

// Simulate the 5 downstream columns via the fitted rates, holding the 3 root columns (nothing
// predicts them) to their true historical trajectory. This is not a shortcut -- it's necessary:
// letting every column free-run decays the whole (unforced, noise-free) linear system to ~0
// within the first ~100 rows and it stays there, at which point any two resolutions "agree"
// trivially on predicting zero regardless of whether the transform is working correctly. Holding
// the roots to real, continuously-varying data keeps a genuine signal driving the downstream
// chain for the whole horizon, which is what actually exercises substep sensitivity.
function simulate(rows, columnNames, rate, quadratic, isRoot, substepsPerRow) {
    const n = columnNames.length;
    const index = Object.fromEntries(columnNames.map((name, i) => [name, i]));
    const dt = 1 / substepsPerRow;
    let current = rows[0].slice();
    const sim = [current.slice()];
    for (let row = 1; row < rows.length; row += 1) {
        for (let sub = 0; sub < substepsPerRow; sub += 1) {
            const next = current.slice();
            for (let col = 0; col < n; col += 1) {
                if (isRoot[col]) continue;
                let derivative = 0;
                for (let src = 0; src < n; src += 1) derivative += rate[col][src] * current[src];
                for (const [key, coefficient] of Object.entries(quadratic)) {
                    const [sourceName, targetName] = key.split('->');
                    if (index[targetName] === col) derivative += coefficient * current[index[sourceName]] ** 2;
                }
                next[col] = current[col] + derivative * dt;
            }
            const rowFraction = (sub + 1) / substepsPerRow;
            for (let col = 0; col < n; col += 1) {
                if (isRoot[col]) next[col] = rows[row - 1][col] + (rows[row][col] - rows[row - 1][col]) * rowFraction;
            }
            current = next;
        }
        sim.push(current.slice());
    }
    return sim;
}

function rmsErrorDownstream(sim, rows, isRoot) {
    let sumSquares = 0, count = 0;
    for (let row = 0; row < rows.length; row += 1) {
        for (let col = 0; col < rows[row].length; col += 1) {
            if (isRoot[col]) continue;
            const diff = sim[row][col] - rows[row][col];
            if (!Number.isFinite(diff)) return Infinity;
            sumSquares += diff * diff;
            count += 1;
        }
    }
    return Math.sqrt(sumSquares / count);
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');

const directory = await mkdtemp(join(tmpdir(), 'konjugateContinuousTimeDrift-'));
try {
    const csvContent = buildThermalSystemCsv();
    const inputPath = join(directory, 'thermalSystem.csv');
    const reportPath = join(directory, 'report.json');
    await writeFile(inputPath, csvContent, 'utf8');
    assert.equal(await execute(executable, ['infer', inputPath, '--report', reportPath, '--degrees', '1,2']),
        0, 'infer must succeed on the 8-node thermal system.');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));

    const columnNames = ['ambientTemperature', 'motorLoad', 'solarIrradiance', 'enclosureTemperature',
        'vibrationAmplitude', 'componentTemperature', 'thermalStress', 'fatigueAccumulation'];
    const index = Object.fromEntries(columnNames.map((name, i) => [name, i]));
    const n = columnNames.length;

    const rate = Array.from({ length: n }, () => new Array(n).fill(0));
    const quadratic = {};
    let acceptedEdgeCount = 0;
    for (const edge of report.edges) {
        if (edge.provenance !== 'continuousLagged' || edge.score < MIN_SCORE) continue;
        acceptedEdgeCount += 1;
        const targetIndex = index[edge.targetColumn], sourceIndex = index[edge.sourceColumn];
        for (const term of edge.terms) {
            if (term.degree === 1) rate[targetIndex][sourceIndex] = term.coefficient;
            else if (term.degree === 2) quadratic[`${edge.sourceColumn}->${edge.targetColumn}`] = term.coefficient;
        }
    }
    assert.ok(acceptedEdgeCount >= 8, `Expected at least 8 high-confidence edges on this system, got ${acceptedEdgeCount}.`);
    for (const self of report.selfTerms) rate[index[self.targetColumn]][index[self.targetColumn]] = self.rate;

    const isRoot = columnNames.map((_, col) => rate[col].every((value, source) => source === col || value === 0));
    assert.deepEqual(columnNames.filter((_, i) => isRoot[i]), ['ambientTemperature', 'motorLoad', 'solarIrradiance'],
        'Expected exactly the 3 known root columns to have no accepted incoming structure.');

    const rows = csvContent.trim().split('\n').slice(1).map((line) => line.split(',').slice(1).map(Number));

    const calibratedRms = rmsErrorDownstream(simulate(rows, columnNames, rate, quadratic, isRoot, 1), rows, isRoot);
    const fineRms = rmsErrorDownstream(simulate(rows, columnNames, rate, quadratic, isRoot, 1000), rows, isRoot);

    assert.ok(Number.isFinite(calibratedRms), `Calibrated-resolution (1 substep/row) simulation must stay finite, got ${calibratedRms}.`);
    assert.ok(Number.isFinite(fineRms), `Fine-resolution (1000 substeps/row) simulation must stay finite -- an infinite or NaN result here means the `
        + `substep drift has become unbounded, exactly the failure mode this feature exists to avoid. Got ${fineRms}.`);

    // Sanity bound on the calibrated-resolution error itself, not just its finiteness -- if this
    // is unexpectedly large, the fit or transform (not just its substep sensitivity) has
    // regressed. Generous relative to the actually-observed ~0.9 to tolerate normal variation.
    assert.ok(calibratedRms < 5, `Calibrated-resolution RMS error is unexpectedly large (${calibratedRms}) -- `
        + 'the fit or the rate transform may have regressed independent of substep sensitivity.');

    // The actual property under test: fine-substep drift stays a BOUNDED multiple of the
    // calibrated-resolution error, not an unbounded blowup. Empirically ~6-7x on this system
    // (see docs/causalInference.md); a generous ceiling well above that catches a real regression
    // (a broken transform reintroducing something like the pre-existing ~1e18 divergence would
    // blow this ratio by many orders of magnitude) without being fragile to small legitimate
    // shifts in the fit.
    const driftRatio = fineRms / calibratedRms;
    assert.ok(driftRatio < 50, `Fine-resolution drift ratio (${driftRatio.toFixed(2)}x calibrated-resolution error) exceeds the bounded-drift `
        + 'ceiling of 50x -- this is the regression this test exists to catch.');

    console.log(`✓ continuous-time drift stays bounded: calibrated RMS ${calibratedRms.toFixed(4)}, `
        + `1000-substep RMS ${fineRms.toFixed(4)} (${driftRatio.toFixed(2)}x)`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
