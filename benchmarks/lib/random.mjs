/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Seeded pseudo-random numbers for the generated benchmarks, so a generated graph or dataset is the same on every machine and every run.
// mulberry32: 32-bit state, integer arithmetic only (Math.imul), so its sequence does not depend on the platform's floating point. The
// same generator as tests/fixtures/thermalSystemCsv.mjs, kept here so the benchmarks do not depend on the test fixtures.

export function mulberry32(seed) {
    let state = seed | 0;
    return function next() {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A standard normal variate by the Box–Muller transform (its cosine half), from two uniforms of `random`.
export function gaussian(random) {
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export const uniform = (random, low, high) => low + (high - low) * random();
export const integerBelow = (random, count) => Math.min(count - 1, Math.floor(random() * count));
