/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Replace with its FMU (docs/proposals/rootPorts.md, decision 10): a component instance replaced by an FMU node built from an FMU
// exported from that component, or any FMU whose inputs and outputs have the instance's port names. The instance's ports are
// matched to the FMU's variables by name, with their directions and units checked; every connection is moved to the terminal of
// the same name (a relationship setting an in port becomes the FMU input reading the same state, a relationship reading an out port
// reads the FMU's output state); its exposed parameters' values are carried to the FMU parameters of the same name. What does not
// match is said, and the replacement is refused while anything would be lost. The result is one document, so one undo step brings
// the instance and its connections back. No DOM, so `npm test` runs it.

import { instanceParameters, instancePorts, subsystemMembers, idAllocator } from './components.mjs';
import { fmiNodeFromPorts, fmuInputRows } from './nodeProgram.mjs';
import { fmuInputBinding } from './boxPorts.mjs';

const clone = (value) => structuredClone(value);
const endpointOf = (edge, role) => (edge[role] !== null && typeof edge[role] === 'object'
    ? { nodeId: Number(edge[role].nodeId), stateId: edge[role].stateId ?? null }
    : { nodeId: Number(edge[role]), stateId: edge[`${role}StateId`] ?? null });
const quoted = (name) => `“${name}”`;
const edgeName = (edge) => quoted(edge.name ?? 'a relationship');
// The unit as a person compares it: "1" and no unit are the same (an FMU says "1" where Konjugate says nothing).
const unitOf = (unit) => (unit === undefined || unit === null || String(unit).trim() === '1' ? '' : String(unit).trim());
const unitText = (unit) => (unitOf(unit) ? ` (${unitOf(unit)})` : '');
// Whether an FMU variable's unit differs from ours: only when the FMU says one (an FMI 2.0 export by Konjugate says none).
const unitDiffers = (fmuUnit, ours) => fmuUnit !== undefined && fmuUnit !== null && String(fmuUnit).trim() !== '' && unitOf(fmuUnit) !== unitOf(ours);

// Whether a relationship sets its target to a state's value as it is: its one binding is the source state and its equation that
// binding alone (what dragging an output to an in port writes, settingRelationship in src/boxPorts.mjs). An FMU input reads a
// state as it is, so only such a relationship moves to the FMU's input.
function copiesState(edge) {
    const model = edge.equationModel ?? {};
    // The canvas lists every symbol the equation may use (the target, time) as a binding too: what counts is the one it uses.
    if (typeof model.mathJson !== 'string') return null;
    const binding = (model.bindings ?? []).find((candidate) => candidate.symbol === model.mathJson);
    if (binding?.kind !== 'state') return null;
    const source = endpointOf(edge, 'source');
    if (Number(binding.nodeId) !== source.nodeId || binding.stateId !== source.stateId) return null;
    return { nodeId: source.nodeId, stateId: source.stateId };
}

