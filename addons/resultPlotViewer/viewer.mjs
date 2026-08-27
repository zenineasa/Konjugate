/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { seriesToCsv } from '../../src/resultExport.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const selectedSignals = new Set();
let context = null;
let signals = [];
let plotReady = false;
let pendingLiveRender = null;
let liveRenderRequested = false;
let plotRendering = false;
let chartMode = 'timeSeries'; // 'timeSeries' | 'scatter' | 'distribution'
let lastSeries = []; // the full series backing the current scatter/distribution chart, cached so
                      // timeline scrubbing can re-filter the revealed trail without a fresh IPC round trip
const distributionPalette = ['#42c9bc', '#d98b54', '#7aa8d9', '#c16f55', '#8fcfc9'];

function formatTime(time) {
    return `${Number(time).toLocaleString(undefined, { maximumSignificantDigits: 6 })} s`;
}

function paddedRange(values, ratio = 0.06) {
    const finite = values.map(Number).filter(Number.isFinite);
    if (!finite.length) return undefined;
    const minimum = Math.min(...finite);
    const maximum = Math.max(...finite);
    const span = maximum - minimum;
    const padding = span ? span * ratio : Math.max(Math.abs(minimum) * ratio, 1);
    return [minimum - padding, maximum + padding];
}

function cursorShape(time) {
    return { type: 'line', x0: time, x1: time, y0: 0, y1: 1, yref: 'paper', line: { color: '#62e1d5', width: 1.5, dash: 'dot' } };
}

// Scatter and distribution modes reveal samples progressively as the timeline advances (a
// phase-space trail / a distribution building up) rather than always drawing the whole run --
// the sample at time 0 is the first one included, so scrubbing back to 0 empties the chart.
function upToTime(samples, time) {
    return samples.filter((sample) => sample.time <= time);
}

function fixedRange(fullValues) {
    const finite = fullValues.map(Number).filter(Number.isFinite);
    return finite.length ? [Math.min(...finite), Math.max(...finite)] : [0, 1];
}

// Bin edges/count are fixed from the full run so bars stay in place and comparable as the trail
// fills in -- only their heights grow. targetBinCount matches Plotly's own rough default.
function histogramBinning(fullValues, targetBinCount = 24) {
    const finite = fullValues.map(Number).filter(Number.isFinite);
    if (!finite.length) return null;
    const minimum = Math.min(...finite), maximum = Math.max(...finite);
    const span = maximum - minimum || Math.max(Math.abs(minimum), 1);
    const size = span / targetBinCount;
    return { start: minimum - size / 2, end: maximum + size / 2, size };
}

function binnedCounts(values, bins) {
    const counts = new Array(Math.max(1, Math.round((bins.end - bins.start) / bins.size))).fill(0);
    values.forEach((value) => {
        const index = Math.min(counts.length - 1, Math.max(0, Math.floor((value - bins.start) / bins.size)));
        counts[index] += 1;
    });
    return counts;
}

function renderRunStatus(run) {
    context.run = { ...context.run, ...run };
    const live = context.run.lifecycle === 'running';
    $('#runLifecycle').textContent = live ? `Live · ${formatTime(context.run.availableResultTime)}` : 'Completed';
    $('#pacing').hidden = !live;
    const pacing = context.run.pacing;
    if (pacing) {
        const value = pacing.mode === 'limitedRatio' ? `limitedRatio:${pacing.simulationSecondsPerWallSecond}` : pacing.mode;
        if ([...$('#pacing').options].some((option) => option.value === value)) $('#pacing').value = value;
    }
}

function scheduleLiveRender() {
    liveRenderRequested = true;
    if (pendingLiveRender || document.hidden) return;
    pendingLiveRender = setTimeout(async () => {
        pendingLiveRender = null;
        if (!liveRenderRequested || plotRendering || document.hidden) return;
        liveRenderRequested = false;
        plotRendering = true;
        try { await renderPlot(); } finally {
            plotRendering = false;
            if (liveRenderRequested) scheduleLiveRender();
        }
    }, 250);
}

