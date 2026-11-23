/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Line plots as plain SVG, with no dependencies, so the report is one self-contained file and each plot also stands alone.
//
// A series' role fixes its colour and dash in every plot: the reference is always the first categorical colour, explicit Euler the
// second, semi-implicit Euler the third (dashed), Verlet, symplectic like it, the third (solid), Runge–Kutta 4 the fourth (solid), Dormand–Prince 5(4) the first (long dashes: it is
// drawn only in plots of error, which have no reference line), Rodas4 the second (dash and dot), a further series the fourth (dotted), and a guide line (such as slope 1)
// is a thin muted dash. Colours come from CSS custom properties, so the same SVG follows the report's light and dark themes; a standalone SVG file
// carries the light values. Text is never drawn in a series colour.

export const roleStyles = {
    reference: { colour: 'var(--series-1)', dash: '' },
    explicit: { colour: 'var(--series-2)', dash: '' },
    semiImplicit: { colour: 'var(--series-3)', dash: '7 4' },
    verlet: { colour: 'var(--series-3)', dash: '' },
    extra: { colour: 'var(--series-4)', dash: '2 3' },
    rungeKutta4: { colour: 'var(--series-4)', dash: '' },
    dormandPrince54: { colour: 'var(--series-1)', dash: '9 3' },
    rodas4: { colour: 'var(--series-2)', dash: '12 3 2 3' },
    slot1: { colour: 'var(--series-1)', dash: '' },
    slot2: { colour: 'var(--series-2)', dash: '' },
    slot3: { colour: 'var(--series-3)', dash: '7 4' },
    slot4: { colour: 'var(--series-4)', dash: '2 3' },
    guide: { colour: 'var(--text-muted)', dash: '4 4', width: 1 }
};

export const lightTheme = `
    --surface-1: #fcfcfb; --page: #f9f9f7; --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
    --good: #006300; --critical: #d03b3b;`;
export const darkTheme = `
    --surface-1: #1a1a19; --page: #0d0d0d; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
    --good: #0ca30c; --critical: #e66767;`;

const width = 640;
const height = 340;
const margin = { left: 72, right: 20, top: 16, bottom: 46 };

