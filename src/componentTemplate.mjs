/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared between src/main.mjs (validates every bundled/installed template on desktop, via
// discoverComponentLibrary) and scripts/buildWebShell.mjs (validates the bundled templates it
// bakes into examples/webManifest.json... -- actually assets/componentLibrary/webManifest.json --
// at build time). Pure function, no node:*/browser-only dependency other than the standard
// structuredClone global (available in both Node and browsers) -- portable as-is, extracted so
// a malformed bundled template is rejected the same way in both places instead of only on
// desktop.

import { fragmentSharedParameterReferences, validateGraphFragment } from './graphClipboard.mjs';

const componentTemplateIdPattern = /^[a-zA-Z][\w-]*$/;

const validPortSymbols = (port) => port !== undefined && (Array.isArray(port) ? port.length : true) &&
    [port].flat().every((symbol) => componentTemplateIdPattern.test(symbol ?? ''));

// Shared parameters declared once by a template and linked from its parameters by key. Used by
// bundles (linked from edge parameters) and node templates (linked from source-term parameters).
function validateSharedParameters(sharedParameters, owner) {
    const sharedKeys = new Set();
    const sharedSymbols = new Set();
    (sharedParameters ?? []).forEach((shared) => {
        if (!componentTemplateIdPattern.test(shared?.key ?? '') || sharedKeys.has(shared.key)) throw new Error(`A ${owner} shared parameter needs a unique key.`);
        if (!componentTemplateIdPattern.test(shared.symbol ?? '') || !shared.name) throw new Error(`A ${owner} shared parameter needs a name and symbol.`);
        if (sharedSymbols.has(shared.symbol)) throw new Error(`A ${owner} shared parameter symbol "${shared.symbol}" is duplicated.`);
        if (!Number.isFinite(shared.value)) throw new Error(`A ${owner} shared parameter needs a finite value.`);
        if (shared.mode !== undefined && !['constant', 'live'].includes(shared.mode)) throw new Error(`A ${owner} shared parameter mode must be constant or live.`);
        if (shared.scope !== undefined && !['instance', 'project'].includes(shared.scope)) throw new Error(`A ${owner} shared parameter scope must be instance or project.`);
        if (shared.mode === 'live') {
            const { minimum, maximum, step } = shared.control ?? {};
            if (![minimum, maximum, step].every(Number.isFinite) || !(minimum < maximum) || !(step > 0) || shared.value < minimum || shared.value > maximum) {
                throw new Error(`A live ${owner} shared parameter needs a slider control with minimum < maximum, step > 0 and its value within the bounds.`);
            }
        }
        sharedKeys.add(shared.key);
        sharedSymbols.add(shared.symbol);
    });
    return sharedKeys;
}

// A fragment template is a piece of model exactly as the canvas holds it -- nodes, relationships, their programs and the
// shared parameters they link to -- so it can express whatever a user can build there, with nothing for the template
// format to keep in step with the canvas. It must stand alone: everything it links to travels with it. A program in it is
// source it carries (cpp or python), never a reference to something installed on one machine (an FMU, a plugin).
function validateFragmentTemplate(template) {
    const { fragment } = template;
    if (!validateGraphFragment(fragment)) throw new Error('A fragment template needs a valid graph fragment: nodes with unique positive integer ids, and relationships between them.');
    const carried = new Set((fragment.sharedParameters ?? []).map((shared) => shared.id));
    fragmentSharedParameterReferences(fragment).forEach((id) => {
        if (!carried.has(id)) throw new Error(`A fragment template links to shared parameter ${id}, which it does not carry.`);
    });
    validateSharedParameters((fragment.sharedParameters ?? []).map((shared) => ({ ...shared, key: `shared${shared.id}` })), 'fragment template');
    const checkProgram = (implementation, owner) => {
        if (!implementation) return;
        if (!['cpp', 'python'].includes(implementation.kind) || typeof implementation.source !== 'string' || !implementation.source.trim()) {
            throw new Error(`${owner} has a program that is not inline cpp or python source.`);
        }
    };
    fragment.nodes.forEach((node) => {
        if (!node.name) throw new Error('A fragment template node needs a name.');
        (node.states ?? []).forEach((state) => {
            if (!componentTemplateIdPattern.test(state?.symbol ?? '') || !state.name) throw new Error(`Node "${node.name}" has a state without a name and symbol.`);
        });
        checkProgram(node.implementation, `Node "${node.name}"`);
        (node.sourceTerms ?? []).forEach((term) => checkProgram(term.implementation, `A source term of node "${node.name}"`));
    });
    fragment.edges.forEach((edge) => {
        if (!edge.name) throw new Error('A fragment template relationship needs a name.');
        checkProgram(edge.implementation, `Relationship "${edge.name}"`);
    });
}

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
    const sharedKeys = validateSharedParameters(template.sharedParameters, 'bundle');
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
    if (!template || !['node', 'edge', 'bundle', 'fragment'].includes(template.kind)) throw new Error('A template must have kind "node", "edge", "bundle" or "fragment".');
    if (!componentTemplateIdPattern.test(template.id ?? '')) throw new Error('A template needs a valid id.');
    if (!template.name) throw new Error('A template needs a name.');
    if (template.description !== undefined && typeof template.description !== 'string') throw new Error('A template description must be a string.');
    const domains = template.domains ?? [];
    if (!Array.isArray(domains) || !domains.length || !domains.every((domain) => typeof domain === 'string' && domain)) {
        throw new Error('A template needs a non-empty domains array.');
    }
    if (template.kind === 'fragment') {
        validateFragmentTemplate(template);
    } else if (template.kind === 'bundle') {
        validateBundleTemplate(template);
    } else if (template.kind === 'node') {
        if (!Array.isArray(template.states) || !template.states.length) throw new Error('A node template needs at least one state.');
        const stateSymbols = new Set();
        template.states.forEach((state) => {
            if (!componentTemplateIdPattern.test(state.symbol ?? '') || !state.label) throw new Error('A node template state needs a label and symbol.');
            stateSymbols.add(state.symbol);
        });
        const sharedKeys = validateSharedParameters(template.sharedParameters, 'node template');
        (template.sourceTerms ?? []).forEach((term) => {
            if (!stateSymbols.has(term.state) || !term.expression) throw new Error('A node template source term needs a state matching one of its own states and an expression.');
            if (term.setsValue !== undefined && typeof term.setsValue !== 'boolean') throw new Error(`The source term for "${term.state}" has a setsValue flag that is not a boolean.`);
            const symbols = new Set();
            (term.parameters ?? []).forEach((parameter) => {
                if (!componentTemplateIdPattern.test(parameter?.symbol ?? '') || !parameter.name) throw new Error(`The source term for "${term.state}" has a parameter without a name and symbol.`);
                if (symbols.has(parameter.symbol) || stateSymbols.has(parameter.symbol)) throw new Error(`The source term for "${term.state}" reuses the symbol "${parameter.symbol}".`);
                symbols.add(parameter.symbol);
                if (parameter.shared !== undefined && !sharedKeys.has(parameter.shared)) {
                    throw new Error(`The source term for "${term.state}" links parameter "${parameter.symbol}" to an undeclared shared parameter "${parameter.shared}".`);
                }
                if (parameter.shared === undefined && !Number.isFinite(parameter.value)) throw new Error(`The source term for "${term.state}" needs a finite value for parameter "${parameter.symbol}".`);
            });
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

// Whether placing the template puts a C++ program in the model, which needs a compiler. Found by walking the whole
// template for an `implementation` of kind cpp, not by looking in the places a program is known to go, so a template
// shape added later is covered too. The web edition cannot compile C++ yet, so its library leaves such templates out.
export function componentTemplateHasCppProgram(template) {
    const visit = (value) => {
        if (Array.isArray(value)) return value.some(visit);
        if (!value || typeof value !== 'object') return false;
        return Object.entries(value).some(([key, child]) => (key === 'implementation' && child?.kind === 'cpp') || visit(child));
    };
    return visit(template);
}