// What replacing instance `subsystemId` by the FMU whose ports are `fmuPorts` (describeInstalledFmuPorts) would do, row by row:
// `{ name, rows, problems, notes, ok }`. Each row is `{ kind: "in" | "out" | "parameter", name, ok, text }`, said in the card's
// words; `problems` are why the replacement is refused (nothing is replaced while there is one), `notes` what a person should know
// that loses nothing. `plan` (internal) carries the moves for replaceInstanceWithFmu.
export function fmuReplacementPlan(document, subsystemId, fmuPorts) {
    const record = (document.subsystems ?? []).find((subsystem) => subsystem.id === subsystemId && !subsystem.deleted);
    const rows = [];
    const problems = [];
    const notes = [];
    const result = (plan = null) => ({ name: record?.name ?? '', rows, problems, notes, ok: !problems.length, plan });
    if (!record || record.definitionId == null) {
        problems.push('Only an instance of a component can be replaced by its FMU.');
        return result();
    }
    if (insideAnotherInstance(document, record)) {
        problems.push(`${record.name} lies inside another component: open that component and replace it there.`);
        return result();
    }
    const ports = instancePorts(document, subsystemId).filter((port) => port.declared);
    if (!ports.length) {
        problems.push(`${record.name} declares no ports. An FMU is matched to an instance by its ports' names: name its ports on its card first.`);
        return result();
    }
    const members = subsystemMembers(document, subsystemId);
    const insideNodeIds = new Set(members.nodes.map((node) => node.id));
    const insideEdgeIds = new Set(members.edges.map((edge) => edge.id));
    const fmuInputs = (fmuPorts?.inputs ?? []).filter((port) => port.causality === 'input');
    const fmuParameters = (fmuPorts?.inputs ?? []).filter((port) => port.causality === 'parameter');
    const fmuOutputs = fmuPorts?.outputs ?? [];
    const byName = (list, name) => list.find((port) => port.name === name);
    const boundary = (document.edges ?? []).filter((edge) => !edge.deleted && !insideEdgeIds.has(edge.id)
        && (insideNodeIds.has(endpointOf(edge, 'source').nodeId) || insideNodeIds.has(endpointOf(edge, 'target').nodeId)));
    const handledEdges = new Set();
    const inputBindings = [];
    const outputMoves = [];
    const removedEdgeIds = [];
    const matchedInputs = new Set();
    const matchedOutputs = new Set();
    const isPortState = (end, port) => end.nodeId === port.nodeId && end.stateId === port.stateId;

    const unitsUnsaid = [];
    for (const port of ports) {
        // Its connections are this port's to move, or to refuse with it: never said again as a connection to an inside state.
        boundary.filter((edge) => isPortState(endpointOf(edge, 'target'), port) || isPortState(endpointOf(edge, 'source'), port)).forEach((edge) => handledEdges.add(edge.id));
        const wanted = port.direction === 'in' ? 'input' : 'output';
        const match = byName(port.direction === 'in' ? fmuInputs : fmuOutputs, port.name);
        const sideways = port.direction === 'in'
            ? (byName(fmuOutputs, port.name) ? 'an output' : byName(fmuParameters, port.name) ? 'a parameter, set once when the run starts' : null)
            : (byName(fmuInputs, port.name) ? 'an input' : byName(fmuParameters, port.name) ? 'a parameter' : null);
        const direction = port.direction === 'in' ? 'In port' : port.direction === 'out' ? 'Out port' : 'Port both ways';
        if (!match) {
            const why = sideways
                ? `${direction} ${quoted(port.name)} is ${sideways} of the FMU, not an ${wanted}.`
                : `${direction} ${quoted(port.name)} has no FMU ${wanted} of the same name.`;
            problems.push(why);
            rows.push({ kind: port.direction === 'in' ? 'in' : 'out', name: port.name, ok: false, text: why });
            continue;
        }
        if (unitDiffers(match.unit, port.unit)) {
            const why = `${quoted(port.name)} is in ${unitOf(port.unit) || 'no unit'} here and in ${unitOf(match.unit) || 'no unit'} in the FMU.`;
            problems.push(why);
            rows.push({ kind: port.direction === 'in' ? 'in' : 'out', name: port.name, ok: false, text: why });
            continue;
        }
        if (unitOf(port.unit) && !unitOf(match.unit)) unitsUnsaid.push(port.name);
        if (port.direction === 'in') {
            matchedInputs.add(match.name);
            const setting = boundary.filter((edge) => isPortState(endpointOf(edge, 'target'), port) && !insideNodeIds.has(endpointOf(edge, 'source').nodeId));
            const reading = boundary.filter((edge) => isPortState(endpointOf(edge, 'source'), port) && !insideNodeIds.has(endpointOf(edge, 'target').nodeId));
            reading.forEach((edge) => {
                handledEdges.add(edge.id);
                problems.push(`${edgeName(edge)} reads in port ${quoted(port.name)} from outside: an FMU input cannot be read. Read what sets it instead.`);
            });
            let text;
            let ok = true;
            if (setting.length > 1) {
                ok = false;
                text = `${quoted(port.name)} is set by ${setting.length} relationships (${setting.map(edgeName).join(', ')}): an FMU input reads one state.`;
                problems.push(text);
            } else if (setting.length === 1) {
                const [edge] = setting;
                handledEdges.add(edge.id);
                const source = copiesState(edge);
                if (!source) {
                    ok = false;
                    text = `${quoted(port.name)} is set by ${edgeName(edge)} through an equation: an FMU input reads a state as it is. Connect a state to it directly (drag it to the terminal), then replace.`;
                    problems.push(text);
                } else {
                    const node = (document.nodes ?? []).find((candidate) => candidate.id === source.nodeId);
                    const state = node?.states?.find((candidate) => candidate.id === source.stateId);
                    inputBindings.push(fmuInputBinding(match.key, source));
                    removedEdgeIds.push(edge.id);
                    text = `in · ${port.name}${unitText(port.unit)} → FMU input ${match.name}, reading ${node?.name ?? 'a node'}.${state?.symbol ?? 'a state'}`;
                }
            } else {
                const start = Number.isFinite(match.start) ? ` · ${match.start}${unitText(match.unit)}` : '';
                text = `in · ${port.name}${unitText(port.unit)} → FMU input ${match.name}: nothing connected, the FMU's own start${start}`;
            }
            rows.push({ kind: 'in', name: port.name, ok, text });
            continue;
        }
        matchedOutputs.add(match.name);
        const setting = boundary.filter((edge) => isPortState(endpointOf(edge, 'target'), port) && !insideNodeIds.has(endpointOf(edge, 'source').nodeId));
        setting.forEach((edge) => {
            handledEdges.add(edge.id);
            problems.push(`${edgeName(edge)} sets ${quoted(port.name)} from outside: an FMU output is the FMU's own, nothing outside can set it.`);
        });
        const readers = boundary.filter((edge) => isPortState(endpointOf(edge, 'source'), port) && !insideNodeIds.has(endpointOf(edge, 'target').nodeId));
        readers.forEach((edge) => handledEdges.add(edge.id));
        outputMoves.push({ port, key: match.key });
        if (port.direction !== 'out') notes.push(`${quoted(port.name)} goes both ways here; FMI has no variable both ways, so it is the FMU's output.`);
        rows.push({
            kind: 'out', name: port.name, ok: !setting.length,
            text: `out · ${port.name}${unitText(port.unit)} → FMU output ${match.name}${readers.length ? `, read by ${readers.map(edgeName).join(', ')}` : ''}`
        });
    }

    // A relationship between the instance and the rest of the model that is not at one of its ports would be lost.
    for (const edge of boundary) {
        if (handledEdges.has(edge.id)) continue;
        problems.push(`${edgeName(edge)} connects to a state inside ${record.name} that is not a port: the FMU does not offer it. Make that state a port, or remove ${edgeName(edge)}.`);
    }
    // So would an edge group or a read of an inside state that is not an out port, from a node or relationship outside.
    for (const group of document.edgeGroups ?? []) {
        const members_ = group.memberNodeIds ?? [];
        if (members_.some((id) => insideNodeIds.has(id)) && !members_.every((id) => insideNodeIds.has(id))) {
            problems.push(`The edge group ${quoted(group.name ?? 'an edge group')} joins nodes inside ${record.name} to nodes outside: ungroup it first.`);
        }
    }
    const outPortStates = new Set(outputMoves.map(({ port }) => `${port.nodeId}:${port.stateId}`));
    const outsideHolders = [
        ...(document.nodes ?? []).filter((node) => !node.deleted && !insideNodeIds.has(node.id)),
        ...(document.edges ?? []).filter((edge) => !edge.deleted && !insideEdgeIds.has(edge.id) && !handledEdges.has(edge.id) && !boundary.includes(edge))
    ];
    for (const holder of outsideHolders) {
        const stray = referencesTo(holder, insideNodeIds).find((reference) => !outPortStates.has(`${reference.nodeId}:${reference.stateId}`));
        if (stray) problems.push(`${quoted(holder.name ?? 'Something outside')} reads a state inside ${record.name} that is not an out port: the FMU does not offer it.`);
    }

    if (unitsUnsaid.length) notes.push(`The FMU does not say the unit of ${unitsUnsaid.map(quoted).join(', ')} (an FMI 2.0 export says none): taken as the port's own.`);
    for (const port of fmuInputs) if (!matchedInputs.has(port.name)) notes.push(`The FMU's input ${quoted(port.name)} has no in port here: it keeps the FMU's own start.`);
    for (const port of fmuOutputs) if (!matchedOutputs.has(port.name)) notes.push(`The FMU's output ${quoted(port.name)} is not a port here: it is offered on the FMU's box.`);

    // Exposed parameters: carried to the FMU parameter of the same symbol (the export names an exposed parameter by its symbol), or
    // of the same name.
    const parameterBindings = [];
    for (const parameter of instanceParameters(document, subsystemId)) {
        const match = byName(fmuParameters, parameter.symbol) ?? byName(fmuParameters, parameter.name);
        const shown = parameter.boundTo != null ? `reading shared parameter ${sharedName(document, parameter.boundTo)}` : `${parameter.value}${unitText(parameter.unit)}`;
        if (!match) {
            const text = `${parameter.name} (${parameter.symbol}) = ${shown} has no FMU parameter of the same name: not carried, the FMU keeps its own.`;
            notes.push(text);
            rows.push({ kind: 'parameter', name: parameter.symbol, ok: false, text });
            continue;
        }
        if (unitDiffers(match.unit, parameter.unit)) {
            const text = `${parameter.name} (${parameter.symbol}) is in ${unitOf(parameter.unit) || 'no unit'} here and in ${unitOf(match.unit) || 'no unit'} in the FMU: not carried, the FMU keeps its own.`;
            notes.push(text);
            rows.push({ kind: 'parameter', name: parameter.symbol, ok: false, text });
            continue;
        }
        parameterBindings.push(parameter.boundTo != null
            ? { key: match.key, kind: 'parameter', sharedParameterId: parameter.boundTo }
            : { key: match.key, kind: 'value', value: parameter.value });
        rows.push({ kind: 'parameter', name: parameter.symbol, ok: true, text: `parameter · ${parameter.symbol} = ${shown} → FMU parameter ${match.name}` });
    }
    return result({ record, members, inputBindings, parameterBindings, outputMoves, removedEdgeIds, insideNodeIds, insideEdgeIds });
}

