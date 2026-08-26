/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Deterministic pseudo-random generator (mulberry32), used instead of a smooth formula like a
// sinusoid: a smooth curve is strongly autocorrelated with itself, which the engine-side unit
// tests (engine/tests/causalInferenceTests.cpp) found leaks information across lags in exactly
// the way real noise must not, producing a spurious reverse edge. Shared between
// tests/interactionRunner.mjs's causal-inference tests and tests/engine/continuousTimeDrift.mjs.
export function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function gaussianFrom(random) {
    const u1 = Math.max(random(), 1e-9);
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// An 8-node electronics-enclosure thermal/vibration system: 3 independent AR(1) roots
// (ambientTemperature, motorLoad, solarIrradiance), 5 downstream nodes, 12 true lagged edges (one
// quadratic: componentTemperature -> thermalStress). See tests/interactionRunner.mjs's "recovers
// most of a realistic 8-node, 12-edge system" test for the full history of why this system exists
// and what it validates.
export function buildThermalSystemCsv(rowCount = 3000) {
    const random = mulberry32(8080);
    const amb = new Array(rowCount), motor = new Array(rowCount), solar = new Array(rowCount);
    amb[0] = 0.2; motor[0] = 0.1; solar[0] = 0.15;
    for (let t = 1; t < rowCount; t += 1) {
        amb[t] = 0.5 * amb[t - 1] + 0.3 * gaussianFrom(random);
        motor[t] = 0.5 * motor[t - 1] + 0.3 * gaussianFrom(random);
        solar[t] = 0.5 * solar[t - 1] + 0.3 * gaussianFrom(random);
    }
    const enc = new Array(rowCount), vib = new Array(rowCount);
    for (let t = 0; t < rowCount; t += 1) {
        const pAmb = t > 0 ? amb[t - 1] : amb[0], pMotor = t > 0 ? motor[t - 1] : motor[0], pSolar = t > 0 ? solar[t - 1] : solar[0];
        enc[t] = 2.0 * pAmb + 1.5 * pSolar + 0.05 * gaussianFrom(random);
        vib[t] = 3.0 * pMotor + 0.4 * gaussianFrom(random);
    }
    const comp = new Array(rowCount);
    for (let t = 0; t < rowCount; t += 1) {
        const pEnc = t > 0 ? enc[t - 1] : enc[0], pMotor = t > 0 ? motor[t - 1] : motor[0], pAmb = t > 0 ? amb[t - 1] : amb[0];
        comp[t] = 2.5 * pEnc + 1.0 * pMotor + 1.0 * pAmb + 0.05 * gaussianFrom(random);
    }
    const stress = new Array(rowCount);
    for (let t = 0; t < rowCount; t += 1) {
        const pComp = t > 0 ? comp[t - 1] : comp[0], pAmb = t > 0 ? amb[t - 1] : amb[0];
        stress[t] = 3.5 * pComp + 0.8 * pComp * pComp + 2.0 * pAmb + 0.05 * gaussianFrom(random);
    }
    const fatigue = new Array(rowCount);
    for (let t = 0; t < rowCount; t += 1) {
        const pStress = t > 0 ? stress[t - 1] : stress[0], pVib = t > 0 ? vib[t - 1] : vib[0];
        const pComp = t > 0 ? comp[t - 1] : comp[0], pMotor = t > 0 ? motor[t - 1] : motor[0];
        fatigue[t] = 1.5 * pStress + 1.2 * pVib + 1.0 * pComp + 0.8 * pMotor + 0.6 * gaussianFrom(random);
    }
    const columnNames = ['ambientTemperature', 'motorLoad', 'solarIrradiance', 'enclosureTemperature',
        'vibrationAmplitude', 'componentTemperature', 'thermalStress', 'fatigueAccumulation'];
    const lines = [['time', ...columnNames].join(',')];
    for (let t = 0; t < rowCount; t += 1) {
        lines.push([t, amb[t], motor[t], solar[t], enc[t], vib[t], comp[t], stress[t], fatigue[t]].join(','));
    }
    return `${lines.join('\n')}\n`;
}
