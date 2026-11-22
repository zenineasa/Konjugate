/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A check that, once it has held, keeps holding for the rest of that play of its tutorial (docs/proposals/tutorials.md): for a step that
// asks the person to look at something (a relationship's card, a run that can be steered), which is over once seen, and which the next
// step's own work then closes or ends. Without it, the controller would report the step undone ("Something from step 1 is no longer
// there") while the person does exactly what the next card asks. A play is known by the project the tutorial started from (`start`, the
// same object for every look of one play, a new one for the next play), so a play started again is judged afresh.
export function latch(holds) {
    const seen = new WeakSet();
    return (facts) => {
        if (facts.start && seen.has(facts.start)) return true;
        const now = Boolean(holds(facts));
        if (now && facts.start) seen.add(facts.start);
        return now;
    };
}