// Unchanged from the original single-purpose renderPlot -- must stay byte-identical in behavior
// when chartMode === 'timeSeries'. Only the multi-axis-per-unit layout and the cursor shape are
// specific to this mode; scatter/distribution build their own, simpler layouts.
function buildTimeSeriesFigure(series) {
    const units = [...new Set(series.map((item) => item.unit || 'Value'))];
    const traces = series.map((item) => ({
        type: 'scatter', mode: 'lines', name: `${item.entityName} · ${item.symbol}`,
        x: item.samples.map((sample) => sample.time),
        y: item.samples.map((sample) => sample.value),
        yaxis: units.indexOf(item.unit || 'Value') ? `y${units.indexOf(item.unit || 'Value') + 1}` : 'y',
        line: { width: 2 },
        hovertemplate: `${item.entityName}<br>${item.name}: %{y:.6g} ${item.unit}<br>t = %{x:.6g} s<extra></extra>`
    }));
    const layout = {
        autosize: true,
        margin: { l: 58, r: Math.max(24, 52 * (units.length - 1)), t: 52, b: 48 },
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(7,15,21,.55)',
        font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 10 },
        hovermode: 'x unified', showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.08, yanchor: 'bottom', itemclick: 'toggle', itemdoubleclick: 'toggleothers' },
        xaxis: { title: 'Time (s)', range: paddedRange(series.flatMap((item) => item.samples.map((sample) => sample.time)), .03), gridcolor: '#1d303a', zerolinecolor: '#2b414c' },
        shapes: [cursorShape(context.time)]
    };
    units.forEach((unit, index) => {
        layout[index ? `yaxis${index + 1}` : 'yaxis'] = {
            title: unit,
            range: paddedRange(series.filter((item) => (item.unit || 'Value') === unit).flatMap((item) => item.samples.map((sample) => sample.value))),
            gridcolor: index ? 'rgba(0,0,0,0)' : '#1d303a', zerolinecolor: '#2b414c',
            ...(index ? { overlaying: 'y', side: 'right', anchor: 'free', position: Math.max(.72, 1 - (index - 1) * .07) } : {})
        };
    });
    return { traces, layout, onClick: (event) => {
        const time = Number(event.points?.[0]?.x);
        if (Number.isFinite(time)) window.konjugateVisualizer.seek(time);
    } };
}

// Marker size in pixels needs a bounded, human-legible range regardless of a signal's own raw
// magnitude -- min-max normalized into [6, 24], matching Plotly's own common bubble-chart
// convention. A constant (zero-span) size signal maps to the midpoint rather than dividing by
// zero. The scale itself is fixed from `fullValues` (the whole run) so marker sizes stay
// comparable as the trail reveals more points, while `values` is just what's drawn right now.
function normalizedMarkerSize(values, fullValues) {
    const finite = fullValues.map(Number).filter(Number.isFinite);
    const minimum = Math.min(...finite);
    const span = Math.max(...finite) - minimum;
    return values.map((value) => span ? 6 + ((value - minimum) / span) * 18 : 15);
}

// Axis ranges, the color scale and the size scale are all fixed from the full run (not just the
// currently-revealed trail) so the chart doesn't visibly rescale itself as the trail grows --
// see buildDistributionFigure for the equivalent for histogram bins/counts. Plotly's own
// zoom/pan then persists across trail updates, since those go through Plotly.restyle (trace data
// only) rather than a full react that would reassert these ranges -- see applyTrail.
function buildScatterFigure(series, { xId, yId, colorId, sizeId, time }) {
    const byId = new Map(series.map((item) => [item.signalId, item]));
    const x = byId.get(xId), y = byId.get(yId);
    const colorItem = colorId ? byId.get(colorId) : null;
    const sizeItem = sizeId ? byId.get(sizeId) : null;
    const revealedColor = colorItem ? upToTime(colorItem.samples, time) : null;
    const revealedSize = sizeItem ? upToTime(sizeItem.samples, time) : null;
    const [cmin, cmax] = colorItem ? fixedRange(colorItem.samples.map((sample) => sample.value)) : [0, 1];
    const trace = {
        type: 'scatter', mode: 'markers',
        x: upToTime(x.samples, time).map((sample) => sample.value),
        y: upToTime(y.samples, time).map((sample) => sample.value),
        marker: {
            size: sizeItem
                ? normalizedMarkerSize(revealedSize.map((sample) => sample.value), sizeItem.samples.map((sample) => sample.value))
                : 8,
            ...(colorItem ? {
                color: revealedColor.map((sample) => sample.value),
                colorscale: 'Viridis', showscale: true, cmin, cmax,
                colorbar: { title: colorItem.unit || colorItem.name, thickness: 12, len: 0.7 }
            } : { color: '#42c9bc' })
        },
        hovertemplate: `${x.entityName} · ${x.symbol}: %{x:.6g} ${x.unit}<br>${y.entityName} · ${y.symbol}: %{y:.6g} ${y.unit}<extra></extra>`
    };
    const layout = {
        autosize: true,
        margin: { l: 58, r: colorItem ? 90 : 24, t: 24, b: 48 },
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(7,15,21,.55)',
        font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 10 },
        showlegend: false,
        xaxis: { title: `${x.entityName} · ${x.symbol}${x.unit ? ` (${x.unit})` : ''}`, range: paddedRange(x.samples.map((sample) => sample.value)), gridcolor: '#1d303a', zerolinecolor: '#2b414c' },
        yaxis: { title: `${y.entityName} · ${y.symbol}${y.unit ? ` (${y.unit})` : ''}`, range: paddedRange(y.samples.map((sample) => sample.value)), gridcolor: '#1d303a', zerolinecolor: '#2b414c' }
    };
    return { traces: [trace], layout, onClick: null };
}

