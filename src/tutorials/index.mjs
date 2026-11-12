/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Every tutorial Konjugate ships (docs/proposals/tutorials.md), in the order the Tutorials list shows them within an area, and how the
// list is searched and grouped. Shared by the desktop and web editions' renderer and by the main process (which checks the ids a window
// reports and the data files it asks for against this list).

import { buildFromComponents } from './buildFromComponents.mjs';
import { calibrateTank } from './calibrateTank.mjs';
import { discoverEquations } from './discoverEquations.mjs';
import { firstModel } from './firstModel.mjs';
import { liveTwin } from './liveTwin.mjs';
import { fixInstability } from './fixInstability.mjs';
import { optimiseObjective } from './optimiseObjective.mjs';
import { steerByHand } from './steerByHand.mjs';
import { tuneController } from './tuneController.mjs';
import { whatIfBranches } from './whatIfBranches.mjs';

export const tutorials = Object.freeze([firstModel, buildFromComponents, fixInstability, calibrateTank, optimiseObjective, tuneController, steerByHand, whatIfBranches, discoverEquations, liveTwin]);

// The groups of the list, in order, with the heading each shows. A tutorial's `area` is one of these ids.
export const tutorialAreas = Object.freeze([
    { id: 'start', title: 'Start here' },
    { id: 'modelling', title: 'Modelling' },
    { id: 'results', title: 'Results' },
    { id: 'tuning', title: 'Tuning and calibration' },
    { id: 'control', title: 'Control' },
    { id: 'data', title: 'Data and twins' }
]);

export const tutorialById = (id) => tutorials.find((tutorial) => tutorial.id === id) ?? null;

// The tutorials that start from an example (by its file name, as the Examples dialog names it), for the guide's cards back to them.
export const tutorialsForExample = (exampleId) => tutorials.filter((tutorial) => tutorial.start.from === 'example' && tutorial.start.example === exampleId);

// The files beside the examples that a tutorial reads (a tutorial's measurements): the only ones a window may ask the main process for.
export const tutorialDataFiles = Object.freeze([...new Set(tutorials.flatMap((tutorial) => tutorial.data ?? []))]);

// An example's name as people see it ("tankCalibration.kjt" is "Tank Calibration"), as src/exampleCatalog.mjs's exampleLabel names it;
// that module reads files, so it cannot be loaded in a page, and a test keeps the two the same.
export const exampleTitle = (fileName) => {
    const stem = String(fileName).replace(/\.kjt$/, '');
    return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
};

// How a tutorial says where it starts, in the list.
export const tutorialStartLabel = (tutorial, exampleLabel = exampleTitle) => (tutorial.start.from === 'example'
    ? `Starts from the ${exampleLabel(tutorial.start.example)} example` : 'From an empty canvas');

const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

// The tutorials whose title, sentence, tags or starting example match every word of `query`, best first: a match in the title counts most,
// then a tag, then the rest. An empty query returns the whole list in its own order. `exampleLabel` turns an example's file name into the
// name people see ("Tank Calibration"), so it can be searched by that name too.
export function searchTutorials(query, { list = tutorials, exampleLabel = exampleTitle } = {}) {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [...list];
    const scored = [];
    list.forEach((tutorial, index) => {
        const title = normalize(tutorial.title);
        const tags = normalize(tutorial.tags.join(' '));
        const rest = normalize(`${tutorial.summary} ${tutorial.start.from === 'example' ? `${exampleLabel(tutorial.start.example)} ${tutorial.start.example}` : 'empty canvas scratch'}`);
        let score = 0;
        for (const word of words) {
            const best = title.includes(word) ? 3 : tags.includes(word) ? 2 : rest.includes(word) ? 1 : 0;
            if (!best) return;
            score += best;
        }
        scored.push({ tutorial, score, index });
    });
    return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.tutorial);
}

// The list as the dialog shows it with nothing typed: one group per area that has a tutorial, in the areas' order.
export function groupTutorials(list = tutorials) {
    return tutorialAreas.map((area) => ({ ...area, tutorials: list.filter((tutorial) => tutorial.area === area.id) }))
        .filter((group) => group.tutorials.length);
}
