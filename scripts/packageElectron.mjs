// Copyright © 2026 Zenin Easa Panthakkalakath

import { packager } from '@electron/packager';
import { bundlePackagedApp } from './bundlePackagedApp.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ignoredTopLevelDirectories = new Set([
    'out',
    'vcpkg_installed',
    '.tools',
    'engine',
    '.git',
    '.github',
    '.vscode',
    '.claude',
    'tests',
    'docs',
    'packaging',
    'evals',
    'welcome',
    'scripts',
    'distribution',
    'vcpkgOverlays',
]);

// tests/ is otherwise entirely test-authoring machinery that has no business in a package shipped
// to users -- except src/main.mjs dynamically imports tests/interactionRunner.mjs at runtime under
// --interaction-test (see scripts/runPackagedInteractionTests.mjs, which drives exactly that
// packaged path against `make verifyPackagedInteraction`), so it and its one own dependency must
// still be copied in even though the rest of tests/ is not. Every ancestor directory of an allowed
// file must be un-ignored too, or fs.cp's recursive copy (see copyTemplate in
// @electron/packager's platform.js) never descends far enough to reach it.
const packagedTestFiles = new Set([
    'tests/interactionRunner.mjs',
    'tests/fixtures/thermalSystemCsv.mjs',
    'tests/drivers/electronWindowDriver.mjs',
]);
const packagedTestAncestorDirectories = new Set(
    [...packagedTestFiles].flatMap((file) => {
        const segments = file.split('/').slice(0, -1);
        return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    })
);

// The rest of registry/ ships inside the app (it is Discover's offline fallback, images included),
// but an entry's screenshots don't: they are only shown next to an Install button, which needs the
// network anyway, so the app downloads and caches them on demand instead (see
// registryScreenshotPathPattern in src/packageArchive.mjs and scripts/verifyPackagedRegistry.mjs).
const ignoredPathPrefixes = [
    'registry/screenshots',
    // Parts of dependencies nothing loads at run time. The renderers load dependencies by file
    // path (see the import maps in src/*/index.html): three is build/three.module.js and
    // three.core.js plus a few examples/jsm addons, and the compute engine is dist/esm-min.
    'node_modules/@types',
    'node_modules/three/src',
    'node_modules/three/build/three.tsl.js',
    'node_modules/three/build/three.webgpu.js',
    'node_modules/three/build/three.webgpu.nodes.js',
    'node_modules/@cortex-js/compute-engine/dist/types',
    'node_modules/@cortex-js/compute-engine/dist/esm-min/cli',
    'node_modules/pyodide/console.html',
    'node_modules/pyodide/console-v2.html',
];

// Top-level files that build or document the app and are never read by it.
const ignoredTopLevelFiles = new Set([
    'Makefile',
    'package-lock.json',
    'vcpkg.json',
    'ReadMe.md',
    'Privacy.md',
    'CONTRIBUTING.md',
    'CLA.md',
    // Shipped beside the app as an extraResource; the copy inside it was never read.
    'ThirdPartyNotices.md',
]);

// Files inside node_modules that are never run: TypeScript sources and declarations, source maps
// and documentation. Licence and notice files are kept whatever their extension.
const ignoredDependencyFilePattern = /\.(?:map|ts|mts|cts|md|markdown)$|^(?:changelog|history)(?:\.|$)/i;
const keptDependencyFilePattern = /^(?:licen[cs]e|notice|copying|authors)(?:[.-]|$)/i;

// Native prebuilds for other platforms (bufferutil ships one per platform).
const prebuildPattern = /^node_modules\/(?:.+\/)?prebuilds\/([^/]+)(?:\/|$)/;

export function shouldIgnorePackagePath(filePath, { platform, arch } = {}) {
    const normalized = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
    if (packagedTestFiles.has(normalized) || packagedTestAncestorDirectories.has(normalized)) return false;
    if (ignoredPathPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
    if (ignoredTopLevelFiles.has(normalized)) return true;
    if (normalized.startsWith('node_modules/')) {
        const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
        if (ignoredDependencyFilePattern.test(fileName) && !keptDependencyFilePattern.test(fileName)) return true;
        const prebuild = prebuildPattern.exec(normalized);
        if (prebuild && platform && arch && prebuild[1] !== `${platform}-${arch}`) return true;
    }
    const [topLevelDirectory] = normalized.split('/').filter(Boolean);
    return ignoredTopLevelDirectories.has(topLevelDirectory);
}

// KONJUGATE_PACKAGE_INTERACTION_TESTS=1 bundles the --interaction-test runner into the app (see
// scripts/bundlePackagedApp.mjs), for `make verifyPackagedInteraction`; a package for users leaves it out.
export function createPackageOptions({ platform, arch, appVersion, icon, name, appBundleId, includeTests = process.env.KONJUGATE_PACKAGE_INTERACTION_TESTS === '1' }) {
    return {
        dir: '.',
        name,
        platform,
        arch,
        appVersion,
        icon,
        appBundleId: platform === 'darwin' ? appBundleId : undefined,
        // Registers .kjt as a Konjugate document type in Info.plist -- CFBundleDocumentTypes is
        // the legacy declaration most of macOS still keys off; UTExportedTypeDeclarations is the
        // modern UTI counterpart Launch Services increasingly expects alongside it.
        extendInfo: platform === 'darwin' ? {
            CFBundleDocumentTypes: [{
                CFBundleTypeName: 'Konjugate Project',
                CFBundleTypeRole: 'Editor',
                LSItemContentTypes: ['com.konjugate.kjt'],
                LSHandlerRank: 'Owner',
                CFBundleTypeExtensions: ['kjt']
            }],
            UTExportedTypeDeclarations: [{
                UTTypeIdentifier: 'com.konjugate.kjt',
                UTTypeConformsTo: ['public.data'],
                UTTypeDescription: 'Konjugate Project',
                UTTypeTagSpecification: { 'public.filename-extension': ['kjt'] }
            }]
        } : undefined,
        extraResource: [
            'out/packageResources/engine',
            'ThirdPartyNotices.md',
            'thirdPartyLicenses',
            'docs/welcome.md',
            'docs/causalInferenceInteractionHelp.md',
        ],
        ignore: (filePath) => shouldIgnorePackagePath(filePath, { platform, arch }),
        out: 'out/package',
        overwrite: true,
        prune: true,
        afterPrune: [({ buildPath }) => bundlePackagedApp(buildPath, { includeTests })],
    };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [, , platform, arch, appVersion, icon, name, appBundleId] = process.argv;
    if (!platform || !arch || !appVersion || !icon || !name) {
        console.error('Usage: node scripts/packageElectron.mjs <platform> <arch> <version> <icon> <name> [bundle-id]');
        process.exit(2);
    }
    if (platform === 'darwin' && !appBundleId) {
        console.error('A bundle ID is required for macOS packaging.');
        process.exit(2);
    }

    await packager(createPackageOptions({ platform, arch, appVersion, icon, name, appBundleId }));
}