function buildDistributionFigure(series, { time }) {
    const binsBySignal = series.map((item) => histogramBinning(item.samples.map((sample) => sample.value)));
    const maxCount = Math.max(1, ...series.map((item, index) => {
        const bins = binsBySignal[index];
        return bins ? Math.max(...binnedCounts(item.samples.map((sample) => sample.value), bins)) : 0;
    }));
    const traces = series.map((item, index) => ({
        type: 'histogram', name: `${item.entityName} · ${item.symbol}`,
        x: upToTime(item.samples, time).map((sample) => sample.value),
        ...(binsBySignal[index] ? { xbins: binsBySignal[index] } : {}),
        opacity: series.length > 1 ? 0.65 : 1,
        marker: { color: distributionPalette[index % distributionPalette.length] },
        hovertemplate: `${item.entityName} · ${item.symbol}: %{x:.6g} ${item.unit}<br>count: %{y}<extra></extra>`
    }));
    const layout = {
        autosize: true,
        margin: { l: 58, r: 24, t: series.length > 1 ? 52 : 24, b: 48 },
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(7,15,21,.55)',
        font: { color: '#8297a1', family: 'system-ui, sans-serif', size: 10 },
        showlegend: series.length > 1,
        legend: { orientation: 'h', x: 0, y: 1.08, yanchor: 'bottom' },
        barmode: 'overlay',
        xaxis: { title: series.length === 1 ? `${series[0].entityName} · ${series[0].symbol}${series[0].unit ? ` (${series[0].unit})` : ''}` : 'Value', gridcolor: '#1d303a', zerolinecolor: '#2b414c' },
        yaxis: { title: 'Count', range: [0, maxCount * 1.08], gridcolor: '#1d303a', zerolinecolor: '#2b414c' }
    };
    return { traces, layout, onClick: null };
}

// Cheap trail-position update for a scrub/live tick: restyles trace data only, in place, so any
// zoom/pan the user has set on the chart survives (unlike renderPlot's full Plotly.react, which
// legitimately rebuilds -- and re-ranges -- the chart because the selection itself changed).
function applyTrail(time) {
    if (!plotReady || chartMode === 'timeSeries') return;
    if (chartMode === 'scatter') {
        const byId = new Map(lastSeries.map((item) => [item.signalId, item]));
        const x = byId.get(Number($('#scatterX').value));
        const y = byId.get(Number($('#scatterY').value));
        if (!x || !y) return;
        const colorId = Number($('#scatterColor').value) || null;
        const sizeId = Number($('#scatterSize').value) || null;
        const colorItem = colorId ? byId.get(colorId) : null;
        const sizeItem = sizeId ? byId.get(sizeId) : null;
        const update = {
            x: [upToTime(x.samples, time).map((sample) => sample.value)],
            y: [upToTime(y.samples, time).map((sample) => sample.value)]
        };
        if (colorItem) update['marker.color'] = [upToTime(colorItem.samples, time).map((sample) => sample.value)];
        if (sizeItem) {
            update['marker.size'] = [normalizedMarkerSize(
                upToTime(sizeItem.samples, time).map((sample) => sample.value),
                sizeItem.samples.map((sample) => sample.value)
            )];
        }
        Plotly.restyle($('#analysisPlot'), update, [0]);
    } else if (chartMode === 'distribution') {
        Plotly.restyle($('#analysisPlot'), {
            x: lastSeries.map((item) => upToTime(item.samples, time).map((sample) => sample.value))
        }, lastSeries.map((_item, index) => index));
    }
}

