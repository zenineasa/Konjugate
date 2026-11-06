/* Copyright © 2026 Zenin Easa Panthakkalakath */

// branchLabel is undefined for every caller comparing nothing (the overwhelmingly common single-
// branch inspector view) -- it only matters to ResultPlot.render's branch-coloring path below,
// which only activates once more than one distinct label is actually present in a render() call.
export function nodeResultSeries(result, node, branchLabel) {
    if (!result?.samples?.length || !node?.states?.length) return [];
    const samplesByState = new Map(node.states.map((state) => [state.id, []]));
    result.samples.forEach((sample) => {
        sample.states.forEach((state) => samplesByState.get(state.stateId)?.push({
            time: Number(sample.time),
            value: Number(state.value)
        }));
    });
    return node.states.map((state) => ({
        nodeId: node.id,
        stateId: state.id,
        name: state.label,
        symbol: state.symbol,
        unit: state.unit ?? '',
        samples: samplesByState.get(state.id) ?? [],
        ...(branchLabel !== undefined ? { branchLabel } : {})
    })).filter((series) => series.samples.length);
}

// Same field-reading convention as nodeResultSeries() above, but keyed directly by an explicit
// list of state ids rather than one node's states -- useful when the states of interest span
// multiple nodes, as a digital-twin tuning CSV's mapped columns generally do.
export function resultSeriesForStateIds(result, stateIds) {
    const samplesByState = new Map(stateIds.map((id) => [id, []]));
    if (!result?.samples?.length) return samplesByState;
    result.samples.forEach((sample) => {
        sample.states.forEach((state) => samplesByState.get(state.stateId)?.push({
            time: Number(sample.time),
            value: Number(state.value)
        }));
    });
    return samplesByState;
}

export function nearestSampleIndex(samples, time) {
    if (!samples.length) return -1;
    let low = 0;
    let high = samples.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Number(samples[middle].time) < time) low = middle + 1;
        else high = middle;
    }
    if (low === 0) return 0;
    return Math.abs(Number(samples[low].time) - time) < Math.abs(Number(samples[low - 1].time) - time)
        ? low : low - 1;
}

export function paddedRange(values, paddingRatio = 0.08) {
    const finiteValues = values.map(Number).filter(Number.isFinite);
    if (!finiteValues.length) return undefined;
    const minimum = Math.min(...finiteValues);
    const maximum = Math.max(...finiteValues);
    const span = maximum - minimum;
    const padding = span
        ? span * paddingRatio
        : Math.max(Math.abs(minimum) * paddingRatio, 1);
    return [minimum - padding, maximum + padding];
}


import { isPhoneLayout } from './phoneLayout.mjs';

// A plot narrower than this is a phone's: a legend of a node's nine states, laid out as it is for a desktop, fills the whole plot, and the
// toolbar's buttons are bigger than the curves they sit on.
const narrowPlotWidth = 460;


// Whether a plot in `element` is a phone's. A plot is drawn while its panel may still be hidden, when it measures no width at all, so the
// phone layout stands in for the width it cannot read.
export function isNarrowPlot(element) {
    const width = element.clientWidth;
    return width ? width < narrowPlotWidth : isPhoneLayout();
}

// Lays `layout` and `config` out for a phone: the legend is left to chips under the plot (a legend of a node's nine states, laid out by
// Plotly in a plot this narrow, is a column that fills it); dragging pans (a finger is not a mouse's box-select); the toolbar is left off;
// and the extra y axes (one per unit, drawn on the right) keep their curves but not their tick labels, which at a phone's width pile on
// top of one another.
export function fitPlotToNarrowScreen(layout, config) {
    layout.showlegend = false;
    layout.margin = { ...layout.margin, t: 12, b: 38, r: 14 };
    layout.dragmode = 'pan';
    config.displayModeBar = false;
    for (const key of Object.keys(layout)) {
        if (/^yaxis[2-9]$/.test(key)) layout[key] = { ...layout[key], showticklabels: false, title: undefined };
    }
}

// One chip per curve under a narrow plot: its colour, its name, and a tap that shows or hides the curve.
const chipColors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

export class ResultPlot {
    constructor(element, { onSeek } = {}) {
        this.element = element;
        this.onSeek = onSeek;
        this.rendered = false;
    }

