/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Checks that a file is a Konjugate data log (docs/connectingADataSource.md), with the same reader Konjugate will use, and says
// what is in it. For anyone writing their own logger: run it on what your program writes.
//
//   node scripts/checkDataLog.mjs path/to/log.csv
//
// Exits 0 and prints a summary when the file is good; exits 1 with the line and the reason when it is not.

import { readFile } from 'node:fs/promises';
import { DataLogError, readDataLog } from '../src/dataLog.mjs';

const path = process.argv[2];
if (!path) {
    console.error('Usage: node scripts/checkDataLog.mjs path/to/log.csv');
    process.exit(2);
}

try {
    const { header, observations } = readDataLog(await readFile(path));
    // Rows go forward in time, so the first and last observations span the log (spreading a long log into Math.min would overflow).
    const clock = header.epoch === null ? 'seconds since the start' : `seconds since ${new Date(header.epoch).toISOString()}`;
    console.log(`${path} is a Konjugate data log${header.source ? ` from ${header.source}` : ''}.`);
    console.log(observations.length ? `Time: ${clock}, from ${observations[0].time} to ${observations.at(-1).time}.` : `Time: ${clock}. It has no readings yet.`);
    for (const signal of header.signals) {
        const own = observations.filter((observation) => observation.signal === signal.name);
        const flagged = own.filter((observation) => observation.quality !== 'good').length;
        const corrected = own.filter((observation) => observation.revision > 0).length;
        const notes = [flagged && `${flagged} not good`, corrected && `${corrected} corrections`].filter(Boolean);
        console.log(`  ${signal.name} [${signal.unit}], ${signal.role === 'input' ? 'an input' : 'an output'}: ${own.length} readings${notes.length ? ` (${notes.join(', ')})` : ''}`);
    }
} catch (error) {
    if (!(error instanceof DataLogError)) throw error;
    console.error(`${path} is not a valid Konjugate data log. ${error.message}`);
    process.exit(1);
}
