/* Copyright © 2026 Zenin Easa Panthakkalakath */

const $ = (selector, root = document) => root.querySelector(selector);
const selectedSignals = new Set();
let context = null;
let signals = [];
let plotReady = false;
let pendingLiveRender = null;
let liveRenderRequested = false;
let plotRendering = false;

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

async function renderPlot() {
    const series = await window.konjugateVisualizer.readSeries([...selectedSignals], { maxPoints: 5000 });
    $('.plotWorkspace').classList.toggle('hasSignals', Boolean(series.length));
    if (!series.length) {
        if (plotReady) Plotly.purge($('#analysisPlot'));
        plotReady = false;
        return;
    }
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
    await Plotly.react($('#analysisPlot'), traces, layout, { responsive: true, displaylogo: false, scrollZoom: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });
    $('#analysisPlot').removeAllListeners?.('plotly_click');
    $('#analysisPlot').on?.('plotly_click', (event) => {
        const time = Number(event.points?.[0]?.x);
        if (Number.isFinite(time)) window.konjugateVisualizer.seek(time);
    });
    plotReady = true;
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
    await renderPlot();
}

$('#signalSearch').addEventListener('input', (event) => renderSignalBrowser(event.target.value));
$('#clearSignals').addEventListener('click', () => {
    selectedSignals.clear();
    renderSignalBrowser($('#signalSearch').value);
    renderPlot();
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
    if (plotReady) Plotly.relayout($('#analysisPlot'), { shapes: [cursorShape(time)] });
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
