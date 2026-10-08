// Copyright © 2026 Zenin Easa Panthakkalakath

// Which node labels the canvas leaves out where they would overlap. A label is a card of a fixed size on screen,
// whatever the zoom: a model of a hundred nodes seen whole is then a pile of cards, none readable. Labels are taken
// in order of importance and one that would overlap a label already written is left out, as a map leaves out a
// village's name beside a city's. Zooming in spreads the nodes and brings the names back; pointing at a shape or
// selecting it always shows its label.

// Models up to this many nodes keep every label: there the cards seldom meet, and where two do the user can tell
// them apart.
export const declutterAbove = 30;

// `labels`: [{ id, left, top, width, height, priority, keep, shown }] in screen pixels. `keep`: must stay (selected,
// pointed at, flagged); `priority`: higher is written first (a node's number of relationships); `shown`: it was
// written last time, which breaks a tie in its favour so labels do not flicker as the camera moves. Returns the ids
// to leave out, as a Set.
export function declutterLabels(labels, { gap = 2 } = {}) {
    const order = [...labels].sort((a, b) => (Number(Boolean(b.keep)) - Number(Boolean(a.keep))) || ((b.priority ?? 0) - (a.priority ?? 0))
        || (Number(Boolean(b.shown)) - Number(Boolean(a.shown))) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const written = [];
    const hidden = new Set();
    for (const label of order) {
        const box = { left: label.left - gap, right: label.left + label.width + gap, top: label.top - gap, bottom: label.top + label.height + gap };
        const overlaps = written.some((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom);
        if (overlaps && !label.keep) hidden.add(label.id);
        else written.push(box);
    }
    return hidden;
}
