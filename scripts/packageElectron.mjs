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

export function shouldIgnorePackagePath(filePath) {
    const [topLevelDirectory] = filePath.replaceAll('\\', '/').split('/').filter(Boolean);
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
            'docs/About.md',
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
