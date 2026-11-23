/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What every problem's evaluation shares: run a model, compare it with its reference, and describe the result as a row of the results
// table, a named check against the problem's thresholds, and a plot.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { trajectory } from './engine.mjs';
import { errorMetrics } from './metrics.mjs';

export const methodName = (variant = {}) => {
    if (variant.method === 'rungeKutta4') return `Runge–Kutta 4${variant.stepsPerGlobalStep > 1 ? ` (${variant.stepsPerGlobalStep} steps per global step)` : ''}`;
    if (variant.method === 'dormandPrince54') {
        if (variant.stepsPerGlobalStep) return `Dormand–Prince 5(4), error control off (${variant.stepsPerGlobalStep} step${variant.stepsPerGlobalStep > 1 ? 's' : ''} per global step)`;
        return `Adaptive, Dormand–Prince 5(4)${variant.tolerance?.relative ? ` (relative tolerance ${variant.tolerance.relative})` : ''}`;
    }
    return variant.integration === 'semiImplicit' ? 'semi-implicit Euler' : 'explicit Euler';
};

// Runs the model with a variant and compares the chosen states with the reference at the run's own sample times.
export async function runAndCompare(engine, modelPath, variant, run, stateIds, reference) {
    const result = await engine.run(modelPath, variant, run);
    const numeric = trajectory(result, stateIds);
    const exact = reference(result.times);
    return { result, numeric, exact, ...errorMetrics(numeric, exact) };
}

// A row of the results table. Columns a problem does not measure stay empty.
export function resultRow({ caseName, model, variant = {}, run, errors = {}, conservationError = null, steadyStateError = null, observedOrder = null, work = {}, unit = '', note = '' }) {
    return {
        case: caseName,
        model,
        method: methodName(variant),
        globalTimeStep: run?.globalTimeStep ?? null,
        substeps: variant.substeps ?? 1,
        targetTime: run?.targetTime ?? null,
        maxAbsError: errors.maxAbsError ?? null,
        rmse: errors.rmse ?? null,
        relativeError: errors.relativeError ?? null,
        conservationError,
        steadyStateError,
        observedOrder,
        globalSteps: work.globalSteps ?? null,
        substepsExecuted: work.substeps ?? null,
        evaluations: work.evaluations ?? null,
        unit,
        note
    };
}

// The problem's committed numerical reference data (written by benchmarks/reference/generateReferences.py), when it has one.
export function referenceData(directory) {
    const path = join(directory, 'reference.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// Collects a problem's checks: each value is judged against the threshold of the same name in its benchmark.json, which must exist.
export function createChecks(thresholds) {
    const checks = [];
    return {
        checks,
        add(name, value, description) {
            const limit = thresholds[name];
            if (!limit) throw new Error(`benchmark.json has no threshold named ${name}.`);
            const pass = Number.isFinite(value) || value === Infinity
                ? (limit.max === undefined || value <= limit.max) && (limit.min === undefined || value >= limit.min)
                : false;
            checks.push({ name, description, value, limit, pass });
        }
    };
}

// A line plot: series of [x, y] points. role picks the series' fixed colour and dash, so a method looks the same in every plot.
export function linePlot({ id, title, subtitle = '', xLabel, yLabel, logX = false, logY = false, xTicks = null, series }) {
    return { id, title, subtitle, xLabel, yLabel, logX, logY, ...(xTicks ? { xTicks } : {}), series };
}

export const series = (name, role, xs, ys) => ({ name, role, points: xs.map((x, index) => [x, ys[index]]) });

// The engine's run fields from a benchmark.json section, with any overridden.
export function engineRun(section, overrides = {}) {
    const merged = { ...section, ...overrides };
    return { globalTimeStep: merged.globalTimeStep, targetTime: merged.targetTime, outputInterval: merged.outputInterval };
}

// How closely two independently computed references agree: per column, the largest absolute difference divided by the column's largest
// magnitude in `independent`; the largest over the columns. Columns in joules and in kelvin are judged alike.
export function referenceAgreement(computed, independent) {
    if (computed.length !== independent.length) return Infinity;
    let largest = 0;
    independent[0].forEach((_unused, column) => {
        const scale = Math.max(...independent.map((sample) => Math.abs(sample[column])));
        const difference = Math.max(...independent.map((sample, row) => Math.abs(sample[column] - computed[row][column])));
        largest = Math.max(largest, scale > 0 ? difference / scale : difference);
    });
    return largest;
}
