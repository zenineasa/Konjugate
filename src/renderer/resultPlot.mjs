/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function nodeResultSeries(result, node) {
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
        samples: samplesByState.get(state.id) ?? []
    })).filter((series) => series.samples.length);
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

export class ResultPlot {
    constructor(element, { onSeek } = {}) {
        this.element = element;
        this.onSeek = onSeek;
        this.rendered = false;
    }

    async render(series, currentTime = 0) {
        if (!globalThis.Plotly) throw new Error('Plotly.js is unavailable.');
        const units = [...new Set(series.map((item) => item.unit || 'Value'))];
        const times = series.flatMap((item) => item.samples.map((sample) => sample.time));
        const traces = series.map((item) => ({
            type: 'scatter',
            mode: 'lines',
            name: item.symbol,
            x: item.samples.map((sample) => sample.time),
            y: item.samples.map((sample) => sample.value),
            yaxis: units.indexOf(item.unit || 'Value') ? `y${units.indexOf(item.unit || 'Value') + 1}` : 'y',
            line: { width: 2 },
            hovertemplate: `${item.name}<br>%{y:.6g} ${item.unit}<br>t = %{x:.6g} s<extra></extra>`
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
        await globalThis.Plotly.react(this.element, traces, layout, {
            responsive: true,
            displaylogo: false,
            scrollZoom: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d']
        });
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
        this.rendered = false;
    }
}
