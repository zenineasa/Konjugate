// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPackageOptions, shouldIgnorePackagePath } from '../scripts/packageElectron.mjs';

test('Electron Packager excludes build-only top-level directories', async () => {
    const excluded = [
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
    ];

    for (const directory of excluded) {
        assert.equal(shouldIgnorePackagePath(`/${directory}`), true);
        assert.equal(shouldIgnorePackagePath(`/${directory}/nested/file`), true);
        assert.equal(shouldIgnorePackagePath(`\\${directory}\\nested\\file`), true);
        assert.equal(shouldIgnorePackagePath(`/prefix-${directory}/file`), false);
    }

    for (const packagedPath of ['/package.json', '/src/main.mjs', '/protocol/schema.json']) {
        assert.equal(shouldIgnorePackagePath(packagedPath), false);
    }
});

test('Electron Packager options retain resources and macOS bundle ID', () => {
    const options = createPackageOptions({
        platform: 'darwin',
        arch: 'arm64',
        appVersion: '1.2.3',
        icon: 'app.icns',
        name: 'Konjugate',
        appBundleId: 'com.konjugate',
    });

    assert.equal(options.appBundleId, 'com.konjugate');
    assert.deepEqual(options.extraResource, [
        'out/packageResources/engine',
        'thirdPartyNotices.md',
        'thirdPartyLicenses',
        'docs/About.md',
        'docs/causalInferenceInteractionHelp.md',
    ]);
    assert.equal(options.ignore, shouldIgnorePackagePath);
});