function currentSignalIds() {
    if (chartMode === 'scatter') {
        const ids = [$('#scatterX').value, $('#scatterY').value, $('#scatterColor').value, $('#scatterSize').value]
            .filter(Boolean).map(Number);
        return [...new Set(ids)];
    }
    return [...selectedSignals];
}

async function renderPlot() {
    const signalIds = currentSignalIds();
    const missingScatterAxis = chartMode === 'scatter' && (!$('#scatterX').value || !$('#scatterY').value);
    const series = missingScatterAxis ? [] : await window.konjugateVisualizer.readSeries(signalIds, { maxPoints: 5000 });
    $('.plotWorkspace').classList.toggle('hasSignals', Boolean(series.length));
    $('#exportCsv').disabled = !series.length;
    if (!series.length) {
        if (plotReady) Plotly.purge($('#analysisPlot'));
        plotReady = false;
        return;
    }
    lastSeries = series;
    const figure = chartMode === 'scatter'
        ? buildScatterFigure(series, { xId: Number($('#scatterX').value), yId: Number($('#scatterY').value), colorId: Number($('#scatterColor').value) || null, sizeId: Number($('#scatterSize').value) || null, time: context.time })
        : chartMode === 'distribution' ? buildDistributionFigure(series, { time: context.time }) : buildTimeSeriesFigure(series);
    await Plotly.react($('#analysisPlot'), figure.traces, figure.layout, { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });
    $('#analysisPlot').removeAllListeners?.('plotly_click');
    if (figure.onClick) $('#analysisPlot').on?.('plotly_click', figure.onClick);
    plotReady = true;
}

function renderScatterPickers() {
    const grouped = Map.groupBy(signals, (signal) => signal.entityName);
    const optionsHtml = [...grouped.entries()].map(([entityName, items]) => `<optgroup label="${entityName}">${
        items.map((signal) => `<option value="${signal.signalId}">${signal.name} · ${signal.symbol}</option>`).join('')
    }</optgroup>`).join('');
    ['#scatterX', '#scatterY'].forEach((selector) => {
        const select = $(selector);
        const previous = select.value;
        select.innerHTML = optionsHtml;
        if (signals.some((signal) => String(signal.signalId) === previous)) select.value = previous;
    });
    ['#scatterColor', '#scatterSize'].forEach((selector) => {
        const select = $(selector);
        const previous = select.value;
        select.innerHTML = `<option value="">None</option>${optionsHtml}`;
        if (signals.some((signal) => String(signal.signalId) === previous)) select.value = previous;
    });
}

function applyChartModeVisibility() {
    $('#scatterPickers').hidden = chartMode !== 'scatter';
    $('#signalSearch').hidden = chartMode === 'scatter';
    $('#signalGroups').hidden = chartMode === 'scatter';
    $('#resetTrail').hidden = chartMode === 'timeSeries';
}

function renderSignalBrowser(filter = '') {
    const normalizedFilter = filter.trim().toLowerCase();
    const groups = Map.groupBy(signals.filter((signal) => `${signal.entityName} ${signal.name} ${signal.symbol} ${signal.unit}`.toLowerCase().includes(normalizedFilter)), (signal) => signal.entityId);
    const container = $('#signalGroups');
    container.replaceChildren();
    groups.forEach((items, entityId) => {
        const group = document.createElement('section');
        group.className = 'signalGroup';
        group.dataset.entityId = entityId;
        group.classList.toggle('selectedEntity', context.selectedNodeId === entityId);
        const heading = document.createElement('strong');
        heading.textContent = items[0].entityName;
        group.appendChild(heading);
        items.forEach((signal) => {
            const label = document.createElement('label');
            label.className = 'signalOption';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = selectedSignals.has(signal.signalId);
            input.addEventListener('change', () => {
                if (input.checked) selectedSignals.add(signal.signalId);
                else selectedSignals.delete(signal.signalId);
                renderPlot();
            });
            const identity = document.createElement('span');
            const name = document.createElement('b');
            name.textContent = signal.name;
            const symbol = document.createElement('small');
            symbol.textContent = signal.symbol;
            identity.append(name, symbol);
            const unit = document.createElement('em');
            unit.textContent = signal.unit || '—';
            label.append(input, identity, unit);
            group.appendChild(label);
        });
        container.appendChild(group);
    });
}

