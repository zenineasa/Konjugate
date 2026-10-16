/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Builds the example plugin package, out/examples/helloProvider.kjp, from examples/providers/. The Hello World add-on
// example lives in its own repository (Konjugate-HelloWorld) now, like the other add-ons, and builds its own .kja there.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageArchive } from '../src/packageArchive.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, '..');
const outputDirectory = join(projectRoot, 'out', 'examples');
const providerDirectory = join(projectRoot, 'examples', 'providers');

// The example is built and tried against this Konjugate, so that is the minimum it claims
// (docs/proposals/packageCompatibility.md). A package author sets the lowest version they have actually tested.
const appVersion = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version;
const minimumKonjugate = /^\d+\.\d+\.\d+$/.test(appVersion) ? { minimumKonjugateVersion: appVersion } : {};

const pluginManifest = JSON.parse(await readFile(join(providerDirectory, 'helloWorld.plugin.json'), 'utf8'));
const pluginSource = await readFile(join(providerDirectory, 'helloWorld.py'));
const pluginComponent = await readFile(join(providerDirectory, 'helloComponent.json'));
const pluginPackage = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'plugin',
        packageId: pluginManifest.pluginId, name: pluginManifest.name, version: pluginManifest.version, ...minimumKonjugate,
        contents: { manifest: 'plugin.json' }
    },
    contributionManifest: pluginManifest,
    files: { 'helloWorld.py': pluginSource, 'helloComponent.json': pluginComponent }
});

await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'helloProvider.kjp'), pluginPackage);
console.log(`Wrote ${join(outputDirectory, 'helloProvider.kjp')}`);
