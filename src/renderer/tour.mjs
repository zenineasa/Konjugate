/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The tutorials' controller (docs/proposals/tutorials.md; the first-model tour, docs/proposals/guidedTour.md, is the first of them): a
// card that says what to do next, a ring around the control it is about, and a check, every few hundred milliseconds and whenever told
// something happened, of whether the person has done it. What each tutorial's steps say and how each is judged lives in ../tutorials/,
// shared by both editions; what this file knows about the page is only what it is handed: how to read the facts the checks need, and how
// to fill a step in.

import { brokenStepBefore, currentStepIndex, stepLabel, stepText } from '../tutorials/steps.mjs';

const element = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
};

// getFacts() -> { document, ui }; actions: { [name]: async (step) => string | void }, the page's own actions a step names: its `fill` (the
// fill button), its `skip` (what "Skip this step" does for the person, so the steps after it still work) and its `link.action` (a link in
// the card's text, such as a download; what it returns is said under the text); edition: 'desktop' | 'web';
// onFinish(outcome, tutorial) with 'completed' or 'skipped', after the card has gone from the screen.
// start(tutorial, { start }) plays a tutorial; `start` is the project as the tutorial found it, handed to every check.
// onStep(step | null, label) is told whenever the step on screen changes, and null when the tutorial ends: for a step whose work is in
// another window, which shows it there.
export function createTour({ getFacts, actions: pageActions = {}, edition, onFinish = () => {}, onStep = () => {}, pollMilliseconds = 300 }) {
    let tutorial = null;
    let steps = [];
    let startDocument = null;
    let reached = 0;
    let active = false;
    let timer = null;
    let filling = false;
    // Which play of a tutorial an action belongs to: one still waiting when a tutorial ends (or another starts) is left to finish
    // unheard, and does not hold the next tutorial's buttons.
    let play = 0;
    // The steps the person skipped: "Skip this step" did them, and a check that does not hold for a moment after (a run still starting)
    // is not reported as something undone.
    const skipped = new Set();
    // The step whose skip could not do it, while the person is still on it.
    let skipFailed = null;
    let shownStep = null;
    const ring = element('div', 'tourRing');
    ring.hidden = true;
    ring.setAttribute('aria-hidden', 'true');
    const card = element('section', 'tourFloating');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Tutorial');
    card.hidden = true;
    const progress = element('span', 'tourProgress');
    const title = element('strong', 'tourTitle');
    const text = element('p', 'tourText');
    const link = element('button', 'tourContentLink', '');
    link.type = 'button';
    const linkNote = element('p', 'tourLinkNote');
    linkNote.setAttribute('role', 'status');
    const notice = element('p', 'tourNotice');
    const back = element('button', 'tourLink', '');
    back.type = 'button';
    const fillButton = element('button', 'tourSecondary', 'Fill this in for me');
    fillButton.type = 'button';
    const next = element('button', 'tourPrimary', 'Next');
    next.type = 'button';
    const skip = element('button', 'tourLink', 'Leave tutorial');
    skip.type = 'button';
    const skipStep = element('button', 'tourLink tourSkipStep', 'Skip this step');
    skipStep.type = 'button';
    const actions = element('div', 'tourActions');
    actions.append(skip, skipStep, fillButton, next);
    card.append(progress, title, text, link, linkNote, notice, back, actions);
    document.body.append(ring, card);

    const targetOf = (step, facts) => (typeof step.target === 'function' ? step.target(facts.ui) : step.target);

    function placeRing(step, facts) {
        // A step's target is a selector, or an element where no selector can name it (a node's label, found by its text).
        const reference = step.advance === 'next' ? null : targetOf(step, facts);
        const target = typeof reference === 'string' ? document.querySelector(reference) : reference ?? null;
        const rect = target?.getBoundingClientRect();
        const visible = rect && rect.width > 0 && rect.height > 0 && !target.closest('[hidden], .hidden');
        ring.hidden = !visible;
        // A control to press pulses, to draw the eye; a panel the step is about keeps a still ring.
        ring.classList.toggle('tourRingPulse', Boolean(visible && target.matches('button, [role="button"], input, select, summary')));
        if (!visible) return null;
        const margin = 4;
        Object.assign(ring.style, { left: `${rect.left - margin}px`, top: `${rect.top - margin}px`, width: `${rect.width + 2 * margin}px`, height: `${rect.height + 2 * margin}px` });
        return rect;
    }

    // Where the card goes: a corner that covers neither the control a step points at nor anything the person is working in (the
    // editors and builders that open at the side, the panels, the timeline), the first of four that is clear, else the least covered.
    // Someone who drags the card by its title puts it where they want it, and it stays there.
    let dragged = null;
    const obstacleSelector = '.contextCard:not(.hidden), .componentLibraryPanel:not([hidden]):not(.hidden), .resultTransport, dialog[open]';
    function placeCard(targetRect) {
        if (dragged) {
            Object.assign(card.style, { left: `${dragged.left}px`, top: `${dragged.top}px`, right: 'auto', bottom: 'auto' });
            return;
        }
        const { width, height } = card.getBoundingClientRect();
        const margin = 24;
        const obstacles = [...document.querySelectorAll(obstacleSelector)].filter((item) => !card.contains(item) && item.getClientRects().length)
            .map((item) => item.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
        if (targetRect) obstacles.push(targetRect);
        const top = 160;
        const candidates = [
            { left: margin + 70, top: window.innerHeight - height - margin },
            { left: window.innerWidth - width - margin, top: window.innerHeight - height - margin },
            { left: margin + 70, top },
            { left: window.innerWidth - width - margin, top }
        ];
        const covered = (spot) => obstacles.reduce((sum, rect) => {
            const overlapX = Math.min(spot.left + width, rect.right) - Math.max(spot.left, rect.left);
            const overlapY = Math.min(spot.top + height, rect.bottom) - Math.max(spot.top, rect.top);
            return sum + (overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0);
        }, 0);
        // Stay where it already is while that is still clear, so it does not jump about between steps for nothing.
        const best = candidates.map((spot) => ({ spot, area: covered(spot) })).sort((a, b) => a.area - b.area)[0];
        const current = card.dataset.spot ? candidates[Number(card.dataset.spot)] : null;
        const chosen = current && covered(current) === 0 ? current : best.spot;
        card.dataset.spot = String(candidates.indexOf(chosen));
        Object.assign(card.style, { left: `${Math.max(8, chosen.left)}px`, top: `${Math.max(8, chosen.top)}px`, right: 'auto', bottom: 'auto' });
    }

    title.addEventListener('pointerdown', (event) => {
        const rect = card.getBoundingClientRect();
        const offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const move = (moved) => {
            dragged = {
                left: Math.min(Math.max(0, moved.clientX - offset.x), window.innerWidth - rect.width),
                top: Math.min(Math.max(0, moved.clientY - offset.y), window.innerHeight - rect.height)
            };
            placeCard(null);
        };
        const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        event.preventDefault();
    });

    function render() {
        if (!active) return;
        // A dialog the person opened (the run settings) sits above everything else on the page and makes the rest of it inert, so the card
        // and the ring move into it while it is open, and back out when it closes.
        const host = document.querySelector('dialog[open]') ?? document.body;
        if (ring.parentElement !== host) host.append(ring, card);
        const facts = { ...getFacts(), start: startDocument };
        const index = currentStepIndex(facts, reached, steps);
        reached = Math.max(reached, index);
        const step = steps[reached];
        const broken = brokenStepBefore(facts, reached, steps, skipped);
        card.hidden = false;
        progress.textContent = stepLabel(reached, steps);
        title.textContent = step.title;
        text.textContent = stepText(step, edition);
        if (link.dataset.step !== step.id) { linkNote.textContent = ''; link.dataset.step = step.id; }
        link.hidden = !step.link || !pageActions[step.link.action];
        link.textContent = step.link?.label ?? '';
        link.disabled = filling;
        linkNote.hidden = !linkNote.textContent;
        next.hidden = step.advance !== 'next';
        next.textContent = step.nextLabel ?? 'Next';
        fillButton.hidden = !step.fill || !pageActions[step.fill];
        fillButton.textContent = step.fillLabel ?? 'Fill this in for me';
        fillButton.disabled = filling;
        skip.hidden = step.id === 'finish';
        skipStep.hidden = step.advance === 'next' || !pageActions[step.skip];
        skipStep.disabled = filling;
        if (skipFailed !== reached) skipFailed = null;
        back.hidden = broken === null;
        notice.hidden = broken === null && skipFailed === null;
        if (skipFailed !== null && broken === null) notice.textContent = 'This step could not be done for you. Try it by hand, or skip it again.';
        if (broken !== null) {
            notice.textContent = `Something from step ${broken} is no longer there.`;
            back.textContent = `Go back to step ${broken}`;
            back.onclick = () => { reached = broken; render(); };
        }
        if (shownStep !== step) {
            shownStep = step;
            onStep(step, stepLabel(reached, steps));
        }
        const ringRect = placeRing(step, facts);
        placeCard(ringRect);
    }

    function finish(outcome) {
        if (!active) return;
        active = false;
        play += 1;
        filling = false;
        clearInterval(timer);
        shownStep = null;
        onStep(null, '');
        ring.hidden = true;
        card.hidden = true;
        onFinish(outcome, tutorial);
    }

    next.addEventListener('click', () => {
        if (steps[reached].id === 'finish') finish('completed');
        else { reached += 1; render(); }
    });
    skip.addEventListener('click', () => finish('skipped'));
    // Runs one of the page's actions for the step on screen, one at a time; returns what it returned.
    async function perform(name) {
        const step = steps[reached];
        if (filling || !pageActions[name]) return undefined;
        const ours = play;
        filling = true;
        render();
        try { return await pageActions[name](step); } finally { if (play === ours) { filling = false; render(); } }
    }
    fillButton.addEventListener('click', () => perform(steps[reached].fill));
    link.addEventListener('click', async () => {
        const said = await perform(steps[reached].link?.action);
        linkNote.textContent = typeof said === 'string' ? said : '';
        render();
    });
    skipStep.addEventListener('click', async () => {
        const index = reached;
        const step = steps[index];
        const ours = play;
        if (filling || step.advance === 'next') return;
        try { await perform(step.skip); } catch (error) { console.error(`Skipping the "${step.id}" step failed.`, error); }
        if (play !== ours) return;
        // A skip counts once the step is done; if it could not be done for the person, the card says so and stays, rather than moving on
        // to a step that needs it.
        const until = Date.now() + 3000;
        while (!step.done({ ...getFacts(), start: startDocument }) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
        if (play !== ours) return;
        if (!step.done({ ...getFacts(), start: startDocument })) {
            skipFailed = index;
            render();
            return;
        }
        skipped.add(index);
        if (active && reached === index) reached = index + 1;
        render();
    });
    window.addEventListener('resize', () => render());

    return {
        get active() { return active; },
        get step() { return active ? steps[reached].id : null; },
        get tutorial() { return active ? tutorial : null; },
        // `at` is the step to start on (a tutorial carried on after Konjugate restarted, say); it starts at the beginning otherwise.
        start(played, { start = null, at = null } = {}) {
            tutorial = played;
            // A step can be for one edition only (one that needs the desktop engine's checkpoints, say): left out of the others.
            steps = played.steps.filter((step) => !step.editions || step.editions.includes(edition));
            startDocument = start;
            card.setAttribute('aria-label', played.title);
            reached = Math.max(0, at ? steps.findIndex((step) => step.id === at) : 0);
            play += 1;
            filling = false;
            skipped.clear();
            skipFailed = null;
            linkNote.textContent = '';
            dragged = null;
            delete card.dataset.spot;
            active = true;
            clearInterval(timer);
            timer = setInterval(render, pollMilliseconds);
            render();
        },
        // Something changed that a step may be waiting for.
        notify: render,
        stop: () => finish('skipped')
    };
}
