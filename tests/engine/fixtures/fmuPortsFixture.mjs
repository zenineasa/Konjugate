/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A model with ports at the top level, for FMU export with a declared interface (docs/proposals/rootPorts.md, stage 4): a
// controller integrating gain × (setpoint − measurement), its setpoint and measurement in ports (Updates nothing inside sets), its
// integral the out port "command", the gain an exposed parameter linked from both relationships, and a counter whose rate has a
// constant part and a live part, both baked into the FMU, its state observable as a local. Used by tests/fmuInterface.test.mjs and
// tests/engine/fmiPortsExportFidelity.mjs.

export const portsStateIds = { setpoint: 11, measurement: 12, integral: 13, count: 14 };

export const portsDocument = {
    format: 'konjugate', version: 1, metadata: { projectName: 'Ported controller' },
    runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.2 }], activeRunConfigurationId: 900,
    sharedParameters: [{ id: 30, name: 'Gain', symbol: 'g', value: 0.5, unit: '1/s', mode: 'constant', exposed: true }],
    nodes: [
        { id: 1, name: 'Setpoint', states: [{ id: 11, name: 'Setpoint', symbol: 'setpoint', initialValue: 20, unit: 'degC', kind: 'update' }], sourceTerms: [] },
        { id: 2, name: 'Measurement', states: [{ id: 12, name: 'Measurement', symbol: 'measurement', initialValue: 18, unit: 'degC', kind: 'update' }], sourceTerms: [] },
        { id: 3, name: 'Controller', states: [{ id: 13, name: 'Integral', symbol: 'integral', initialValue: 0, unit: '', kind: 'rate' }], sourceTerms: [] },
        {
            id: 4, name: 'Counter', states: [{ id: 14, name: 'Count', symbol: 'count', initialValue: 0, unit: '', kind: 'rate' }],
            sourceTerms: [{
                id: 101, state: 'count', expression: 'a + b',
                expressionModel: {
                    latex: 'a + b', bindings: [{ kind: 'parameter', parameterId: 23, symbol: 'a' }, { kind: 'parameter', parameterId: 24, symbol: 'b' }],
                    output: { stateId: 14 }, mathJson: ['Add', 'a', 'b']
                },
                parameters: [
                    { id: 23, name: 'Base rate', symbol: 'a', value: 1, mode: 'constant' },
                    { id: 24, name: 'Extra rate', symbol: 'b', value: 0.5, mode: 'live', control: { minimum: 0, maximum: 1, step: 0.1 } }
                ]
            }]
        }
    ],
    edges: [
        {
            id: 201, name: 'Setpoint in', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 3, stateId: 13 }, directionality: 'directed',
            equationModel: {
                latex: 'g x', bindings: [{ kind: 'state', role: 'source', nodeId: 1, stateId: 11, symbol: 'x' }, { kind: 'parameter', parameterId: 21, symbol: 'g' }],
                output: { role: 'target', stateId: 13 }, mathJson: ['Multiply', 'g', 'x']
            },
            parameters: [{ id: 21, name: 'Gain', symbol: 'g', value: 0.5, mode: 'constant', sharedParameterId: 30 }]
        },
        {
            id: 202, name: 'Measurement in', source: { nodeId: 2, stateId: 12 }, target: { nodeId: 3, stateId: 13 }, directionality: 'directed',
            equationModel: {
                latex: '-g x', bindings: [{ kind: 'state', role: 'source', nodeId: 2, stateId: 12, symbol: 'x' }, { kind: 'parameter', parameterId: 22, symbol: 'g' }],
                output: { role: 'target', stateId: 13 }, mathJson: ['Multiply', ['Negate', 'g'], 'x']
            },
            parameters: [{ id: 22, name: 'Gain', symbol: 'g', value: 0.5, mode: 'constant', sharedParameterId: 30 }]
        }
    ],
    component: {
        name: 'Ported controller',
        ports: [{ key: 1, stateId: 11, name: 'setpoint', direction: 'in' }, { key: 2, stateId: 12, name: 'measurement', direction: 'in' }, { key: 3, stateId: 13, name: 'command', direction: 'out' }]
    },
    subsystems: [], edgeGroups: []
};