    // branchColors: Map<branchLabel, hex> -- only consulted when more than one distinct
    // branchLabel is present across series (the N-way branch comparison overlay); a single-branch
    // render (every existing caller) is byte-identical to before this parameter existed, since
    // series items with no branchLabel never populate more than one entry in branchLabels below.
    // `traces` as Plotly was given them; none removes the chips.
    drawChipLegend(traces) {
        this.chips?.remove();
        this.chips = null;
        if (!traces.length || !this.element.parentNode) return;
        const chips = document.createElement('div');
        chips.className = 'plotChips';
        traces.forEach((trace, index) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'plotChip';
            chip.setAttribute('aria-pressed', 'true');
            const swatch = document.createElement('i');
            swatch.style.background = trace.line?.color ?? chipColors[index % chipColors.length];
            chip.append(swatch, trace.name);
            chip.addEventListener('click', () => {
                const shown = chip.getAttribute('aria-pressed') !== 'true';
                chip.setAttribute('aria-pressed', String(shown));
                globalThis.Plotly.restyle(this.element, { visible: shown }, [index]);
            });
            chips.append(chip);
        });
        this.element.after(chips);
        this.chips = chips;
    }

    async render(series, currentTime = 0, { branchColors } = {}) {
        if (!globalThis.Plotly) throw new Error('Plotly.js is unavailable.');
        const units = [...new Set(series.map((item) => item.unit || 'Value'))];
        const times = series.flatMap((item) => item.samples.map((sample) => sample.time));
        const branchLabels = new Set(series.map((item) => item.branchLabel).filter(Boolean));
        const colorByBranch = branchLabels.size > 1 ? branchColors : null;
        const traces = series.map((item) => ({
            type: 'scatter',
            mode: 'lines',
            name: colorByBranch ? `${item.symbol} (${item.branchLabel})` : item.symbol,
            x: item.samples.map((sample) => sample.time),
            y: item.samples.map((sample) => sample.value),
            yaxis: units.indexOf(item.unit || 'Value') ? `y${units.indexOf(item.unit || 'Value') + 1}` : 'y',
            line: { width: 2, ...(colorByBranch ? { color: colorByBranch.get(item.branchLabel) } : {}) },
            hovertemplate: `${item.name}${colorByBranch ? ` (${item.branchLabel})` : ''}<br>%{y:.6g} ${item.unit}<br>t = %{x:.6g} s<extra></extra>`
        }));
        const layout = {
            autosize: true,
            margin: { l: 48, r: Math.max(18, 42 * (units.length - 1)), t: 42, b: 38 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(7,15,21,.52)',
            font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 9 },
            hovermode: 'x unified',
            showlegend: true,
            legend: {
                orientation: 'h', x: 0, y: 1.08, yanchor: 'bottom',
                tracegroupgap: 8,
                itemclick: 'toggle',
                itemdoubleclick: 'toggleothers'
            },
            xaxis: { title: 'Time (s)', range: paddedRange(times, 0.04), gridcolor: '#1d303a', zerolinecolor: '#2b414c' },
            shapes: [this.cursorShape(currentTime)]
        };
        units.forEach((unit, index) => {
            const key = index ? `yaxis${index + 1}` : 'yaxis';
            layout[key] = {
                title: unit,
                range: paddedRange(series
                    .filter((item) => (item.unit || 'Value') === unit)
                    .flatMap((item) => item.samples.map((sample) => sample.value))),
                gridcolor: index ? 'rgba(0,0,0,0)' : '#1d303a',
                zerolinecolor: '#2b414c',
                ...(index ? { overlaying: 'y', side: 'right', anchor: 'free', position: Math.max(.74, 1 - (index - 1) * .08) } : {})
            };
        });
        const config = { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };
        if (isNarrowPlot(this.element)) {
            // With the axes' labels gone, the unit is what says which axis a curve is read against.
            if (units.length > 1) traces.forEach((trace, index) => { trace.name = `${trace.name} (${series[index].unit || 'Value'})`; });
            fitPlotToNarrowScreen(layout, config);
        }
        await globalThis.Plotly.react(this.element, traces, layout, config);
        this.drawChipLegend(isNarrowPlot(this.element) ? traces : []);
        this.element.removeAllListeners?.('plotly_click');
        this.element.on?.('plotly_click', (event) => {
            const time = Number(event.points?.[0]?.x);
            if (Number.isFinite(time)) this.onSeek?.(time);
        });
        this.rendered = true;
    }

    cursorShape(time) {
        return {
            type: 'line', x0: time, x1: time, y0: 0, y1: 1, yref: 'paper',
            line: { color: '#62e1d5', width: 1.5, dash: 'dot' }
        };
    }

    setCursor(time) {
        if (!this.rendered) return;
        globalThis.Plotly.relayout(this.element, { shapes: [this.cursorShape(time)] });
    }

    clear() {
        if (this.rendered) globalThis.Plotly?.purge(this.element);
        this.drawChipLegend([]);
        this.rendered = false;
    }
}

