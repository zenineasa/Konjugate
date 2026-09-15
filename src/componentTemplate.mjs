/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared between src/main.mjs (validates every bundled/installed template on desktop, via
// discoverComponentLibrary) and scripts/buildWebShell.mjs (validates the bundled templates it
// bakes into examples/webManifest.json... -- actually assets/componentLibrary/webManifest.json --
// at build time). Pure function, no node:*/browser-only dependency other than the standard
// structuredClone global (available in both Node and browsers) -- portable as-is, extracted so
// a malformed bundled template is rejected the same way in both places instead of only on
// desktop.

const componentTemplateIdPattern = /^[a-zA-Z][\w-]*$/;

// Deliberately hand-rolled like validateAddonManifest rather than a schema library -- the shape
// is small and stable.
export function validateComponentTemplate(template) {
    if (!template || (template.kind !== 'node' && template.kind !== 'edge')) throw new Error('A template must have kind "node" or "edge".');
    if (!componentTemplateIdPattern.test(template.id ?? '')) throw new Error('A template needs a valid id.');
    if (!template.name) throw new Error('A template needs a name.');
    const domains = template.domains ?? [];
    if (!Array.isArray(domains) || !domains.length || !domains.every((domain) => typeof domain === 'string' && domain)) {
        throw new Error('A template needs a non-empty domains array.');
    }
    if (template.kind === 'node') {
        if (!Array.isArray(template.states) || !template.states.length) throw new Error('A node template needs at least one state.');
        const stateSymbols = new Set();
        template.states.forEach((state) => {
            if (!componentTemplateIdPattern.test(state.symbol ?? '') || !state.label) throw new Error('A node template state needs a label and symbol.');
            stateSymbols.add(state.symbol);
        });
        (template.sourceTerms ?? []).forEach((term) => {
            if (!stateSymbols.has(term.state) || !term.expression) throw new Error('A node template source term needs a state matching one of its own states and an expression.');
        });
    } else {
        // A port is usually one expected state symbol per role, but an edge whose equation
        // couples more than one state on the same side (e.g. a motor's current and angular
        // velocity, both referenced from the same "target" role) needs to declare more than one.
        const validPort = (port) => port !== undefined && (Array.isArray(port) ? port.length : true) &&
            [port].flat().every((symbol) => componentTemplateIdPattern.test(symbol ?? ''));
        if (!template.ports || !validPort(template.ports.source) || !validPort(template.ports.target)) {
            throw new Error('An edge template needs source and target port symbols.');
        }
        if (!template.latex) throw new Error('An edge template needs a latex expression.');
        (template.parameters ?? []).forEach((parameter) => {
            if (!componentTemplateIdPattern.test(parameter.symbol ?? '') || !parameter.name) throw new Error('An edge template parameter needs a name and symbol.');
        });
        // Required, not just validated-if-present: the builder's own "no explicit output yet"
        // default is the target's first state, but that default is unreliable once an edge template
        // arms a chained two-endpoint pick (refreshStateReferences briefly runs source-only, which
        // leaves an implicit selection that then survives once the target is picked too) -- so a
        // template can never safely rely on it and must always say which state it means to update.
        if (!template.output || !['source', 'target'].includes(template.output.role) || !componentTemplateIdPattern.test(template.output.state ?? '')) {
            throw new Error('An edge template needs an output naming a role ("source" or "target") and a state symbol.');
        }
        if (template.bidirectional !== undefined && typeof template.bidirectional !== 'boolean') {
            throw new Error('An edge template\'s bidirectional flag must be a boolean.');
        }
    }
    return structuredClone(template);
}
