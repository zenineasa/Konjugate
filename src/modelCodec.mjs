/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The one place that says how a node or relationship looks in a project document and how it looks while the canvas is
// editing it. Opening a file, saving, pasting a copied graph and placing a library template all go through these four
// functions, so a field is added in one place and works in all of them.
//
// The editor's definition is not the document's shape (`title` for `name`, a state's `label` for its `name`, a colour
// as a number, `appearance` flattened, a relationship's endpoints as plain ids), and the pieces that need the canvas or
// the editor's own normalisation arrive through `context`, so this module has no DOM or three.js dependency and
// `npm test` can round-trip a document through it.
//
// `context`:
//   geometryFromDocument(mesh), serializeGeometry(geometry)  imported-mesh conversion
//   stateValueText(value, unit)                              { text, exact } shown for a state's value
//   transformOf(definition)                                  { position, rotation, scale } read from the canvas object
//   newId()                                                  an id for a state saved without one
//   sourceTermExpressionModel(definition, term), relationshipEquationModel(definition)   the editor's normalisers

// A field this module does not know is kept, and written back as it was, so a document from a newer Konjugate loses
// nothing by passing through an older one, and a field added to the schema survives load, undo, paste and save before
// anyone has taught the canvas about it.
const nodeDocumentKeys = new Set([
    'id', 'name', 'type', 'description', 'subsystemId', 'enabled', 'numerics', 'position', 'rotation', 'scale',
    'states', 'sourceTerms', 'implementation', 'appearance'
]);
const relationshipDocumentKeys = new Set([
    'id', 'groupId', 'name', 'description', 'source', 'target', 'directionality', 'enabled', 'equation', 'equationModel',
    'implementation', 'parameters', 'appearance'
]);

function unknownFields(document, knownKeys) {
    const fields = Object.fromEntries(Object.entries(document).filter(([key]) => !knownKeys.has(key)));
    return Object.keys(fields).length ? { extraFields: structuredClone(fields) } : {};
}

const colorToNumber = (color, fallback) => Number.parseInt(String(color ?? fallback).replace('#', ''), 16);
const colorToText = (color) => `#${color.toString(16).padStart(6, '0')}`;

// `subsystemId` overrides the document's, for a node that lands somewhere other than where it was saved.
export function nodeFromDocument(node, context, { subsystemId } = {}) {
    const appearance = node.appearance ?? {};
    const importedGeometry = appearance.type === 'mesh' ? context.geometryFromDocument(appearance.mesh) : null;
    return {
        id: node.id,
        title: node.name || 'Untitled node',
        type: node.type || 'Custom node',
        description: node.description ?? '',
        shape: importedGeometry ? 'imported' : appearance.shape || 'box',
        position: node.position?.length === 3 ? node.position : [0, 0, 0],
        rotation: node.rotation?.length === 3 ? node.rotation : [0, 0, 0],
        scale: node.scale?.length === 3 ? node.scale : [1, 1, 1],
        color: colorToNumber(appearance.color, '#34727a'),
        importedGeometry,
        geometryFileName: appearance.fileName ?? null,
        badgeClass: '',
        subsystemId: subsystemId === undefined ? node.subsystemId ?? null : subsystemId,
        deleted: false,
        enabled: node.enabled !== false,
        substepsPerGlobalStep: Math.max(1, Math.min(10000, Number(node.numerics?.substepsPerGlobalStep) || 1)),
        integration: node.numerics?.integration === 'semiImplicit' ? 'semiImplicit' : 'explicit',
        sourceTerms: (node.sourceTerms ?? []).map((term) => ({ ...term, parameters: term.parameters ?? [] })),
        // The node's own program: a computational-node provider, or an installed FMU's reference (edited under
        // Program in the node editor).
        implementation: node.implementation ? structuredClone(node.implementation) : null,
        // Parts of the node's shape, each a mesh in the frame of a body the node reports the pose of (a robot's
        // links, say): kept and handed to result visualizers, not drawn on the canvas.
        appearanceParts: Array.isArray(appearance.parts) ? structuredClone(appearance.parts) : null,
        states: (node.states ?? []).map((state) => ({
            id: state.id,
            label: state.name,
            symbol: state.symbol,
            initialValue: state.initialValue,
            unit: state.unit ?? '',
            value: context.stateValueText(state.initialValue, state.unit).text,
            exactValue: context.stateValueText(state.initialValue, state.unit).exact,
            className: ''
        })),
        ...unknownFields(node, nodeDocumentKeys)
    };
}

