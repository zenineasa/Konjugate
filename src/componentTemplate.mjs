/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared between src/main.mjs (validates every bundled/installed template on desktop, via
// discoverComponentLibrary) and scripts/buildWebShell.mjs (validates the bundled templates it
// bakes into examples/webManifest.json... -- actually assets/componentLibrary/webManifest.json --
// at build time). Pure function, no node:*/browser-only dependency other than the standard
// structuredClone global (available in both Node and browsers) -- portable as-is, extracted so
// a malformed bundled template is rejected the same way in both places instead of only on
// desktop.

const componentTemplateIdPattern = /^[a-zA-Z][\w-]*$/;

const validPortSymbols = (port) => port !== undefined && (Array.isArray(port) ? port.length : true) &&
    [port].flat().every((symbol) => componentTemplateIdPattern.test(symbol ?? ''));

// A bundle stamps out several edges at once among N named endpoint nodes, optionally with shared
// parameters declared once and linked from any of its edges' parameters -- so a physical quantity
// that several relationships must agree on (a winding resistance, both legs of one lending
// facility) cannot drift apart. See docs/proposals/componentLibrary.md, "Bundles".
function validateBundleTemplate(template) {
    const endpointIds = new Set();
    if (!Array.isArray(template.endpoints) || template.endpoints.length < 2) throw new Error('A bundle needs at least two endpoints.');
    template.endpoints.forEach((endpoint) => {
        if (!componentTemplateIdPattern.test(endpoint?.id ?? '') || !endpoint.label) throw new Error('A bundle endpoint needs an id and a label.');
        if (endpointIds.has(endpoint.id)) throw new Error(`A bundle endpoint id "${endpoint.id}" is duplicated.`);
        endpointIds.add(endpoint.id);
    });
    const sharedKeys = new Set();
    const sharedSymbols = new Set();
    (template.sharedParameters ?? []).forEach((shared) => {
        if (!componentTemplateIdPattern.test(shared?.key ?? '') || sharedKeys.has(shared.key)) throw new Error('A bundle shared parameter needs a unique key.');
        if (!componentTemplateIdPattern.test(shared.symbol ?? '') || !shared.name) throw new Error('A bundle shared parameter needs a name and symbol.');
        if (sharedSymbols.has(shared.symbol)) throw new Error(`A bundle shared parameter symbol "${shared.symbol}" is duplicated.`);
        if (!Number.isFinite(shared.value)) throw new Error('A bundle shared parameter needs a finite value.');
        if (shared.mode !== undefined && !['constant', 'live'].includes(shared.mode)) throw new Error('A bundle shared parameter mode must be constant or live.');
        if (shared.scope !== undefined && !['instance', 'project'].includes(shared.scope)) throw new Error('A bundle shared parameter scope must be instance or project.');
        if (shared.mode === 'live') {
            const { minimum, maximum, step } = shared.control ?? {};
            if (![minimum, maximum, step].every(Number.isFinite) || !(minimum < maximum) || !(step > 0) || shared.value < minimum || shared.value > maximum) {
                throw new Error('A live bundle shared parameter needs a slider control with minimum < maximum, step > 0 and its value within the bounds.');
            }
        }
        sharedKeys.add(shared.key);
        sharedSymbols.add(shared.symbol);
    });
    if (!Array.isArray(template.edges) || !template.edges.length) throw new Error('A bundle needs at least one edge.');
    template.edges.forEach((edge) => {
        if (!edge?.name) throw new Error('A bundle edge needs a name.');
        if (!endpointIds.has(edge.from) || !endpointIds.has(edge.to) || edge.from === edge.to) {
            throw new Error(`Bundle edge "${edge.name}" must run between two different declared endpoints.`);
        }
        if (!edge.ports || !validPortSymbols(edge.ports.source) || !validPortSymbols(edge.ports.target)) {
            throw new Error(`Bundle edge "${edge.name}" needs source and target port symbols.`);
        }
        if (!edge.latex) throw new Error(`Bundle edge "${edge.name}" needs a latex expression.`);
        if (!edge.output || !['source', 'target'].includes(edge.output.role) || !componentTemplateIdPattern.test(edge.output.state ?? '')) {
            throw new Error(`Bundle edge "${edge.name}" needs an output naming a role ("source" or "target") and a state symbol.`);
        }
        if (edge.bidirectional !== undefined && typeof edge.bidirectional !== 'boolean') {
            throw new Error(`Bundle edge "${edge.name}" bidirectional flag must be a boolean.`);
        }
        const symbols = new Set();
        (edge.parameters ?? []).forEach((parameter) => {
            if (!componentTemplateIdPattern.test(parameter?.symbol ?? '') || !parameter.name) throw new Error(`Bundle edge "${edge.name}" has a parameter without a name and symbol.`);
            if (symbols.has(parameter.symbol)) throw new Error(`Bundle edge "${edge.name}" repeats the parameter symbol "${parameter.symbol}".`);
            symbols.add(parameter.symbol);
            if (parameter.shared !== undefined && !sharedKeys.has(parameter.shared)) {
                throw new Error(`Bundle edge "${edge.name}" links parameter "${parameter.symbol}" to an undeclared shared parameter "${parameter.shared}".`);
            }
        });
    });
}

// Deliberately hand-rolled like validateAddonManifest rather than a schema library -- the shape
// is small and stable.
export function validateComponentTemplate(template) {
    if (!template || !['node', 'edge', 'bundle'].includes(template.kind)) throw new Error('A template must have kind "node", "edge" or "bundle".');
    if (!componentTemplateIdPattern.test(template.id ?? '')) throw new Error('A template needs a valid id.');
    if (!template.name) throw new Error('A template needs a name.');
    const domains = template.domains ?? [];
    if (!Array.isArray(domains) || !domains.length || !domains.every((domain) => typeof domain === 'string' && domain)) {
        throw new Error('A template needs a non-empty domains array.');
    }
    if (template.kind === 'bundle') {
        validateBundleTemplate(template);
    } else if (template.kind === 'node') {
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
