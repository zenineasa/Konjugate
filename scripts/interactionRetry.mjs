// Copyright © 2026 Zenin Easa Panthakkalakath

// Deciding what a second pass of the interaction suite runs, and what the two passes together say
// (scripts/runPackagedInteractionTests.mjs). A break in packaging or bundling fails a scenario every
// time, so it fails both passes and still fails the run; a scenario that fails once on timing (a click
// landing a frame early on a slow runner) passes the second time, and is reported as flaky rather than
// hidden, so one that keeps needing the second pass gets its timing fixed.

// The scenarios to run again, in the order they ran: each failure, and the members of its group that ran
// before it (scenarioGroups in tests/interactionRunner.mjs), since those set up what it works on. Every
// other scenario sets itself up, so it is run again alone.
export function scenariosToRetry(outcomes) {
    const retry = new Set();
    outcomes.forEach(({ name, status, group }, index) => {
        if (status !== 'failed') return;
        if (group) for (const earlier of outcomes.slice(0, index)) if (earlier.group === group && earlier.status !== 'skipped') retry.add(earlier.name);
        retry.add(name);
    });
    return outcomes.map(({ name }) => name).filter((name) => retry.has(name));
}

// KONJUGATE_INTERACTION_ONLY's form: substrings of scenario names separated by "||".
export function onlyFilter(names) {
    if (names.some((name) => name.includes('||'))) throw new Error('A scenario name contains "||", which KONJUGATE_INTERACTION_ONLY cannot select.');
    return names.join('||');
}

// The run as a whole: what failed twice (the run fails), and what failed once and then passed (flaky).
export function combineOutcomes(firstPass, secondPass) {
    const firstFailed = firstPass.filter(({ status }) => status === 'failed').map(({ name }) => name);
    const secondByName = new Map(secondPass.map(({ name, status }) => [name, status]));
    const failed = firstFailed.filter((name) => secondByName.get(name) !== 'passed');
    const flaky = firstFailed.filter((name) => secondByName.get(name) === 'passed');
    // A scenario run again only to set up a failure after it, which failed this time: it passed the first time,
    // so it is flaky, and the failure after it was not given a fair second try.
    for (const [name, status] of secondByName) {
        if (status === 'failed' && !firstFailed.includes(name) && !flaky.includes(name)) flaky.push(name);
    }
    return { failed, flaky };
}
