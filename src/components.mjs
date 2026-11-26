/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Subsystem components (docs/proposals/subsystemComponents.md, docs/subsystems.md): a subsystem can be an instance of a
// definition, a sealed component document held in the project's `subsystemDefinitions`, and several instances share one.
// Everything here works on project documents (the JSON a .kjt holds), so the canvas, files, the library and the tests all
// use the same code and none of it needs the DOM.
//
// - A definition is `{ id, document, link? }`. Its `document` is a whole project (nodes, edges, shared parameters, edge
//   groups, its own subsystems and definitions) with a `component` block naming it and its ports. Ids inside `document`
//   are in the document's own space.
// - An instance is a subsystem record with `definitionId`, and `parameterValues` for exposed parameters that differ from
//   the component's defaults (`{ parameterKey, value }`, or `{ parameterKey, sharedParameterId }` to bind one to a shared
//   parameter of the parent).
// - The instance's contents are kept in the project's flat graph, as before ("expanded"): every entity made from the
//   definition carries `definitionKey`, its id in the definition's document, which is how expanding again keeps each
//   entity's project id. Subsystems nested inside an instance are records with `definitionKey` (and no `definitionId`:
//   their own definitions live inside the outer document).
// - Shared parameters made from a definition carry `subsystemId`, the instance they belong to.

import { collectEntityIds, remapIds } from './graphClipboard.mjs';
import { sayKindsAlike, stateKinds, termsReachingStates } from './ratesAndUpdates.mjs';

const endpointNodeId = (endpoint) => Number(endpoint !== null && typeof endpoint === 'object' ? endpoint.nodeId : endpoint);
const clone = (value) => structuredClone(value);

// Fields of a nested subsystem record that belong to the document it is written in, not to the project it is expanded
// into: they are left out when expanding and put back from the definition when writing back.
const nestedStructuralKeys = ['definitionId', 'parameterValues', 'link'];
// An instance's settling of its nodes' Updates (docs/proposals/ratesAndUpdates.md), kept in its component's `component` block.
const componentUpdateKeys = ['updates', 'updatesLimit'];

export const componentDocumentFormat = 'konjugate';

// ---- Membership -------------------------------------------------------------------------------------------------------

// The subsystem and every subsystem nested in it, at any depth.
function subtreeIds(document, subsystemId) {
    const ids = [subsystemId];
    for (let index = 0; index < ids.length; index += 1) {
        (document.subsystems ?? []).forEach((subsystem) => {
            if ((subsystem.parentSubsystemId ?? null) === ids[index] && !ids.includes(subsystem.id)) ids.push(subsystem.id);
        });
    }
    return new Set(ids);
}

// Every sharedParameterId named anywhere in `value`.
function sharedParameterReferences(value, found = new Set()) {
    if (Array.isArray(value)) value.forEach((item) => sharedParameterReferences(item, found));
    else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            if (key === 'sharedParameterId' && typeof child === 'number') found.add(child);
            else sharedParameterReferences(child, found);
        }
    }
    return found;
}

// What belongs to a subsystem in a project document: its nested subsystems, its nodes at any depth, the edges and edge
// groups whose every end is inside it, and the shared parameters that are its own (made from its definition) or are used
// only inside it. A shared parameter also used outside stays outside; `outsideParameterIds` lists those used inside.
export function subsystemMembers(document, subsystemId) {
    const subsystems = subtreeIds(document, subsystemId);
    const nodes = (document.nodes ?? []).filter((node) => subsystems.has(node.subsystemId ?? null));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const inside = (edge) => nodeIds.has(endpointNodeId(edge.source)) && nodeIds.has(endpointNodeId(edge.target));
    const edges = (document.edges ?? []).filter(inside);
    const edgeGroups = (document.edgeGroups ?? []).filter((group) => group.memberNodeIds?.length && group.memberNodeIds.every((id) => nodeIds.has(id)));
    const insideRefs = sharedParameterReferences([nodes, edges, edgeGroups]);
    const outsideNodes = (document.nodes ?? []).filter((node) => !nodeIds.has(node.id));
    const outsideEdges = (document.edges ?? []).filter((edge) => !inside(edge));
    const outsideGroups = (document.edgeGroups ?? []).filter((group) => !edgeGroups.includes(group));
    const outsideRefs = sharedParameterReferences([outsideNodes, outsideEdges, outsideGroups]);
    // A parameter of the parent that an instance's exposed parameter is bound to stays the parent's, used here or not.
    const bound = new Set((document.subsystems ?? []).flatMap((subsystem) => (subsystem.parameterValues ?? []).map((value) => value.sharedParameterId)).filter((id) => id != null));
    const sharedParameters = (document.sharedParameters ?? []).filter((shared) => (
        shared.subsystemId != null ? subsystems.has(shared.subsystemId)
            : insideRefs.has(shared.id) && !outsideRefs.has(shared.id) && !bound.has(shared.id)
    ));
    const ownSharedIds = new Set(sharedParameters.map((shared) => shared.id));
    return {
        subsystemIds: subsystems,
        nestedSubsystems: (document.subsystems ?? []).filter((subsystem) => subsystem.id !== subsystemId && subsystems.has(subsystem.id)),
        nodes, edges, edgeGroups, sharedParameters,
        outsideParameterIds: [...insideRefs].filter((id) => !ownSharedIds.has(id))
    };
}

// ---- Walking entities -------------------------------------------------------------------------------------------------

// Every object with a numeric `id` in `value`, depth first, in array order: the order new ids are given in, so the same
// document always expands to the same ids.
function entitiesWithIds(value, found = []) {
    if (Array.isArray(value)) value.forEach((item) => entitiesWithIds(item, found));
    else if (value && typeof value === 'object') {
        if (typeof value.id === 'number') found.push(value);
        for (const [key, child] of Object.entries(value)) {
            if (key === 'document') continue;
            if (child && typeof child === 'object') entitiesWithIds(child, found);
        }
    }
    return found;
}

function maxId(value) {
    return collectEntityIds(value).reduce((max, id) => Math.max(max, id), 0);
}

// The next free id in a project document, counting everything that has one (definitions' documents included, which only
// makes the number larger).
export function nextFreeId(document) {
    return maxId(document) + 1;
}

export function idAllocator(document) {
    let next = nextFreeId(document);
    return () => next++;
}

// ---- Extracting a definition from an instance -------------------------------------------------------------------------