export function nodeToDocument(definition, context) {
    const { position, rotation, scale } = context.transformOf(definition);
    return {
        ...structuredClone(definition.extraFields ?? {}),
        id: definition.id,
        name: definition.title,
        type: definition.type,
        ...(definition.description ? { description: definition.description } : {}),
        ...(definition.subsystemId === null ? {} : { subsystemId: definition.subsystemId }),
        enabled: definition.enabled !== false,
        // integration is written only when it is not the default, so other models save exactly as before.
        numerics: { substepsPerGlobalStep: definition.substepsPerGlobalStep, ...(definition.integration === 'semiImplicit' ? { integration: 'semiImplicit' } : {}) },
        position,
        // Omitted when at the identity value, like subsystemId above -- keeps a node that was never rotated or scaled
        // serializing exactly as it did before these fields existed, rather than growing every node's JSON with inert
        // zeros and ones.
        ...(rotation.every((angle) => angle === 0) ? {} : { rotation }),
        ...(scale.every((factor) => factor === 1) ? {} : { scale }),
        states: definition.states.map((state) => ({
            id: state.id ?? context.newId(),
            name: state.label,
            symbol: state.symbol,
            initialValue: (state.initialValue ?? Number.parseFloat(state.value)) || 0,
            unit: state.unit ?? ''
        })),
        sourceTerms: (definition.sourceTerms ?? []).map((term) => ({
            ...term,
            parameters: term.parameters ?? [],
            ...(!term.implementation ? { expressionModel: context.sourceTermExpressionModel(definition, term) } : {})
        })),
        ...(definition.implementation ? { implementation: structuredClone(definition.implementation) } : {}),
        appearance: {
            ...(definition.importedGeometry
                ? {
                    type: 'mesh',
                    fileName: definition.geometryFileName,
                    color: colorToText(definition.color),
                    mesh: context.serializeGeometry(definition.importedGeometry)
                }
                : {
                    type: 'primitive',
                    shape: definition.shape,
                    color: colorToText(definition.color)
                }),
            ...(definition.appearanceParts ? { parts: structuredClone(definition.appearanceParts) } : {})
        }
    };
}

// `pasted` is a relationship that lands in a different place from where it was saved: it is not in the edge group it
// was copied from, and its waypoints (absolute points on the canvas) would no longer lie along it.
export function relationshipFromDocument(edge, { pasted = false } = {}) {
    return {
        id: edge.id,
        groupId: pasted ? null : edge.groupId ?? null,
        title: edge.name || 'Untitled relationship',
        description: edge.description ?? '',
        source: edge.source.nodeId,
        sourceStateId: edge.source.stateId ?? null,
        target: edge.target.nodeId,
        targetStateId: edge.target.stateId ?? null,
        directionality: edge.directionality ?? 'directed',
        equation: edge.equation ?? '',
        equationModel: edge.equationModel ?? {
            latex: edge.equation ?? '',
            output: { role: 'target', stateId: edge.target.stateId ?? null },
            bindings: [],
            mathJson: null
        },
        implementation: edge.implementation ?? null,
        parameters: edge.parameters ?? [],
        color: colorToNumber(edge.appearance?.color, '#9c83c4'),
        offset: Number(edge.appearance?.offset) || 0,
        waypoints: !pasted && Array.isArray(edge.appearance?.waypoints) ? edge.appearance.waypoints.map((point) => point.map(Number)) : [],
        deleted: false,
        enabled: edge.enabled !== false,
        ...unknownFields(edge, relationshipDocumentKeys)
    };
}

export function relationshipToDocument(definition, context) {
    return {
        ...structuredClone(definition.extraFields ?? {}),
        id: definition.id,
        ...(definition.groupId == null ? {} : { groupId: definition.groupId }),
        name: definition.title,
        ...(definition.description ? { description: definition.description } : {}),
        source: { nodeId: definition.source, stateId: definition.sourceStateId ?? '' },
        target: { nodeId: definition.target, stateId: definition.targetStateId ?? '' },
        directionality: definition.directionality,
        enabled: definition.enabled !== false,
        equation: definition.equationModel?.latex ?? definition.equation ?? '',
        equationModel: context.relationshipEquationModel(definition),
        ...(definition.implementation ? { implementation: definition.implementation } : {}),
        parameters: definition.parameters ?? [],
        appearance: {
            color: colorToText(definition.color),
            offset: definition.offset,
            waypoints: definition.waypoints ?? []
        }
    };
}
