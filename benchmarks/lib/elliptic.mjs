/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Jacobi elliptic functions and the complete elliptic integral of the first kind, by the arithmetic-geometric mean (Abramowitz and
// Stegun, Handbook of Mathematical Functions, 16.4 and 17.6). They give the exact motion of a pendulum released from rest at any
// amplitude below the top. The parameter is m = k², as in A&S and scipy.special.ellipj, which the reference generator checks against.

function arithmeticGeometricMean(parameter) {
    const a = [1];
    const c = [Math.sqrt(parameter)];
    let b = Math.sqrt(1 - parameter);
    while (Math.abs(c.at(-1)) > 1e-17 * a.at(-1) && a.length < 64) {
        const previous = a.at(-1);
        a.push((previous + b) / 2);
        c.push((previous - b) / 2);
        b = Math.sqrt(previous * b);
    }
    return { a, c };
}

export function completeEllipticK(parameter) {
    if (!(parameter >= 0 && parameter < 1)) throw new Error('The elliptic parameter must be in [0, 1).');
    return Math.PI / (2 * arithmeticGeometricMean(parameter).a.at(-1));
}

export function jacobiElliptic(argument, parameter) {
    if (!(parameter >= 0 && parameter < 1)) throw new Error('The elliptic parameter must be in [0, 1).');
    const { a, c } = arithmeticGeometricMean(parameter);
    const steps = a.length - 1;
    let phi = 2 ** steps * a[steps] * argument;
    let previous = phi;
    for (let n = steps; n >= 1; --n) {
        previous = phi;
        phi = (phi + Math.asin((c[n] / a[n]) * Math.sin(phi))) / 2;
    }
    const sn = Math.sin(phi);
    const cn = Math.cos(phi);
    const dn = steps ? cn / Math.cos(previous - phi) : 1;
    return { sn, cn, dn };
}

// A pendulum θ'' = -(g/L) sin θ released from rest at θ0 (|θ0| < π): θ(t) = 2 asin(k sn(K - ω0 t, k²)), θ'(t) = -2 k ω0 cn(K - ω0 t, k²),
// k = sin(θ0/2), ω0 = √(g/L), K = K(k²). Its period is 4K/ω0.
export function pendulumMotion({ gravity, length, initialAngle }, times) {
    const naturalFrequency = Math.sqrt(gravity / length);
    const modulus = Math.sin(initialAngle / 2);
    const parameter = modulus * modulus;
    const quarter = completeEllipticK(parameter);
    return times.map((time) => {
        const { sn, cn } = jacobiElliptic(quarter - naturalFrequency * time, parameter);
        return [2 * Math.asin(modulus * sn), -2 * modulus * naturalFrequency * cn];
    });
}

export function pendulumPeriod({ gravity, length, initialAngle }) {
    const modulus = Math.sin(initialAngle / 2);
    return 4 * completeEllipticK(modulus * modulus) / Math.sqrt(gravity / length);
}
