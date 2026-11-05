/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The ownership block (docs/proposals/modelOwnership.md) every shipped example carries, so that a model opened from Konjugate's own examples
// says whose work it is and on what terms, and a copy a person saves from one keeps that attribution (they can take it over with "Make this
// my own", which records where it came from). The examples are Konjugate's, under the 0BSD license, so anyone may use, change and share them for any purpose with no conditions at all; the license text is in examples/LICENSE.
//
// The save times are fixed rather than read from the clock: they are the times the examples were stamped, so building the examples again
// gives the same files, and a copy saved from one reports when the example itself first existed, not when someone first saved their copy.

import { normalizeOwnership } from '../src/ownership.mjs';

export const exampleOwner = 'Zenin Easa Panthakkalakath';
export const exampleSavedAt = '2026-11-05T06:00:00Z';
export const exampleSavedWith = '1.3.6';

export function exampleOwnership(title) {
    return normalizeOwnership({
        title,
        owner: exampleOwner,
        copyright: `Copyright © 2026 ${exampleOwner}`,
        license: { id: '0BSD' },
        contact: 'info@konjugate.com',
        firstSavedAt: exampleSavedAt,
        lastSavedAt: exampleSavedAt,
        savedWith: exampleSavedWith
    });
}

// The title of an example: the first heading of its guide.
export function exampleTitle(guide) {
    const match = /^# (.+)$/m.exec(guide);
    if (!match) throw new Error('The example guide has no title heading.');
    return match[1].trim();
}
