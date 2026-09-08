// Copyright © 2026 Zenin Easa Panthakkalakath

import { packager } from '@electron/packager';
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
]);
const packagedTestAncestorDirectories = new Set(
    [...packagedTestFiles].flatMap((file) => {
        const segments = file.split('/').slice(0, -1);
        return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
    })
);

export function shouldIgnorePackagePath(filePath) {
    const normalized = filePath.replaceAll('\\', '/').replace(/^\/+/, '');
    if (packagedTestFiles.has(normalized) || packagedTestAncestorDirectories.has(normalized)) return false;
    const [topLevelDirectory] = normalized.split('/').filter(Boolean);
    return ignoredTopLevelDirectories.has(topLevelDirectory);
}

export function createPackageOptions({ platform, arch, appVersion, icon, name, appBundleId }) {
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
            'thirdPartyNotices.md',
            'thirdPartyLicenses',
            'docs/welcome.md',
            'docs/causalInferenceInteractionHelp.md',
        ],
        ignore: shouldIgnorePackagePath,
        out: 'out/package',
        overwrite: true,
        prune: true,
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
