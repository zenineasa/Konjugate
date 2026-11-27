/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Bring in a controller from another tool" (docs/proposals/rootPorts.md, stage 8), starting from the Heated room model beside the
// examples (examples/pidController/HeatedRoom.kjt): a PI controller drawn in OpenModelica from the Modelica Standard Library's blocks and
// exported as an FMU (examples/pidController/PidController.fmu) is put in the library, added as a box with ports, connected by dragging
// (its measurement to the room's temperature, its setpoint to the setpoint, its command to the room's heater), run; then compared with the
// same room controlled by the same PI controller written in Konjugate, switched on for it; and its gain changed on its card. Desktop
// only: the web edition runs no FMU.

export const controllerFromAnotherToolValues = Object.freeze({
    runSeconds: 14400,
    fmu: 'PidController',
    room: 'Room',
    setpoint: 'Setpoint',
    twin: 'Room with Konjugate PI',
    // The FMU's inputs and output, and the states of ours each connects to.
    measurement: { key: 'measurement', node: 'Room', symbol: 'temperature', row: 0 },
    wanted: { key: 'setpoint', node: 'Setpoint', symbol: 'setpoint', row: 0 },
    command: { key: 'command', node: 'Room', symbol: 'heater', row: 1 },
    gain: { key: 'k', from: 0.5, to: 2 },
    fmus: ['pidController/PidController.fmu']
});
const values = controllerFromAnotherToolValues;

const nodeNamed = (document, name) => (document?.nodes ?? []).find((node) => node.name === name) ?? null;
const fmuNode = (document) => (document?.nodes ?? []).find((node) => node.name === values.fmu && node.implementation?.kind === 'fmi') ?? null;
const stateOf = (document, name, symbol) => nodeNamed(document, name)?.states?.find((state) => state.symbol === symbol) ?? null;

// An input of the FMU reads the state it should.
export function controllerInputConnected(document, input) {
    const fmu = fmuNode(document);
    const state = stateOf(document, input.node, input.symbol);
    const binding = fmu?.implementation?.bindings?.find((item) => item.key === input.key);
    return Boolean(state && binding?.kind === 'state' && binding.nodeId === nodeNamed(document, input.node).id && binding.stateId === state.id);
}

// The room's heater is set from the FMU's command, by a relationship.
export function controllerCommandConnected(document) {
    const fmu = fmuNode(document);
    const command = fmu?.states?.find((state) => fmu.implementation.outputs?.some((output) => output.key === values.command.key && output.stateId === state.id));
    const heater = stateOf(document, values.command.node, values.command.symbol);
    return Boolean(command && heater && (document.edges ?? []).some((edge) => edge.enabled !== false
        && edge.source?.nodeId === fmu.id && edge.source?.stateId === command.id && edge.target?.nodeId === nodeNamed(document, values.command.node).id && edge.target?.stateId === heater.id));
}

export const controllerConnected = (document) => controllerInputConnected(document, values.measurement) && controllerInputConnected(document, values.wanted) && controllerCommandConnected(document);

// The room with Konjugate's PI is switched on, with what gives it the setpoint.
export const twinSwitchedOn = (document) => nodeNamed(document, values.twin)?.enabled !== false
    && (document?.edges ?? []).some((edge) => edge.target?.nodeId === nodeNamed(document, values.twin)?.id && edge.enabled !== false);

