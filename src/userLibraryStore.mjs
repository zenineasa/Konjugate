/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The operations on the user's own templates, once, for both editions. The desktop app keeps them as files in its user
// data folder and the web edition in the browser; each supplies only where they live, as
//   readAll()          every user template saved
//   write(template)    save one, replacing any with that id
//   remove(id)         delete one
//   otherTemplateIds() the ids of every template that is not the user's, which a new one must not take
// and everything that decides what is allowed is here, so the two cannot disagree.

import { validateComponentTemplate } from './componentTemplate.mjs';
import { moveSection, sectionPathProblem } from './librarySections.mjs';
import { changeUserTemplate, userTemplateId } from './userLibrary.mjs';

export function createUserLibraryStore({ readAll, write, remove, otherTemplateIds }) {
    const find = async (id) => {
        const template = (await readAll()).find((candidate) => candidate.id === id);
        if (!template) throw new Error('That template is not in your library.');
        return template;
    };
    return {
        // Saves a template; if its id is taken by now, it is given the next free one. Returns what was saved.
        async save(template) {
            const valid = validateComponentTemplate(template);
            if (valid.kind !== 'fragment') throw new Error('Only a selection of nodes and relationships can be saved to the library.');
            const taken = new Set([...await otherTemplateIds(), ...(await readAll()).map((saved) => saved.id)]);
            const saved = taken.has(valid.id) ? { ...valid, id: userTemplateId(valid.name, taken) } : valid;
            await write(saved);
            return saved;
        },

        async update(id, changes) {
            const changed = changeUserTemplate(await find(id), changes);
            await write(changed);
            return changed;
        },

        // Renames or moves a section: every template in it, or below it, is filed under the new path. Returns their ids.
        async moveSection(from, to) {
            for (const path of [from, to]) {
                const problem = sectionPathProblem(path);
                if (problem) throw new Error(problem);
            }
            const templates = await readAll();
            const moves = moveSection(templates, from, to);
            // Checked before anything is written, so a move that cannot be made leaves the library as it was.
            const changed = moves.map(({ id, section }) => changeUserTemplate(templates.find((template) => template.id === id), { section }));
            for (const template of changed) await write(template);
            return changed.map(({ id }) => id);
        },

        async remove(id) {
            await find(id);
            await remove(id);
        }
    };
}
