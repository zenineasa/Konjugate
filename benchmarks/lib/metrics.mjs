/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The error measures every benchmark reports, defined once so they mean the same thing in every row of the results.
//
// Given a Konjugate trajectory and a reference trajectory sampled at the same times (an array of samples, each an array of the compared
// states' values):
//   maxAbsError    the largest |konjugate - reference| over every compared state and sample, in the states' own unit
//   rmse           the root mean square of the same differences over every compared state and sample
//   relativeError  per state, its largest absolute error divided by the reference's range over the run (max - min); the largest over the
//                  states. A state's range is used rather than its value so a temperature near 300 K or a voltage passing through zero
//                  is judged against how much it actually moves.

export function errorMetrics(konjugate, reference) {
    if (konjugate.length !== reference.length) throw new Error(`Trajectories differ in length: ${konjugate.length} and ${reference.length} samples.`);
    const stateCount = reference[0].length;
    const largest = new Array(stateCount).fill(0);
    const minimum = new Array(stateCount).fill(Infinity);
    const maximum = new Array(stateCount).fill(-Infinity);
    let squares = 0;
    let count = 0;
    for (let sample = 0; sample < reference.length; ++sample) {
        for (let state = 0; state < stateCount; ++state) {
            const exact = reference[sample][state];
            const difference = konjugate[sample][state] - exact;
            if (!Number.isFinite(difference)) return { maxAbsError: Infinity, rmse: Infinity, relativeError: Infinity };
            largest[state] = Math.max(largest[state], Math.abs(difference));
            minimum[state] = Math.min(minimum[state], exact);
            maximum[state] = Math.max(maximum[state], exact);
            squares += difference * difference;
            count += 1;
        }
    }
    const relative = largest.map((error, state) => {
        const range = maximum[state] - minimum[state];
        return range > 0 ? error / range : (error === 0 ? 0 : Infinity);
    });
    return { maxAbsError: Math.max(...largest), rmse: Math.sqrt(squares / count), relativeError: Math.max(...relative) };
}

// The order p in error ≈ C hᵖ: from each successive pair of step sizes (log2 of the error ratio when the step halves), and as the
// least-squares slope of log(error) against log(h) over all of them.
export function observedOrder(stepSizes, errors) {
    const pairwise = [];
    for (let index = 1; index < stepSizes.length; ++index) {
        pairwise.push(Math.log(errors[index - 1] / errors[index]) / Math.log(stepSizes[index - 1] / stepSizes[index]));
    }
    const x = stepSizes.map(Math.log);
    const y = errors.map(Math.log);
    const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
    const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
    let covariance = 0;
    let variance = 0;
    for (let index = 0; index < x.length; ++index) {
        covariance += (x[index] - meanX) * (y[index] - meanY);
        variance += (x[index] - meanX) ** 2;
    }
    return { pairwise, fitted: covariance / variance, finest: pairwise.at(-1) };
}

// For a conserved quantity's values over a run: the largest relative departure from its initial value, and the final one.
export function conservationDrift(values, scale = Math.abs(values[0])) {
    let largest = 0;
    for (const value of values) largest = Math.max(largest, Math.abs(value - values[0]));
    if (!Number.isFinite(largest)) return { maxRelativeDrift: Infinity, finalRelativeDrift: Infinity };
    return { maxRelativeDrift: largest / scale, finalRelativeDrift: (values.at(-1) - values[0]) / scale };
}

export function median(values) {
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median, minimum, maximum and the median absolute deviation, for repeated timings.
export function spread(values) {
    const centre = median(values);
    return {
        median: centre,
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        medianAbsoluteDeviation: median(values.map((value) => Math.abs(value - centre))),
        count: values.length
    };
}

// A timing's statistics: spread() with the quartiles, the interquartile range, the minimum over the median and the runs themselves. The
// headline of every timing is its minimum (benchmarks/README.md, Timing): noise on a computer only ever adds time.
export function timingStatistics(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    // Quartiles by linear interpolation between order statistics (the R-7 rule, NumPy's default).
    const quantile = (q) => {
        const position = (sorted.length - 1) * q;
        const below = Math.floor(position);
        return sorted[below] + (sorted[Math.min(below + 1, sorted.length - 1)] - sorted[below]) * (position - below);
    };
    const basic = spread(values);
    return {
        ...basic, lowerQuartile: quantile(0.25), upperQuartile: quantile(0.75), interquartileRange: quantile(0.75) - quantile(0.25),
        minimumOverMedian: basic.median > 0 ? basic.minimum / basic.median : null, values: values.slice()
    };
}
