// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { vcpkgCommit } from '../scripts/developmentEnvironment.mjs';

const rootDirectory = join(import.meta.dirname, '..');

test('development dependencies and bootstrap use the same pinned vcpkg baseline', async () => {
    const manifest = JSON.parse(await readFile(join(rootDirectory, 'vcpkg.json'), 'utf8'));
    assert.equal(manifest['builtin-baseline'], vcpkgCommit);
    assert.deepEqual(manifest.dependencies.toSorted(), ['boost-property-tree', 'eigen3', 'metis', 'openssl', 'protobuf', 'zlib']);
});

test('normal development requires METIS while the fallback preset disables it explicitly', async () => {
    const presets = JSON.parse(await readFile(join(rootDirectory, 'engine', 'CMakePresets.json'), 'utf8'));
    const development = presets.configurePresets.find((preset) => preset.name === 'development');
    const fallback = presets.configurePresets.find((preset) => preset.name === 'development-no-metis');
    assert.equal(development.cacheVariables.KONJUGATE_REQUIRE_METIS, 'ON');
    assert.equal(fallback.cacheVariables.KONJUGATE_ENABLE_METIS, 'OFF');
    assert.equal(fallback.cacheVariables.KONJUGATE_REQUIRE_METIS, 'OFF');
});
