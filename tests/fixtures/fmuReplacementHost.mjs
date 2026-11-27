/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A model holding the stage 4 controller of docs/proposals/rootPorts.md (tests/engine/fixtures/fmuPortsFixture.mjs) as a component
// instance, for Replace with its FMU (decision 10): used by tests/fmuReplacement.test.mjs and the desktop interaction test that exports
// the controller as an FMU and replaces the instance by it.

import { instancePorts, placeComponent } from '../../src/components.mjs';
import { settingRelationship } from '../../src/boxPorts.mjs';
import { portsDocument } from '../engine/fixtures/fmuPortsFixture.mjs';

// The stage 4 controller (in ports setpoint and measurement, out port command, exposed gain g) placed as "Ported controller", its
// setpoint read from a thermostat, its measurement from a room, its command driving a valve, and its gain 0.8 for this instance.
export function replacementHost() {
    const base = {
        format: 'konjugate', version: 1, metadata: { projectName: 'Host' }, sharedParameters: [],
        nodes: [
            { id: 1001, name: 'Thermostat', position: [-8, 2, 0], states: [{ id: 1002, name: 'Target', symbol: 'target', initialValue: 20, unit: 'degC', kind: 'rate' }], sourceTerms: [] },
            { id: 1003, name: 'Room', position: [-8, -2, 0], states: [{ id: 1004, name: 'Temperature', symbol: 'temperature', initialValue: 18, unit: 'degC', kind: 'rate' }], sourceTerms: [] },
            { id: 1005, name: 'Valve', position: [8, 0, 0], states: [{ id: 1006, name: 'Opening', symbol: 'opening', initialValue: 0, unit: '', kind: 'rate' }], sourceTerms: [] }
        ],
        // Rate states nothing but a constant changes, read by the in ports: the FMU reads them as the instance's ports are set.
        runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.1 }], activeRunConfigurationId: 900,
        edges: [], subsystems: [], edgeGroups: []
    };
    const component = structuredClone(portsDocument);
    delete component.runConfigurations;
    delete component.activeRunConfigurationId;
    const { document, subsystemId } = placeComponent(base, component, { position: [1, 2, 0], name: 'Ported controller' });
    const port = (name) => instancePorts(document, subsystemId).find((item) => item.declared && item.name === name);
    document.edges.push(settingRelationship({ id: 2001, source: { nodeId: 1001, stateId: 1002 }, target: { nodeId: port('setpoint').nodeId, stateId: port('setpoint').stateId }, nodes: document.nodes }));
    document.edges.push(settingRelationship({ id: 2002, source: { nodeId: 1003, stateId: 1004 }, target: { nodeId: port('measurement').nodeId, stateId: port('measurement').stateId }, nodes: document.nodes }));
    const command = port('command');
    document.edges.push({
        id: 2003, name: 'Drive', source: { nodeId: command.nodeId, stateId: command.stateId }, target: { nodeId: 1005, stateId: 1006 }, directionality: 'directed', equation: 'u',
        equationModel: { latex: 'u', output: { role: 'target', stateId: 1006 }, bindings: [{ kind: 'state', role: 'source', nodeId: command.nodeId, stateId: command.stateId, symbol: 'u' }], mathJson: 'u' },
        parameters: []
    });
    document.sharedParameters.find((shared) => shared.subsystemId === subsystemId && shared.exposed).value = 0.8;
    return { document, subsystemId, port };
}


// The component alone, as a component file opened as a project: what is exported as the FMU.
export const replacementComponent = portsDocument;
