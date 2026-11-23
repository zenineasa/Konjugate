/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A model with nodes integrated with Verlet (numerics.integration "verlet", docs/proposals/integrators.md, Verlet, node by node),
// checked against the engine by the code export and FMU fidelity tests:
//
//   Drive (explicit Euler)         d' = -d
//   Mass (Verlet, speed first,     v' = -k x + 0.2 t + c d   (c d through a relationship from Drive, read from the snapshot)
//         3 substeps)              x' = v                    velocity Verlet: v kicked, x drifted at the substep's middle
//   Pendulum (Verlet, position     θ' = ω                    position Verlet: θ kicked, ω drifted
//         first, 2 substeps)       ω' = -(g + 1) sin θ       g follows a linear schedule, read at each evaluation's own time

export const verletStateIds = { drive: 11, speed: 21, position: 22, angle: 31, rate: 32 };

const state = (nodeId, stateId, symbol) => ({ kind: 'state', nodeId, stateId, symbol });

export function verletDocument() {
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'Verlet fidelity' },
        sharedParameters: [{ id: 950, name: 'Gravity', symbol: 'gravity', value: 7, unit: '', mode: 'constant',
            schedule: { interpolation: 'linear', samples: [[0, 1], [2, 3]] } }],
        nodes: [
            { id: 1, name: 'Drive', numerics: { substepsPerGlobalStep: 1 }, states: [{ id: 11, name: 'D', symbol: 'd', initialValue: 1, unit: '' }], sourceTerms: [{
                id: 101, state: 'd', expression: '-d', parameters: [],
                expressionModel: { latex: '', bindings: [state(1, 11, 'd')], output: { stateId: 11 }, mathJson: ['Negate', 'd'] }
            }] },
            { id: 2, name: 'Mass', numerics: { substepsPerGlobalStep: 3, integration: 'verlet' }, states: [
                { id: 21, name: 'V', symbol: 'v', initialValue: 0, unit: '' },
                { id: 22, name: 'X', symbol: 'x', initialValue: 1, unit: '' }
            ], sourceTerms: [{
                id: 201, state: 'v', expression: '-k x + 0.2 t', parameters: [{ id: 202, name: 'Stiffness', symbol: 'k', value: 4, mode: 'constant' }],
                expressionModel: { latex: '', bindings: [state(2, 22, 'x'), { kind: 'parameter', parameterId: 202, symbol: 'k' }, { kind: 'time', symbol: 't' }],
                    output: { stateId: 21 }, mathJson: ['Add', ['Multiply', '-1', 'k', 'x'], ['Multiply', '0.2', 't']] }
            }, {
                id: 203, state: 'x', expression: 'v', parameters: [],
                expressionModel: { latex: '', bindings: [state(2, 21, 'v')], output: { stateId: 22 }, mathJson: 'v' }
            }] },
            { id: 3, name: 'Pendulum', numerics: { substepsPerGlobalStep: 2, integration: 'verlet' }, states: [
                { id: 31, name: 'Angle', symbol: 'theta', initialValue: 2, unit: '' },
                { id: 32, name: 'Rate', symbol: 'omega', initialValue: 0, unit: '' }
            ], sourceTerms: [{
                id: 301, state: 'theta', expression: 'omega', parameters: [],
                expressionModel: { latex: '', bindings: [state(3, 32, 'omega')], output: { stateId: 31 }, mathJson: 'omega' }
            }, {
                id: 302, state: 'omega', expression: '-(g + 1) sin theta', parameters: [{ id: 303, name: 'g', symbol: 'g', value: 0, mode: 'constant', sharedParameterId: 950 }],
                expressionModel: { latex: '', bindings: [state(3, 31, 'theta'), { kind: 'parameter', parameterId: 303, symbol: 'g' }],
                    output: { stateId: 32 }, mathJson: ['Multiply', '-1', ['Add', 'g', '1'], ['Sin', 'theta']] }
            }] }
        ],
        edges: [{
            id: 401, name: 'Push', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', equation: 'c d',
            parameters: [{ id: 402, name: 'Coupling', symbol: 'c', value: 0.5, mode: 'constant' }],
            equationModel: { latex: '', bindings: [{ kind: 'state', role: 'source', nodeId: 1, stateId: 11, symbol: 'd' }, { kind: 'parameter', parameterId: 402, symbol: 'c' }],
                output: { role: 'target', stateId: 21 }, mathJson: ['Multiply', 'c', 'd'] }
        }]
    };
}
