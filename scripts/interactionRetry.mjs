// Copyright © 2026 Zenin Easa Panthakkalakath

// What two passes of the interaction suite say together (scripts/runPackagedInteractionTests.mjs runs the
// whole suite a second time when a scenario fails). A break in packaging or bundling fails a scenario
// every time, so it fails both passes and still fails the run; a scenario that fails once on timing
// (a click landing a frame early on a slow runner) passes the second time, and is reported as
// flaky rather than hidden, so one that keeps needing the second pass gets its timing fixed.

// The run as a whole: what failed twice (the run fails), and what failed once and then passed (flaky).
export function combineOutcomes(firstPass, secondPass) {
    const firstFailed = firstPass.filter(({ status }) => status === 'failed').map(({ name }) => name);
    const secondByName = new Map(secondPass.map(({ name, status }) => [name, status]));
    const failed = firstFailed.filter((name) => secondByName.get(name) !== 'passed');
    const flaky = firstFailed.filter((name) => secondByName.get(name) === 'passed');
    // A scenario that passed the first time and failed the second is flaky too.
    for (const [name, status] of secondByName) {
        if (status === 'failed' && !firstFailed.includes(name) && !flaky.includes(name)) flaky.push(name);
    }
    return { failed, flaky };
}
