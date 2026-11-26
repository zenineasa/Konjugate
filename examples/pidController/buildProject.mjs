/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes HeatedRoomPid.kjt (docs/proposals/rootPorts.md, stage 7): a heated room controlled by PidController.fmu, and beside it a
// second room controlled by the same PI controller written in Konjugate, both following one setpoint that steps from 18 °C to 21 °C
// at an hour. The FMU is kept in the project's file, so the project opens and runs where the FMU is not in the library yet. Needs no
// Docker: it reads the committed FMU, as Konjugate reads one when it is added to a model.
//
//   node examples/pidController/buildProject.mjs

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeInstalledFmuPorts } from '../../src/fmiResolver.mjs';
import { installFmuArchive } from '../../src/fmuPackage.mjs';
import { documentRequires, fmiNodeFromPorts, implementationForFile } from '../../src/nodeProgram.mjs';
import { encodeProjectFile, sha256Hex } from '../../src/projectFile.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The room, as both copies have it: C dT/dt = P·heater − UA·(T − outside).
export const room = { capacity: 5e5, power: 3000, ua: 100, outside: 5, start: 15 };
// The controller, as the FMU's LimPID has it (PidController.mo): k, Ti, the limits and the anti-windup gain Ni.
export const controller = { k: 0.5, ti: 600, yMax: 1, yMin: 0, ni: 0.9 };

const parameter = (id, name, symbol, value, unit) => ({ id, name, symbol, value, unit, mode: 'constant' });
const stateBinding = (nodeId, stateId, symbol) => ({ kind: 'state', nodeId, stateId, symbol });
const parameterBinding = (parameterId, symbol) => ({ kind: 'parameter', parameterId, symbol });
const appearance = (color, shape = 'box') => ({ type: 'primitive', shape, color });

// The room's own part on its temperature: (P·heater − UA·(T − outside)) / C, heater being the state `heaterState` of the room.
function roomTerm({ id, nodeId, temperatureId, heaterId, heaterSymbol, parameterIds }) {
    const [capacity, power, ua, outside] = parameterIds;
    return {
        id, state: 'temperature', expression: `(power * ${heaterSymbol} - ua * (temperature - outside)) / capacity`,
        expressionModel: {
            latex: `\\frac{\\mathrm{power}\\cdot\\mathrm{${heaterSymbol}}-\\mathrm{ua}\\cdot(\\mathrm{temperature}-\\mathrm{outside})}{\\mathrm{capacity}}`,
            output: { stateId: temperatureId },
            mathJson: ['Divide', ['Add', ['Multiply', 'power', heaterSymbol], ['Negate', ['Multiply', 'ua', ['Add', 'temperature', ['Negate', 'outside']]]]], 'capacity'],
            bindings: [parameterBinding(power, 'power'), stateBinding(nodeId, heaterId, heaterSymbol), parameterBinding(ua, 'ua'), stateBinding(nodeId, temperatureId, 'temperature'), parameterBinding(outside, 'outside'), parameterBinding(capacity, 'capacity')]
        },
        parameters: [
            parameter(capacity, 'Heat capacity', 'capacity', room.capacity, 'J/K'), parameter(power, 'Heater power', 'power', room.power, 'W'),
            parameter(ua, 'Heat loss', 'ua', room.ua, 'W/K'), parameter(outside, 'Outside temperature', 'outside', room.outside, 'degC')
        ]
    };
}

