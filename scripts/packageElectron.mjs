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
        extraResource: [
            'out/packageResources/engine',
            'thirdPartyNotices.md',
            'thirdPartyLicenses',
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
