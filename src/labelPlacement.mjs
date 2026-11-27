/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where a label on a line stands (a read's chip, "→ measurement", and a relationship's, "PidController → Room"): the first spot along
// its own line that covers no node card, so it never hides a card's title or values. The spot it has is kept while it stays clear, so
// labels do not hop about as the view moves. No DOM: the window measures, this chooses (tests/labelPlacement.test.mjs).

// The spots to try along a line, as fractions of it, in order: `current` (where it stands now) first, then `usual`, then ever further
// from `usual` on both sides, short of the line's ends (a label there would sit on a node).
export function labelSpotPreferences(usual, current = null) {
    const spots = [];
    const add = (t) => {
        const rounded = Math.round(t * 100) / 100;
        if (rounded >= 0.12 && rounded <= 0.88 && !spots.includes(rounded)) spots.push(rounded);
    };
    if (Number.isFinite(current)) add(current);
    add(usual);
    for (let step = 0.1; step < 0.8; step += 0.1) {
        add(usual + step);
        add(usual - step);
    }
    add(0.88);
    add(0.12);
    return spots;
}

// The spot, of `spots` ([{ t, x, y }], on screen, in preference order), at which a label of `size` ({ width, height }, centred on the
// spot) covers none of `obstacles` ([{ left, top, right, bottom }]); with none clear, the one covering least. Null for no spots.
export function clearLabelSpot(spots, size, obstacles) {
    let best = null;
    let bestCovered = Infinity;
    for (const spot of spots) {
        const rect = { left: spot.x - size.width / 2, right: spot.x + size.width / 2, top: spot.y - size.height / 2, bottom: spot.y + size.height / 2 };
        let covered = 0;
        for (const obstacle of obstacles) {
            const width = Math.min(rect.right, obstacle.right) - Math.max(rect.left, obstacle.left);
            const height = Math.min(rect.bottom, obstacle.bottom) - Math.max(rect.top, obstacle.top);
            if (width > 0 && height > 0) covered += width * height;
        }
        if (covered === 0) return spot;
        if (covered < bestCovered) { best = spot; bestCovered = covered; }
    }
    return best;
}
