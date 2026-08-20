/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageArchive } from '../src/packageArchive.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, '..');
const outputDirectory = join(projectRoot, 'out', 'examples');
const addonDirectory = join(projectRoot, 'addons', 'helloWorld');
const providerDirectory = join(projectRoot, 'examples', 'providers');

const addonManifest = JSON.parse(await readFile(join(addonDirectory, 'addon.json'), 'utf8'));
const addonFiles = {};
for (const file of ['index.html', 'styles.css', 'helloWorld.mjs']) addonFiles[file] = await readFile(join(addonDirectory, file));
const addonPackage = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'addon',
        packageId: addonManifest.addonId, name: addonManifest.name, version: addonManifest.version,
        contents: { manifest: 'addon.json' }
    },
    contributionManifest: addonManifest,
    files: addonFiles
});

const pluginManifest = JSON.parse(await readFile(join(providerDirectory, 'helloWorld.plugin.json'), 'utf8'));
const pluginSource = await readFile(join(providerDirectory, 'helloWorld.py'));
const pluginComponent = await readFile(join(providerDirectory, 'helloComponent.json'));
const pluginPackage = createPackageArchive({
    packageManifest: {
        format: 'konjugate-package', formatVersion: 1, packageType: 'plugin',
        packageId: pluginManifest.pluginId, name: pluginManifest.name, version: pluginManifest.version,
        contents: { manifest: 'plugin.json' }
    },
    contributionManifest: pluginManifest,
    files: { 'helloWorld.py': pluginSource, 'helloComponent.json': pluginComponent }
});

await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'helloWorld.kja'), addonPackage);
await writeFile(join(outputDirectory, 'helloProvider.kjp'), pluginPackage);
console.log(`Wrote ${join(outputDirectory, 'helloWorld.kja')}`);
console.log(`Wrote ${join(outputDirectory, 'helloProvider.kjp')}`);
