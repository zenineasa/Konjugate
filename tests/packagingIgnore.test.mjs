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
        'evals',
    ];

    for (const directory of excluded) {
        assert.equal(shouldIgnorePackagePath(`/${directory}`), true);
        assert.equal(shouldIgnorePackagePath(`/${directory}/nested/file`), true);
        assert.equal(shouldIgnorePackagePath(`\\${directory}\\nested\\file`), true);
        assert.equal(shouldIgnorePackagePath(`/prefix-${directory}/file`), false);
    }

    // registry/ is Discover's offline fallback and registry/images/ the pictures it shows without
    // any network access (see scripts/verifyPackagedRegistry.mjs, which checks the packaged copy).
    for (const packagedPath of ['/package.json', '/src/main.mjs', '/protocol/schema.json', '/registry', '/registry/konjugate.fintech.json', '/registry/images', '/registry/images/konjugate.fintech.webp']) {
        assert.equal(shouldIgnorePackagePath(packagedPath), false);
    }
});

test('Electron Packager leaves registry screenshots out of the app, since they are downloaded on demand', () => {
    for (const screenshotPath of ['/registry/screenshots', '/registry/screenshots/konjugate.fintech.1.webp', '\\registry\\screenshots\\konjugate.fintech.1.webp']) {
        assert.equal(shouldIgnorePackagePath(screenshotPath), true);
    }
    // Only that directory: images and entries stay, and a lookalike name is not caught.
    for (const packagedPath of ['/registry/images/konjugate.fintech.webp', '/registry/konjugate.fintech.json', '/registry/screenshotsOther/file.json']) {
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

test('Electron Packager leaves the assistant evaluation harness out of the app', () => {
    for (const evalPath of ['/evals/assistant/assistantEval.mjs', '/evals/assistant/cases/thermal.json', '/evals/assistant/reference.json']) assert.equal(shouldIgnorePackagePath(evalPath), true, evalPath);
    for (const appPath of ['/src/assistantOperations.mjs', '/src/aiProviderRegistry.mjs', '/src/aiRemoteProviders.mjs']) assert.equal(shouldIgnorePackagePath(appPath), false, appPath);
});

test('Electron Packager leaves the Welcome feed out of the app, but keeps the bundled Welcome assets', () => {
    for (const feedPath of ['/welcome', '/welcome/featured.json', '/welcome/images/a.webp']) assert.equal(shouldIgnorePackagePath(feedPath), true, feedPath);
    for (const bundled of ['/assets/welcome', '/assets/welcome/videos.json', '/assets/welcome/whatsNew.json']) assert.equal(shouldIgnorePackagePath(bundled), false, bundled);
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
        'ThirdPartyNotices.md',
        'thirdPartyLicenses',
        'docs/welcome.md',
        'docs/causalInferenceInteractionHelp.md',
    ]);
    assert.equal(options.ignore('/node_modules/bufferutil/prebuilds/darwin-arm64/bufferutil.node'), false);
    assert.equal(options.ignore('/node_modules/bufferutil/prebuilds/win32-x64/bufferutil.node'), true);
    assert.equal(options.ignore('/src/main.mjs'), false);
});

test('Electron Packager leaves build files and dependency sources, maps and docs out of the app', () => {
    for (const excluded of [
        '/scripts/buildEngine.mjs', '/distribution/snap/snapcraft.yaml', '/vcpkgOverlays/x', '/Makefile', '/package-lock.json', '/ReadMe.md', '/ThirdPartyNotices.md',
        '/node_modules/three/build/three.module.js.map', '/node_modules/foo/index.d.ts', '/node_modules/foo/src/index.ts', '/node_modules/foo/README.md', '/node_modules/foo/CHANGELOG.md', '/node_modules/foo/History',
        '/node_modules/@types/node/index.d.ts', '/node_modules/three/src/Three.js', '/node_modules/three/build/three.webgpu.js', '/node_modules/@cortex-js/compute-engine/dist/types/x.d.ts',
    ]) assert.equal(shouldIgnorePackagePath(excluded, { platform: 'darwin', arch: 'arm64' }), true, excluded);
    for (const kept of [
        '/LICENSE', '/package.json', '/src/renderer/index.html', '/node_modules/foo/LICENSE.md', '/node_modules/foo/license', '/node_modules/foo/NOTICE.md', '/node_modules/foo/index.js', '/node_modules/foo/package.json',
        '/node_modules/three/build/three.module.js', '/node_modules/three/build/three.core.js', '/node_modules/three/examples/jsm/controls/OrbitControls.js', '/node_modules/style-mod/src/style-mod.js',
        '/node_modules/@cortex-js/compute-engine/dist/esm-min/compute-engine.js', '/node_modules/pyodide/pyodide.asm.wasm', '/node_modules/foo/data.tsx.json',
    ]) assert.equal(shouldIgnorePackagePath(kept, { platform: 'darwin', arch: 'arm64' }), false, kept);
});

test('Electron Packager bundles the main process after pruning, with the interaction-test runner only when asked', () => {
    const base = { platform: 'darwin', arch: 'arm64', appVersion: '1.2.3', icon: 'app.icns', name: 'Konjugate', appBundleId: 'com.konjugate' };
    for (const includeTests of [false, true]) {
        const options = createPackageOptions({ ...base, includeTests });
        assert.equal(options.prune, true);
        assert.equal(options.afterPrune.length, 1);
        assert.equal(typeof options.afterPrune[0], 'function');
    }
});
