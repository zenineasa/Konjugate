/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Why a run stopped, in words a person can act on: the engine's message (which reaches the renderer as one line, often
// prefixed by a code) turned into a title, a few lines and the nodes it is about. For an imported FMU the engine names
// the FMU's model, its call, the time and what the FMU said (engine/include/konjugate/fmiImportedNode.hpp, refused());
// this finds the node or nodes running that FMU, says the call in plain words, and gives the value the offending
// variable started from, or every parameter's when the FMU refused a step, since a parameter left at 0 is the usual
// cause. See docs/proposals/fmuImportWorkflow.md, stage 1.

const fmuRefusal = /^The FMU '(.+?)' (refused|failed fatally in) (\S+)(?: \(([^)]*)\))?(?: at t = (\S+?))?: (.*)$/s;

// What an FMI call was for, as a person would say it; what names the variable or step, from the engine's message.
function plainCall(call, what) {
    const variable = /^(setting|getting) '(.+)'$/.exec(what ?? '');
    if (variable) return variable[1] === 'setting' ? `the value given to ${variable[2]}` : `a request for ${variable[2]}`;
    if (/DoStep$/.test(call)) {
        const step = /^a step of (.+)$/.exec(what ?? '');
        return step ? `its step (a step of ${step[1]} s)` : 'its step';
    }
    if (/Instantiate/.test(call)) return 'its start';
    if (/InitializationMode$|SetupExperiment$/.test(call)) return 'its start values';
    if (/FMUstate|FMUState/i.test(call)) return 'saving or restoring its state';
    return what ? `${call} (${what})` : call;
}

// The FMU's own reason, without the log category some FMUs put first ("logStatusError: ...").
function plainReason(reason) {
    const text = String(reason ?? '').trim().replace(/^log[A-Za-z]*:\s*/, '');
    if (!text || /^it gave no reason\.?$/.test(text)) return '';
    return text.endsWith('.') ? text : `${text}.`;
}

function numberText(value) {
    return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : String(value);
}

function nodeName(node) {
    return node?.name ?? node?.title ?? `node ${node?.id}`;
}

// What a binding of `node`'s program reads and the value it starts from: { label, value, unit } or null.
function bindingStart(binding, node, nodes, sharedParameters) {
    if (!binding) return null;
    if (binding.kind === 'parameter') {
        const shared = sharedParameters.find((candidate) => candidate.id === binding.sharedParameterId);
        if (!shared) return null;
        return { label: `shared ${shared.name ?? shared.symbol}`, value: shared.schedule ? null : Number(shared.value ?? 0), unit: shared.unit ?? '', scheduled: Boolean(shared.schedule) };
    }
    if (binding.kind === 'state') {
        const owner = binding.nodeId === undefined || binding.nodeId === null ? node : nodes.find((candidate) => candidate.id === binding.nodeId);
        const state = owner?.states?.find((candidate) => candidate.id === binding.stateId);
        if (!state) return null;
        return {
            label: owner === node ? `this.${state.symbol}` : `${nodeName(owner)}.${state.symbol}`,
            value: Number(state.initialValue ?? state.value ?? 0), unit: state.unit ?? ''
        };
    }
    return null;
}

function valueText(start) {
    if (!start) return 'not set';
    if (start.scheduled) return `follows a schedule (${start.label})`;
    return `${numberText(start.value)}${start.unit ? ` ${start.unit}` : ''}`;
}

function listOf(names) {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const maximumListed = 8;

// message: the engine's text. document: { nodes, edges, sharedParameters } as the project serializes them. fmuPorts: an
// object from node id to that node's FMU ports (src/fmiResolver.mjs describeInstalledFmuPorts), for the FMU nodes
// whose ports could be read. Returns { title, lines, nodeIds, message } -- message the engine's text without its code.
export function describeRunFailure(message, document = {}, fmuPorts = {}) {
    const nodes = document.nodes ?? [];
    const edges = document.edges ?? [];
    const sharedParameters = document.sharedParameters ?? [];
    let text = String(message ?? '').trim();
    for (let previous = ''; previous !== text;) {
        previous = text;
        text = text.replace(/^[A-Z][A-Z0-9_]+:\s*/, '').replace(/^Error:\s*/, '').replace(/^A node program failed:\s*/, '');
    }
    if (!text) return { title: 'The run stopped, and the engine gave no reason.', lines: [], nodeIds: [], message: text };

    const refusal = fmuRefusal.exec(text);
    if (refusal) {
        const [, modelName, how, call, what, time, reason] = refusal;
        const fmuNodes = nodes.filter((node) => node.implementation?.kind === 'fmi');
        let running = fmuNodes.filter((node) => fmuPorts[node.id]?.name === modelName);
        if (!running.length && fmuNodes.length === 1) running = fmuNodes;
        const where = running.length ? `the FMU in ${listOf(running.map((node) => `'${nodeName(node)}'`))}` : `the FMU '${modelName}'`;
        const at = time === undefined ? '' : ` at t = ${time} s`;
        const title = `The run stopped${at}: ${where} ${how === 'refused' ? 'refused' : 'stopped with a fatal error on'} ${plainCall(call, what)}.`;
        const lines = [];
        const said = plainReason(reason);
        if (said) lines.push(`It said: ${said}`);
        const node = running.length === 1 ? running[0] : null;
        const ports = node ? fmuPorts[node.id] : null;
        const bindings = node?.implementation?.bindings ?? [];
        const variable = /^setting '(.+)'$/.exec(what ?? '')?.[1];
        if (node && ports && variable) {
            const port = (ports.inputs ?? []).find((candidate) => candidate.name === variable);
            if (port) {
                const start = bindingStart(bindings.find((binding) => binding.key === port.key), node, nodes, sharedParameters);
                lines.push(`${variable} was ${valueText(start)} at the start${start ? ` (it reads ${start.label})` : ''}.`);
            }
        } else if (node && ports) {
            const parameters = (ports.inputs ?? []).filter((port) => port.causality === 'parameter');
            if (parameters.length) {
                const values = parameters.slice(0, maximumListed).map((port) => `${port.name} = ${valueText(bindingStart(bindings.find((binding) => binding.key === port.key), node, nodes, sharedParameters))}`);
                const more = parameters.length > maximumListed ? `, and ${parameters.length - maximumListed} more` : '';
                lines.push(`Its parameters at the start: ${values.join(', ')}${more}.`);
                const zeros = parameters.filter((port) => bindingStart(bindings.find((binding) => binding.key === port.key), node, nodes, sharedParameters)?.value === 0);
                if (zeros.length) lines.push(`A parameter at 0 is a common cause: check ${listOf(zeros.map((port) => port.name))}.`);
            }
        }
        return { title, lines, nodeIds: running.map((node) => node.id), message: text };
    }

    // Not an FMU: the engine's sentence, with a relationship named by its name rather than its number.
    const relationship = /^The relationship (\d+) /.exec(text);
    const edge = relationship ? edges.find((candidate) => String(candidate.id) === relationship[1]) : null;
    const said = edge ? text.replace(/^The relationship \d+ /, `The relationship '${edge.name ?? edge.id}' `) : text;
    const lines = [];
    if (/non-finite/.test(text)) lines.push('A value became infinite or not a number: look for a division by zero, a logarithm or square root of a negative number, or a value that grows without bound.');
    return { title: `The run stopped: ${said.endsWith('.') ? said : `${said}.`}`, lines, nodeIds: [], message: text };
}
