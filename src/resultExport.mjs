/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { resultSignalSeries } from './resultSession.mjs';

// Derives the same {signalId, header} pairs the renderer's CSV export builds from a live
// model (node.title/state.label/state.unit), but directly from a parsed project document's raw
// JSON field names (node.name/state.name/state.symbol/state.unit) -- for callers, like the CLI,
// that never hydrate a renderer-side model.
export function projectDocumentSignals(document) {
    return document.nodes.filter((node) => !node.deleted).flatMap((node) => (node.states ?? []).map((state) => ({
        signalId: state.id,
        header: `${node.name} — ${state.name}${state.unit ? ` (${state.unit})` : ''}`
    })));
}

export function csvField(value) {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// series: [{signalId, samples: [{time, value}]}] -- exactly what resultSignalSeries returns,
// whether obtained directly (a CLI, with the full result in hand) or over IPC (the renderer,
// via window.engine.readResultSeries, which just forwards resultSignalSeries's own return
// value). signals: [{signalId, header}], same order as passed to resultSignalSeries.
export function seriesToCsv(series, signals) {
    const sampleCount = Math.max(0, ...series.map((item) => item.samples.length));
    const rows = Array.from({ length: sampleCount }, (_, index) => [
        series.find((item) => item.samples.length)?.samples[index]?.time ?? '',
        ...series.map((item) => item.samples[index]?.value ?? '')
    ]);
    return [['time (s)', ...signals.map((signal) => signal.header)], ...rows]
        .map((row) => row.map(csvField).join(',')).join('\n');
}

// signals: [{signalId, header}]. result: the decoded engine result (has .samples[].states[]).
export function resultSignalsToCsv(result, signals) {
    const series = resultSignalSeries(result, signals.map((signal) => signal.signalId), {
        startTime: 0,
        endTime: Infinity,
        maxPoints: Infinity
    });
    return seriesToCsv(series, signals);
}
