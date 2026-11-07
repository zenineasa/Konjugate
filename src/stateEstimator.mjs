/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The mathematics of the live twin's estimator (docs/proposals/stateEstimator.md): a stochastic ensemble Kalman filter. An
// ensemble is an array of members, each an array of state values in one fixed order. Everything here is plain numbers, with the
// randomness drawn from a seeded generator, so the same readings and seed give the same estimates to the bit; running the model
// that moves the members is src/windowSession.mjs's.
//
//   seededNormal(seed)                      draws standard normal numbers, the same sequence for the same seed
//   initialEnsemble(mean, spread, count)    members spread about a mean, each state by its own standard deviation
//   perturb(members, sigmas)                the model's own uncertainty over a stretch, added to each member
//   analyse(members, observations)          the members moved toward readings by the Kalman gain the ensemble implies
//   ensembleStatistics(members)             each state's mean and spread
//   readingNoise(values)                    a sensor's noise from its readings' scatter about their own smooth course

// mulberry32, then Box–Muller: small, fast, and the same on every platform.
export function seededNormal(seed) {
    let state = (Number(seed) >>> 0) || 1;
    const uniform = () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return () => {
        if (spare !== null) {
            const value = spare;
            spare = null;
            return value;
        }
        let u = 0;
        while (u === 0) u = uniform();
        const v = uniform();
        const radius = Math.sqrt(-2 * Math.log(u));
        spare = radius * Math.sin(2 * Math.PI * v);
        return radius * Math.cos(2 * Math.PI * v);
    };
}

export function initialEnsemble(mean, spread, count, normal) {
    return Array.from({ length: count }, () => mean.map((value, index) => value + (spread[index] ?? 0) * normal()));
}

export function perturb(members, sigmas, normal) {
    return members.map((member) => member.map((value, index) => value + (sigmas[index] ? sigmas[index] * normal() : 0)));
}

export function ensembleStatistics(members) {
    const count = members.length;
    const size = members[0]?.length ?? 0;
    const mean = Array.from({ length: size }, (_, index) => members.reduce((sum, member) => sum + member[index], 0) / count);
    const spread = mean.map((average, index) => (count > 1 ? Math.sqrt(members.reduce((sum, member) => sum + (member[index] - average) ** 2, 0) / (count - 1)) : 0));
    return { mean, spread };
}

// Solves a x = b for a small symmetric positive definite a (one row per reading), by Gaussian elimination with partial pivoting.
function solve(matrix, rhs) {
    const size = matrix.length;
    const a = matrix.map((row, index) => [...row, ...rhs[index]]);
    const width = a[0].length;
    for (let column = 0; column < size; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < size; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
        if (!(Math.abs(a[pivot][column]) > 0)) throw new Error('The readings and the ensemble give no information to weigh: is every estimated reading\'s noise zero?');
        [a[column], a[pivot]] = [a[pivot], a[column]];
        for (let row = 0; row < size; row += 1) {
            if (row === column) continue;
            const factor = a[row][column] / a[column][column];
            if (!factor) continue;
            for (let k = column; k < width; k += 1) a[row][k] -= factor * a[column][k];
        }
    }
    return a.map((row, index) => row.slice(size).map((value) => value / row[index]));
}

// observations: [{ index, value, noise }]: the position of the measured state in a member, the reading, and its standard deviation;
// or [{ predictions, value, noise }], `predictions` being what each member predicted the reading would be (a reading taken before the
// analysis time, read off each member's own run to then: an asynchronous filter, which uses every reading of a stretch, not only
// the one at its end).
// updatable: which positions the analysis may change (a state the model computes from others is read, never set); all by default.
// bounds: [{ minimum, maximum }] or null per position, which a member is kept within. Answers the members after the analysis and
// the gain: for each position, how much it moved for one unit of each reading's innovation.
export function analyse(members, observations, normal, { updatable = null, bounds = [] } = {}) {
    if (!observations.length) return { members: members.map((member) => [...member]), gain: [] };
    const count = members.length;
    const size = members[0].length;
    const { mean } = ensembleStatistics(members);
    const anomalies = members.map((member) => member.map((value, index) => value - mean[index]));
    // What each member predicts for each reading, and how far from the members' mean prediction.
    const predicted = observations.map((observation) => observation.predictions ?? members.map((member) => member[observation.index]));
    const predictedMean = predicted.map((values) => values.reduce((sum, value) => sum + value, 0) / count);
    const predictedAnomalies = predicted.map((values, row) => values.map((value) => value - predictedMean[row]));
    // Covariances, from the ensemble: between the readings' predictions (m×m) and between every state and them (n×m).
    const between = predictedAnomalies.map((row) => predictedAnomalies.map((column) => row.reduce((sum, value, member) => sum + value * column[member], 0) / (count - 1)));
    const across = Array.from({ length: size }, (_, state) => predictedAnomalies.map((column) => anomalies.reduce((sum, anomaly, member) => sum + anomaly[state] * column[member], 0) / (count - 1)));
    const innovationCovariance = between.map((row, i) => row.map((value, j) => value + (i === j ? observations[i].noise ** 2 : 0)));
    // K = across · innovationCovariance⁻¹, found as (innovationCovariance⁻¹ · acrossᵀ)ᵀ since the matrix is symmetric.
    const solved = solve(innovationCovariance, observations.map((_, i) => across.map((row) => row[i])));
    const gain = Array.from({ length: size }, (_, state) => observations.map((_, i) => solved[i][state]));
    const canChange = (index) => (updatable ? updatable[index] : true);
    const updated = members.map((member, memberIndex) => {
        // Each member is moved toward the readings perturbed by their own noise, which keeps the analysis spread honest.
        const innovation = observations.map((observation, row) => observation.value + observation.noise * normal() - predicted[row][memberIndex]);
        return member.map((value, index) => {
            if (!canChange(index)) return value;
            let next = value + gain[index].reduce((sum, weight, i) => sum + weight * innovation[i], 0);
            const bound = bounds[index];
            if (bound) next = Math.min(Math.max(next, bound.minimum), bound.maximum);
            return next;
        });
    });
    return { members: updated, gain };
}

