/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An FMU node and a component instance are both a part with inputs and outputs, drawn and connected alike
// (docs/proposals/rootPorts.md, stage 5): its inputs are terminals on its left edge, its outputs on its right, and a connection is
// made by dragging from one to the other. What the terminals are, and what a connection writes, is worked out here from what the
// file already holds, so nothing new is stored: an FMU's input reading a state is the binding Connect to… writes
// ({ key, kind: "state", nodeId, stateId }), and a value reaching a component's in port, or any Konjugate state, is a one-way
// relationship that sets it. No DOM, so `npm test` runs it.

import { stateKinds } from './ratesAndUpdates.mjs';

const nodeName = (node) => node.title ?? node.name ?? '';
const stateName = (state) => state.label ?? state.name ?? state.symbol;
const endpointOf = (edge, role) => (edge[role] !== null && typeof edge[role] === 'object'
    ? { nodeId: edge[role].nodeId, stateId: edge[role].stateId ?? null }
    : { nodeId: edge[role], stateId: edge[`${role}StateId`] ?? null });

// An FMU node's terminals: its inputs (causality "input"; its parameters stay on its card), each with what it reads now, and its
// outputs, each with the state it sets. `ports` is the FMU's ports as describeInstalledFmuPorts gives them; `nodes` the model's
// nodes, to name what an input reads. `{ inputs: [{ key, name, unit, start, reads }], outputs: [{ key, name, unit, stateId }] }`,
// `reads` `{ nodeId, stateId, text }` for an input bound to a state, `{ value, text }` for one given a value, or null (the FMU's
// own start).
export function fmuBoxPorts(node, ports, nodes = []) {
    const implementation = node.implementation;
    if (implementation?.kind !== 'fmi' || !ports) return { inputs: [], outputs: [] };
    const bindings = new Map((implementation.bindings ?? []).map((binding) => [binding.key, binding]));
    const inputs = (ports.inputs ?? []).filter((port) => port.causality === 'input').map((port) => {
        const binding = bindings.get(port.key);
        let reads = null;
        if (binding?.kind === 'state' && binding.nodeId != null) {
            const source = nodes.find((candidate) => candidate.id === binding.nodeId && !candidate.deleted);
            const state = source?.states?.find((candidate) => candidate.id === binding.stateId);
            reads = { nodeId: binding.nodeId, stateId: binding.stateId, text: source && state ? `${nodeName(source)}.${state.symbol}` : 'a state no longer there' };
        } else if (binding?.kind === 'value') {
            reads = { value: Number(binding.value), text: String(binding.value) };
        }
        return { key: port.key, name: port.name ?? port.key, unit: port.unit ?? '', start: port.start, reads };
    });
    const outputPorts = new Map((ports.outputs ?? []).map((port) => [port.key, port]));
    const outputs = (implementation.outputs ?? []).map((output) => {
        const port = outputPorts.get(output.key);
        const state = (node.states ?? []).find((candidate) => candidate.id === output.stateId);
        return { key: output.key, name: port?.name ?? (state ? stateName(state) : output.key), unit: port?.unit ?? state?.unit ?? '', stateId: output.stateId };
    }).filter((output) => (node.states ?? []).some((state) => state.id === output.stateId));
    return { inputs, outputs };
}

// A component instance's terminals, from its declared ports (instancePorts in src/components.mjs, ids in the project's space): in
// ports on the left, out ports and ports both ways on the right. `{ inputs, outputs }`, each `{ key, name, unit, stateId, nodeId,
// connected }`.
export function instanceBoxPorts(ports) {
    const terminal = (port) => ({ key: port.key, name: port.name, unit: port.unit ?? '', stateId: port.stateId, nodeId: port.nodeId, connected: Boolean(port.connected) });
    const declared = ports.filter((port) => port.declared);
    return { inputs: declared.filter((port) => port.direction === 'in').map(terminal), outputs: declared.filter((port) => port.direction !== 'in').map(terminal) };
}

// What an input terminal says when nothing is connected to it, and when something is, with the timing a person needs: an FMU reads
// its inputs at the start of each step, so a value from an Update arrives a step late.
export function inputTerminalText(input, { kind, startText = null }) {
    if (kind === 'fmu') {
        if (!input.reads) return { detail: `the FMU's own start${startText ? ` · ${startText}` : ''}`, tooltip: `${input.name} reads nothing, so it keeps the FMU's own start value. Drag a state or an output here to connect it.` };
        return { detail: `reads ${input.reads.text}`, tooltip: `${input.name} reads ${input.reads.text}, at the start of each step: one step late. Drag another state here to read that instead.` };
    }
    return input.connected
        ? { detail: 'connected', tooltip: `${input.name} is set by a relationship from outside.` }
        : { detail: `nothing connected${startText ? ` · stays at ${startText}` : ''}`, tooltip: `${input.name} has nothing connected, so it stays at its start. Drag an output or a state here to set it.` };
}

// A name for a part placed beside others of the same name (an FMU added twice, a component placed twice): its own when free, else
// numbered, "PidController 2", "PidController 3", so its card, its arrows and the messages about it say which one is meant.
export function distinctPartName(name, takenNames) {
    const taken = new Set(takenNames);
    if (!taken.has(name)) return name;
    for (let number = 2; ; number += 1) if (!taken.has(`${name} ${number}`)) return `${name} ${number}`;
}

