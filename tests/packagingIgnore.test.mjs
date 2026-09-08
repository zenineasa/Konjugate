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

test('Electron Packager excludes tests/ except the --interaction-test driver src/main.mjs imports at runtime', () => {
    // tests/ and tests/fixtures/ themselves (the container directories of the allowed files below)
    // must stay un-ignored, or fs.cp's recursive copy (see copyTemplate in @electron/packager's
    // platform.js, empirically confirmed to invoke the filter per directory and skip descending
    // into one it returns true for) never reaches the allowed files at all.
    for (const containerPath of ['/tests', '/tests/fixtures', '\\tests', '\\tests\\fixtures']) {
        assert.equal(shouldIgnorePackagePath(containerPath), false);
    }
    for (const allowedPath of ['/tests/interactionRunner.mjs', '/tests/fixtures/thermalSystemCsv.mjs']) {
        assert.equal(shouldIgnorePackagePath(allowedPath), false);
        assert.equal(shouldIgnorePackagePath(allowedPath.replaceAll('/', '\\')), false);
    }
    for (const excludedPath of [
        '/tests/otherTest.test.mjs',
        '/tests/engine/executionPlanTests.cpp',
        '/tests/fixtures/otherFixture.mjs',
        '\\tests\\otherTest.test.mjs',
    ]) {
        assert.equal(shouldIgnorePackagePath(excludedPath), true);
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
        'docs/welcome.md',
        'docs/causalInferenceInteractionHelp.md',
    ]);
    assert.equal(options.ignore, shouldIgnorePackagePath);
});
