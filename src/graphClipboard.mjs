/* Copyright © 2026 Zenin Easa Panthakkalakath */

export const graphFragmentFormat = 'konjugateGraphFragment';
export const graphFragmentVersion = 1;

function remapEquationModel(equationModel, ids) {
    if (!equationModel) return equationModel;
    return {
        ...structuredClone(equationModel),
        bindings: (equationModel.bindings ?? []).map((binding) => ({
            ...structuredClone(binding),
            ...(ids.has(binding.nodeId) ? { nodeId: ids.get(binding.nodeId) } : {}),
            ...(ids.has(binding.stateId) ? { stateId: ids.get(binding.stateId) } : {}),
            ...(ids.has(binding.parameterId) ? { parameterId: ids.get(binding.parameterId) } : {})
        })),
        ...(equationModel.output ? {
            output: {
                ...structuredClone(equationModel.output),
                ...(ids.has(equationModel.output.stateId) ? { stateId: ids.get(equationModel.output.stateId) } : {})
            }
        } : {})
    };
}

function remapImplementation(implementation, ids) {
    if (!implementation) return implementation;
    return {
        ...structuredClone(implementation),
        bindings: (implementation.bindings ?? []).map((binding) => ({
            ...structuredClone(binding),
            ...(ids.has(binding.nodeId) ? { nodeId: ids.get(binding.nodeId) } : {}),
            ...(ids.has(binding.stateId) ? { stateId: ids.get(binding.stateId) } : {}),
            ...(ids.has(binding.parameterId) ? { parameterId: ids.get(binding.parameterId) } : {})
        })),
        ...(implementation.output ? { output: {
            ...structuredClone(implementation.output),
            ...(ids.has(implementation.output.stateId) ? { stateId: ids.get(implementation.output.stateId) } : {})
        } } : {})
    };
}

function fragmentEntityIds(fragment) {
    return fragment.nodes.flatMap((node) => [
        node.id,
        ...(node.states ?? []).map((state) => state.id),
        ...(node.sourceTerms ?? []).flatMap((term) => [term.id, ...(term.parameters ?? []).map((parameter) => parameter.id)])
    ]).concat(fragment.edges.flatMap((edge) => [edge.id, ...(edge.parameters ?? []).map((parameter) => parameter.id)]));
}

export function validateGraphFragment(fragment) {
    if (fragment?.format !== graphFragmentFormat || fragment.version !== graphFragmentVersion ||
        !Array.isArray(fragment.nodes) || !fragment.nodes.length || !Array.isArray(fragment.edges)) return false;
    const ids = fragmentEntityIds(fragment);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return false;
    const nodeIds = new Set(fragment.nodes.map((node) => node.id));
    return fragment.edges.every((edge) => nodeIds.has(edge.source?.nodeId) && nodeIds.has(edge.target?.nodeId));
}

export function createGraphFragment(document, selectedNodeIds) {
    const selected = new Set(selectedNodeIds);
    const nodes = (document.nodes ?? []).filter((node) => selected.has(node.id)).map((node) => structuredClone(node));
    const includedNodeIds = new Set(nodes.map((node) => node.id));
    const edges = (document.edges ?? []).filter((edge) => (
        includedNodeIds.has(edge.source?.nodeId) && includedNodeIds.has(edge.target?.nodeId)
    )).map((edge) => structuredClone(edge));
    if (!nodes.length) return null;
    return { format: graphFragmentFormat, version: graphFragmentVersion, nodes, edges };
}

export function remapGraphFragment(fragment, firstId, positionOffset = [1, 0, 1]) {
    if (!validateGraphFragment(fragment) || !Number.isSafeInteger(firstId) || firstId <= 0) {
        throw new Error('The copied graph fragment is invalid.');
    }
    let nextId = firstId;
    const ids = new Map(fragmentEntityIds(fragment).map((id) => [id, nextId++]));
    const nodes = fragment.nodes.map((node) => ({
        ...structuredClone(node),
        id: ids.get(node.id),
        name: `${node.name} copy`,
        position: (node.position ?? [0, 0, 0]).map((value, index) => Number(value) + Number(positionOffset[index] ?? 0)),
        states: (node.states ?? []).map((state) => ({ ...structuredClone(state), id: ids.get(state.id) })),
        sourceTerms: (node.sourceTerms ?? []).map((term) => ({
            ...structuredClone(term),
            id: ids.get(term.id),
            parameters: (term.parameters ?? []).map((parameter) => ({ ...structuredClone(parameter), id: ids.get(parameter.id) })),
            ...(term.expressionModel ? { expressionModel: remapEquationModel(term.expressionModel, ids) } : {}),
            ...(term.implementation ? { implementation: remapImplementation(term.implementation, ids) } : {})
        }))
    }));
    const edges = fragment.edges.map((edge) => ({
        ...structuredClone(edge),
        id: ids.get(edge.id),
        name: `${edge.name} copy`,
        source: { ...structuredClone(edge.source), nodeId: ids.get(edge.source.nodeId), ...(ids.has(edge.source.stateId) ? { stateId: ids.get(edge.source.stateId) } : {}) },
        target: { ...structuredClone(edge.target), nodeId: ids.get(edge.target.nodeId), ...(ids.has(edge.target.stateId) ? { stateId: ids.get(edge.target.stateId) } : {}) },
        equationModel: remapEquationModel(edge.equationModel, ids),
        ...(edge.implementation ? { implementation: remapImplementation(edge.implementation, ids) } : {}),
        parameters: (edge.parameters ?? []).map((parameter) => ({ ...structuredClone(parameter), id: ids.get(parameter.id) }))
    }));
    return { nodes, edges, nextId };
}
