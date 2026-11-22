/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A simple pendulum at large amplitude: 1 m long, released from rest at 2 rad (about 115°), where sin θ is far from θ. One node.
//     dθ/dt = ω        dω/dt = -(g/L) sin θ
// Reference: the exact solution in Jacobi elliptic functions, θ(t) = 2 asin(k sn(K - ω0 t, k²)), ω(t) = -2 k ω0 cn(K - ω0 t, k²), with
// k = sin(θ0/2), ω0 = √(g/L), K = K(k²) (benchmarks/lib/elliptic.mjs). reference.json holds the same motion from scipy.special.ellipj and
// from solve_ivp (DOP853, rtol 1e-12), which the run checks against.
// Energy per unit mass, E = ½ L² ω² - g L cos θ, is constant; its drift is reported relative to E(0) + g L, the energy above the bottom.

import { join } from 'node:path';
import { evaluateConservative } from '../../lib/conservative.mjs';
import { pendulumMotion, pendulumPeriod } from '../../lib/elliptic.mjs';
import { createModel, negate, parameter, product, quotient, state } from '../../lib/project.mjs';
import { createChecks, referenceAgreement, referenceData } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'pendulum.kjt');
export const constants = Object.freeze({ gravity: 9.81, length: 1, initialAngle: 2 });

export function build() {
    const model = createModel('Benchmark: pendulum at large amplitude');
    const bob = model.node('Pendulum', { type: 'Pendulum', color: '#5d7885', shape: 'sphere', states: [
        ['angle', 'Angle', constants.initialAngle, 'rad'],
        ['angularVelocity', 'Angular velocity', 0, 'rad/s']
    ] });
    model.sourceTerm(bob, 'angle', 'angularVelocity', { angularVelocity: state(bob, 'angularVelocity') });
    model.sourceTerm(bob, 'angularVelocity', quotient(negate(product('gravity', ['Sin', 'angle'])), 'length'), {
        gravity: parameter('Gravity', constants.gravity, 'm/s²'), angle: state(bob, 'angle'), length: parameter('Length', constants.length, 'm')
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -10, outputInterval: 2 ** -4 } }), ids: [bob.stateIds.angle, bob.stateIds.angularVelocity] };
}

export const models = { pendulum: () => build().document };

export const reference = (times) => pendulumMotion(constants, times);

const energy = ([angle, angularVelocity]) => 0.5 * constants.length ** 2 * angularVelocity ** 2 - constants.gravity * constants.length * Math.cos(angle);

export const convergenceCase = { title: 'Pendulum (θ0 = 2 rad)', modelPath, stateIds: () => build().ids, reference, unit: 'rad, rad/s' };

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const { rows, plots } = await evaluateConservative({
        engine, config, add, modelPath, modelName: 'pendulum', stateIds: build().ids, reference, energy,
        energyScale: energy([constants.initialAngle, 0]) + constants.gravity * constants.length, title: 'Pendulum', unit: 'rad, rad/s', plotPrefix: 'pendulum',
        plotUnits: { stateName: 'angle', stateAxis: 'Angle (rad)', energyScaleName: '(E(0) + g L)' }
    });
    const data = referenceData(directory);
    add('referenceAgreementElliptic', data ? referenceAgreement(reference(data.cases.elliptic.times), data.cases.elliptic.states) : NaN,
        'This reference against scipy.special.ellipj (reference.json), largest difference relative to each column\'s magnitude');
    add('referenceAgreementSolveIvp', data ? referenceAgreement(reference(data.cases.solveIvp.times), data.cases.solveIvp.states) : NaN,
        'This reference against SciPy solve_ivp, DOP853 at rtol = atol = 1e-12 (reference.json), relative to each column\'s magnitude: a numerical check, not an exact one');
    return { rows, checks, plots, notes: [`Period at θ0 = ${constants.initialAngle} rad: ${pendulumPeriod(constants).toFixed(6)} s (small-angle formula: ${(2 * Math.PI / Math.sqrt(constants.gravity / constants.length)).toFixed(6)} s).`] };
}
