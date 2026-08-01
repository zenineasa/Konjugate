/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { reconcileEquationBindings, validateEquationLatex } from './equationModel.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const symbolPattern = /^[a-z][A-Za-z0-9]*$/;

function issue(code, severity, message, kind = 'model', entityId = null, field = null) {
    return { code, severity, message, location: { kind, entityId, field } };
}

export function validateModel(model) {
    const issues = [];
    const ids = new Set();
    const nodes = model.nodes ?? [];
    const relationships = model.relationships ?? [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));

    const registerId = (id, kind, entityId, label) => {
        if (!uuidPattern.test(id ?? '')) issues.push(issue('invalidUuid', 'error', `${label} does not have a valid UUID.`, kind, entityId, 'id'));
        else if (ids.has(id)) issues.push(issue('duplicateUuid', 'error', `${label} reuses an existing UUID.`, kind, entityId, 'id'));
        ids.add(id);
    };

    if (!nodes.length) issues.push(issue('emptyModel', 'warning', 'Add at least one node to begin building a model.'));

    for (const node of nodes) {
        registerId(node.id, 'node', node.id, `Node “${node.title || 'Untitled'}”`);
        if (!node.title?.trim()) issues.push(issue('nodeNameEmpty', 'warning', 'Give this node a descriptive name.', 'node', node.id, 'name'));
        if (!node.states?.length) issues.push(issue('nodeStatesEmpty', 'warning', 'This node has no state variables.', 'node', node.id, 'states'));
        const symbols = new Set();
        for (const state of node.states ?? []) {
            registerId(state.id, 'node', node.id, `State “${state.label || state.symbol || 'Untitled'}”`);
            if (!symbolPattern.test(state.symbol ?? '')) issues.push(issue('stateSymbolInvalid', 'error', `State symbol “${state.symbol || ''}” must be lower camel case.`, 'node', node.id, 'states'));
            else if (symbols.has(state.symbol)) issues.push(issue('stateSymbolDuplicate', 'error', `State symbol “${state.symbol}” is duplicated in this node.`, 'node', node.id, 'states'));
            symbols.add(state.symbol);
        }
        for (const term of node.sourceTerms ?? []) {
            registerId(term.id, 'node', node.id, 'Source term');
            if (!symbols.has(term.state)) issues.push(issue('sourceStateMissing', 'error', `Source term references missing state “${term.state || ''}”.`, 'node', node.id, 'sourceTerms'));
            if (!term.expression?.trim()) issues.push(issue('sourceExpressionEmpty', 'error', 'Source term requires an expression.', 'node', node.id, 'sourceTerms'));
        }
    }

    const executableRelationships = [];
    for (const relationship of relationships) {
        registerId(relationship.id, 'edge', relationship.id, `Relationship “${relationship.title || 'Untitled'}”`);
        const sourceNode = nodeById.get(relationship.source);
        const targetNode = nodeById.get(relationship.target);
        if (!sourceNode) issues.push(issue('edgeSourceMissing', 'error', 'Relationship source node no longer exists.', 'edge', relationship.id, 'source'));
        if (!targetNode) issues.push(issue('edgeTargetMissing', 'error', 'Relationship target node no longer exists.', 'edge', relationship.id, 'target'));
        if (relationship.source === relationship.target) issues.push(issue('edgeSelfConnection', 'error', 'A relationship must connect two different nodes.', 'edge', relationship.id, 'target'));

        const parameterSymbols = new Set();
        for (const parameter of relationship.parameters ?? []) {
            registerId(parameter.id, 'edge', relationship.id, `Parameter “${parameter.name || parameter.symbol || 'Untitled'}”`);
            if (!symbolPattern.test(parameter.symbol ?? '')) issues.push(issue('parameterSymbolInvalid', 'error', `Parameter symbol “${parameter.symbol || ''}” must be lower camel case.`, 'edge', relationship.id, 'parameters'));
            else if (parameterSymbols.has(parameter.symbol)) issues.push(issue('parameterSymbolDuplicate', 'error', `Parameter symbol “${parameter.symbol}” is duplicated.`, 'edge', relationship.id, 'parameters'));
            parameterSymbols.add(parameter.symbol);
        }

        if (!sourceNode || !targetNode) continue;
        const equationModel = relationship.equationModel ?? {};
        const latex = equationModel.latex ?? relationship.equation ?? '';
        const bindings = reconcileEquationBindings(equationModel.bindings, sourceNode, targetNode, relationship.parameters);
        const equationValidation = validateEquationLatex(latex, bindings);
        if (!latex.trim()) issues.push(issue('edgeEquationEmpty', 'error', 'Relationship requires an equation.', 'edge', relationship.id, 'equation'));
        else if (!equationValidation.valid) issues.push(issue('edgeEquationInvalid', 'error', equationValidation.errors.join(' '), 'edge', relationship.id, 'equation'));
        const outputNode = equationModel.output?.role === 'source' ? sourceNode : targetNode;
        if (!equationModel.output?.stateId || !outputNode.states?.some((state) => state.id === equationModel.output.stateId)) {
            issues.push(issue('edgeOutputMissing', 'error', 'Choose the state updated by this equation.', 'edge', relationship.id, 'output'));
        }
        executableRelationships.push({ id: relationship.id, bindings, mathJson: equationValidation.valid ? equationValidation.mathJson : null, output: equationModel.output ?? null });
    }

    const blocking = issues.some((item) => item.severity === 'error');
    return {
        valid: !blocking,
        issues,
        executableModel: blocking ? null : { nodes, relationships: executableRelationships }
    };
}
