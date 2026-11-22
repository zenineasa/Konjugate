/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Undamped harmonic oscillator: a 1 kg mass on a 1 N/m spring, released from 1 m at rest, one node.
//     dx/dt = v        dv/dt = -(k/m) x
// Reference: x(t) = x0 cos ωt, v(t) = -x0 ω sin ωt, ω = √(k/m); its energy ½ k x² + ½ m v² is constant.
// The node lists the displacement before the velocity, so a semi-implicit node updates x from the old v and then v from the new x
// (symplectic Euler).

import { join } from 'node:path';
import { evaluateConservative } from '../../lib/conservative.mjs';
import { createModel, negate, parameter, product, quotient, state } from '../../lib/project.mjs';
import { createChecks } from '../../lib/study.mjs';

export const directory = import.meta.dirname;
export const modelPath = join(directory, 'harmonicOscillator.kjt');
export const constants = Object.freeze({ mass: 1, stiffness: 1, initialDisplacement: 1 });

export function build() {
    const model = createModel('Benchmark: harmonic oscillator');
    const body = model.node('Mass on a spring', { type: 'Spring-mass', color: '#5d7885', states: [
        ['displacement', 'Displacement', constants.initialDisplacement, 'm'],
        ['velocity', 'Velocity', 0, 'm/s']
    ] });
    model.sourceTerm(body, 'displacement', 'velocity', { velocity: state(body, 'velocity') });
    model.sourceTerm(body, 'velocity', quotient(negate(product('stiffness', 'displacement')), 'mass'), {
        stiffness: parameter('Stiffness', constants.stiffness, 'N/m'), displacement: state(body, 'displacement'), mass: parameter('Mass', constants.mass, 'kg')
    });
    return { document: model.document({ runConfiguration: { name: 'Benchmark', globalTimeStep: 2 ** -6, outputInterval: 0.25 } }), ids: [body.stateIds.displacement, body.stateIds.velocity] };
}

export const models = { harmonicOscillator: () => build().document };

export function reference(times) {
    const omega = Math.sqrt(constants.stiffness / constants.mass);
    const x0 = constants.initialDisplacement;
    return times.map((time) => [x0 * Math.cos(omega * time), -x0 * omega * Math.sin(omega * time)]);
}

const energy = ([x, v]) => 0.5 * constants.stiffness * x * x + 0.5 * constants.mass * v * v;

export const convergenceCase = { title: 'Harmonic oscillator', modelPath, stateIds: () => build().ids, reference, unit: 'm, m/s' };

export async function evaluate({ engine, config }) {
    const { add, checks } = createChecks(config.thresholds);
    const { rows, plots } = await evaluateConservative({
        engine, config, add, modelPath, modelName: 'harmonicOscillator', stateIds: build().ids, reference, energy,
        energyScale: energy([constants.initialDisplacement, 0]), title: 'Harmonic oscillator', unit: 'm, m/s', plotPrefix: 'oscillator',
        plotUnits: { stateName: 'displacement', stateAxis: 'Displacement (m)', energyScaleName: 'E(0)' }
    });
    return { rows, checks, plots, notes: [] };
}