// Konjugate's own validated categorical slots 1 (blue) and 2 (orange) -- see the dataviz skill's
// reference palette, dark-mode column, passed through the palette's six-check validator against
// this app's real panel surface (#111d27): worst adjacent CVD Delta E 9.4, normal-vision 26.5,
// both >= 3:1 contrast. A same-hue lighten/darken pair was tried first and, in real use, wasn't
// distinguishable enough -- two genuinely different hues read far more clearly at a glance.
const simulatedColor = '#3987e5';
const measuredColor = '#d95926';

// A one-shot, static comparison for the digital-twin tuning review step: measured versus
// simulated (with the just-fitted parameter values applied) for each mapped signal, plus a
// residual (simulated - measured) sub-trace on its own subplot underneath. Deliberately a plain
// function rather than a ResultPlot method -- ResultPlot's seek/cursor interaction and its
// unit-grouped secondary-axis stacking exist for the main live-run view, neither of which this
// static, review-only comparison needs; every mapped signal shares one axis per subplot here
// instead, which keeps this simple for the common case of a handful of mapped signals rather than
// risking an under-tested multi-axis layout for a first version.
//
// Color now carries *measured vs. simulated* (fixed blue/orange, consistent across every entry),
// not which signal -- reinforcing the dotted/solid distinction rather than a separate per-signal
// identity. That's a deliberate trade: with more than one mapped entry, color no longer
// disambiguates *which* signal is which (every entry's simulated line is blue, every measured
// line is orange) -- the legend/hover still do, via each label carrying the entry's name (see
// labelFor) whenever there's more than one entry, but two entries plotted close together are only
// told apart by that label, not by hue. Revisit with small multiples if that turns out to matter
// in practice; today's real usage is one mapped signal at a time.
//
// entries: [{ name, unit, times: number[], measured: number[], simulated: number[], tolerance? }] -- times,
// measured and simulated must already be the same length and index-paired per entry. An entry with a
// `tolerance` (a replayed data log's) also draws it either side of zero on the residual, so the
// stretches where the model was out of step can be seen. `simulatedLabel` names the model's line.
export async function renderMeasuredVsSimulatedComparison(element, entries, { simulatedLabel = 'Simulated' } = {}) {
    if (!globalThis.Plotly) throw new Error('Plotly.js is unavailable.');
    const labelFor = (entry, kind) => (entries.length > 1 ? `${entry.name}: ${kind}` : kind);
    const traces = entries.flatMap((entry) => {
        const unitSuffix = entry.unit ? ` ${entry.unit}` : '';
        const span = entry.times.length ? [entry.times[0], entry.times.at(-1)] : [];
        const band = entry.tolerance > 0 ? [entry.tolerance, -entry.tolerance].map((level) => ({
            type: 'scatter', mode: 'lines', name: `${entry.name} tolerance`, showlegend: false, hoverinfo: 'skip',
            x: span, y: span.map(() => level), xaxis: 'x2', yaxis: 'y2',
            line: { width: 1, dash: 'dash', color: measuredColor }
        })) : [];
        return [
            ...band,
            // Simulated is listed first and Measured second so Plotly, which draws traces in
            // array order (later = on top), draws the dotted measured line on top of the solid
            // simulated one -- with the reverse order the solid line was covering the dots
            // wherever the two nearly overlapped. legendrank keeps the legend itself reading
            // Measured-then-Simulated (ground truth first) independent of this draw order.
            {
                type: 'scatter', mode: 'lines', name: labelFor(entry, simulatedLabel), legendrank: 2,
                x: entry.times, y: entry.simulated,
                line: { width: 2, color: simulatedColor },
                hovertemplate: `${entry.name} ${simulatedLabel.toLowerCase()}<br>%{y:.6g}${unitSuffix}<br>t = %{x:.6g} s<extra></extra>`
            },
            {
                type: 'scatter', mode: 'lines', name: labelFor(entry, 'Measured'), legendrank: 1,
                x: entry.times, y: entry.measured,
                line: { width: 2, dash: 'dot', color: measuredColor },
                hovertemplate: `${entry.name} measured<br>%{y:.6g}${unitSuffix}<br>t = %{x:.6g} s<extra></extra>`
            },
            {
                type: 'scatter', mode: 'lines', name: `${entry.name} residual`, showlegend: false,
                x: entry.times, y: entry.times.map((_, sampleIndex) => entry.simulated[sampleIndex] - entry.measured[sampleIndex]),
                xaxis: 'x2', yaxis: 'y2',
                line: { width: 2, color: simulatedColor },
                hovertemplate: `${entry.name} residual<br>%{y:.6g}${unitSuffix}<br>t = %{x:.6g} s<extra></extra>`
            }
        ];
    });
    const allTimes = entries.flatMap((entry) => entry.times);
    const layout = {
        autosize: true,
        margin: { l: 48, r: 18, t: 34, b: 34 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(7,15,21,.52)',
        font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 9 },
        hovermode: 'x unified',
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.14, yanchor: 'bottom', tracegroupgap: 12 },
        xaxis: { range: paddedRange(allTimes, 0.04), gridcolor: '#1d303a', zerolinecolor: '#2b414c', anchor: 'y', automargin: true },
        xaxis2: { matches: 'x', gridcolor: '#1d303a', zerolinecolor: '#2b414c', anchor: 'y2', automargin: true },
        yaxis: { domain: [0.32, 1], gridcolor: '#1d303a', zerolinecolor: '#2b414c', automargin: true },
        yaxis2: { domain: [0, 0.2], gridcolor: '#1d303a', zerolinecolor: '#2b414c', automargin: true },
        // A horizontal paper-referenced annotation instead of a rotated yaxis2.title: a rotated
        // title needs vertical room along its own axis span to draw, and this subplot's domain
        // (20% of a container that's already only ~250px of actual plotting area) isn't tall
        // enough for one -- confirmed by screenshot, the title silently never rendered at any
        // margin setting. A horizontal label has no such constraint and reads better here anyway.
        annotations: [{
            text: 'Residual', xref: 'paper', yref: 'paper', x: 0, y: 0.2,
            xanchor: 'left', yanchor: 'bottom', showarrow: false,
            font: { color: '#8297a1', size: 9 }
        }]
    };
    await globalThis.Plotly.newPlot(element, traces, layout, {
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    });
}

