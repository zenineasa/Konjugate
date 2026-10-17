/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Project-level shared parameters: a top-level `sharedParameters` array of parameter definitions
// (id, name, symbol, value, unit, mode, optional control) that any relationship or source-term
// parameter can link to through `sharedParameterId`. The engine resolves links itself, so a
// simulation needs no preprocessing; this module is for consumers that read parameter values
// directly from the document (standalone code export, FMU export) and for the set of ids that
// accept live control.

// The id a live-control command (setParameterValue / scheduleParameterValue) must use for
// `parameter`: the shared parameter's id when linked, its own id otherwise.
export function controlParameterId(parameter) {
    return parameter.sharedParameterId ?? parameter.id;
}

// Ids that accept live control: every live shared parameter plus every unlinked live parameter
// (a linked parameter takes its mode from its shared definition and is controlled through it).
export function liveControlParameterIds(document) {
    const isUnlinkedLive = (parameter) => parameter.sharedParameterId === undefined && parameter.mode === 'live';
    return new Set([
        ...(document.sharedParameters ?? []).filter((parameter) => parameter.mode === 'live').map((parameter) => parameter.id),
        ...(document.edges ?? []).flatMap((edge) => (edge.parameters ?? []).filter(isUnlinkedLive).map((parameter) => parameter.id)),
        ...(document.nodes ?? []).flatMap((node) => (node.sourceTerms ?? []).flatMap((term) => (term.parameters ?? [])
            .filter(isUnlinkedLive).map((parameter) => parameter.id)))
    ]);
}

// A copy of the document with every link replaced by the shared definition's value, unit, mode,
// slider range and stored schedule, and the shared definitions removed -- each linked parameter becomes an ordinary
// self-contained one. Used by exports that have no runtime notion of sharing.
export function resolveSharedParameters(document) {
    const shared = new Map((document.sharedParameters ?? []).map((parameter) => [parameter.id, parameter]));
    const resolved = structuredClone(document);
    delete resolved.sharedParameters;
    const bake = (parameter) => {
        if (parameter.sharedParameterId === undefined) return;
        const definition = shared.get(parameter.sharedParameterId);
        if (!definition) throw new Error(`Parameter "${parameter.name ?? parameter.id}" links to a shared parameter that does not exist.`);
        delete parameter.sharedParameterId;
        parameter.value = definition.value;
        parameter.unit = definition.unit;
        parameter.mode = definition.mode;
        if (definition.control) parameter.control = structuredClone(definition.control);
        else delete parameter.control;
        // A stored schedule travels with the baked value; scheduleKey lets an export emit one table
        // for every parameter linked to the same shared one.
        if (definition.schedule) Object.assign(parameter, { schedule: structuredClone(definition.schedule), scheduleKey: definition.id });
        else { delete parameter.schedule; delete parameter.scheduleKey; }
    };
    for (const edge of resolved.edges ?? []) (edge.parameters ?? []).forEach(bake);
    for (const node of resolved.nodes ?? []) for (const term of node.sourceTerms ?? []) (term.parameters ?? []).forEach(bake);
    // A computational-node provider binds shared parameters directly (a node has none of its own): each such binding
    // gets the shared parameter itself, baked as a linked parameter is.
    for (const node of resolved.nodes ?? []) {
        for (const binding of node.implementation?.bindings ?? []) {
            if (binding.kind !== 'parameter' || binding.sharedParameterId === undefined) continue;
            const definition = shared.get(binding.sharedParameterId);
            if (!definition) throw new Error(`Provider binding "${binding.key}" links to a shared parameter that does not exist.`);
            binding.parameter = { id: definition.id, name: definition.name, symbol: definition.symbol, sharedParameterId: definition.id };
            bake(binding.parameter);
        }
    }
    return resolved;
}
