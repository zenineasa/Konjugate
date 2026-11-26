/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The interface an FMU export offers when the project declares ports at the top level (docs/proposals/rootPorts.md, stage 4):
// its in ports become the FMU's inputs, its out ports (and ports both ways) its outputs, its exposed parameters its tunable
// parameters, and every other state is observable (causality "local"). Worked out from the project document before it is
// flattened for the engine, which takes the component block away. A project without ports has no interface here, and its
// FMU export takes today's path, byte for byte. No DOM, so `npm test` runs it.

import { rootPorts } from './components.mjs';

const everyParameter = (document) => [
    ...(document.edges ?? []).flatMap((edge) => (edge.parameters ?? []).map((parameter) => ({ parameter, owner: edge.name }))),
    ...(document.nodes ?? []).flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => (term.parameters ?? []).map((parameter) => ({ parameter, owner: node.name }))))
];

// `{ inputs, outputs, parameters, bothWays, problems, baked }`, or null when the project declares no ports. Inputs and outputs are
// `{ key, stateId, name, unit }`; parameters `{ sharedParameterId, symbol, name, unit, value }`. `problems` are the ports an
// export refuses, each said with why: an in port must be an Update nothing in the model sets, since a host's input is held as
// that state's value. `baked` counts the parameters that are not part of the interface: constant ones (offered to expose) and
// live ones (a person's knobs, baked at their value or computed from their schedule).
export function fmuExportInterface(document) {
    const ports = rootPorts(document);
    if (!ports.length) return null;
    const inputs = [];
    const outputs = [];
    const bothWays = [];
    const problems = [];
    for (const port of ports) {
        const entry = { key: port.key, stateId: port.stateId, name: port.name, unit: port.unit };
        if (port.direction === 'in') {
            if (port.kind !== 'update') problems.push(`“${port.name}” is an in port on a Rate state: an FMU's input is a value the host holds, so an in port must be an Update. Make ${port.symbol} an Update, or make the port an out port.`);
            else if (port.reached) problems.push(`“${port.name}” is an in port that the model also sets inside: an FMU's input is a value the host holds, so nothing inside may set it. Remove what sets ${port.symbol}, or make the port an out port.`);
            inputs.push(entry);
        } else {
            outputs.push(entry);
            if (port.direction !== 'out') bothWays.push(port.name);
        }
    }
    const exposed = (document.sharedParameters ?? []).filter((shared) => shared.exposed && shared.subsystemId == null && !shared.schedule);
    const parameters = exposed.map((shared) => ({ sharedParameterId: shared.id, symbol: shared.symbol, name: shared.name ?? shared.symbol, unit: shared.unit ?? '', value: Number(shared.value ?? 0) }));
    const exposedIds = new Set(exposed.map((shared) => shared.id));
    const sharedById = new Map((document.sharedParameters ?? []).map((shared) => [shared.id, shared]));
    const counted = new Set();
    const baked = { constant: 0, live: 0 };
    for (const { parameter } of everyParameter(document)) {
        const shared = parameter.sharedParameterId != null ? sharedById.get(parameter.sharedParameterId) : null;
        if (shared && exposedIds.has(shared.id)) continue;
        const source = shared ?? parameter;
        const id = shared ? `shared:${shared.id}` : `own:${parameter.id}`;
        if (counted.has(id) || source.schedule) continue;
        counted.add(id);
        baked[source.mode === 'live' ? 'live' : 'constant'] += 1;
    }
    return { inputs, outputs, parameters, bothWays, problems, baked };
}

// The export dialog's summary of what a host gets, in the interface's own words: "Inputs: setpoint (°C), measurement (°C) ·
// Outputs: command · Parameters: kp, ti (tunable) · 4 other states observable · Steps: whole multiples of 0.01 s".
export function fmuInterfaceSummary(fmuInterface, { stateCount, globalTimeStep }) {
    const named = (items) => items.map((item) => (item.unit ? `${item.name} (${item.unit})` : item.name)).join(', ');
    const locals = stateCount - fmuInterface.inputs.length - fmuInterface.outputs.length;
    return [
        `Inputs: ${fmuInterface.inputs.length ? named(fmuInterface.inputs) : 'none'}`,
        `Outputs: ${fmuInterface.outputs.length ? named(fmuInterface.outputs) : 'none'}`,
        `Parameters: ${fmuInterface.parameters.length ? `${fmuInterface.parameters.map((parameter) => parameter.symbol).join(', ')} (tunable)` : 'none'}`,
        `${locals} other state${locals === 1 ? '' : 's'} observable`,
        `Steps: whole multiples of ${globalTimeStep} s`
    ].join(' · ');
}

// The constant parameters an export bakes, made the project's exposed parameters in one step (the dialog's Expose them): a shared
// one marked exposed; a relationship's or node's own one made a shared parameter of its own, exposed, and linked to it, its
// symbol kept where no shared parameter has it yet, else numbered (k, k2). Live and scheduled ones are left as they are. `newId`
// gives a fresh id for each shared parameter made. Returns a new document.
export function exposeBakedParameters(document, newId) {
    const next = structuredClone(document);
    next.sharedParameters = next.sharedParameters ?? [];
    const taken = new Set(next.sharedParameters.map((shared) => shared.symbol));
    for (const shared of next.sharedParameters) {
        if (shared.subsystemId == null && !shared.exposed && shared.mode !== 'live' && !shared.schedule) shared.exposed = true;
    }
    for (const { parameter } of everyParameter(next)) {
        if (parameter.sharedParameterId != null || parameter.mode === 'live' || parameter.schedule) continue;
        let symbol = parameter.symbol;
        for (let number = 2; taken.has(symbol); number += 1) symbol = `${parameter.symbol}${number}`;
        taken.add(symbol);
        const id = newId();
        next.sharedParameters.push({
            id, name: parameter.name ?? parameter.symbol, symbol, value: Number(parameter.value) || 0, unit: parameter.unit ?? '', mode: 'constant', exposed: true
        });
        parameter.sharedParameterId = id;
        // As linking a row to a new shared parameter does: its fitting bounds and slider are the shared parameter's to have.
        delete parameter.tuning;
        delete parameter.control;
    }
    if (!next.sharedParameters.length) delete next.sharedParameters;
    return next;
}