// What tuning towards an objective changed, for the states the objective names: the run with the starting parameter values (dotted) and with
// the tuned ones (solid). entries: [{ name, unit, times, before, after }], each index-paired.
export async function renderBeforeAfterComparison(element, entries) {
    if (!globalThis.Plotly) throw new Error('Plotly.js is unavailable.');
    const labelFor = (entry, kind) => (entries.length > 1 ? `${entry.name}: ${kind}` : kind);
    const traces = entries.flatMap((entry) => {
        const unitSuffix = entry.unit ? ` ${entry.unit}` : '';
        return [
            { type: 'scatter', mode: 'lines', name: labelFor(entry, 'Before tuning'), legendrank: 1, x: entry.times, y: entry.before, line: { width: 2, dash: 'dot', color: measuredColor }, hovertemplate: `${entry.name} before<br>%{y:.6g}${unitSuffix}<br>t = %{x:.6g} s<extra></extra>` },
            { type: 'scatter', mode: 'lines', name: labelFor(entry, 'After tuning'), legendrank: 2, x: entry.times, y: entry.after, line: { width: 2, color: simulatedColor }, hovertemplate: `${entry.name} after<br>%{y:.6g}${unitSuffix}<br>t = %{x:.6g} s<extra></extra>` }
        ];
    });
    const axis = { gridcolor: '#1d303a', zerolinecolor: '#2b414c', automargin: true };
    await globalThis.Plotly.newPlot(element, traces, {
        autosize: true, margin: { l: 48, r: 18, t: 34, b: 34 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(7,15,21,.52)',
        font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 9 }, hovermode: 'x unified', showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.14, yanchor: 'bottom' }, xaxis: { ...axis, title: { text: 'Time (s)', standoff: 4 } }, yaxis: axis
    }, { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });
}

const plotAxis = { gridcolor: '#1d303a', zerolinecolor: '#2b414c', automargin: true };
const plotFrame = {
    autosize: true, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(7,15,21,.52)',
    font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 9 }, showlegend: true,
    legend: { orientation: 'h', x: 0, y: 1.14, yanchor: 'bottom' }
};
const plotConfig = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

