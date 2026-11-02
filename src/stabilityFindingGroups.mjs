/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The during-run monitor's first check fires again each time a state's growth starts over, so one ordinary transient (a joint moving off from
// rest) can raise it dozens of times. The findings panel lists each state's findings of one kind once instead: how many there were, and
// when the first and last came. `findings` is in the order the engine raised them; a group keeps the place of its first finding.
export function groupStabilityFindings(findings) {
    const groups = new Map();
    for (const finding of findings) {
        const key = `${finding.nodeId}|${finding.stateId ?? 0}|${finding.code}`;
        const group = groups.get(key);
        if (!group) {
            groups.set(key, { ...finding, count: 1, firstTime: finding.globalTime, lastTime: finding.globalTime });
            continue;
        }
        group.count += 1;
        if (Number.isFinite(finding.globalTime)) {
            if (!Number.isFinite(group.firstTime) || finding.globalTime < group.firstTime) group.firstTime = finding.globalTime;
            if (!Number.isFinite(group.lastTime) || finding.globalTime > group.lastTime) group.lastTime = finding.globalTime;
        }
    }
    // A group points at its first finding in time, which is where clicking it takes a person.
    return [...groups.values()].map((group) => ({ ...group, globalTime: group.firstTime }));
}

// "3 findings", or "3 findings · 46 occurrences" when some repeat.
export function stabilityFindingsTitle(groups) {
    const occurrences = groups.reduce((total, group) => total + group.count, 0);
    const findings = groups.length === 1 ? '1 finding' : `${groups.length} findings`;
    return occurrences > groups.length ? `${findings} · ${occurrences} occurrences` : findings;
}

// Where a group's finding or findings fall: nothing for a finding with no time, one time for one, a span for several.
// `format` turns a time into text.
export function stabilityGroupWhen(group, format) {
    if (!Number.isFinite(group.firstTime)) return group.count > 1 ? `${group.count} times across the run` : 'across the run';
    if (group.count === 1) return `at ${format(group.firstTime)}`;
    return `${group.count} times, from ${format(group.firstTime)} to ${format(group.lastTime)}`;
}

// The monitor's first check is a cheap early warning (a state's change grew for several steps in a row), which an ordinary transient also
// triggers; the checks that confirm instability (the full analysis during the run, the study of the finished run) are the others.
export const earlyStabilityCodes = Object.freeze(['duringRunGrowthTrend']);
export const isEarlyStabilityFinding = (finding) => earlyStabilityCodes.includes(finding.code);
