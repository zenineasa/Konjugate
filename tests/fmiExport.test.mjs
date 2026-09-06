/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Unit tests for the pure-JS parts of src/fmiExport.mjs -- mergeFmuPackages needs no engine binary
// and no compiled shared library, so it can be exercised directly with hand-built zip archives.
// generateFmuPackage itself (which does need the engine) stays covered by
// tests/engine/fmiExportFidelity.mjs and tests/engine/fmiRoundTrip.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, unzipSync } from 'fflate';
import { mergeFmuPackages } from '../src/fmiExport.mjs';

function fmuBytes({ guid = 'guid-1', binaries = {} }) {
    const entries = {
        'modelDescription.xml': new TextEncoder().encode(`<fmiModelDescription guid="${guid}"></fmiModelDescription>`)
    };
    for (const [path, text] of Object.entries(binaries)) entries[path] = new TextEncoder().encode(text);
    return zipSync(entries, { level: 0 });
}

test('mergeFmuPackages combines binaries from matching-guid exports into one archive', () => {
    const macFmu = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'mac-bytes' } });
    const winFmu = fmuBytes({ binaries: { 'binaries/win64/model.dll': 'win-bytes' } });
    const merged = mergeFmuPackages([{ name: 'mac.fmu', data: macFmu }, { name: 'win.fmu', data: winFmu }]);

    const entries = unzipSync(merged);
    assert.equal(new TextDecoder().decode(entries['binaries/darwin64/model.dylib']), 'mac-bytes');
    assert.equal(new TextDecoder().decode(entries['binaries/win64/model.dll']), 'win-bytes');
    assert.ok(entries['modelDescription.xml']);
});

test('mergeFmuPackages rejects files whose guids differ', () => {
    const first = fmuBytes({ guid: 'guid-1', binaries: { 'binaries/darwin64/model.dylib': 'a' } });
    const second = fmuBytes({ guid: 'guid-2', binaries: { 'binaries/win64/model.dll': 'b' } });
    assert.throws(() => mergeFmuPackages([{ name: 'a.fmu', data: first }, { name: 'b.fmu', data: second }]), /same model/);
});

test('mergeFmuPackages rejects a lone file', () => {
    const only = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'a' } });
    assert.throws(() => mergeFmuPackages([{ name: 'a.fmu', data: only }]), /at least two/);
});

test('mergeFmuPackages rejects the same platform directory with conflicting bytes', () => {
    const first = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'a' } });
    const second = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'different' } });
    assert.throws(() => mergeFmuPackages([{ name: 'a.fmu', data: first }, { name: 'b.fmu', data: second }]), /different contents/);
});

test('mergeFmuPackages accepts identical bytes for the same platform directory', () => {
    const first = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'same' } });
    const second = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'same' } });
    const merged = mergeFmuPackages([{ name: 'a.fmu', data: first }, { name: 'b.fmu', data: second }]);
    assert.equal(new TextDecoder().decode(unzipSync(merged)['binaries/darwin64/model.dylib']), 'same');
});

test('mergeFmuPackages rejects a non-FMU file', () => {
    const notAnFmu = zipSync({ 'readme.txt': new TextEncoder().encode('hello') }, { level: 0 });
    const valid = fmuBytes({ binaries: { 'binaries/darwin64/model.dylib': 'a' } });
    assert.throws(() => mergeFmuPackages([{ name: 'a.fmu', data: valid }, { name: 'oops.txt', data: notAnFmu }]), /doesn't look like an FMU/);
});
