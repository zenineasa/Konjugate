/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

export const assistantProposalVersion = 1;
const symbolPattern = /^[a-z][A-Za-z0-9]*$/;
const referencePattern = /^[a-z][A-Za-z0-9]*$/;
const operationKinds = new Set([
    'addNode', 'addState', 'addSourceTerm', 'addEdge', 'addParameter', 'setEdgeEquation',
    'updateNode', 'updateState', 'updateEdge', 'updateParameter', 'removeEntity'
]);

export class AssistantProposalError extends Error {
    constructor(message, operationIndex = null) {
        super(operationIndex === null ? message : `Operation ${operationIndex + 1}: ${message}`);
        this.name = 'AssistantProposalError';
        this.operationIndex = operationIndex;
    }
}

function requireText(value, field, operationIndex) {
    if (typeof value !== 'string' || !value.trim()) throw new AssistantProposalError(`${field} is required.`, operationIndex);
    return value.trim();
}

function requireNumber(value, field, operationIndex) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AssistantProposalError(`${field} must be a finite number.`, operationIndex);
    }
    return value;
}

function requireSymbol(value, field, operationIndex) {
    const symbol = requireText(value, field, operationIndex);
    if (!symbolPattern.test(symbol)) {
        throw new AssistantProposalError(`${field} must be a lower camel case identifier.`, operationIndex);
    }
    return symbol;
}

function defaultPosition(nodeIndex) {
    const column = nodeIndex % 4;
    const row = Math.floor(nodeIndex / 4);
    return [(column - 1.5) * 3.6, -row * 3.2, 0];
}

function projectEntities(document) {
    const entities = new Map();
    for (const configuration of document.runConfigurations ?? []) {
        entities.set(configuration.id, { kind: 'runConfiguration', value: configuration });
    }
    for (const node of document.nodes) {
        entities.set(node.id, { kind: 'node', value: node });
        for (const state of node.states ?? []) entities.set(state.id, { kind: 'state', value: state, parent: node });
        for (const term of node.sourceTerms ?? []) entities.set(term.id, { kind: 'sourceTerm', value: term, parent: node });
    }
    for (const edge of document.edges) {
        entities.set(edge.id, { kind: 'edge', value: edge });
        for (const parameter of edge.parameters ?? []) entities.set(parameter.id, { kind: 'parameter', value: parameter, parent: edge });
    }
    return entities;
}

export function validateAssistantProposal(proposal) {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
        throw new AssistantProposalError('A proposal must be an object.');
    }
    if (proposal.proposalVersion !== assistantProposalVersion) {
        throw new AssistantProposalError(`proposalVersion must be ${assistantProposalVersion}.`);
    }
    if (!Array.isArray(proposal.operations) || !proposal.operations.length) {
        throw new AssistantProposalError('A proposal requires at least one operation.');
    }
    proposal.operations.forEach((operation, index) => {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
            throw new AssistantProposalError('The operation must be an object.', index);
        }
        if (!operationKinds.has(operation.kind)) {
            throw new AssistantProposalError(`Unsupported operation kind “${operation.kind ?? ''}”.`, index);
        }
        if (operation.ref !== undefined && !referencePattern.test(operation.ref)) {
            throw new AssistantProposalError('ref must be a lower camel case temporary reference.', index);
        }
    });
    return true;
}

