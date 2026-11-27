/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A read's chip ("→ measurement") and a relationship's label ("PidController → Room") stood at a fixed point along their lines, and in
// examples/pidController/HeatedRoomPid.kjt covered the Room card's title and its Temperature value (round 5). Each now takes the first
// spot along its own line clear of every node card, keeping the spot it has while that stays clear, so it does not hop about.

import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLabelSpot, labelSpotPreferences } from '../src/labelPlacement.mjs';

// On screen (pixels, y down): the Room card to the right of Room's box, and a read from Room (left) to an FMU input (right).
const roomCard = { left: 760, top: 520, right: 940, bottom: 620 };
const along = (t) => ({ t, x: 650 + (1030 - 650) * t, y: 600 + (460 - 600) * t });
const size = { width: 96, height: 18 };

test('a label takes the first spot along its line that covers no card', () => {
    const spots = labelSpotPreferences(0.4).map(along);
    const chosen = clearLabelSpot(spots, size, [roomCard]);
    const rect = { left: chosen.x - 48, right: chosen.x + 48, top: chosen.y - 9, bottom: chosen.y + 9 };
    assert.ok(rect.left >= roomCard.right || rect.right <= roomCard.left || rect.top >= roomCard.bottom || rect.bottom <= roomCard.top, `It covers the card: ${JSON.stringify(rect)}`);
    assert.notEqual(chosen.t, 0.4, 'Where it stood before covered the card.');
    assert.equal(clearLabelSpot(labelSpotPreferences(0.4).map(along), size, []).t, 0.4, 'With nothing in the way, where it always stood.');
});

test('a label keeps the spot it has while that stays clear, and with nowhere clear takes the one covering least', () => {
    assert.deepEqual(labelSpotPreferences(0.5, 0.8).slice(0, 2), [0.8, 0.5], 'Its current spot first, then its usual one.');
    assert.equal(clearLabelSpot(labelSpotPreferences(0.4, 0.8).map(along), size, [roomCard]).t, 0.8);
    const everywhere = { left: 0, top: 0, right: 2000, bottom: 2000 };
    // Covering everything below y = 470: every spot is covered, the highest on the line (the end nearest the FMU) least.
    const partly = { left: 0, top: 470, right: 2000, bottom: 2000 };
    const chosen = clearLabelSpot(labelSpotPreferences(0.4).map(along), size, [partly]);
    assert.ok(chosen.t >= 0.8, `The spot least covered is the highest on the line: ${chosen.t}`);
    assert.ok(clearLabelSpot(labelSpotPreferences(0.4).map(along), size, [everywhere]), 'Some spot, even when all are covered.');
    assert.equal(clearLabelSpot([], size, [roomCard]), null);
});
