/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A section of the user's component library is a path of names, such as ["Pumps", "Centrifugal"], held on each template
// that lives in it. A section exists exactly while a template is in it: there is no separate list of folders to keep in
// step with the templates, so there is nothing to drift. Renaming or moving a section is rewriting the path on the
// templates inside it.

export const maximumSectionDepth = 4;
export const maximumSectionNameLength = 60;

// The path a person types: names separated by "/", with the spaces around them dropped. An empty string is the top level.
export function parseSectionPath(text) {
    const path = String(text ?? '').split('/').map((name) => name.trim()).filter(Boolean);
    const problem = sectionPathProblem(path);
    if (problem) throw new Error(problem);
    return path;
}

export const sectionPathText = (path) => path.join(' / ');

export function sectionPathProblem(path) {
    if (!Array.isArray(path)) return 'A section must be a list of names.';
    if (path.length > maximumSectionDepth) return `A section can be nested at most ${maximumSectionDepth} deep.`;
    for (const name of path) {
        if (typeof name !== 'string' || !name.trim() || name !== name.trim()) return 'Every section name must be text without leading or trailing spaces.';
        if (name.length > maximumSectionNameLength) return `A section name can be at most ${maximumSectionNameLength} characters.`;
        if (name.includes('/')) return 'A section name cannot contain "/".';
    }
    return null;
}

export const isSectionWithin = (path, ancestor) => ancestor.length <= path.length && ancestor.every((name, index) => path[index] === name);
export const sameSection = (left, right) => left.length === right.length && isSectionWithin(left, right);

const byName = (left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });

// The sections as a tree: each node has the `templates` filed directly in it and its child sections, both in name order.
// The root is the top level, whose path is empty.
export function sectionTree(templates) {
    const root = { name: '', path: [], templates: [], children: [] };
    for (const template of templates) {
        let node = root;
        (template.section ?? []).forEach((name, depth) => {
            let child = node.children.find((candidate) => candidate.name === name);
            if (!child) {
                child = { name, path: [...node.path, name], templates: [], children: [] };
                node.children.push(child);
            }
            node = child;
            if (depth === (template.section.length - 1)) node.templates.push(template);
        });
        if (!(template.section ?? []).length) root.templates.push(template);
    }
    const sort = (node) => {
        node.children.sort(byName);
        node.templates.sort(byName);
        node.children.forEach(sort);
    };
    sort(root);
    return root;
}

// Every section path that has a template in it or below it, for offering as a choice.
export function sectionPaths(templates) {
    const seen = new Map();
    for (const template of templates) {
        const path = template.section ?? [];
        for (let length = 1; length <= path.length; length += 1) {
            const prefix = path.slice(0, length);
            seen.set(sectionPathText(prefix), prefix);
        }
    }
    return [...seen.values()].sort((left, right) => sectionPathText(left).localeCompare(sectionPathText(right), undefined, { sensitivity: 'base' }));
}

// What moving (or renaming) the section `from` to `to` does: the templates in it or below it, each with its new path.
export function moveSection(templates, from, to) {
    if (!from.length) throw new Error('The top level cannot be moved.');
    const problem = sectionPathProblem(to);
    if (problem) throw new Error(problem);
    if (isSectionWithin(to, from) && to.length >= from.length && !sameSection(to, from)) throw new Error('A section cannot be moved into itself.');
    return templates.filter((template) => isSectionWithin(template.section ?? [], from))
        .map((template) => ({ id: template.id, section: [...to, ...template.section.slice(from.length)] }));
}
