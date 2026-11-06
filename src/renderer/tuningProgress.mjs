/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Parameter tuning card shows while a fit runs (docs/proposals/parameterTuningObjectives.md): the numbers, the estimate, the
// warnings and the convergence plot, all worked out from the progress events the engine sends (one per simulation; see
// FittingProgressEvent in protocol/engineProtocol.proto). Pure functions, so they are checked without a window.

export const noImprovementWindow = 50;

// "850 ms", "12.4 s", "2 min 40 s", "1 h 05 min": as short as is still readable at that size.
export function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    // Nothing at all is 0 s (a live twin's first window starts there); anything more, however little, is at least 1 ms.
    if (seconds === 0) return '0 s';
    if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))} ms`;
    if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
    const rounded = Math.round(seconds);
    const minutes = Math.floor(rounded / 60);
    if (minutes < 60) return `${minutes} min ${String(rounded % 60).padStart(2, '0')} s`;
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

// A loss to a few significant digits, or "—" when it is not a number.
export function formatLoss(value) {
    return Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : '—';
}

// The cost of one simulation is how long the starting values took, which the engine reports as the first event. `limits` are what the
// person chose: at most `simulations`, and/or `seconds`. Says only what is known: with no limit it does not guess an end.
export function estimateText(events, { simulations = null, seconds = null } = {}) {
    const first = events[0];
    if (!first?.baseline) return '';
    const each = first.elapsedSeconds;
    let text = `One simulation takes ${formatDuration(each)}`;
    if (simulations > 0) {
        const total = each * simulations;
        text += seconds > 0 && seconds < total
            ? `, so ${simulations} simulations would take ${formatDuration(total)}; your ${formatDuration(seconds)} limit ends it first.`
            : `, so up to ${simulations} simulations is about ${formatDuration(total)}.`;
    } else if (seconds > 0) {
        text += `, so about ${Math.max(1, Math.round(seconds / Math.max(each, 1e-9)))} simulations fit in your ${formatDuration(seconds)} limit.`;
    } else {
        text += '.';
    }
    return text;
}

// Everything the numbers beside the plot need.
// `maximize` flips what counts as better: the values are always the objective as written, so they rise when maximising.
export function summarizeTuning(events, { simulations = null, seconds = null, maximize = false } = {}) {
    if (!events.length) return null;
    const first = events[0];
    const last = events.at(-1);
    const baselineLoss = first.loss;
    const bestLoss = last.bestLoss;
    // Simulations since the best last got meaningfully better: a tiny wobble in the last digits is not progress.
    const direction = maximize ? -1 : 1;
    let sinceImprovement = 0;
    for (let index = events.length - 1; index > 0; index -= 1) {
        const before = events[index - 1].bestLoss;
        if (direction * (before - events[index].bestLoss) > Math.abs(before) * 1e-9) break;
        sinceImprovement += 1;
    }
    const finiteBaseline = Number.isFinite(baselineLoss) && baselineLoss !== 0;
    const progress = simulations > 0 ? Math.min(1, last.iteration / simulations) : seconds > 0 ? Math.min(1, last.elapsedSeconds / seconds) : null;
    const remaining = progress !== null && progress > 0 && progress < 1 && last.iteration > 2
        ? (last.elapsedSeconds * (1 - progress)) / progress : null;
    return {
        simulations: last.iteration,
        failedTrials: last.failedTrials,
        elapsedSeconds: last.elapsedSeconds,
        simulationsPerSecond: last.elapsedSeconds > 0 ? last.iteration / last.elapsedSeconds : 0,
        baselineLoss,
        bestLoss,
        // How much better the best is than where it started, as a fraction (0.38 is 38% lower, or higher when maximising); null when it started at nothing.
        improvement: finiteBaseline && Number.isFinite(bestLoss) ? (direction * (baselineLoss - bestLoss)) / Math.abs(baselineLoss) : null,
        sinceImprovement,
        progress,
        remainingSeconds: remaining,
        bestParameterValues: last.bestParameterValues,
        // The most any limit is broken by in the best simulation so far, relative to the limit (0 when none is, or there are none).
        bestViolation: last.bestViolation ?? 0
    };
}

// Plain sentences for what a person should know about, nothing when all is well.
export function tuningWarnings(summary) {
    if (!summary) return [];
    const warnings = [];
    if (summary.failedTrials > 0) {
        warnings.push(`${summary.failedTrials} simulation${summary.failedTrials === 1 ? '' : 's'} failed: the model was unstable or errored with those values. They count as the worst result and the search goes on.`);
    }
    if (summary.bestViolation > 1e-3) {
        warnings.push(`The best so far still breaks a limit by ${(summary.bestViolation * 100).toFixed(summary.bestViolation >= 0.1 ? 0 : 1)}%. Breaking one is penalised, so the search is working to bring it back inside.`);
    }
    if (summary.sinceImprovement >= noImprovementWindow) {
        warnings.push(`No improvement in the last ${summary.sinceImprovement} simulations. It may have found the best it can: you can stop and use the best so far.`);
    }
    return warnings;
}

// The two traces of the convergence plot: a dot per simulation (failed ones are left out, since they score a stand-in value) and the
// best so far as a line. x is the simulation number.
export function convergenceTraces(events) {
    const scored = events.filter((event) => !event.failed);
    return {
        attempts: { x: scored.map((event) => event.iteration), y: scored.map((event) => event.loss) },
        best: { x: events.map((event) => event.iteration), y: events.map((event) => event.bestLoss) }
    };
}