// The project document: the FMU node built from `ports` (describeInstalledFmuPorts) for the FMU installed as `fmuId`@`fmuVersion`.
export function heatedRoomPidDocument({ fmuId, fmuVersion, ports, archiveSha256 }) {
    const setpoint = {
        id: 1, name: 'Setpoint', position: [-9, 3, 0], appearance: appearance('#5f8fd6', 'sphere'),
        description: 'The wanted room temperature: 18 °C, then 21 °C from an hour on.',
        states: [{ id: 2, name: 'Setpoint', symbol: 'setpoint', initialValue: 18, unit: 'degC', kind: 'update' }],
        sourceTerms: [{
            id: 3, state: 'setpoint', expression: 'wanted', setsValue: true,
            expressionModel: { latex: '\\mathrm{wanted}', output: { stateId: 2 }, mathJson: 'wanted', bindings: [parameterBinding(4, 'wanted')] },
            parameters: [{ id: 4, name: 'Wanted temperature', symbol: 'wanted', value: 18, unit: 'degC', mode: 'constant', sharedParameterId: 90 }]
        }]
    };
    const heated = {
        id: 10, name: 'Room', position: [-9, -1, 0], appearance: appearance('#c98a5a'),
        description: 'A room losing heat to the outside and gaining it from a heater, whose command comes from the FMU.',
        states: [
            { id: 11, name: 'Temperature', symbol: 'temperature', initialValue: room.start, unit: 'degC', kind: 'rate' },
            // Full power at the start, as the controller commands it then (18 °C wanted, 15 °C in the room).
            { id: 12, name: 'Heater', symbol: 'heater', initialValue: 1, unit: '', kind: 'update' }
        ],
        sourceTerms: [roomTerm({ id: 13, nodeId: 10, temperatureId: 11, heaterId: 12, heaterSymbol: 'heater', parameterIds: [14, 15, 16, 17] })]
    };
    // The FMU, as Konjugate builds a node from one (fmiNodeFromPorts), reading the setpoint and the room's temperature.
    let next = 100;
    const built = fmiNodeFromPorts({ name: 'PidController', states: [] }, {
        guid: fmuId, version: fmuVersion, ports: { ...ports, about: { ...(ports.about ?? {}), archiveSha256, archiveBytes: 0 } }, newId: () => next++
    });
    // Its two inputs read the setpoint and the room's temperature; its parameters (k, Ti) keep the FMU's own values.
    const reads = { setpoint: { nodeId: 1, stateId: 2 }, measurement: { nodeId: 10, stateId: 11 } };
    built.implementation.bindings = built.implementation.bindings.map((binding) => (reads[binding.key] ? { key: binding.key, kind: 'state', ...reads[binding.key] } : binding));
    const pid = {
        id: 20, name: built.name, position: [0, 1, 0], appearance: appearance('#34727a'),
        description: 'A PI controller drawn from the Modelica Standard Library\'s blocks in OpenModelica, exported as an FMU (PidController.mo beside this project).',
        states: built.states, sourceTerms: [], implementation: implementationForFile(built.implementation)
    };
    const command = built.states[0];
    // The second room, its controller written in Konjugate: LimPID's PI form with its anti-windup, as its equations.
    const twin = {
        id: 30, name: 'Room with Konjugate PI', position: [-9, -6, 0], appearance: appearance('#8a7ac9'),
        description: 'The same room, controlled by the same PI controller written in Konjugate: u = clamp(k·(r − T + I)), dI/dt = ((r − T) + (u − k·(r − T + I))/(k·Ni)) / Ti.',
        states: [
            { id: 31, name: 'Temperature', symbol: 'temperature', initialValue: room.start, unit: 'degC', kind: 'rate' },
            { id: 32, name: 'Integral', symbol: 'integral', initialValue: 0, unit: 'K', kind: 'rate' },
            { id: 33, name: 'Command', symbol: 'command', initialValue: 1, unit: '', kind: 'update' },
            { id: 34, name: 'Setpoint', symbol: 'reference', initialValue: 18, unit: 'degC', kind: 'update' }
        ],
        sourceTerms: [
            roomTerm({ id: 35, nodeId: 30, temperatureId: 31, heaterId: 33, heaterSymbol: 'command', parameterIds: [36, 37, 38, 39] }),
            {
                id: 40, state: 'command', expression: 'max(yMin, min(yMax, k * (reference - temperature + integral)))', setsValue: true,
                expressionModel: {
                    latex: '\\max\\left(\\mathrm{yMin},\\min\\left(\\mathrm{yMax},k\\cdot(\\mathrm{reference}-\\mathrm{temperature}+\\mathrm{integral})\\right)\\right)',
                    output: { stateId: 33 },
                    mathJson: ['Max', 'yMin', ['Min', 'yMax', ['Multiply', 'k', ['Add', 'reference', ['Negate', 'temperature'], 'integral']]]],
                    bindings: [parameterBinding(41, 'yMin'), parameterBinding(42, 'yMax'), parameterBinding(43, 'k'), stateBinding(30, 34, 'reference'), stateBinding(30, 31, 'temperature'), stateBinding(30, 32, 'integral')]
                },
                parameters: [parameter(41, 'Smallest command', 'yMin', controller.yMin, ''), parameter(42, 'Largest command', 'yMax', controller.yMax, ''), parameter(43, 'Gain', 'k', controller.k, 'K^-1')]
            },
            {
                id: 44, state: 'integral', expression: '((reference - temperature) + (command - k * (reference - temperature + integral)) / (k * ni)) / ti',
                expressionModel: {
                    latex: '\\frac{(\\mathrm{reference}-\\mathrm{temperature})+\\frac{\\mathrm{command}-k\\cdot(\\mathrm{reference}-\\mathrm{temperature}+\\mathrm{integral})}{k\\cdot\\mathrm{ni}}}{\\mathrm{ti}}',
                    output: { stateId: 32 },
                    mathJson: ['Divide', ['Add', ['Add', 'reference', ['Negate', 'temperature']], ['Divide', ['Add', 'command', ['Negate', ['Multiply', 'k', ['Add', 'reference', ['Negate', 'temperature'], 'integral']]]], ['Multiply', 'k', 'ni']]], 'ti'],
                    bindings: [stateBinding(30, 34, 'reference'), stateBinding(30, 31, 'temperature'), stateBinding(30, 33, 'command'), parameterBinding(45, 'k'), stateBinding(30, 32, 'integral'), parameterBinding(46, 'ni'), parameterBinding(47, 'ti')]
                },
                parameters: [parameter(45, 'Gain', 'k', controller.k, 'K^-1'), parameter(46, 'Anti-windup gain', 'ni', controller.ni, ''), parameter(47, 'Integral time', 'ti', controller.ti, 's')]
            }
        ]
    };
    const setting = (id, name, source, target, symbol) => {
        const latex = `\\mathrm{${symbol}}`;
        return {
            id, name, source, target, directionality: 'directed', equation: latex,
            equationModel: { latex, output: { role: 'target', stateId: target.stateId }, bindings: [{ kind: 'state', role: 'source', nodeId: source.nodeId, stateId: source.stateId, symbol }], mathJson: symbol },
            parameters: []
        };
    };
    const nodes = [setpoint, heated, pid, twin];
    return {
        format: 'konjugate', version: 1, metadata: { units: 'SI', projectName: 'Heated room with a PI controller from OpenModelica' },
        // As the app works it out, from the FMU's bindings before the file leaves out those that read nothing (k and Ti keep the FMU's values).
        requires: documentRequires([], nodes.map((node) => (node.id === 20 ? { ...node, implementation: built.implementation } : node))),
        runConfigurations: [{ id: 900, name: 'Four hours', globalTimeStep: 10, outputInterval: 60, targetTime: 14400 }], activeRunConfigurationId: 900,
        sharedParameters: [{ id: 90, name: 'Wanted temperature', symbol: 'wanted', value: 18, unit: 'degC', mode: 'constant', schedule: { interpolation: 'hold', samples: [[0, 18], [3600, 21]] } }],
        nodes,
        edges: [
            setting(50, `Room.heater = PidController.${command.symbol}`, { nodeId: 20, stateId: command.id }, { nodeId: 10, stateId: 12 }, `source${command.symbol[0].toUpperCase()}${command.symbol.slice(1)}`),
            setting(51, 'Room with Konjugate PI.reference = Setpoint.setpoint', { nodeId: 1, stateId: 2 }, { nodeId: 30, stateId: 34 }, 'sourceSetpoint')
        ],
        subsystems: [], edgeGroups: []
    };
}

// The FMU installed in a folder of its own, its ports read as Konjugate reads them when it is added to a model.
export async function installedPidController(archive, directory) {
    const installed = await installFmuArchive(archive, { directory });
    const ports = await describeInstalledFmuPorts(directory, installed.guid, installed.version);
    return { fmuId: installed.guid, fmuVersion: installed.version, ports, archiveSha256: sha256Hex(archive) };
}

async function main() {
    const archive = await readFile(join(here, 'PidController.fmu'));
    const directory = await mkdtemp(join(tmpdir(), 'k64-pidproject-'));
    try {
        const fmu = await installedPidController(archive, directory);
        const document = heatedRoomPidDocument(fmu);
        const content = JSON.stringify(document);
        await writeFile(join(here, 'HeatedRoomPid.kjt'), await encodeProjectFile(content, { attachments: [{ kind: 'fmu', name: 'PidController.fmu', buffer: archive }] }));
        console.log(`HeatedRoomPid.kjt written: ${document.nodes.length} nodes, the FMU (${fmu.fmuId}) kept in it; requires ${JSON.stringify(document.requires)}.`);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
