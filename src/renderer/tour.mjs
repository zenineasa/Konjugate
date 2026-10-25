/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The guided first-model tour's controller (docs/proposals/guidedTour.md): a card that says what to do next, a ring around the control
// it is about, and a check, every few hundred milliseconds and whenever told something happened, of whether the person has done it.
// What the steps say and how each is judged lives in ../tour/tourSteps.mjs, shared by both editions; what this file knows about the
// page is only what it is handed: how to read the facts the checks need, and how to fill a step in.

import { brokenStepBefore, currentStepIndex, stepText, tourSteps } from '../tour/tourSteps.mjs';

const element = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
};

// getFacts() -> { document, ui }; fill: { [name]: async () => void }; edition: 'desktop' | 'web';
// onFinish(outcome) with 'completed' or 'skipped', after the tour has gone from the screen.
export function createTour({ getFacts, fill = {}, edition, onFinish = () => {}, pollMilliseconds = 300 }) {
    let reached = 0;
    let active = false;
    let timer = null;
    let filling = false;
    const ring = element('div', 'tourRing');
    ring.hidden = true;
    ring.setAttribute('aria-hidden', 'true');
    const card = element('section', 'tourFloating');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Guided tour');
    card.hidden = true;
    const progress = element('span', 'tourProgress');
    const title = element('strong', 'tourTitle');
    const text = element('p', 'tourText');
    const notice = element('p', 'tourNotice');
    const back = element('button', 'tourLink', '');
    back.type = 'button';
    const fillButton = element('button', 'tourSecondary', 'Fill this in for me');
    fillButton.type = 'button';
    const next = element('button', 'tourPrimary', 'Next');
    next.type = 'button';
    const skip = element('button', 'tourLink', 'Skip tour');
    skip.type = 'button';
    const actions = element('div', 'tourActions');
    actions.append(skip, fillButton, next);
    card.append(progress, title, text, notice, back, actions);
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
        const facts = getFacts();
        const index = currentStepIndex(facts, reached);
        reached = Math.max(reached, index);
        const step = tourSteps[reached];
        const broken = brokenStepBefore(facts, reached);
        card.hidden = false;
        progress.textContent = step.id === 'welcome' ? '' : `Step ${reached} of ${tourSteps.length - 2}`;
        title.textContent = step.title;
        text.textContent = stepText(step, edition);
        next.hidden = step.advance !== 'next';
        next.textContent = step.nextLabel ?? 'Next';
        fillButton.hidden = !step.fill || !fill[step.fill];
        fillButton.disabled = filling;
        skip.hidden = step.id === 'finish';
        back.hidden = broken === null;
        notice.hidden = broken === null;
        if (broken !== null) {
            notice.textContent = `Something from step ${broken} is no longer there.`;
            back.textContent = `Go back to step ${broken}`;
            back.onclick = () => { reached = broken; render(); };
        }
        const ringRect = placeRing(step, facts);
        placeCard(ringRect);
    }

    function finish(outcome) {
        if (!active) return;
        active = false;
        clearInterval(timer);
        ring.hidden = true;
        card.hidden = true;
        onFinish(outcome);
    }

    next.addEventListener('click', () => {
        if (tourSteps[reached].id === 'finish') finish('completed');
        else { reached += 1; render(); }
    });
    skip.addEventListener('click', () => finish('skipped'));
    fillButton.addEventListener('click', async () => {
        const step = tourSteps[reached];
        if (filling || !fill[step.fill]) return;
        filling = true;
        render();
        try { await fill[step.fill](); } finally { filling = false; render(); }
    });
    window.addEventListener('resize', () => render());

    return {
        get active() { return active; },
        get step() { return active ? tourSteps[reached].id : null; },
        start() {
            reached = 0;
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
