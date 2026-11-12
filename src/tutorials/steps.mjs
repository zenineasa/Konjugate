/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What every tutorial shares (docs/proposals/tutorials.md): how its card is labelled, which step a person is on, and whether something
// they did earlier has been undone. A tutorial is data (one module per tutorial in this folder); the renderer's controller
// (src/renderer/tour.mjs) reads it through these functions and nothing else, in both the desktop and the web edition.
//
// A step is done when `done({ document, start, ui })` is true. `document` is the project as it would be saved, `start` is the project as
// the tutorial found it (the example it loaded, or the empty canvas), and `ui` holds the few facts only the interface knows (a builder
// is open, a run has finished, a plot has been on screen). Every check stays true once it has become true, unless the person undoes
// what the step asked for: that is what lets the controller notice an undone step and offer to go back to it.
//
// By convention a tutorial's first step is `welcome` and its last is `finish`; both wait for Next and neither is numbered.

const counted = (step) => step.id !== 'welcome' && step.id !== 'finish';

// What the card says above a step's title: nothing on the welcome or the closing card (unless the closing card is a bonus step, as the
// first-model tour's is), and every other step counted out of the numbered ones.
export function stepLabel(index, steps) {
    const step = steps[index];
    if (!step || step.id === 'welcome') return '';
    if (step.bonus) return 'Bonus step';
    if (step.id === 'finish') return '';
    return `Step ${index} of ${steps.filter(counted).length}`;
}

// The text a step shows in an edition (a closing card may end with a sentence about the desktop app's extras).
export const stepText = (step, edition) => `${step.text}${edition === 'desktop' ? step.desktopText ?? '' : step.webText ?? ''}`;

// The step a person is on, given what they have done: the first one that is not done, never beyond a step that waits for Next, and
// `reached` (the step the tutorial has got to) is the floor, so a step that is done by a person's own action stays done.
export function currentStepIndex(facts, reached, steps) {
    let index = Math.min(steps.length - 1, Math.max(0, reached));
    while (index < steps.length - 1 && steps[index].advance !== 'next' && steps[index].done(facts)) index += 1;
    return index;
}

// The earliest step before `index` whose check no longer holds (a node was deleted, say), or null when everything done so far still is.
// A step the person skipped is left out: "Skip this step" did it for them, and it is not theirs to go back to.
export function brokenStepBefore(facts, index, steps, skipped = new Set()) {
    for (let candidate = 1; candidate < index; candidate += 1) if (steps[candidate].advance !== 'next' && !skipped.has(candidate) && !steps[candidate].done(facts)) return candidate;
    return null;
}

// ---- Helpers for checks that ask a project about its parameters

// The value a relationship's parameter has, by the relationship's name and the parameter's symbol, following a link to a shared
// parameter, which is where a linked parameter's value lives. Undefined when there is no such relationship or parameter.
export function edgeParameterValue(document, edgeName, symbol) {
    const edge = (document?.edges ?? []).find((candidate) => candidate.name === edgeName);
    const parameter = (edge?.parameters ?? []).find((candidate) => candidate.symbol === symbol);
    if (!parameter) return undefined;
    if (parameter.sharedParameterId !== undefined) {
        const shared = (document?.sharedParameters ?? []).find((candidate) => candidate.id === parameter.sharedParameterId);
        if (shared) return Number(shared.value);
    }
    return Number(parameter.value);
}

// Whether a relationship's parameter has a different value in `document` than in `start`: what a step that asks for a change checks.
export const edgeParameterChanged = (document, start, edgeName, symbol) => {
    const now = edgeParameterValue(document, edgeName, symbol);
    const before = edgeParameterValue(start, edgeName, symbol);
    return now !== undefined && before !== undefined && now !== before;
};