function sharedName(document, id) {
    const shared = (document.sharedParameters ?? []).find((candidate) => candidate.id === id);
    return shared ? `${shared.name ?? shared.symbol} (${shared.symbol})` : 'that is gone';
}

function insideAnotherInstance(document, record) {
    const subsystems = document.subsystems ?? [];
    for (let parent = subsystems.find((item) => item.id === record.parentSubsystemId); parent; parent = subsystems.find((item) => item.id === parent.parentSubsystemId)) {
        if (parent.definitionId != null) return true;
    }
    return false;
}

// Every { nodeId, stateId } an entity refers to (equation bindings, an FMU's or program's bindings, endpoints), at nodes in `nodeIds`.
function referencesTo(value, nodeIds, found = []) {
    if (Array.isArray(value)) value.forEach((item) => referencesTo(item, nodeIds, found));
    else if (value && typeof value === 'object') {
        if (value.nodeId !== undefined && nodeIds.has(Number(value.nodeId))) found.push({ nodeId: Number(value.nodeId), stateId: value.stateId ?? null });
        for (const child of Object.values(value)) if (child && typeof child === 'object') referencesTo(child, nodeIds, found);
    }
    return found;
}

// Points every reference to (fromNodeId, fromStateId) in `value` at (toNodeId, toStateId). Mutates.
function moveReferences(value, from, to) {
    if (Array.isArray(value)) value.forEach((item) => moveReferences(item, from, to));
    else if (value && typeof value === 'object') {
        if (Number(value.nodeId) === from.nodeId && value.stateId === from.stateId) {
            value.nodeId = to.nodeId;
            value.stateId = to.stateId;
        }
        for (const child of Object.values(value)) if (child && typeof child === 'object') moveReferences(child, from, to);
    }
}

