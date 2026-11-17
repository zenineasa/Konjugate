// Copyright © 2026 Zenin Easa Panthakkalakath

// Deciding what a second pass of the interaction suite runs, and what the two passes together say
// (scripts/runPackagedInteractionTests.mjs). A break in packaging or bundling fails a scenario
// every time, so it fails both passes and still fails the run; a scenario that fails once on timing
// (a click landing a frame early on a slow runner) passes the second time, and is reported as
// flaky rather than hidden, so one that keeps needing the second pass gets its timing fixed.

// The scenarios to run again: each failure, and the scenario that ran just before it, since a few
// build on the one before (edge group meshing works on the nodes the rotate test leaves).
export function scenariosToRetry(outcomes) {
    const retry = [];
    let previousRan = null;
    for (const { name, status } of outcomes) {
        if (status === 'failed') {
            if (previousRan && !retry.includes(previousRan)) retry.push(previousRan);
            if (!retry.includes(name)) retry.push(name);
        }
        if (status !== 'skipped') previousRan = name;
    }
    return retry;
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

// KONJUGATE_INTERACTION_ONLY's form: substrings of scenario names separated by "||".
export function onlyFilter(names) {
    if (names.some((name) => name.includes('||'))) throw new Error('A scenario name contains "||", which KONJUGATE_INTERACTION_ONLY cannot select.');
    return names.join('||');
}
