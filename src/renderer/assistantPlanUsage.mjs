/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How much of a subscription's limits is used, drawn as meters (docs/aiAssistantGuide.md, "What a request uses"): Claude's
// session (five hours) and weekly limits, as Claude Code's own /usage says them (src/aiVendorTools.mjs parsePlanUsage), each
// with how much is used and when it resets. In Settings beside the tool, and in the assistant panel while that tool answers.

const tone = (percent) => (percent >= 90 ? 'high' : percent >= 75 ? 'raised' : 'normal');

// `usage`: { windows: [{ kind, label, percent, resets }] }. `compact`: one short line of small meters, the resets in the tooltip.
export function planUsageMeters(usage, { compact = false } = {}) {
    const box = document.createElement('div');
    box.className = compact ? 'planUsage compact' : 'planUsage';
    for (const window of usage?.windows ?? []) {
        const item = document.createElement('div');
        item.className = `planUsageWindow ${tone(window.percent)}`;
        item.dataset.planWindow = window.kind;
        const label = Object.assign(document.createElement('span'), { className: 'planUsageLabel', textContent: compact ? (window.kind === 'session' ? 'Session' : window.label) : window.label });
        const bar = document.createElement('span');
        bar.className = 'planUsageBar';
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(window.percent));
        bar.ariaLabel = `${window.label}: ${window.percent}% used`;
        const fill = document.createElement('span');
        fill.style.width = `${window.percent}%`;
        bar.append(fill);
        const said = `${Math.round(window.percent)}%${!compact && window.resets ? ` · resets ${window.resets}` : ''}`;
        const value = Object.assign(document.createElement('span'), { className: 'planUsageValue', textContent: said });
        item.title = `${window.label}: ${Math.round(window.percent)}% used${window.resets ? `, resets ${window.resets}` : ''}`;
        item.append(label, bar, value);
        box.append(item);
    }
    return box;
}