// The component document of a subsystem as it is in the project now. With `base` (the definition it was expanded from),
// entities keep the keys they were expanded with and new ones are numbered after the base's; without, the document's ids
// are the entities' project ids (as when a subsystem first becomes a component, so nothing is renumbered). Returns the
// document, the instance's exposed-parameter values, and the map from project id to document id.
export function extractComponent(document, subsystemId, { base = null, name = null } = {}) {
    const record = (document.subsystems ?? []).find((subsystem) => subsystem.id === subsystemId);
    if (!record) throw new Error(`No subsystem ${subsystemId} in this project.`);
    const members = subsystemMembers(document, subsystemId);
    const baseEntities = new Map(base ? entitiesWithIds([base.nodes, base.edges, base.edgeGroups, base.sharedParameters, base.subsystems]).map((entity) => [entity.id, entity]) : []);
    let fresh = base ? maxId(base) + 1 : 0;
    const idMap = new Map();
    const parts = clone({ nodes: members.nodes, edges: members.edges, edgeGroups: members.edgeGroups, sharedParameters: members.sharedParameters, subsystems: members.nestedSubsystems });
    const keyed = (entity) => (base ? entity.definitionKey ?? null : null);
    entitiesWithIds([parts.nodes, parts.edges, parts.edgeGroups, parts.sharedParameters, parts.subsystems]).forEach((entity) => {
        const key = keyed(entity);
        idMap.set(entity.id, key !== null && key !== undefined ? key : base ? fresh++ : entity.id);
    });
    // A definition of the project placed inside (a subsystem moved into this one) goes into the document with it.
    const carried = [];
    parts.subsystems.forEach((subsystem) => {
        if (subsystem.definitionId == null) return;
        const definition = (document.subsystemDefinitions ?? []).find((item) => item.id === subsystem.definitionId);
        if (!definition || carried.some((item) => item.projectId === definition.id)) return;
        const newId = base ? fresh++ : definition.id;
        idMap.set(definition.id, newId);
        carried.push({ projectId: definition.id, definition: { ...clone(definition), id: newId } });
    });
    // A shared parameter of the parent used inside becomes an exposed parameter of the component, bound to it here.
    const parameterValues = [];
    const exposedFromOutside = members.outsideParameterIds.map((outsideId) => {
        const outside = (document.sharedParameters ?? []).find((shared) => shared.id === outsideId);
        if (!outside) return null;
        const existing = base?.sharedParameters?.find((shared) => shared.exposed && (record.parameterValues ?? []).some((value) => value.parameterKey === shared.id && value.sharedParameterId === outsideId));
        const key = existing ? existing.id : base ? fresh++ : outsideId;
        idMap.set(outsideId, key);
        parameterValues.push({ parameterKey: key, sharedParameterId: outsideId });
        const { subsystemId: unusedOwner, definitionKey: unusedKey, ...rest } = clone(outside);
        return { ...rest, id: key, exposed: true };
    }).filter(Boolean);
    // Which nodes and nested subsystems sit directly in the instance, decided before renumbering (a new id may equal it).
    const rootNodes = new Set(parts.nodes.map((node, index) => ((node.subsystemId ?? null) === subsystemId ? index : -1)).filter((index) => index >= 0));
    const rootSubsystems = new Set(parts.subsystems.map((subsystem, index) => ((subsystem.parentSubsystemId ?? null) === subsystemId ? index : -1)).filter((index) => index >= 0));
    const remapped = remapIds(parts, idMap);
    const restore = (entity) => {
        // Keys and records that belong to definitions inside this one come back from the base, not from the project.
        const original = baseEntities.get(entity.id);
        delete entity.definitionKey;
        if (original?.definitionKey !== undefined) entity.definitionKey = original.definitionKey;
    };
    entitiesWithIds([remapped.nodes, remapped.edges, remapped.edgeGroups, remapped.sharedParameters]).forEach(restore);
    remapped.nodes.forEach((node, index) => { if (rootNodes.has(index)) delete node.subsystemId; });
    remapped.subsystems.forEach((subsystem, index) => {
        const original = baseEntities.get(subsystem.id);
        if (rootSubsystems.has(index)) subsystem.parentSubsystemId = null;
        delete subsystem.definitionKey;
        if (original) {
            nestedStructuralKeys.forEach((key) => { if (original[key] !== undefined && subsystem[key] === undefined) subsystem[key] = clone(original[key]); });
            if (original.definitionKey !== undefined) subsystem.definitionKey = original.definitionKey;
        }
    });
    remapped.sharedParameters.forEach((shared) => {
        delete shared.subsystemId;
        // An exposed parameter's value in the project is this instance's; the component keeps its default.
        const original = baseEntities.get(shared.id);
        // So are its symbol and name, when the project needed them changed to keep them unique; the component keeps its own.
        if (original) { shared.symbol = original.symbol; shared.name = original.name; }
        if (shared.exposed && original && Number(original.value) !== Number(shared.value)) {
            parameterValues.push({ parameterKey: shared.id, value: shared.value });
            shared.value = original.value;
        }
    });
    const definitions = [...clone(base?.subsystemDefinitions ?? []), ...carried.map((item) => item.definition)];
    const component = clone(base?.component ?? { name: name ?? record.name ?? 'Component', ports: [] });
    if (name) component.name = name;
    // Whether the component settles its nodes' Updates is the component's, set on any of its instances.
    componentUpdateKeys.forEach((key) => { if (record[key] !== undefined) component[key] = clone(record[key]); else delete component[key]; });
    const result = {
        format: componentDocumentFormat,
        version: 1,
        metadata: clone(base?.metadata ?? document.metadata ?? { units: 'SI' }),
        runConfigurations: clone(base?.runConfigurations ?? []),
        sharedParameters: [...remapped.sharedParameters, ...exposedFromOutside],
        nodes: remapped.nodes,
        edges: remapped.edges,
        subsystems: remapped.subsystems,
        edgeGroups: remapped.edgeGroups,
        subsystemDefinitions: definitions,
        component
    };
    // Instances nested inside keep their definitions in step, by the same rule as the project's.
    syncDefinitions(result);
    return { document: result, parameterValues, idMap };
}

// ---- Expanding an instance from its definition ------------------------------------------------------------------------