// The instance replaced by the FMU node, as one new document: `{ document, nodeId }`. `fmuPorts` and `guid`/`version` name the FMU
// (installed in the library); `newId` gives fresh ids (by default after the document's own). Throws, with the reasons, when the plan
// has problems. The node takes the instance's name and place, so the model reads as before.
export function replaceInstanceWithFmu(document, subsystemId, { fmuPorts, guid, version, newId = null }) {
    const outcome = fmuReplacementPlan(document, subsystemId, fmuPorts);
    if (!outcome.ok) throw new Error(outcome.problems.join(' '));
    const { record, members, inputBindings, parameterBindings, outputMoves, removedEdgeIds, insideNodeIds, insideEdgeIds } = outcome.plan;
    const next = clone(document);
    const allocate = newId ?? idAllocator(next);
    const built = fmiNodeFromPorts({ name: record.name, states: [] }, { guid, version, ports: fmuPorts, newId: allocate });
    const nodeId = allocate();
    // Its rows in the FMU's own order, each reading what the instance's connection or parameter gave it; the rest read nothing (the
    // FMU's own start), which the file leaves out.
    const given = new Map([...inputBindings, ...parameterBindings].map((binding) => [binding.key, binding]));
    built.implementation.bindings = fmuInputRows(fmuPorts.inputs, []).map((row) => given.get(row.key)).filter(Boolean);
    const node = {
        id: nodeId, name: record.name, position: [...(record.position ?? [0, 0, 0])], states: built.states, sourceTerms: [],
        implementation: built.implementation,
        ...(record.parentSubsystemId != null ? { subsystemId: record.parentSubsystemId } : {})
    };
    const removedSubsystems = members.subsystemIds;
    // Its own shared parameters (its exposed parameters' copies, and those used only inside it) go with it.
    const ownShared = new Set(members.sharedParameters.map((shared) => shared.id));
    const removedEdges = new Set([...insideEdgeIds, ...removedEdgeIds]);
    next.nodes = [...(next.nodes ?? []).filter((item) => !insideNodeIds.has(item.id)), node];
    next.edges = (next.edges ?? []).filter((edge) => !removedEdges.has(edge.id));
    next.subsystems = (next.subsystems ?? []).filter((subsystem) => !removedSubsystems.has(subsystem.id));
    next.edgeGroups = (next.edgeGroups ?? []).filter((group) => !(group.memberNodeIds?.length && group.memberNodeIds.every((id) => insideNodeIds.has(id))));
    if (next.sharedParameters) next.sharedParameters = next.sharedParameters.filter((shared) => !ownShared.has(shared.id));
    const used = new Set(next.subsystems.map((subsystem) => subsystem.definitionId).filter((id) => id != null));
    if (next.subsystemDefinitions) next.subsystemDefinitions = next.subsystemDefinitions.filter((definition) => used.has(definition.id));
    // What read an out port reads the FMU's output of the same name.
    const outsideNodes = next.nodes.filter((item) => item !== node);
    for (const { port, key } of outputMoves) {
        const stateId = built.implementation.outputs.find((output) => output.key === key)?.stateId;
        moveReferences([next.edges, outsideNodes], { nodeId: port.nodeId, stateId: port.stateId }, { nodeId, stateId });
    }
    return { document: next, nodeId };
}

// The instance's run, by its out ports' names (the FMU's output names), for Compare with original once it is replaced: `{ modelName,
// times, outputs }`, or null when the samples hold none of them. `samples` are a run's (state values by stateId, project ids).
export function instanceRunByPortName(document, subsystemId, samples, modelName) {
    if (!samples?.length) return null;
    const outputs = {};
    for (const port of instancePorts(document, subsystemId).filter((item) => item.declared && item.direction !== 'in')) {
        const values = samples.map((sample) => sample.states.find((state) => state.stateId === port.stateId)?.value);
        if (values.every((value) => Number.isFinite(value))) outputs[port.name] = values;
    }
    return Object.keys(outputs).length ? { modelName, times: samples.map((sample) => sample.time), outputs } : null;
}
