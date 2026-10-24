// Copyright © 2026 Zenin Easa Panthakkalakath

// The Results Analysis and Pose Visualizer add-ons live in their own repositories now, but part of
// the interaction suite drives them to exercise core's add-on host (toolstrip commands, result
// sessions, exports). Install their built packages into the run's scratch user data, from sibling
// checkouts built with `npm run build` (the same side-by-side layout the add-on repos use to find
// ../konjugate), or from KONJUGATE_INTERACTION_ADDONS: a list of .kja paths or directories,
// separated by the platform path delimiter. Tests needing an add-on that isn't found skip.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { inspectPackageArchive, installPackageArchive } from '../src/packageArchive.mjs';
import { isNewerVersion } from '../src/registryClient.mjs';

const siblingRepositories = ['konjugate-resultplotviewer', 'konjugate-posevisualizer'];

async function packagesIn(path) {
    if (path.endsWith('.kja')) return existsSync(path) ? [path] : [];
    const names = await readdir(path).catch(() => []);
    return names.filter((name) => name.endsWith('.kja')).map((name) => join(path, name));
}

export async function installInteractionAddons(rootDirectory, userDataDirectory) {
    const sources = process.env.KONJUGATE_INTERACTION_ADDONS
        ? process.env.KONJUGATE_INTERACTION_ADDONS.split(delimiter).filter(Boolean).map((path) => resolve(path))
        : siblingRepositories.map((name) => resolve(rootDirectory, '..', name, 'out'));
    // An out/ folder can hold several builds of the same add-on; only the newest is installed.
    const newest = new Map();
    for (const source of sources) {
        for (const path of await packagesIn(source)) {
            const archive = await readFile(path);
            const { packageId, version } = inspectPackageArchive(archive, { extension: '.kja' }).packageManifest;
            const current = newest.get(packageId);
            if (!current || isNewerVersion(version, current.version)) newest.set(packageId, { archive, version });
        }
    }
    const installed = [];
    for (const [packageId, { archive, version }] of newest) {
        await installPackageArchive(archive, {
            extension: '.kja', directory: join(userDataDirectory, 'packages'), overwrite: true
        });
        installed.push(packageId);
    }
    console.log(installed.length
        ? `Installed add-ons for the interaction suite: ${[...newest].map(([packageId, { version }]) => `${packageId} ${version}`).join(', ')}`
        : 'No add-on packages found for the interaction suite; tests that need them will be skipped.');
    return installed;
}
