/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Turning a selection on the canvas into a template of the user's own, and changing one afterwards. Pure, so the desktop
// app and the web edition (which keep the saved templates in different places) make and change them identically, and so
// `npm test` can run it. A user template is an ordinary `fragment` template (see src/componentTemplate.mjs) with a
// `section` path; it is validated by the same function as a bundled one, and nothing here knows a second format.

import { fragmentTemplateProblems, validateComponentTemplate } from './componentTemplate.mjs';
import { createGraphFragment } from './graphClipboard.mjs';
import { sectionPathProblem } from './librarySections.mjs';

// The selection cannot be stored, and why, each reason a sentence that says what to change.
export class UnstorableSelectionError extends Error {
    constructor(problems) {
        super(problems.join(' '));
        this.name = 'UnstorableSelectionError';
        this.problems = problems;
    }
}

// An id from the name, not already taken. Template ids are letters, digits, "_" and "-", starting with a letter, which is
// what keeps one safe to use as a file name.
export function userTemplateId(name, takenIds) {
    const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'template';
    const taken = new Set(takenIds);
    let id = `user_${slug}`;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `user_${slug}_${suffix}`;
    return id;
}

const round = (value) => Math.round(value * 1e6) / 1e6;

// Words for an id in the selection's document, so "refers to state 12" can say whose state.
function referenceDescriber(document) {
    const nodes = new Map((document.nodes ?? []).map((node) => [node.id, node]));
    const states = new Map((document.nodes ?? []).flatMap((node) => (node.states ?? []).map((state) => [state.id, { state, node }])));
    return (key, id) => {
        if (key === 'nodeId' && nodes.has(id)) return `the node "${nodes.get(id).name}"`;
        if (key === 'stateId' && states.has(id)) return `the state "${states.get(id).state.name}" of the node "${states.get(id).node.name}"`;
        return `${key.replace(/Id$/, '')} ${id}`;
    };
}

export function buildUserTemplate({ document, selectedNodeIds, name, description = '', section = [], takenIds = [] }) {
    const title = String(name ?? '').trim();
    if (!title) throw new Error('A template needs a name.');
    const sectionProblem = sectionPathProblem(section);
    if (sectionProblem) throw new Error(sectionProblem);
    const fragment = createGraphFragment(document, selectedNodeIds, { includeSharedParameters: true });
    if (!fragment) throw new Error('Select at least one node to save.');

    // Where the selection sat, where it was, and what it was in, say nothing about the template: the layout is kept
    // relative to its own middle, and it lands in whatever is open when it is placed.
    const middle = [0, 1, 2].map((axis) => round(fragment.nodes.reduce((sum, node) => sum + Number(node.position?.[axis] ?? 0), 0) / fragment.nodes.length));
    fragment.nodes.forEach((node) => {
        node.position = [0, 1, 2].map((axis) => round(Number(node.position?.[axis] ?? 0) - middle[axis]));
        delete node.subsystemId;
    });
    fragment.edges.forEach((edge) => {
        delete edge.groupId;
        if (edge.appearance) edge.appearance.waypoints = [];
    });
    // A shared parameter is made afresh for each placement unless it says otherwise.
    (fragment.sharedParameters ?? []).forEach((shared) => { shared.scope ??= 'instance'; });

    const problems = fragmentTemplateProblems(fragment, { describeReference: (key, id) => referenceDescriber(document)(key, id) });
    if (problems.length) throw new UnstorableSelectionError(problems);

    return validateComponentTemplate({
        id: userTemplateId(title, takenIds),
        kind: 'fragment',
        name: title,
        ...(description.trim() ? { description: description.trim() } : {}),
        domains: ['custom'],
        ...(section.length ? { section } : {}),
        color: fragment.nodes[0].appearance?.color ?? '#42c9bc',
        fragment
    });
}

// The same template with a new name, description or section. Anything left out stays as it was.
export function changeUserTemplate(template, { name = template.name, description = template.description ?? '', section = template.section ?? [] }) {
    const title = String(name).trim();
    if (!title) throw new Error('A template needs a name.');
    const rest = { ...template };
    delete rest.section;
    delete rest.description;
    return validateComponentTemplate({
        ...rest,
        name: title,
        ...(String(description).trim() ? { description: String(description).trim() } : {}),
        ...(section.length ? { section } : {})
    });
}