async function loadSession() {
    context = await window.konjugateVisualizer.getContext();
    if (!context) return;
    signals = await window.konjugateVisualizer.listSignals();
    selectedSignals.clear();
    signals.filter((signal) => signal.entityId === context.selectedNodeId).forEach((signal) => selectedSignals.add(signal.signalId));
    $('#projectName').textContent = context.projectName;
    $('#runName').textContent = context.run.name;
    $('#timeline').max = String(context.run.targetTime);
    $('#timeline').value = String(context.time);
    $('#currentTime').value = formatTime(context.time);
    $('#targetTime').value = formatTime(context.run.targetTime);
    renderRunStatus(context.run);
    renderSignalBrowser();
    renderScatterPickers();
    applyChartModeVisibility();
    await renderPlot();
}

$('#chartMode').addEventListener('change', (event) => {
    chartMode = event.target.value;
    applyChartModeVisibility();
    renderPlot();
});
['#scatterX', '#scatterY', '#scatterColor', '#scatterSize'].forEach((selector) => {
    $(selector).addEventListener('change', () => renderPlot());
});
$('#signalSearch').addEventListener('input', (event) => renderSignalBrowser(event.target.value));
$('#clearSignals').addEventListener('click', () => {
    selectedSignals.clear();
    renderSignalBrowser($('#signalSearch').value);
    renderPlot();
});
$('#resetTrail').addEventListener('click', () => window.konjugateVisualizer.seek(0));
$('#exportCsv').addEventListener('click', async () => {
    const signalIds = currentSignalIds();
    if (!signalIds.length) return;
    const series = await window.konjugateVisualizer.readSeries(signalIds, { maxPoints: Infinity });
    const byId = new Map(series.map((item) => [item.signalId, item]));
    const orderedSeries = signalIds.map((id) => byId.get(id)).filter(Boolean);
    const csvSignals = orderedSeries.map((item) => ({
        signalId: item.signalId,
        header: `${item.entityName} — ${item.name}${item.unit ? ` (${item.unit})` : ''}`
    }));
    const csv = seriesToCsv(orderedSeries, csvSignals);
    const suggestedFilename = `${context.projectName} — ${context.run.name} (${chartMode}).csv`;
    await window.konjugateVisualizer.exportCsv(suggestedFilename, csv);
});
$('#timeline').addEventListener('input', (event) => window.konjugateVisualizer.seek(Number(event.target.value)));
$('#pacing').addEventListener('change', async (event) => {
    const [mode, ratio] = event.target.value.split(':');
    await window.konjugateVisualizer.requestPacing({
        mode,
        simulationSecondsPerWallSecond: mode === 'realTime' ? 1 : Number(ratio || 1)
    });
});
window.konjugateVisualizer.onTimelineChange((time) => {
    if (!context) return;
    context.time = Number(time);
    $('#timeline').value = String(time);
    $('#currentTime').value = formatTime(time);
    if (!plotReady) return;
    if (chartMode === 'timeSeries') Plotly.relayout($('#analysisPlot'), { shapes: [cursorShape(time)] });
    else applyTrail(time);
});
window.konjugateVisualizer.onSelectionChange((nodeId) => {
    if (!context) return;
    context.selectedNodeId = nodeId;
    document.querySelectorAll('.signalGroup').forEach((group) => group.classList.toggle('selectedEntity', Number(group.dataset.entityId) === nodeId));
});
window.konjugateVisualizer.onSamplesAvailable(({ availableResultTime }) => {
    if (!context) return;
    context.run.availableResultTime = availableResultTime;
    renderRunStatus(context.run);
    scheduleLiveRender();
});
window.konjugateVisualizer.onRunStatusChange((run) => {
    if (!context) return;
    renderRunStatus(run);
});
window.konjugateVisualizer.onPacingChange((pacing) => {
    if (!context) return;
    renderRunStatus({ pacing });
});
window.konjugateVisualizer.onSessionChange(loadSession);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && liveRenderRequested) scheduleLiveRender();
});

loadSession();