function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '–';
    if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
    if (value === 0) return '0';
    const magnitude = Math.abs(value);
    if (magnitude >= 1e5 || magnitude < 1e-3) return value.toExponential(2).replace('e+', 'e');
    return Number(value.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function niceStep(span, count) {
    const raw = span / count;
    const power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

// An axis over the data. Linear: the value axis is widened to whole ticks, the other axis keeps the data's own extent. Logarithmic: the
// data's extent, padded slightly, with ticks at the powers of ten inside it (and at 2 and 5 times them when there are fewer than three).
// Explicit ticks, when a plot gives them (a ladder of step sizes, say), replace the computed ones.
function axis(values, logarithmic, { widen = true, ticks: explicit = null } = {}) {
    const finite = values.filter((value) => Number.isFinite(value) && (!logarithmic || value > 0));
    let low = Math.min(...finite);
    let high = Math.max(...finite);
    if (logarithmic) {
        if (low === high) { low /= 2; high *= 2; }
        const pad = (Math.log10(high) - Math.log10(low)) * 0.04;
        const lowLog = Math.log10(low) - pad;
        const highLog = Math.log10(high) + pad;
        let ticks = explicit ?? [];
        if (!explicit) {
            for (let power = Math.ceil(lowLog); power <= Math.floor(highLog); ++power) ticks.push(10 ** power);
            const stride = Math.max(1, Math.ceil(ticks.length / 7));
            ticks = ticks.filter((_tick, index) => index % stride === 0);
            if (ticks.length < 3) {
                ticks = [];
                for (let power = Math.floor(lowLog); power <= Math.ceil(highLog); ++power) for (const factor of [1, 2, 5]) ticks.push(factor * 10 ** power);
                ticks = ticks.filter((tick) => Math.log10(tick) >= lowLog && Math.log10(tick) <= highLog);
            }
        }
        return { low: 10 ** lowLog, high: 10 ** highLog, ticks, map: (value) => Math.log10(value) };
    }
    if (low === high) { low -= 1; high += 1; }
    const step = niceStep(high - low, 5);
    if (widen) {
        low = Math.floor(low / step) * step;
        high = Math.ceil(high / step) * step;
    }
    const ticks = [];
    for (let tick = Math.ceil(low / step - 1e-9) * step; tick <= high + step * 1e-9; tick += step) ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : tick);
    return { low, high, ticks: explicit ?? ticks, map: (value) => value };
}

const superscripts = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

function tickLabel(value, logarithmic) {
    if (logarithmic) {
        // A step size below one that is a power of two (the ladders the convergence studies halve through) reads best as one.
        const power2 = Math.log2(value);
        if (value < 1 && Number.isInteger(power2)) return `2${String(power2).split('').map((character) => superscripts[character]).join('')}`;
        const power = Math.floor(Math.log10(value) + 1e-9);
        const factor = Math.round(value / 10 ** power);
        if (Math.abs(value / (factor * 10 ** power) - 1) > 1e-9) return formatNumber(value);
        if (power >= 0 && power <= 3) return String(factor * 10 ** power);
        return factor === 1 ? `1e${power}` : `${factor}e${power}`;
    }
    return formatNumber(value);
}

// The geometry of a plot: its scales, and each series' visible points in pixels (non-finite points, and non-positive ones on a log
// axis, are left out and break the line).
export function layout(plot) {
    const xs = plot.series.flatMap((entry) => entry.points.map(([x]) => x));
    const ys = plot.series.flatMap((entry) => entry.points.map(([, y]) => y));
    const xAxis = axis(xs, plot.logX, { widen: false, ticks: plot.xTicks ?? null });
    const yAxis = axis(ys, plot.logY);
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const px = (x) => margin.left + (xAxis.map(x) - xAxis.map(xAxis.low)) / (xAxis.map(xAxis.high) - xAxis.map(xAxis.low)) * innerWidth;
    const py = (y) => margin.top + innerHeight - (yAxis.map(y) - yAxis.map(yAxis.low)) / (yAxis.map(yAxis.high) - yAxis.map(yAxis.low)) * innerHeight;
    const visible = (x, y) => Number.isFinite(x) && Number.isFinite(y) && (!plot.logX || x > 0) && (!plot.logY || y > 0);
    return { xAxis, yAxis, px, py, visible, innerWidth, innerHeight };
}

export function renderSvg(plot, { standalone = false } = {}) {
    const { xAxis, yAxis, px, py, visible } = layout(plot);
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(plot.title)}" class="plot" data-plot="${escapeXml(plot.id)}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="12">`);
    if (standalone) parts.push(`<style>svg { ${lightTheme} }</style><rect width="${width}" height="${height}" fill="var(--surface-1)"/>`);
    for (const tick of yAxis.ticks) {
        const y = py(tick);
        parts.push(`<line x1="${margin.left}" x2="${width - margin.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`);
        parts.push(`<text x="${margin.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" style="font-variant-numeric: tabular-nums">${escapeXml(tickLabel(tick, plot.logY))}</text>`);
    }
    for (const tick of xAxis.ticks) {
        const x = px(tick);
        parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${height - margin.bottom}" y2="${height - margin.bottom + 4}" stroke="var(--axis)" stroke-width="1"/>`);
        parts.push(`<text x="${x.toFixed(1)}" y="${height - margin.bottom + 18}" text-anchor="middle" fill="var(--text-muted)" style="font-variant-numeric: tabular-nums">${escapeXml(tickLabel(tick, plot.logX))}</text>`);
    }
    parts.push(`<line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="var(--axis)" stroke-width="1"/>`);
    parts.push(`<text x="${margin.left + (width - margin.left - margin.right) / 2}" y="${height - 8}" text-anchor="middle" fill="var(--text-secondary)">${escapeXml(plot.xLabel)}</text>`);
    parts.push(`<text transform="translate(16 ${margin.top + (height - margin.top - margin.bottom) / 2}) rotate(-90)" text-anchor="middle" fill="var(--text-secondary)">${escapeXml(plot.yLabel)}</text>`);
    for (const entry of plot.series) {
        const style = roleStyles[entry.role] ?? roleStyles.reference;
        let path = '';
        let drawing = false;
        for (const [x, y] of entry.points) {
            if (!visible(x, y)) { drawing = false; continue; }
            path += `${drawing ? 'L' : 'M'}${px(x).toFixed(1)} ${py(y).toFixed(1)}`;
            drawing = true;
        }
        if (path) parts.push(`<path d="${path}" fill="none" stroke="${style.colour}" stroke-width="${style.width ?? 2}" stroke-linejoin="round" stroke-linecap="round"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''}/>`);
    }
    parts.push('</svg>');
    return parts.join('');
}

// A legend as HTML: a short stroke in the series' colour and dash beside its name in text ink.
export function renderLegend(plot) {
    if (plot.series.length < 2) return '';
    return `<ul class="legend">${plot.series.map((entry) => {
        const style = roleStyles[entry.role] ?? roleStyles.reference;
        return `<li><svg width="26" height="10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke="${style.colour}" stroke-width="${style.width ?? 2}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''} stroke-linecap="round"/></svg>${escapeXml(entry.name)}</li>`;
    }).join('')}</ul>`;
}

// The plot's data as CSV: one x column per series when the series do not share their x values.
export function plotCsv(plot) {
    const header = plot.series.flatMap((entry) => [`${entry.name} x`, `${entry.name} y`]);
    const length = Math.max(...plot.series.map((entry) => entry.points.length));
    const lines = [header.map((text) => `"${text.replaceAll('"', '""')}"`).join(',')];
    for (let row = 0; row < length; ++row) {
        lines.push(plot.series.flatMap((entry) => entry.points[row] ? entry.points[row].map(String) : ['', '']).join(','));
    }
    return `${lines.join('\n')}\n`;
}

export { escapeXml };