// Where, along the model's x, a part placed beside the drawn model goes so that nothing drawn covers another: right of the right edge of
// every label and terminal drawn (`drawnRightPx`, on screen), with room for the new box's own input terminals and half its body, turned
// into model units at the current zoom (`pixelsPerUnit` at `atX`, which stands at `atScreenX`); never nearer than `minimumStep`. A fixed
// step alone put a second FMU's terminals over the first one's label at some zooms, where a drop meant for a covered row landed on a
// terminal (the bug hunt).
export const placementRoomPx = { inputTerminals: 230, boxHalfUnits: 0.75 };
export function placementBeside({ atX, atScreenX, pixelsPerUnit, drawnRightPx, minimumStep }) {
    const fixed = atX + minimumStep;
    if (!(pixelsPerUnit > 1) || !Number.isFinite(drawnRightPx) || !Number.isFinite(atScreenX)) return fixed;
    const clear = atX + (Math.max(drawnRightPx, atScreenX) - atScreenX + placementRoomPx.inputTerminals) / pixelsPerUnit + placementRoomPx.boxHalfUnits;
    return Math.max(fixed, clear);
}

// Why a drag from a terminal connects nothing where it was let go, said on the status line; '' when the drop can connect. `drag` is
// { box, role, terminal } (role "input" or "output"), `target` what is under the pointer: a terminal { kind: "terminal", box, role,
// terminal }, a node { kind: "node", node }, or null for empty canvas. A drop is never silently dropped (the bug hunt: a drag onto a
// row hidden under another box's terminal landed on that terminal and did nothing).
export function boxDropProblem(drag, target) {
    const dragged = `${drag.box.name}'s ${drag.terminal.name}`;
    const wanted = drag.role === 'input' ? 'an output, a node or one of its states' : 'an input, a node or one of its states';
    if (!target) return `Nothing was connected: drop ${dragged} on ${wanted}.`;
    if (target.kind !== 'terminal' || target.role !== drag.role) return '';
    if (target.box.key === drag.box.key && String(target.terminal.key) === String(drag.terminal.key)) return `Nothing was connected: ${dragged} was let go where it started.`;
    return `Nothing was connected: ${target.box.name}'s ${target.terminal.name} is an ${drag.role} too. Drop ${dragged} on ${wanted}.`;
}

// The binding Connect to… writes for an FMU input reading a state: the same entry, so a drag and the card are one thing.
export function fmuInputBinding(inputKey, source) {
    return { key: inputKey, kind: 'state', nodeId: source.nodeId, stateId: source.stateId };
}

// Whether a value can be set on a state by a relationship: an Update can (a relationship's single equation gives an Update its
// value); a Rate cannot, since a relationship adds a rate to it. `null` when it can, else why not, said for the status line.
export function settingRefusal(target, nodes, edges) {
    const node = nodes.find((candidate) => candidate.id === target.nodeId);
    const state = node?.states?.find((candidate) => candidate.id === target.stateId);
    if (!state) return 'That state is no longer there.';
    if (stateKinds(nodes, edges).get(Number(state.id))?.kind !== 'update') {
        return `${nodeName(node)}.${state.symbol} is a Rate: a relationship would add to its rate, not set it. Make it an Update on its node's Equations tab to set it from here.`;
    }
    const already = edges.find((edge) => !edge.deleted && (() => { const end = endpointOf(edge, 'target'); return end.nodeId === target.nodeId && end.stateId === target.stateId; })());
    if (already) return `${nodeName(node)}.${state.symbol} is already set by ${describeEdge(already)}: remove that relationship first.`;
    return null;
}
const describeEdge = (item) => `“${item.title ?? item.name ?? 'a relationship'}”`;

const capitalised = (symbol) => `${symbol.charAt(0).toUpperCase()}${symbol.slice(1)}`;

// The one-way relationship that sets `target` (an Update) to the value of `source`, as a project document's edge: named
// "Target.state = Source.state", its equation the source's value, written as the editor writes a relationship's equation
// (a binding named source<Symbol>).
export function settingRelationship({ id, source, target, nodes }) {
    const sourceNode = nodes.find((node) => node.id === source.nodeId);
    const targetNode = nodes.find((node) => node.id === target.nodeId);
    const sourceState = sourceNode.states.find((state) => state.id === source.stateId);
    const targetState = targetNode.states.find((state) => state.id === target.stateId);
    const symbol = `source${capitalised(sourceState.symbol)}`;
    const latex = `\\mathrm{${symbol}}`;
    return {
        id, name: `${nodeName(targetNode)}.${targetState.symbol} = ${nodeName(sourceNode)}.${sourceState.symbol}`,
        source: { nodeId: source.nodeId, stateId: source.stateId }, target: { nodeId: target.nodeId, stateId: target.stateId },
        directionality: 'directed', equation: latex,
        equationModel: { latex, output: { role: 'target', stateId: target.stateId }, bindings: [{ kind: 'state', role: 'source', nodeId: source.nodeId, stateId: source.stateId, symbol }], mathJson: symbol },
        parameters: []
    };
}