// A live twin, as it stands (docs/proposals/predictionActualWindow.md's figure): every reading so far, the model over the latest
// comparison window (shaded) and its forecast after now (dashed), and a line at now. Times are hours from the start of the log.
// view: { name, unit, measured: [{ time, value }], window: [{ time, value }], forecast: [{ time, value }], anchor, now }
export async function renderLiveTwin(element, view) {
    if (!globalThis.Plotly) throw new Error('Plotly.js is unavailable.');
    const hours = (samples) => samples.map((sample) => sample.time / 3600);
    const unit = view.unit ? ` ${view.unit}` : '';
    const traces = [
        { type: 'scatter', mode: 'markers', name: 'Measured', x: hours(view.measured), y: view.measured.map((sample) => sample.value), marker: { size: 3, color: measuredColor }, hovertemplate: `Measured %{y:.4g}${unit}<br>%{x:.3f} h<extra></extra>` },
        { type: 'scatter', mode: 'lines', name: 'Model in the window', x: hours(view.window), y: view.window.map((sample) => sample.value), line: { width: 2, color: simulatedColor }, hovertemplate: `Model %{y:.4g}${unit}<br>%{x:.3f} h<extra></extra>` },
        { type: 'scatter', mode: 'lines', name: 'Forecast', x: hours(view.forecast), y: view.forecast.map((sample) => sample.value), line: { width: 2, dash: 'dash', color: simulatedColor }, hovertemplate: `Forecast %{y:.4g}${unit}<br>%{x:.3f} h<extra></extra>` }
    ];
    if (view.sandbox?.length) {
        traces.push({ type: 'scatter', mode: 'lines', name: 'With what you tried', x: hours(view.sandbox), y: view.sandbox.map((sample) => sample.value), line: { width: 2, color: '#42c9bc' }, hovertemplate: `Tried %{y:.4g}${unit}<br>%{x:.3f} h<extra></extra>` });
    }
    await globalThis.Plotly.react(element, traces, {
        ...plotFrame, margin: { l: 48, r: 12, t: 30, b: 32 },
        xaxis: { ...plotAxis, title: { text: 'Hours from the start of the log', standoff: 4 } },
        yaxis: { ...plotAxis, title: { text: `${view.name}${unit}`, standoff: 4 } },
        shapes: [
            { type: 'rect', xref: 'x', yref: 'paper', x0: view.anchor / 3600, x1: view.now / 3600, y0: 0, y1: 1, fillcolor: 'rgba(57,135,229,.10)', line: { width: 0 }, layer: 'below' },
            { type: 'line', xref: 'x', yref: 'paper', x0: view.now / 3600, x1: view.now / 3600, y0: 0, y1: 1, line: { width: 1, dash: 'dot', color: '#8297a1' } }
        ]
    }, plotConfig);
}

// The jump at each move of the window (the model's prediction against the reading it is replaced by), with the tolerance either
// side: drift shows as jumps that keep to one side. jumps: [{ time, jump }], times in seconds from the start of the log.
export async function renderJumps(element, { name, unit, jumps, tolerance }) {
    if (!globalThis.Plotly) throw new Error('Plotly.js is unavailable.');
    const x = jumps.map((entry) => entry.time / 3600);
    const span = x.length ? [x[0], x.at(-1)] : [0, 1];
    const suffix = unit ? ` ${unit}` : '';
    const traces = [{ type: 'scatter', mode: 'lines+markers', name: `${name}: jump`, x, y: jumps.map((entry) => entry.jump), line: { width: 1.5, color: simulatedColor }, marker: { size: 4 }, hovertemplate: `Jump %{y:.3g}${suffix}<br>%{x:.3f} h<extra></extra>` }];
    if (tolerance > 0) {
        for (const level of [tolerance, -tolerance]) {
            traces.push({ type: 'scatter', mode: 'lines', showlegend: false, hoverinfo: 'skip', x: span, y: [level, level], line: { width: 1, dash: 'dash', color: measuredColor } });
        }
    }
    await globalThis.Plotly.react(element, traces, {
        ...plotFrame, showlegend: false, margin: { l: 48, r: 12, t: 8, b: 32 },
        xaxis: { ...plotAxis, title: { text: 'Hours from the start of the log', standoff: 4 } },
        yaxis: { ...plotAxis, title: { text: `Jump${suffix}`, standoff: 4 } }
    }, plotConfig);
}