export function applyAssistantProposal(projectDocument, proposal, options = {}) {
    validateAssistantProposal(proposal);
    if (projectDocument?.format !== 'konjugate' || projectDocument.version !== 1 ||
        !Array.isArray(projectDocument.nodes) || !Array.isArray(projectDocument.edges)) {
        throw new AssistantProposalError('The active project is not a supported Konjugate document.');
    }

    const document = structuredClone(projectDocument);
    const entities = projectEntities(document);
    let nextEntityId = Math.max(0, ...entities.keys()) + 1;
    const idFactory = options.idFactory ?? (() => nextEntityId++);
    const temporaryReferences = new Map();
    const changes = [];

    const allocate = (operation, kind, value, parent, operationIndex) => {
        const id = idFactory();
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new AssistantProposalError('The id factory must produce a positive safe integer.', operationIndex);
        }
        if (entities.has(id)) throw new AssistantProposalError('The id factory produced a duplicate identifier.', operationIndex);
        if (operation.ref) {
            if (temporaryReferences.has(operation.ref)) {
                throw new AssistantProposalError(`Temporary reference “${operation.ref}” is already defined.`, operationIndex);
            }
            temporaryReferences.set(operation.ref, id);
        }
        value.id = id;
        entities.set(id, { kind, value, parent });
        return id;
    };
    const resolve = (reference, expectedKind, operationIndex) => {
        const key = temporaryReferences.get(reference) ?? reference;
        const entity = entities.get(key);
        if (!entity) throw new AssistantProposalError(`Reference “${reference ?? ''}” does not exist or has not been created yet.`, operationIndex);
        if (entity.kind !== expectedKind) {
            throw new AssistantProposalError(`Reference “${reference}” identifies a ${entity.kind}, not a ${expectedKind}.`, operationIndex);
        }
        return entity;
    };
    const ensureUniqueSymbol = (items, symbol, entityName, operationIndex) => {
        if (items.some((item) => item.symbol === symbol)) {
            throw new AssistantProposalError(`${entityName} already contains the symbol “${symbol}”.`, operationIndex);
        }
    };
    const clearEdgeEquation = (edge) => {
        edge.equation = '';
        edge.equationModel = { latex: '', output: { role: 'target', stateId: edge.target.stateId ?? null }, bindings: [], mathJson: null };
    };
    const changedFields = (before, after) => Object.keys(after)
        .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
        .map((field) => ({ field, before: before[field], after: after[field] }));

    proposal.operations.forEach((operation, operationIndex) => {
        switch (operation.kind) {
        case 'addNode': {
            const name = requireText(operation.name, 'name', operationIndex);
            const position = operation.position ?? defaultPosition(document.nodes.length);
            if (!Array.isArray(position) || position.length !== 3 || position.some((item) => !Number.isFinite(item))) {
                throw new AssistantProposalError('position must contain three finite numbers.', operationIndex);
            }
            const allowedShapes = new Set(['box', 'cylinder', 'sphere']);
            const shape = operation.shape ?? 'box';
            if (!allowedShapes.has(shape)) throw new AssistantProposalError('shape must be box, cylinder or sphere.', operationIndex);
            const color = operation.color ?? '#34727a';
            if (!/^#[0-9a-f]{6}$/i.test(color)) throw new AssistantProposalError('color must be a six-digit hexadecimal color.', operationIndex);
            const node = {
                name,
                type: typeof operation.type === 'string' && operation.type.trim() ? operation.type.trim() : 'Custom node',
                numerics: { substepsPerGlobalStep: 1 },
                position: [...position],
                states: [],
                sourceTerms: [],
                appearance: { type: 'primitive', shape, color }
            };
            allocate(operation, 'node', node, null, operationIndex);
            document.nodes.push(node);
            changes.push({ kind: operation.kind, action: 'add', entityId: node.id, label: `Add node “${name}”` });
            break;
        }
        case 'addState': {
            const node = resolve(operation.nodeRef, 'node', operationIndex).value;
            const symbol = requireSymbol(operation.symbol, 'symbol', operationIndex);
            ensureUniqueSymbol(node.states, symbol, `Node “${node.name}”`, operationIndex);
            const state = {
                name: requireText(operation.name, 'name', operationIndex),
                symbol,
                initialValue: requireNumber(operation.initialValue, 'initialValue', operationIndex),
                unit: typeof operation.unit === 'string' ? operation.unit.trim() : ''
            };
            allocate(operation, 'state', state, node, operationIndex);
            node.states.push(state);
            changes.push({ kind: operation.kind, action: 'add', entityId: state.id, focusEntityId: node.id, label: `Add state ${symbol} to “${node.name}”` });
            break;
        }
        case 'addSourceTerm': {
            const node = resolve(operation.nodeRef, 'node', operationIndex).value;
            const output = resolve(operation.outputStateRef, 'state', operationIndex);
            if (output.parent !== node) throw new AssistantProposalError('The output state does not belong to the source-term node.', operationIndex);
            const latex = requireText(operation.latex, 'latex', operationIndex);
            const bindings = node.states.map((state) => ({
                kind: 'state', nodeId: node.id, stateId: state.id, symbol: state.symbol, label: state.symbol
            }));
            const validation = validateEquationLatex(latex, bindings);
            if (!validation.valid) throw new AssistantProposalError(validation.errors.join(' '), operationIndex);
            const term = {
                state: output.value.symbol,
                expression: latex,
                expressionModel: {
                    latex,
                    bindings,
                    output: { stateId: output.value.id },
                    mathJson: validation.mathJson
                }
            };
            allocate(operation, 'sourceTerm', term, node, operationIndex);
            node.sourceTerms.push(term);
            changes.push({ kind: operation.kind, action: 'add', entityId: term.id, focusEntityId: node.id, label: `Add local term for ${output.value.symbol}` });
            break;
        }
        case 'addEdge': {
            const source = resolve(operation.sourceNodeRef, 'node', operationIndex).value;
            const target = resolve(operation.targetNodeRef, 'node', operationIndex).value;
            if (source === target) throw new AssistantProposalError('An edge must connect two different nodes.', operationIndex);
            const directionality = operation.directionality ?? 'directed';
            if (!['directed', 'bidirectional'].includes(directionality)) {
                throw new AssistantProposalError('directionality must be directed or bidirectional.', operationIndex);
            }
            const edge = {
                name: requireText(operation.name, 'name', operationIndex),
                source: { nodeId: source.id, stateId: null },
                target: { nodeId: target.id, stateId: null },
                directionality,
                equation: '',
                equationModel: { latex: '', output: { role: 'target', stateId: null }, bindings: [], mathJson: null },
                parameters: [],
                appearance: { color: '#9c83c4', offset: 0 }
            };
            allocate(operation, 'edge', edge, null, operationIndex);
            document.edges.push(edge);
            changes.push({ kind: operation.kind, action: 'add', entityId: edge.id, label: `Connect “${source.name}” to “${target.name}”` });
            break;
        }
        case 'addParameter': {
            const edge = resolve(operation.edgeRef, 'edge', operationIndex).value;
            const symbol = requireSymbol(operation.symbol, 'symbol', operationIndex);
            ensureUniqueSymbol(edge.parameters, symbol, `Relationship “${edge.name}”`, operationIndex);
            const mode = operation.mode ?? 'constant';
            if (!['constant', 'live'].includes(mode)) throw new AssistantProposalError('mode must be constant or live.', operationIndex);
            const parameter = {
                name: requireText(operation.name, 'name', operationIndex),
                symbol,
                value: requireNumber(operation.value, 'value', operationIndex),
                unit: typeof operation.unit === 'string' ? operation.unit.trim() : '',
                mode
            };
            allocate(operation, 'parameter', parameter, edge, operationIndex);
            edge.parameters.push(parameter);
            changes.push({ kind: operation.kind, action: 'add', entityId: parameter.id, focusEntityId: edge.id, label: `Add parameter ${symbol} to “${edge.name}”` });
            break;
        }
        case 'updateNode': {
            const node = resolve(operation.nodeRef, 'node', operationIndex).value;
            const before = structuredClone(node);
            if (operation.name !== undefined) node.name = requireText(operation.name, 'name', operationIndex);
            if (operation.type !== undefined) node.type = requireText(operation.type, 'type', operationIndex);
            if (operation.substepsPerGlobalStep !== undefined) {
                const substeps = requireNumber(operation.substepsPerGlobalStep, 'substepsPerGlobalStep', operationIndex);
                if (!Number.isInteger(substeps) || substeps < 1) throw new AssistantProposalError('substepsPerGlobalStep must be a positive integer.', operationIndex);
                node.numerics = { ...node.numerics, substepsPerGlobalStep: substeps };
            }
            if (operation.shape !== undefined) {
                if (!['box', 'cylinder', 'sphere'].includes(operation.shape)) throw new AssistantProposalError('shape must be box, cylinder or sphere.', operationIndex);
                node.appearance = { type: 'primitive', shape: operation.shape, color: node.appearance?.color ?? '#34727a' };
            }
            if (operation.color !== undefined) {
                if (!/^#[0-9a-f]{6}$/i.test(operation.color)) throw new AssistantProposalError('color must be a six-digit hexadecimal color.', operationIndex);
                node.appearance = { ...node.appearance, color: operation.color };
            }
            const fields = changedFields(before, node);
            if (!fields.length) throw new AssistantProposalError('updateNode must change at least one field.', operationIndex);
            changes.push({ kind: operation.kind, action: 'update', entityId: node.id, focusEntityId: node.id, label: `Update node “${before.name}”`, fields });
            break;
        }
        case 'updateState': {
            const entity = resolve(operation.stateRef, 'state', operationIndex);
            const state = entity.value;
            const before = structuredClone(state);
            if (operation.name !== undefined) state.name = requireText(operation.name, 'name', operationIndex);
            if (operation.initialValue !== undefined) state.initialValue = requireNumber(operation.initialValue, 'initialValue', operationIndex);
            if (operation.unit !== undefined) state.unit = String(operation.unit).trim();
            const fields = changedFields(before, state);
            if (!fields.length) throw new AssistantProposalError('updateState must change at least one field.', operationIndex);
            changes.push({ kind: operation.kind, action: 'update', entityId: state.id, focusEntityId: entity.parent.id, label: `Update state ${state.symbol} on “${entity.parent.name}”`, fields });
            break;
        }
        case 'updateEdge': {
            const edge = resolve(operation.edgeRef, 'edge', operationIndex).value;
            const before = structuredClone(edge);
            if (operation.name !== undefined) edge.name = requireText(operation.name, 'name', operationIndex);
            if (operation.directionality !== undefined) {
                if (!['directed', 'bidirectional'].includes(operation.directionality)) throw new AssistantProposalError('directionality must be directed or bidirectional.', operationIndex);
                edge.directionality = operation.directionality;
            }
            let endpointChanged = false;
            if (operation.sourceNodeRef !== undefined) {
                const source = resolve(operation.sourceNodeRef, 'node', operationIndex).value;
                endpointChanged ||= source.id !== edge.source.nodeId;
                edge.source = { nodeId: source.id, stateId: source.states[0]?.id ?? null };
            }
            if (operation.targetNodeRef !== undefined) {
                const target = resolve(operation.targetNodeRef, 'node', operationIndex).value;
                endpointChanged ||= target.id !== edge.target.nodeId;
                edge.target = { nodeId: target.id, stateId: target.states[0]?.id ?? null };
            }
            if (edge.source.nodeId === edge.target.nodeId) throw new AssistantProposalError('An edge must connect two different nodes.', operationIndex);
            if (endpointChanged) clearEdgeEquation(edge);
            const fields = changedFields(before, edge);
            if (!fields.length) throw new AssistantProposalError('updateEdge must change at least one field.', operationIndex);
            changes.push({ kind: operation.kind, action: 'update', entityId: edge.id, focusEntityId: edge.id, label: `Update relationship “${before.name}”`, fields });
            break;
        }
        case 'updateParameter': {
            const entity = resolve(operation.parameterRef, 'parameter', operationIndex);
            const parameter = entity.value;
            const before = structuredClone(parameter);
            if (operation.name !== undefined) parameter.name = requireText(operation.name, 'name', operationIndex);
            if (operation.value !== undefined) parameter.value = requireNumber(operation.value, 'value', operationIndex);
            if (operation.unit !== undefined) parameter.unit = String(operation.unit).trim();
            if (operation.mode !== undefined) {
                if (!['constant', 'live'].includes(operation.mode)) throw new AssistantProposalError('mode must be constant or live.', operationIndex);
                parameter.mode = operation.mode;
            }
            const fields = changedFields(before, parameter);
            if (!fields.length) throw new AssistantProposalError('updateParameter must change at least one field.', operationIndex);
            changes.push({ kind: operation.kind, action: 'update', entityId: parameter.id, focusEntityId: entity.parent.id, label: `Update parameter ${parameter.symbol} on “${entity.parent.name}”`, fields });
            break;
        }
        case 'removeEntity': {
            const key = temporaryReferences.get(operation.entityRef) ?? operation.entityRef;
            const entity = entities.get(key);
            if (!entity) throw new AssistantProposalError(`Reference “${operation.entityRef ?? ''}” does not exist or has not been created yet.`, operationIndex);
            let label;
            let focusEntityId = null;
            if (entity.kind === 'node') {
                focusEntityId = key;
                label = `Remove node “${entity.value.name}” and its connected relationships`;
                const removedEdges = document.edges.filter((edge) => edge.source.nodeId === key || edge.target.nodeId === key);
                const edgeIds = removedEdges.map((edge) => edge.id);
                document.edges = document.edges.filter((edge) => !edgeIds.includes(edge.id));
                edgeIds.forEach((id) => entities.delete(id));
                removedEdges.flatMap((edge) => edge.parameters).forEach((parameter) => entities.delete(parameter.id));
                for (const item of [...entity.value.states, ...entity.value.sourceTerms]) entities.delete(item.id);
                document.nodes = document.nodes.filter((node) => node.id !== key);
            } else if (entity.kind === 'edge') {
                focusEntityId = key;
                label = `Remove relationship “${entity.value.name}”`;
                entity.value.parameters.forEach((parameter) => entities.delete(parameter.id));
                document.edges = document.edges.filter((edge) => edge.id !== key);
            } else if (entity.kind === 'state') {
                focusEntityId = entity.parent.id;
                label = `Remove state ${entity.value.symbol} from “${entity.parent.name}”`;
                entity.parent.states = entity.parent.states.filter((state) => state.id !== key);
                const removedTerms = entity.parent.sourceTerms.filter((term) => term.expressionModel?.output?.stateId === key);
                removedTerms.forEach((term) => entities.delete(term.id));
                entity.parent.sourceTerms = entity.parent.sourceTerms.filter((term) => !removedTerms.includes(term));
                document.edges.forEach((edge) => {
                    const usesState = edge.source.stateId === key || edge.target.stateId === key || edge.equationModel?.bindings?.some((binding) => binding.stateId === key);
                    if (edge.source.stateId === key) edge.source.stateId = null;
                    if (edge.target.stateId === key) edge.target.stateId = null;
                    if (usesState) clearEdgeEquation(edge);
                });
            } else if (entity.kind === 'parameter') {
                focusEntityId = entity.parent.id;
                label = `Remove parameter ${entity.value.symbol} from “${entity.parent.name}”`;
                entity.parent.parameters = entity.parent.parameters.filter((parameter) => parameter.id !== key);
                if (entity.parent.equationModel?.bindings?.some((binding) => binding.parameterId === key)) clearEdgeEquation(entity.parent);
            } else {
                focusEntityId = entity.parent.id;
                label = `Remove source term from “${entity.parent.name}”`;
                entity.parent.sourceTerms = entity.parent.sourceTerms.filter((term) => term.id !== key);
            }
            entities.delete(key);
            changes.push({ kind: operation.kind, action: 'remove', entityId: key, focusEntityId, label });
            break;
        }
        case 'setEdgeEquation': {
            const edge = resolve(operation.edgeRef, 'edge', operationIndex).value;
            const sourceNode = resolve(edge.source.nodeId, 'node', operationIndex).value;
            const targetNode = resolve(edge.target.nodeId, 'node', operationIndex).value;
            const output = resolve(operation.outputStateRef, 'state', operationIndex);
            const outputRole = output.parent === sourceNode ? 'source' : output.parent === targetNode ? 'target' : null;
            if (!outputRole) throw new AssistantProposalError('The equation output state must belong to an edge endpoint.', operationIndex);
            const latex = requireText(operation.latex, 'latex', operationIndex);
            const bindings = reconcileEquationBindings([], sourceNode, targetNode, edge.parameters);
            const validation = validateEquationLatex(latex, bindings);
            if (!validation.valid) throw new AssistantProposalError(validation.errors.join(' '), operationIndex);
            edge.source.stateId ??= sourceNode.states[0]?.id ?? null;
            edge.target.stateId ??= targetNode.states[0]?.id ?? null;
            edge.equation = latex;
            edge.equationModel = {
                latex,
                output: { role: outputRole, stateId: output.value.id },
                bindings,
                mathJson: validation.mathJson
            };
            changes.push({ kind: operation.kind, action: 'update', entityId: edge.id, focusEntityId: edge.id, label: `Define equation for “${edge.name}”` });
            break;
        }
        }
    });

    return {
        document,
        changes,
        temporaryReferences: Object.fromEntries(temporaryReferences)
    };
}
