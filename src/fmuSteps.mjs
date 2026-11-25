/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The steps a run takes an FMU in, checked before the run (docs/proposals/fmuImportWorkflow.md, stage 6). A node's FMU takes one
// communication step per substep of the node: the global step divided by the node's substeps. An FMU that says it steps by a fixed
// internal step (FMI 3.0's fixedInternalStepSize) is exact only for a communication step that is a whole number of those; some FMUs
// refuse any other (Konjugate's own exports do), others approximate the remainder. So such a step is said, with the global step
// that fixes it for every FMU, or, when no global step fits them all, the FMUs that disagree. Nothing is changed unless asked.
//
// Each FMU node is { name, fmuName, substeps, internalStep } (internalStep a number of seconds, or none). Returns
// { problems: [{ name, fmuName, step, internalStep }], fix: { globalTimeStep, outputInterval } | null, disagree: [names] }.

const tolerance = 1e-9;

// A number as a person reads it: 0.3, not 0.30000000000000004.
export function stepNumber(value) {
    return Number(Number(value).toPrecision(12));
}

export function wholeNumberOf(step, internalStep) {
    if (!(step > 0) || !(internalStep > 0)) return true;
    const ratio = step / internalStep;
    return ratio >= 1 - tolerance && Math.abs(ratio - Math.round(ratio)) <= tolerance * Math.max(1, ratio);
}

export function fmuStepCheck({ globalTimeStep, outputInterval }, fmuNodes) {
    const checked = fmuNodes.filter((node) => node.internalStep > 0);
    const stepOf = (node, global) => global / Math.max(1, node.substeps ?? 1);
    const problems = checked
        .filter((node) => !wholeNumberOf(stepOf(node, globalTimeStep), node.internalStep))
        .map((node) => ({ name: node.name, fmuName: node.fmuName, step: stepNumber(stepOf(node, globalTimeStep)), internalStep: node.internalStep }));
    if (!problems.length) return { problems, fix: null, disagree: [] };
    // Candidates: for each FMU node, the global step that makes its step the nearest whole number of its own. The one closest to
    // the run's own that suits every FMU is offered.
    const candidates = [...new Set(checked.map((node) => {
        const count = Math.max(1, Math.round(stepOf(node, globalTimeStep) / node.internalStep));
        return stepNumber(count * node.internalStep * Math.max(1, node.substeps ?? 1));
    }))].filter((candidate) => checked.every((node) => wholeNumberOf(stepOf(node, candidate), node.internalStep)))
        .sort((a, b) => Math.abs(a - globalTimeStep) - Math.abs(b - globalTimeStep));
    if (!candidates.length) return { problems, fix: null, disagree: checked.map((node) => node.name) };
    const step = candidates[0];
    const intervals = Math.max(1, Math.round((outputInterval > 0 ? outputInterval : step) / step));
    return { problems, fix: { globalTimeStep: step, outputInterval: stepNumber(intervals * step) }, disagree: [] };
}

// What the Run dialog says of it: a sentence per FMU node whose step does not fit, and the fix, or who disagrees.
export function fmuStepSentences(check) {
    const lines = check.problems.map((problem) => `${problem.fmuName === problem.name ? `'${problem.name}'` : `The FMU in '${problem.name}'`} steps by ${problem.internalStep} s inside; this run steps it by ${problem.step} s, which is not a whole number of its steps. Some FMUs refuse that (Konjugate's own exports do); others approximate.`);
    if (check.disagree.length) lines.push(`No one global step suits every FMU here (${check.disagree.map((name) => `'${name}'`).join(', ')}): give one of them more substeps (Numerics tab), or choose the step yourself.`);
    return lines;
}

// The run a model's FMU suggests (its default experiment): { name, stopTime, stepSize } from the first FMU node that says either,
// or null.
export function fmuRunSuggestion(fmuNodes) {
    for (const node of fmuNodes) {
        const experiment = node.defaultExperiment ?? {};
        const stopTime = Number.isFinite(experiment.stopTime) && experiment.stopTime > (experiment.startTime ?? 0) ? experiment.stopTime : null;
        const stepSize = Number.isFinite(experiment.stepSize) && experiment.stepSize > 0 ? experiment.stepSize : null;
        if (stopTime !== null || stepSize !== null) return { name: node.name, stopTime, stepSize };
    }
    return null;
}