// Replaces a subsystem's contents with its definition's, keeping the project id of every entity already made from the
// same definition entity and giving new ones the next free ids in document order. Relationships outside that ended at
// an entity no longer there are removed, and listed. Returns a new project document.
export function expandInstance(document, subsystemId, { allocateId = idAllocator(document) } = {}) {
    const next = clone(document);
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const definition = (next.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    if (!record || !definition) throw new Error('This subsystem has no definition to expand.');
    const source = definition.document;
    const members = subsystemMembers(next, subsystemId);
    const keyMap = new Map();
    entitiesWithIds([members.nodes, members.edges, members.edgeGroups, members.sharedParameters, members.nestedSubsystems]).forEach((entity) => {
        if (entity.definitionKey !== undefined && entity.definitionKey !== null) keyMap.set(entity.definitionKey, entity.id);
    });
    const bindings = new Map((record.parameterValues ?? []).filter((value) => value.sharedParameterId != null).map((value) => [value.parameterKey, value.sharedParameterId]));
    const values = new Map((record.parameterValues ?? []).filter((value) => value.value !== undefined).map((value) => [value.parameterKey, value.value]));
    const parts = clone({
        nodes: source.nodes ?? [], edges: source.edges ?? [], edgeGroups: source.edgeGroups ?? [],
        sharedParameters: (source.sharedParameters ?? []).filter((shared) => !bindings.has(shared.id)),
        subsystems: source.subsystems ?? []
    });
    const idMap = new Map(bindings);
    entitiesWithIds([parts.nodes, parts.edges, parts.edgeGroups, parts.sharedParameters, parts.subsystems]).forEach((entity) => {
        idMap.set(entity.id, keyMap.get(entity.id) ?? allocateId());
    });
    const sourceIds = new Map(entitiesWithIds([parts.nodes, parts.edges, parts.edgeGroups, parts.sharedParameters, parts.subsystems]).map((entity) => [entity, entity.id]));
    const keys = [...sourceIds.values()];
    const remapped = remapIds(parts, idMap);
    entitiesWithIds([remapped.nodes, remapped.edges, remapped.edgeGroups, remapped.sharedParameters, remapped.subsystems]).forEach((entity, index) => {
        entity.definitionKey = keys[index];
    });
    remapped.nodes.forEach((node) => { node.subsystemId = node.subsystemId == null ? subsystemId : node.subsystemId; });
    componentUpdateKeys.forEach((key) => { if (source.component?.[key] !== undefined) record[key] = clone(source.component[key]); else delete record[key]; });
    remapped.subsystems.forEach((subsystem) => {
        if (subsystem.parentSubsystemId == null) subsystem.parentSubsystemId = subsystemId;
        nestedStructuralKeys.forEach((key) => delete subsystem[key]);
    });
    // A shared parameter's symbol must be unique in the project (the validator says so), and every instance has its own copy:
    // a copy keeps the symbol it had, and a new one takes the definition's symbol, or the first free one after it
    // ("conductance2"), with the instance's name after its own so the two can be told apart in tables and tuning.
    const kept = new Map(members.sharedParameters.map((shared) => [shared.id, shared]));
    const taken = new Set((next.sharedParameters ?? []).filter((shared) => !kept.has(shared.id)).map((shared) => shared.symbol));
    remapped.sharedParameters.forEach((shared) => {
        shared.subsystemId = subsystemId;
        if (shared.exposed && values.has(shared.definitionKey)) shared.value = values.get(shared.definitionKey);
        const previous = kept.get(shared.id);
        let symbol = previous && !taken.has(previous.symbol) ? previous.symbol : shared.symbol;
        for (let suffix = 2; taken.has(symbol); suffix += 1) symbol = `${shared.symbol}${suffix}`;
        if (symbol !== shared.symbol) shared.name = previous?.name && previous.symbol === symbol ? previous.name : `${shared.name} (${record.name})`;
        shared.symbol = symbol;
        taken.add(symbol);
    });
    // Out with the old contents, in with the new, each list keeping its place in the project's order.
    const drop = (list, old) => {
        const ids = new Set(old.map((entity) => entity.id));
        return (list ?? []).filter((entity) => !ids.has(entity.id));
    };
    next.nodes = [...drop(next.nodes, members.nodes), ...remapped.nodes];
    next.edges = [...drop(next.edges, members.edges), ...remapped.edges];
    next.edgeGroups = [...drop(next.edgeGroups, members.edgeGroups), ...remapped.edgeGroups];
    next.sharedParameters = [...drop(next.sharedParameters, members.sharedParameters), ...remapped.sharedParameters];
    next.subsystems = [...drop(next.subsystems, members.nestedSubsystems), ...remapped.subsystems];
    // A relationship from outside to something the definition no longer has goes with it.
    const nodeIds = new Set(next.nodes.map((node) => node.id));
    const removedEdgeIds = next.edges.filter((edge) => !nodeIds.has(endpointNodeId(edge.source)) || !nodeIds.has(endpointNodeId(edge.target))).map((edge) => edge.id);
    next.edges = next.edges.filter((edge) => !removedEdgeIds.includes(edge.id));
    next.edgeGroups = next.edgeGroups.map((group) => ({ ...group, memberNodeIds: group.memberNodeIds.filter((id) => nodeIds.has(id)) })).filter((group) => group.memberNodeIds.length >= 2);
    // The instance and the rest of the model say their states' kinds alike (docs/proposals/ratesAndUpdates.md), the side that
    // says none made to say them as the engine reads it now, so neither side's numbers change: a component whose file says
    // no kinds, in a model that says them, says them here, while its definition stays as its file has it.
    const instanceNodeIds = new Set(remapped.nodes.map((node) => node.id));
    sayKindsAlike(next.nodes.filter((node) => !instanceNodeIds.has(node.id)), remapped.nodes, next.edges);
    return { document: next, removedEdgeIds };
}

// Gives the entities of an instance the keys they have in its definition, after the definition was written from them.
function assignKeys(document, subsystemId, idMap) {
    const members = subsystemMembers(document, subsystemId);
    entitiesWithIds([members.nodes, members.edges, members.edgeGroups, members.sharedParameters, members.nestedSubsystems]).forEach((entity) => {
        if (idMap.has(entity.id)) entity.definitionKey = idMap.get(entity.id);
    });
    members.sharedParameters.forEach((shared) => { if (shared.subsystemId == null) shared.subsystemId = subsystemId; });
    members.nestedSubsystems.forEach((subsystem) => nestedStructuralKeys.forEach((key) => delete subsystem[key]));
}

// ---- Keeping definitions and instances in step ------------------------------------------------------------------------

const canonical = (value) => JSON.stringify(value);

// The instances of a project (subsystems with a definition), by definition.
function instancesByDefinition(document) {
    const groups = new Map();
    (document.subsystems ?? []).forEach((subsystem) => {
        if (subsystem.definitionId == null) return;
        if (!groups.has(subsystem.definitionId)) groups.set(subsystem.definitionId, []);
        groups.get(subsystem.definitionId).push(subsystem.id);
    });
    return groups;
}

// After an edit inside an instance, the definition is written from that instance and every other instance of it is
// expanded again; after undo, the same runs and puts them back. The instance that changed is the one whose contents no
// longer match its definition; when several do (or none can be told), `preferredSubsystemId` (the instance being edited)
// wins. Linked definitions are not written to: an instance of one that was changed is expanded again from it, which
// undoes the change (`reverted` lists them). A definition no instance uses any longer is dropped. Mutates `document` and
// returns what it did: `{ changed, reverted, removedEdgeIds }`.
export function syncDefinitions(document, { preferredSubsystemId = null, allocateId = null } = {}) {
    const report = { changed: false, reverted: [], removedEdgeIds: [] };
    const allocate = allocateId ?? idAllocator(document);
    for (const [definitionId, instanceIds] of instancesByDefinition(document)) {
        const definition = (document.subsystemDefinitions ?? []).find((item) => item.id === definitionId);
        if (!definition) continue;
        const extracts = instanceIds.map((id) => ({ id, ...extractComponent(document, id, { base: definition.document }) }));
        const baseText = canonical(definition.document);
        // A linked instance is as its definition has it when it is what expanding the definition again gives: its file's
        // own form, or that form saying its kinds as the model does (expandInstance).
        const asExpanded = (extract) => {
            const { document: expanded } = expandInstance(document, extract.id, { allocateId: idAllocator(document) });
            return canonical(extractComponent(expanded, extract.id, { base: definition.document }).document) === canonical(extract.document);
        };
        const differing = extracts.filter((extract) => canonical(extract.document) !== baseText && !(definition.link && !definition.link.editing && asExpanded(extract)));
        const valuesOf = (extract) => extract.parameterValues;
        // Parameter values are the instance's own: they never count as a change to the definition.
        extracts.forEach((extract) => {
            const record = document.subsystems.find((subsystem) => subsystem.id === extract.id);
            const next = valuesOf(extract);
            if (canonical(record.parameterValues ?? []) !== canonical(next)) {
                if (next.length) record.parameterValues = next; else delete record.parameterValues;
                report.changed = true;
            }
        });
        if (!differing.length) continue;
        // A linked component is changed where it lives (its file, or the library), unless it is being edited here (a library
        // component's Edit), when it is written back as a local one is until it is saved or discarded.
        if (definition.link && !definition.link.editing) {
            for (const extract of differing) {
                const { document: expanded, removedEdgeIds } = expandInstance(document, extract.id, { allocateId: allocate });
                Object.assign(document, expanded);
                report.reverted.push(extract.id);
                report.removedEdgeIds.push(...removedEdgeIds);
            }
            report.changed = true;
            continue;
        }
        // When every instance agrees, the definition is only being brought to the form the canvas writes.
        const allAgree = extracts.every((extract) => canonical(extract.document) === canonical(extracts[0].document));
        const source = allAgree ? extracts[0]
            : differing.find((extract) => extract.id === preferredSubsystemId) ?? differing[0];
        definition.document = source.document;
        assignKeys(document, source.id, source.idMap);
        report.changed = true;
        if (allAgree) {
            extracts.forEach((extract) => assignKeys(document, extract.id, extract.idMap));
            continue;
        }
        for (const extract of extracts) {
            if (extract.id === source.id) continue;
            const { document: expanded, removedEdgeIds } = expandInstance(document, extract.id, { allocateId: allocate });
            Object.assign(document, expanded);
            report.removedEdgeIds.push(...removedEdgeIds);
        }
    }
    const used = new Set((document.subsystems ?? []).map((subsystem) => subsystem.definitionId).filter((id) => id != null));
    const before = (document.subsystemDefinitions ?? []).length;
    if (document.subsystemDefinitions) document.subsystemDefinitions = document.subsystemDefinitions.filter((definition) => used.has(definition.id));
    if ((document.subsystemDefinitions ?? []).length !== before) report.changed = true;
    return report;
}

// ---- Making components ------------------------------------------------------------------------------------------------

// Turns every plain subsystem at the top of a project (one that is neither an instance nor inside one) into an instance
// of its own local definition, keeping every id: the definition's document uses the entities' project ids, so expanding
// it gives back exactly the same flat graph. Subsystems nested in it stay plain subsystems inside its document (they are
// part of it). This is how a project from before components opens, and what a new subsystem becomes. Mutates and returns
// the document.
export function migrateLegacySubsystems(document, { allocateId = null } = {}) {
    const allocate = allocateId ?? idAllocator(document);
    const subsystems = document.subsystems ?? [];
    const insideInstance = (subsystem) => {
        for (let current = subsystem; current; current = subsystems.find((item) => item.id === current.parentSubsystemId)) {
            if (current !== subsystem && (current.definitionId != null || current.definitionKey != null)) return true;
        }
        return false;
    };
    const plain = subsystems.filter((subsystem) => subsystem.definitionId == null && subsystem.definitionKey == null && !insideInstance(subsystem));
    // Outermost first: a plain subsystem inside another plain one is made part of the outer one's document.
    const outermost = plain.filter((subsystem) => !plain.some((other) => other !== subsystem && subtreeIds(document, other.id).has(subsystem.id)));
    for (const subsystem of outermost) {
        const { document: componentDocument, parameterValues, idMap } = extractComponent(document, subsystem.id, { name: subsystem.name });
        const definitionId = allocate();
        document.subsystemDefinitions = [...(document.subsystemDefinitions ?? []), { id: definitionId, document: componentDocument }];
        subsystem.definitionId = definitionId;
        if (parameterValues.length) subsystem.parameterValues = parameterValues;
        assignKeys(document, subsystem.id, idMap);
    }
    return document;
}

// A copy of a project document as a component placed into another project: `component` (a component document, from a
// file, the library or another instance) is placed as a new instance under `parentSubsystemId`, with a new local
// definition. Returns `{ document, subsystemId }`.
export function placeComponent(document, componentDocument, { parentSubsystemId = null, position = [0, 0, 0], name = null, link = null, parameterValues = null } = {}) {
    const next = clone(document);
    const allocate = idAllocator(next);
    const definitionId = allocate();
    const subsystemId = allocate();
    const sealed = clone(componentDocument);
    next.subsystemDefinitions = [...(next.subsystemDefinitions ?? []), { id: definitionId, document: sealed, ...(link ? { link: clone(link) } : {}) }];
    next.subsystems = [...(next.subsystems ?? []), {
        id: subsystemId, name: name ?? sealed.component?.name ?? 'Component', parentSubsystemId, position: [...position], definitionId,
        ...(usableParameterValues(next, sealed, parameterValues).length ? { parameterValues: usableParameterValues(next, sealed, parameterValues) } : {})
    }];
    const { document: expanded } = expandInstance(next, subsystemId, { allocateId: allocate });
    return { document: expanded, subsystemId, definitionId };
}

// An instance's own parameter values that still mean something where it is placed: values for parameters the component
// exposes, and bindings to shared parameters the project has.
function usableParameterValues(document, componentDocument, parameterValues) {
    const exposed = new Set((componentDocument.sharedParameters ?? []).filter((shared) => shared.exposed).map((shared) => shared.id));
    const shared = new Set((document.sharedParameters ?? []).map((item) => item.id));
    return clone(parameterValues ?? []).filter((value) => exposed.has(value.parameterKey) && (value.sharedParameterId == null || shared.has(value.sharedParameterId)));
}

// What copying a subsystem puts on the clipboard: its component document, the instance's own parameter values, and, for a
// linked instance, its link (whose cached document is copied exactly, as the file had it).
export function componentCopyOf(document, subsystemId) {
    const working = clone(document);
    syncDefinitions(working);
    const record = working.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const definition = (working.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    const link = definition?.link ? clone(definition.link) : null;
    if (link) { delete link.editing; delete link.behind; }
    return {
        format: 'konjugateComponentCopy', version: 1, name: record?.name ?? 'Component',
        document: link ? clone(definition.document) : componentDocumentOf(working, subsystemId),
        ...(record?.parameterValues?.length ? { parameterValues: clone(record.parameterValues) } : {}),
        ...(link ? { link } : {})
    };
}

// Pastes a copied subsystem. A local one is an independent copy with a definition of its own (decision 1 of the proposal);
// a linked one is another instance of the same link: of the definition the project already has for it, or, in another
// project, of a new definition linked to the same file or library entry, with its cached copy.
export function pasteComponentCopy(document, copy, { parentSubsystemId = null, position = [0, 0, 0], name = null } = {}) {
    const sameLink = (link) => copy.link && link && link.kind === copy.link.kind
        && (link.kind === 'library' ? link.templateId === copy.link.templateId : (link.path ?? link.fileName) === (copy.link.path ?? copy.link.fileName));
    const existing = (document.subsystemDefinitions ?? []).find((definition) => sameLink(definition.link));
    if (!existing) return placeComponent(document, copy.document, { parentSubsystemId, position, name: name ?? copy.name, link: copy.link ?? null, parameterValues: copy.parameterValues });
    const next = clone(document);
    const allocate = idAllocator(next);
    const subsystemId = allocate();
    const values = usableParameterValues(next, existing.document, copy.parameterValues);
    next.subsystems.push({ id: subsystemId, name: name ?? copy.name, parentSubsystemId, position: [...position], definitionId: existing.id, ...(values.length ? { parameterValues: values } : {}) });
    const { document: expanded } = expandInstance(next, subsystemId, { allocateId: allocate });
    return { document: expanded, subsystemId, definitionId: existing.id };
}

// Another instance of the same local definition, beside the first.
export function placeAnotherInstance(document, subsystemId, { offset = [3.5, 0, 0] } = {}) {
    const next = clone(document);
    syncDefinitions(next);
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    if (record?.definitionId == null) throw new Error('Only an instance of a component can be placed again.');
    const allocate = idAllocator(next);
    const instanceId = allocate();
    next.subsystems.push({
        id: instanceId, name: record.name, parentSubsystemId: record.parentSubsystemId ?? null,
        position: record.position.map((value, index) => Number(value) + Number(offset[index] ?? 0)), definitionId: record.definitionId,
        ...(record.parameterValues ? { parameterValues: clone(record.parameterValues) } : {})
    });
    const { document: expanded } = expandInstance(next, instanceId, { allocateId: allocate });
    return { document: expanded, subsystemId: instanceId };
}

// Makes an instance independent of the others: a definition of its own, a copy of the shared one (with the link dropped,
// which is also what Detach does to a linked instance). Ids are unchanged.
export function separateInstance(document, subsystemId) {
    const next = clone(document);
    syncDefinitions(next);
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const definition = (next.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    if (!definition) throw new Error('This subsystem is not an instance of a component.');
    const allocate = idAllocator(next);
    const copy = { id: allocate(), document: clone(definition.document) };
    next.subsystemDefinitions.push(copy);
    record.definitionId = copy.id;
    syncDefinitions(next);
    return next;
}

// How many instances share a subsystem's definition (1 for a plain subsystem).
export function instanceCount(document, subsystemId) {
    const record = (document.subsystems ?? []).find((subsystem) => subsystem.id === subsystemId);
    if (record?.definitionId == null) return 1;
    return (document.subsystems ?? []).filter((subsystem) => subsystem.definitionId === record.definitionId).length;
}

// ---- The interface: ports and exposed parameters ----------------------------------------------------------------------

// A component's ports, as states inside the instance. Declared ports are the component's (in its block); derived ports,
// for a local definition, are the inside states that relationships from outside bind to now. Each is
// `{ key?, stateId, nodeId, name, symbol, unit, direction, declared, connected }`, ids in the project's space.
export function instancePorts(document, subsystemId) {
    const record = (document.subsystems ?? []).find((subsystem) => subsystem.id === subsystemId);
    const definition = (document.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    const members = subsystemMembers(document, subsystemId);
    const insideNodeIds = new Set(members.nodes.map((node) => node.id));
    const stateOwner = new Map();
    members.nodes.forEach((node) => (node.states ?? []).forEach((state) => stateOwner.set(state.id, { node, state })));
    const byKey = new Map();
    members.nodes.forEach((node) => (node.states ?? []).forEach((state) => { if (state.definitionKey != null) byKey.set(state.definitionKey, state.id); }));
    const connectedStates = new Set();
    (document.edges ?? []).forEach((edge) => {
        const sourceInside = insideNodeIds.has(endpointNodeId(edge.source));
        const targetInside = insideNodeIds.has(endpointNodeId(edge.target));
        if (sourceInside === targetInside) return;
        const end = sourceInside ? edge.source : edge.target;
        if (end?.stateId != null && end.stateId !== '') connectedStates.add(end.stateId);
    });
    const describe = (stateId, extra) => {
        const owner = stateOwner.get(stateId);
        if (!owner) return null;
        // `named` says the port has a name of its own; otherwise `name` is its node's and state's.
        return {
            ...extra, stateId, nodeId: owner.node.id, symbol: owner.state.symbol, unit: owner.state.unit ?? '',
            name: extra.name || `${owner.node.name} · ${owner.state.name ?? owner.state.symbol}`, named: Boolean(extra.name),
            direction: extra.direction ?? 'both', connected: connectedStates.has(stateId)
        };
    };
    const declared = (definition?.document.component?.ports ?? [])
        .map((port) => (byKey.has(port.stateId) ? describe(byKey.get(port.stateId), { key: port.key, name: port.name, direction: port.direction, declared: true }) : null))
        .filter(Boolean);
    const declaredStates = new Set(declared.map((port) => port.stateId));
    const derived = definition?.link ? [] : [...connectedStates].filter((stateId) => !declaredStates.has(stateId))
        .map((stateId) => describe(stateId, { declared: false })).filter(Boolean);
    return [...declared, ...derived];
}

// Declares a port of a local definition (a derived one kept, or a state named as one), or renames a declared one.
// `stateId` is in the project's space; returns a new document.
export function declarePort(document, subsystemId, { stateId, name = null, direction = null }) {
    const next = clone(document);
    syncDefinitions(next);
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const definition = (next.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    if (!definition || definition.link) throw new Error('Ports are declared in a local component.');
    const members = subsystemMembers(next, subsystemId);
    const state = members.nodes.flatMap((node) => node.states ?? []).find((candidate) => candidate.id === stateId);
    if (!state || state.definitionKey == null) throw new Error('A port must be a state inside the subsystem.');
    const component = definition.document.component ?? (definition.document.component = { name: record.name, ports: [] });
    component.ports = component.ports ?? [];
    let port = component.ports.find((item) => item.stateId === state.definitionKey);
    if (!port) {
        port = { key: component.ports.reduce((max, item) => Math.max(max, item.key), 0) + 1, stateId: state.definitionKey };
        component.ports.push(port);
    }
    if (name !== null) { if (name.trim()) port.name = name.trim(); else delete port.name; }
    if (direction !== null) { if (direction && direction !== 'both') port.direction = direction; else delete port.direction; }
    return next;
}

export function removePort(document, subsystemId, key) {
    const next = clone(document);
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const definition = (next.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    if (!definition || definition.link) throw new Error('Ports are declared in a local component.');
    definition.document.component.ports = (definition.document.component.ports ?? []).filter((port) => port.key !== key);
    return next;
}

// ---- Root ports: the project's own component block (docs/proposals/rootPorts.md) --------------------------------------

const portDirections = new Set(['in', 'out', 'both']);
// The next key of a component's ports, by the rule declarePort keeps: one more than the largest.
const nextPortKey = (ports) => ports.reduce((max, item) => Math.max(max, Number(item.key) || 0), 0) + 1;
const stateOwners = (document) => {
    const owners = new Map();
    (document.nodes ?? []).forEach((node) => (node.states ?? []).forEach((state) => owners.set(state.id, { node, state })));
    return owners;
};

// The project's own ports, its top-level interface: each entry of its `component.ports`, described with its state.
// `{ key, stateId, nodeId, name, named, symbol, unit, direction, kind, startValue, reached }`, in the block's order; `kind`
// is the state's (`rate` or `update`), `startValue` its initial value, and `reached` says whether anything in the project
// (a source term, a program, a relationship) changes it, so an in port with nothing reaching it stays at its start when the
// project runs on its own. A port whose state is gone is left out. A project with no block has none. The canvas's own
// definitions (a node's `title`, a state's `label`, relationships' `source`/`sourceStateId`) are read as well as a document's.
export function rootPorts(document) {
    const ports = document?.component?.ports ?? [];
    if (!ports.length) return [];
    const owners = stateOwners(document);
    const nodes = document.nodes ?? [];
    const edges = document.edges ?? [];
    const reaching = termsReachingStates(nodes, edges);
    const kinds = stateKinds(nodes, edges);
    return ports.map((port) => {
        const owner = owners.get(port.stateId);
        if (!owner) return null;
        const { node, state } = owner;
        return {
            key: port.key, stateId: state.id, nodeId: node.id,
            name: port.name || `${node.name ?? node.title} · ${state.name ?? state.label ?? state.symbol}`, named: Boolean(port.name),
            symbol: state.symbol, unit: state.unit ?? '', direction: port.direction ?? 'both',
            kind: kinds.get(Number(state.id))?.kind ?? 'rate', startValue: Number(state.initialValue ?? 0),
            reached: (reaching.get(Number(state.id)) ?? []).length > 0
        };
    }).filter(Boolean);
}

// Declares a state of the project a root port, renames it, changes its direction, or (with `key`) points an existing port
// at another state. The first port declared makes the project's component block, `{ name, ports }`, `name` the one given
// (the project's name), else 'Model'; a component file's block is kept as it is. Returns `{ document, key }`, a new
// document and the port's key. `name` '' takes a given name off; `direction` 'both' or '' takes the direction off.
export function declareRootPort(document, { stateId, key = null, name = null, direction = null, componentName = null } = {}) {
    const next = clone(document);
    const owner = stateOwners(next).get(stateId);
    if (!owner) throw new Error('A port must be a state of the project.');
    if (direction !== null && direction !== '' && !portDirections.has(direction)) throw new Error(`A port's direction is in, out or both, not "${direction}".`);
    const component = next.component ?? (next.component = { name: componentName?.trim() || 'Model', ports: [] });
    component.ports = component.ports ?? [];
    let port;
    if (key !== null) {
        port = component.ports.find((item) => item.key === key);
        if (!port) throw new Error(`No port ${key} in this project.`);
        if (port.stateId !== stateId && component.ports.some((item) => item.stateId === stateId)) throw new Error('That state is already a port.');
        port.stateId = stateId;
    } else {
        port = component.ports.find((item) => item.stateId === stateId);
        if (!port) {
            port = { key: nextPortKey(component.ports), stateId };
            component.ports.push(port);
        }
    }
    if (name !== null) { if (name.trim()) port.name = name.trim(); else delete port.name; }
    if (direction !== null) { if (direction && direction !== 'both') port.direction = direction; else delete port.direction; }
    return { document: next, key: port.key };
}

// Removes a root port, and where it was put on the canvas. Removing the last one removes the component block again, unless
// `keepBlock` (the project was a component before its first port was declared here, as a component file is) or the block
// holds anything else (a description, settling, another field). Returns a new document.
export function removeRootPort(document, key, { keepBlock = false } = {}) {
    const next = clone(document);
    const component = next.component;
    if (!component) return next;
    component.ports = (component.ports ?? []).filter((port) => port.key !== key);
    if (Array.isArray(component.terminalPositions)) {
        component.terminalPositions = component.terminalPositions.filter((entry) => entry.portKey !== key);
        if (!component.terminalPositions.length) delete component.terminalPositions;
    }
    const onlyNameAndPorts = Object.keys(component).every((field) => field === 'name' || field === 'ports');
    if (!component.ports.length && !keepBlock && onlyNameAndPorts) delete next.component;
    return next;
}

// Root ports whose state is gone (its node deleted) taken off, as removeRootPort would; the document itself when none is.
export function pruneRootPorts(document, { keepBlock = false } = {}) {
    const owners = stateOwners(document);
    const gone = (document?.component?.ports ?? []).filter((port) => !owners.has(port.stateId)).map((port) => port.key);
    return gone.reduce((current, key) => removeRootPort(current, key, { keepBlock }), document);
}

// The exposed parameters of an instance: `{ key, sharedParameterId, name, symbol, unit, value, defaultValue, boundTo }`,
// `sharedParameterId` the instance's own copy in the project (null when bound to a parameter of the parent).
export function instanceParameters(document, subsystemId) {
    const record = (document.subsystems ?? []).find((subsystem) => subsystem.id === subsystemId);
    const definition = (document.subsystemDefinitions ?? []).find((item) => item.id === record?.definitionId);
    if (!definition) return [];
    const bindings = new Map((record.parameterValues ?? []).filter((value) => value.sharedParameterId != null).map((value) => [value.parameterKey, value.sharedParameterId]));
    return (definition.document.sharedParameters ?? []).filter((shared) => shared.exposed).map((shared) => {
        const own = (document.sharedParameters ?? []).find((candidate) => candidate.subsystemId === subsystemId && candidate.definitionKey === shared.id);
        const boundTo = bindings.get(shared.id) ?? null;
        return {
            key: shared.id, sharedParameterId: own?.id ?? null, name: shared.name, symbol: shared.symbol, unit: shared.unit ?? '',
            value: boundTo != null ? null : Number(own?.value ?? shared.value), defaultValue: Number(shared.value), boundTo
        };
    });
}

// Exposes a shared parameter used inside a local instance, so each instance can give it its own value. Returns a new
// document.
// `target` is a shared parameter's id, or `{ parameterId }` for a relationship's or source term's own parameter inside,
// which is first made a shared parameter (as linking it to a new shared parameter would).
export function exposeParameter(document, subsystemId, target) {
    const next = clone(document);
    let sharedParameterId = typeof target === 'number' ? target : target?.sharedParameterId;
    if (target?.parameterId != null) {
        const members = subsystemMembers(next, subsystemId);
        const parameter = [...members.edges.flatMap((edge) => edge.parameters ?? []), ...members.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => term.parameters ?? []))]
            .find((candidate) => candidate.id === target.parameterId);
        if (!parameter) throw new Error('No such parameter inside this subsystem.');
        sharedParameterId = target.newId ?? nextFreeId(next);
        next.sharedParameters = [...(next.sharedParameters ?? []), {
            id: sharedParameterId, name: parameter.name ?? parameter.symbol, symbol: parameter.symbol, value: Number(parameter.value) || 0,
            unit: parameter.unit ?? '', ...(parameter.mode ? { mode: parameter.mode } : {}), ...(parameter.control ? { control: clone(parameter.control) } : {})
        }];
        parameter.sharedParameterId = sharedParameterId;
    }
    const shared = (next.sharedParameters ?? []).find((candidate) => candidate.id === sharedParameterId);
    if (!shared) throw new Error('No such shared parameter.');
    if (shared.subsystemId == null) shared.subsystemId = subsystemId;
    shared.exposed = true;
    syncDefinitions(next, { preferredSubsystemId: subsystemId });
    return next;
}

// The parameters inside a local instance that could be exposed: its shared parameters not exposed yet, and the
// relationships' and source terms' own parameters. Each `{ label, target }`, `target` as exposeParameter takes it.
export function exposableParameters(document, subsystemId) {
    const members = subsystemMembers(document, subsystemId);
    const shared = members.sharedParameters.filter((item) => !item.exposed).map((item) => ({ label: `${item.name} (${item.symbol}) · shared`, target: item.id }));
    const own = [
        ...members.edges.flatMap((edge) => (edge.parameters ?? []).filter((parameter) => parameter.sharedParameterId == null).map((parameter) => ({ label: `${parameter.name ?? parameter.symbol} (${parameter.symbol}) · ${edge.name}`, target: { parameterId: parameter.id } }))),
        ...members.nodes.flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => (term.parameters ?? []).filter((parameter) => parameter.sharedParameterId == null).map((parameter) => ({ label: `${parameter.name ?? parameter.symbol} (${parameter.symbol}) · ${node.name}`, target: { parameterId: parameter.id } }))))
    ];
    return [...shared, ...own];
}

// Sets an instance's value for an exposed parameter (a number), binds it to a shared parameter of the parent
// (`{ sharedParameterId }`), or puts it back to the component's default (`null`). Returns a new document.
export function setInstanceParameter(document, subsystemId, parameterKey, setting) {
    const next = clone(document);
    syncDefinitions(next);
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const others = (record.parameterValues ?? []).filter((value) => value.parameterKey !== parameterKey);
    const entry = setting === null ? null
        : typeof setting === 'object' ? { parameterKey, sharedParameterId: setting.sharedParameterId }
            : { parameterKey, value: Number(setting) };
    record.parameterValues = entry ? [...others, entry] : others;
    if (!record.parameterValues.length) delete record.parameterValues;
    const { document: expanded } = expandInstance(next, subsystemId);
    return expanded;
}

// ---- Component documents ----------------------------------------------------------------------------------------------

// The component document of a subsystem, ready to be written to a file or the library: every port it has now declared
// (a file has no outside to derive ports from), its layout centred on its own middle, and its name.
export function componentDocumentOf(document, subsystemId) {
    const working = clone(document);
    if ((working.subsystems ?? []).find((subsystem) => subsystem.id === subsystemId)?.definitionId == null) migrateLegacySubsystems(working);
    syncDefinitions(working);
    let next = working;
    for (const port of instancePorts(next, subsystemId).filter((item) => !item.declared)) next = declarePort(next, subsystemId, { stateId: port.stateId });
    const record = next.subsystems.find((subsystem) => subsystem.id === subsystemId);
    const definition = next.subsystemDefinitions.find((item) => item.id === record.definitionId);
    const result = clone(definition.document);
    result.component = { ...result.component, name: record.name };
    const points = (result.nodes ?? []).map((node) => node.position ?? [0, 0, 0]);
    if (points.length) {
        const middle = [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + Number(point[axis] ?? 0), 0) / points.length);
        result.nodes.forEach((node) => { node.position = (node.position ?? [0, 0, 0]).map((value, axis) => Number(value) - middle[axis]); });
        (result.subsystems ?? []).forEach((subsystem) => { subsystem.position = (subsystem.position ?? [0, 0, 0]).map((value, axis) => Number(value) - middle[axis]); });
    }
    delete result.ownership;
    return result;
}

// What a component document offers, for the review card before it is placed: its name, description, ports (with the
// state each names) and exposed parameters with their defaults. A project without a component block offers its
// subsystems instead (`subsystems`), any of which can be placed as a component.
export function describeComponentDocument(componentDocument) {
    const states = new Map();
    (componentDocument.nodes ?? []).forEach((node) => (node.states ?? []).forEach((state) => states.set(state.id, { node, state })));
    const block = componentDocument.component ?? null;
    return {
        isComponent: Boolean(block),
        name: block?.name ?? null,
        description: block?.description ?? '',
        ports: (block?.ports ?? []).map((port) => {
            const owner = states.get(port.stateId);
            return { key: port.key, name: port.name || (owner ? `${owner.node.name} · ${owner.state.name ?? owner.state.symbol}` : `Port ${port.key}`), symbol: owner?.state.symbol ?? '', unit: owner?.state.unit ?? '', direction: port.direction ?? 'both' };
        }),
        parameters: (componentDocument.sharedParameters ?? []).filter((shared) => shared.exposed).map((shared) => ({ key: shared.id, name: shared.name, symbol: shared.symbol, unit: shared.unit ?? '', value: Number(shared.value) })),
        subsystems: (componentDocument.subsystems ?? []).filter((subsystem) => (subsystem.parentSubsystemId ?? null) === null).map((subsystem) => ({ id: subsystem.id, name: subsystem.name }))
    };
}

// The path of names from the top to a subsystem ("Pump 2 / Impeller"), for naming states out of context.
export function subsystemPath(document, subsystemId) {
    const names = [];
    const seen = new Set();
    for (let id = subsystemId ?? null; id !== null && !seen.has(id);) {
        seen.add(id);
        const subsystem = (document.subsystems ?? []).find((item) => item.id === id);
        if (!subsystem) break;
        names.unshift(subsystem.name);
        id = subsystem.parentSubsystemId ?? null;
    }
    return names.join(' / ');
}

// What the engine is given: no definitions, no component block, no keys; the flat graph only.
export function stripComponents(document) {
    const flat = clone(document);
    delete flat.subsystemDefinitions;
    delete flat.component;
    entitiesWithIds([flat.nodes, flat.edges, flat.edgeGroups, flat.sharedParameters]).forEach((entity) => { delete entity.definitionKey; });
    (flat.sharedParameters ?? []).forEach((shared) => { delete shared.subsystemId; delete shared.exposed; });
    (flat.edges ?? []).forEach((edge) => delete edge.subsystemId);
    return flat;
}

// ---- Linked components (docs/proposals/subsystemComponents.md#linked-files-stage-4) -----------------------------------

// What a component offers: its declared ports (key, the state's symbol and unit, direction) and exposed parameters (key,
// symbol, unit). This, not the inside, is what other models depend on.
export function componentInterface(componentDocument) {
    const states = new Map();
    (componentDocument?.nodes ?? []).forEach((node) => (node.states ?? []).forEach((state) => states.set(state.id, state)));
    return {
        ports: (componentDocument?.component?.ports ?? []).map((port) => ({
            key: port.key, stateId: port.stateId, symbol: states.get(port.stateId)?.symbol ?? null, unit: states.get(port.stateId)?.unit ?? '', direction: port.direction ?? 'both', name: port.name ?? null
        })),
        parameters: (componentDocument?.sharedParameters ?? []).filter((shared) => shared.exposed).map((shared) => ({ key: shared.id, symbol: shared.symbol, unit: shared.unit ?? '', name: shared.name }))
    };
}

// How a new version of a component differs from the one a project holds, by key: ports and parameters added, renamed or
// bound to another state of the same symbol and unit are compatible; ones removed, or whose symbol, unit or direction
// changed, are conflicts.
export function interfaceChanges(previousDocument, nextDocument) {
    const before = componentInterface(previousDocument);
    const after = componentInterface(nextDocument);
    const conflicts = [];
    before.ports.forEach((port) => {
        const next = after.ports.find((candidate) => candidate.key === port.key);
        if (!next) conflicts.push({ kind: 'port', key: port.key, name: port.name ?? port.symbol, change: 'removed' });
        else if (next.symbol !== port.symbol || next.unit !== port.unit || next.direction !== port.direction) conflicts.push({ kind: 'port', key: port.key, name: port.name ?? port.symbol, change: 'changed' });
    });
    before.parameters.forEach((parameter) => {
        const next = after.parameters.find((candidate) => candidate.key === parameter.key);
        if (!next) conflicts.push({ kind: 'parameter', key: parameter.key, name: parameter.name, change: 'removed' });
        else if (next.symbol !== parameter.symbol || next.unit !== parameter.unit) conflicts.push({ kind: 'parameter', key: parameter.key, name: parameter.name, change: 'changed' });
    });
    return {
        compatible: !conflicts.length, conflicts,
        added: [...after.ports.filter((port) => !before.ports.some((candidate) => candidate.key === port.key)).map((port) => ({ kind: 'port', key: port.key })),
            ...after.parameters.filter((parameter) => !before.parameters.some((candidate) => candidate.key === parameter.key)).map((parameter) => ({ kind: 'parameter', key: parameter.key }))]
    };
}

// For an incompatible new version: per instance, the relationships from outside connected to ports that are removed or
// changed, and the parameter bindings to parameters that are. `[{ subsystemId, name, edgeIds, parameterKeys }]`.
export function linkConflicts(document, definitionId, nextDocument) {
    const definition = (document.subsystemDefinitions ?? []).find((item) => item.id === definitionId);
    if (!definition) return [];
    const { conflicts } = interfaceChanges(definition.document, nextDocument);
    const portKeys = new Set(conflicts.filter((item) => item.kind === 'port').map((item) => item.key));
    const parameterKeys = new Set(conflicts.filter((item) => item.kind === 'parameter').map((item) => item.key));
    const affected = (definition.document.component?.ports ?? []).filter((port) => portKeys.has(port.key)).map((port) => port.stateId);
    return (document.subsystems ?? []).filter((subsystem) => subsystem.definitionId === definitionId).map((subsystem) => {
        const members = subsystemMembers(document, subsystem.id);
        const insideNodes = new Set(members.nodes.map((node) => node.id));
        const stateIds = new Set(members.nodes.flatMap((node) => (node.states ?? []).filter((state) => affected.includes(state.definitionKey)).map((state) => state.id)));
        const edgeIds = (document.edges ?? []).filter((edge) => {
            const sourceInside = insideNodes.has(endpointNodeId(edge.source));
            const targetInside = insideNodes.has(endpointNodeId(edge.target));
            if (sourceInside === targetInside) return false;
            const end = sourceInside ? edge.source : edge.target;
            return stateIds.has(end?.stateId);
        }).map((edge) => edge.id);
        const boundKeys = (subsystem.parameterValues ?? []).filter((value) => parameterKeys.has(value.parameterKey)).map((value) => value.parameterKey);
        return { subsystemId: subsystem.id, name: subsystem.name, edgeIds, parameterKeys: boundKeys };
    }).filter((item) => item.edgeIds.length || item.parameterKeys.length);
}

// Takes a new version of a linked component into the project: the cached document replaced, every instance expanded again
// from it, and relationships from outside to a port that now names another state moved to that state. With
// `removeConflicts`, relationships and bindings to what is no longer offered are removed first ("Update and remove").
// Returns `{ document, removedEdgeIds }`.
export function refreshDefinition(document, definitionId, nextDocument, { link = null, removeConflicts = false, allocateId = null } = {}) {
    let next = clone(document);
    const definition = next.subsystemDefinitions.find((item) => item.id === definitionId);
    if (!definition) throw new Error('No such component in this project.');
    const removed = [];
    if (removeConflicts) {
        linkConflicts(next, definitionId, nextDocument).forEach((conflict) => {
            removed.push(...conflict.edgeIds);
            const record = next.subsystems.find((subsystem) => subsystem.id === conflict.subsystemId);
            record.parameterValues = (record.parameterValues ?? []).filter((value) => !conflict.parameterKeys.includes(value.parameterKey));
            if (!record.parameterValues.length) delete record.parameterValues;
        });
        next.edges = next.edges.filter((edge) => !removed.includes(edge.id));
    }
    // A port bound to another state now: relationships from outside follow it, by the port's key.
    const before = componentInterface(definition.document).ports;
    const after = componentInterface(nextDocument).ports;
    const moved = before.map((port) => [port, after.find((candidate) => candidate.key === port.key)]).filter(([port, nextPort]) => nextPort && nextPort.stateId !== port.stateId);
    const instanceIds = next.subsystems.filter((subsystem) => subsystem.definitionId === definitionId).map((subsystem) => subsystem.id);
    const pending = instanceIds.flatMap((subsystemId) => {
        const members = subsystemMembers(next, subsystemId);
        const states = new Map(members.nodes.flatMap((node) => (node.states ?? []).map((state) => [state.definitionKey, { stateId: state.id, nodeId: node.id }])));
        return moved.map(([port, nextPort]) => ({ subsystemId, from: states.get(port.stateId), toKey: nextPort.stateId })).filter((item) => item.from);
    });
    definition.document = clone(nextDocument);
    if (link) definition.link = { ...(definition.link ?? {}), ...clone(link) };
    delete definition.link?.behind;
    const allocate = allocateId ?? idAllocator(next);
    for (const subsystemId of instanceIds) {
        const { document: expanded, removedEdgeIds } = expandInstance(next, subsystemId, { allocateId: allocate });
        next = expanded;
        removed.push(...removedEdgeIds);
    }
    pending.forEach(({ subsystemId, from, toKey }) => {
        const members = subsystemMembers(next, subsystemId);
        const target = members.nodes.flatMap((node) => (node.states ?? []).map((state) => ({ node, state }))).find((item) => item.state.definitionKey === toKey);
        if (!target) return;
        next.edges.forEach((edge) => {
            ['source', 'target'].forEach((role) => {
                if (edge[role]?.stateId !== from.stateId) return;
                edge[role] = { ...edge[role], nodeId: target.node.id, stateId: target.state.id };
                Object.assign(edge, remapIds(edge, new Map([[from.stateId, target.state.id]])));
            });
        });
    });
    return { document: next, removedEdgeIds: [...new Set(removed)] };
}

// The chain of links a component would close into a loop if placed where `here` is (`{ path }` for a file project, or
// `{ templateId }`), or that is deeper than `maxDepth`: the names along it, or null when there is none.
export function linkCycle(componentDocument, here, { maxDepth = 16, source = null } = {}) {
    const same = (link) => link && ((here.path && link.path && link.path === here.path) || (here.templateId && link.templateId === here.templateId));
    const visit = (document, chain) => {
        if (chain.length > maxDepth) return [...chain, '…'];
        for (const definition of document?.subsystemDefinitions ?? []) {
            const link = definition.link;
            const name = link?.fileName ?? link?.templateName ?? definition.document?.component?.name ?? 'a component';
            if (same(link)) return [...chain, name];
            const deeper = visit(definition.document, [...chain, name]);
            if (deeper) return deeper;
        }
        return null;
    };
    if (source && same(source)) return [source.fileName ?? source.templateName ?? 'it'];
    return visit(componentDocument, [source?.fileName ?? source?.templateName ?? componentDocument?.component?.name ?? 'It']);
}

// The version of every component a project's instances use, as a result records it (docs/resultFileFormat.md): each
// definition's name, the sha256 of its document (`hash`, async, given the text: the canvas and the tests each bring their
// own), how many instances use it, and for a linked one where it came from and that source's version.
export async function componentVersions(document, hash) {
    const used = new Map();
    (document.subsystems ?? []).forEach((subsystem) => {
        if (subsystem.definitionId != null) used.set(subsystem.definitionId, (used.get(subsystem.definitionId) ?? 0) + 1);
    });
    const versions = [];
    for (const definition of document.subsystemDefinitions ?? []) {
        if (!used.has(definition.id)) continue;
        const link = definition.link;
        versions.push({
            definitionId: definition.id,
            name: definition.document?.component?.name ?? 'Component',
            sha256: await hash(JSON.stringify(definition.document)),
            instances: used.get(definition.id),
            ...(link ? { link: { kind: link.kind, ...(link.kind === 'library' ? { templateId: link.templateId } : { fileName: link.fileName }), sha256: link.sha256 ?? null } } : {})
        });
    }
    return versions;
}