// The share of a state's uncertainty one reading removes (0 to 1), from the members before the analysis: the squared correlation of
// the state with the measured state, times how much of the measured state's spread the reading can see past its own noise
// (var / (var + noise²)). How "the readings reach" a state the data does not measure is told.
export function explainedShare(members, stateIndex, observation) {
    const { mean } = ensembleStatistics(members);
    const predictions = observation.predictions ?? members.map((member) => member[observation.index]);
    const predictedMean = predictions.reduce((sum, value) => sum + value, 0) / predictions.length;
    let covariance = 0;
    let stateVariance = 0;
    let readingVariance = 0;
    for (const [memberIndex, member] of members.entries()) {
        const a = member[stateIndex] - mean[stateIndex];
        const b = predictions[memberIndex] - predictedMean;
        covariance += a * b;
        stateVariance += a * a;
        readingVariance += b * b;
    }
    if (!(stateVariance > 0) || !(readingVariance > 0)) return 0;
    const correlationSquared = covariance * covariance / (stateVariance * readingVariance);
    const variance = readingVariance / (members.length - 1);
    return correlationSquared * variance / (variance + observation.noise ** 2);
}

// The share of a state's uncertainty a set of readings removes together (0 to 1): what the analysis would take off its variance,
// P_xy (P_yy + R)⁻¹ P_yx, over its variance; for one reading, the same as explainedShare.
export function explainedShareTogether(members, stateIndex, observations) {
    if (!observations.length) return 0;
    const count = members.length;
    const { mean } = ensembleStatistics(members);
    const stateAnomaly = members.map((member) => member[stateIndex] - mean[stateIndex]);
    const variance = stateAnomaly.reduce((sum, value) => sum + value * value, 0) / (count - 1);
    if (!(variance > 0)) return 0;
    const predicted = observations.map((observation) => observation.predictions ?? members.map((member) => member[observation.index]));
    const anomalies = predicted.map((values) => {
        const average = values.reduce((sum, value) => sum + value, 0) / count;
        return values.map((value) => value - average);
    });
    const across = anomalies.map((row) => row.reduce((sum, value, member) => sum + value * stateAnomaly[member], 0) / (count - 1));
    const between = anomalies.map((row, i) => anomalies.map((column, j) => row.reduce((sum, value, member) => sum + value * column[member], 0) / (count - 1) + (i === j ? observations[i].noise ** 2 : 0)));
    let solved;
    try {
        solved = solve(between, across.map((value) => [value]));
    } catch {
        return 0;
    }
    const removed = across.reduce((sum, value, i) => sum + value * solved[i][0], 0);
    return Math.max(0, Math.min(1, removed / variance));
}

// A sensor's noise, as a standard deviation, from readings taken in time order: the scatter of their second differences, which a
// smooth course (a heating curve, a slow drift) hardly affects but noise does (for independent noise of deviation σ, a second
// difference has deviation σ√6). Null with fewer than five readings.
export function readingNoise(values) {
    if (values.length < 5) return null;
    const differences = [];
    for (let index = 1; index < values.length - 1; index += 1) differences.push(values[index + 1] - 2 * values[index] + values[index - 1]);
    return Math.sqrt(differences.reduce((sum, value) => sum + value * value, 0) / differences.length / 6);
}

// The value at a fraction (0 to 1) of the way through sorted values, between the two either side.
export function quantile(sorted, fraction) {
    if (!sorted.length) return NaN;
    const position = (sorted.length - 1) * fraction;
    const below = Math.floor(position);
    const above = Math.min(below + 1, sorted.length - 1);
    return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}