// The FMU's gain is given a value of its own.
export function gainChanged(document) {
    const binding = fmuNode(document)?.implementation?.bindings?.find((item) => item.key === values.gain.key);
    return binding?.kind === 'value' && Number(binding.value) === values.gain.to;
}

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Bring in a controller from another tool',
        text: 'This room is heated by a heater nobody controls yet, and wants 18 °C, then 21 °C from an hour on. The controller comes from OpenModelica: a PI controller drawn from the Modelica Standard Library\'s blocks and exported as an FMU, the standard package simulation tools trade models in. You will add it, connect it to the room by dragging, run it, and compare it with the same controller written in Konjugate, the room below, switched off for now.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'add',
        title: 'Add the controller',
        text: `Press "Put it in my library", then Add (+): under FMU…, add ${values.fmu}. It arrives as a box with ports: its inputs, setpoint and measurement, on its left, its output, command, on its right.`,
        target: (ui) => (ui.resultsOpen ? '#closeResults' : '#addButton'), fill: 'putExampleFmus', fillLabel: 'Put it in my library', skip: 'addExampleFmus',
        done: ({ document }) => Boolean(fmuNode(document))
    },
    {
        id: 'measurement',
        title: 'Let it measure the room',
        text: `Drag from the controller's measurement terminal, on its left, to the ${values.room}'s Temperature: the controller reads the room's temperature, at the start of each step.`,
        target: (ui) => ui.boxPortOf('input', values.measurement.key) ?? ui.labelOf(values.fmu) ?? '#addButton', skip: 'connectControllerInput', input: values.measurement,
        done: ({ document }) => controllerInputConnected(document, values.measurement)
    },
    {
        id: 'wanted',
        title: 'Tell it what is wanted',
        text: `Drag from its setpoint terminal to the ${values.setpoint}'s Setpoint.`,
        target: (ui) => ui.boxPortOf('input', values.wanted.key) ?? ui.labelOf(values.fmu) ?? '#addButton', skip: 'connectControllerInput', input: values.wanted,
        done: ({ document }) => controllerInputConnected(document, values.wanted)
    },
    {
        id: 'command',
        title: 'Let it drive the heater',
        text: `Drag from its command terminal, on its right, to the ${values.room}'s Heater: a relationship now sets the heater, from 0 (off) to 1 (full power), to the controller's command.`,
        target: (ui) => ui.boxPortOf('output', values.command.key) ?? ui.labelOf(values.fmu) ?? '#addButton', skip: 'connectControllerOutput',
        done: ({ document }) => controllerCommandConnected(document)
    },
    {
        id: 'run',
        title: 'Run it',
        text: `Press Run and Start (${values.runSeconds / 3600} hours). Click the ${values.room}: its temperature climbs to 18 °C with the heater full on, steps up to 21 °C after the hour, the heater saturating and coming back. A hollow ⚠ is an early check that something kept growing a few steps in a row, as a warming room does; it settles.`,
        target: (ui) => (ui.runDialogOpen ? '#startRun' : '#runButton'), skip: 'runModel', runSeconds: values.runSeconds,
        done: ({ ui }) => controllerConnected(ui.runModel) && ui.resultEnd >= values.runSeconds - 1e-9
    },
    {
        id: 'compare',
        title: 'Compare it with Konjugate\'s own',
        text: `Press "Close and edit", then "Switch it on": the ${values.twin}, the same room controlled by the same PI controller written in Konjugate's equations, joins the run. Run again and click each room: their temperatures follow each other within a few hundredths of a kelvin. They differ a little because the FMU reads the room's temperature at the start of each step and works its controller out inside, its own way.`,
        target: (ui) => (ui.resultsOpen ? '#closeResults' : ui.runDialogOpen ? '#startRun' : '#runButton'), fill: 'switchOnTwin', fillLabel: 'Switch it on', skip: 'compareWithTwin', runSeconds: values.runSeconds,
        done: ({ ui }) => twinSwitchedOn(ui.runModel) && controllerConnected(ui.runModel) && ui.resultEnd >= values.runSeconds - 1e-9
    },
    {
        id: 'gain',
        title: 'Tune it in place',
        text: `Press "Close and edit" and click ${values.fmu}. On its card, set k, its gain, from ${values.gain.from} to ${values.gain.to}: choose "A value of its own" on k's row and type ${values.gain.to}. Run again: the room reaches 21 °C sooner. An FMU's parameters are tuned where it is used, its file untouched.`,
        target: (ui) => (ui.resultsOpen ? '#closeResults' : ui.labelOf(values.fmu) ?? '#addButton'), skip: 'setControllerGain', runSeconds: values.runSeconds, gain: values.gain,
        done: ({ ui }) => gainChanged(ui.runModel) && ui.resultEnd >= values.runSeconds - 1e-9
    },
    {
        id: 'finish',
        title: 'A controller from another tool controls your model',
        text: 'The controller came from OpenModelica as an FMU, and is a box with ports here like any part with inputs and outputs: dragged to connect, tuned on its card, run beside Konjugate\'s own. Its folder in the examples (pidController) holds its Modelica source, the script that made the FMU, and how it was checked. The FMU carries its C sources too: on a computer it has no binary for, Konjugate builds it from them with that computer\'s C compiler, after asking, and About this FMU says so.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const controllerFromAnotherTool = Object.freeze({
    id: 'controllerFromAnotherTool',
    title: 'Bring in a controller from another tool',
    summary: 'Add a PI controller made in OpenModelica as an FMU, connect it to a heated room by dragging, compare it with Konjugate\'s own, and tune it.',
    minutes: 6,
    area: 'control',
    tags: ['FMU', 'FMI', 'OpenModelica', 'Modelica', 'PID', 'PI', 'controller', 'connect', 'ports', 'co-simulation', 'compare', 'tune'],
    start: { from: 'example', example: 'pidController/HeatedRoom.kjt' },
    editions: ['desktop'],
    fmus: values.fmus,
    steps
});
