/* Copyright © 2026 Zenin Easa Panthakkalakath */

import test from 'node:test';
import assert from 'node:assert/strict';
import { binaryArchitectures, binaryDirectoryCandidates, chooseFmuBinary, describeChosenBinary, fmiArchitecture } from '../src/fmiBinary.mjs';

function machO(cpuType) {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xfeedfacf, true);
    view.setUint32(4, cpuType, true);
    return bytes;
}

function universal(...cpuTypes) {
    const bytes = new Uint8Array(8 + cpuTypes.length * 20);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xcafebabe, false);
    view.setUint32(4, cpuTypes.length, false);
    cpuTypes.forEach((cpuType, index) => view.setUint32(8 + index * 20, cpuType, false));
    return bytes;
}

function elf(machine) {
    const bytes = new Uint8Array(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    new DataView(bytes.buffer).setUint16(18, machine, true);
    return bytes;
}

function pe(machine) {
    const bytes = new Uint8Array(0x100);
    const view = new DataView(bytes.buffer);
    bytes.set([0x4d, 0x5a]);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x50450000, false);
    view.setUint16(0x84, machine, true);
    return bytes;
}

const arm64 = 0x0100000c;
const x8664 = 0x01000007;

test('a shared library says which processors it is built for', () => {
    assert.deepEqual(binaryArchitectures(machO(arm64)), ['aarch64']);
    assert.deepEqual(binaryArchitectures(machO(x8664)), ['x86_64']);
    assert.deepEqual(binaryArchitectures(universal(x8664, arm64)), ['x86_64', 'aarch64']);
    assert.deepEqual(binaryArchitectures(elf(62)), ['x86_64']);
    assert.deepEqual(binaryArchitectures(elf(183)), ['aarch64']);
    assert.deepEqual(binaryArchitectures(pe(0x8664)), ['x86_64']);
    assert.deepEqual(binaryArchitectures(pe(0x14c)), ['x86']);
    assert.equal(binaryArchitectures(new TextEncoder().encode('not a library at all')), null);
    assert.equal(fmiArchitecture('arm64'), 'aarch64');
    assert.equal(fmiArchitecture('x64'), 'x86_64');
});

test('an FMU is looked for under its own standard\'s directory name first, then the other\'s', () => {
    assert.deepEqual(binaryDirectoryCandidates('3.0', { platform: 'darwin', arch: 'arm64' }), ['aarch64-darwin', 'darwin64']);
    assert.deepEqual(binaryDirectoryCandidates('2.0', { platform: 'darwin', arch: 'arm64' }), ['darwin64', 'aarch64-darwin']);
    assert.deepEqual(binaryDirectoryCandidates('3.0', { platform: 'linux', arch: 'x64' }), ['x86_64-linux', 'linux64']);
    assert.deepEqual(binaryDirectoryCandidates('2.0', { platform: 'win32', arch: 'x64' }), ['win64', 'x86_64-windows']);
    assert.deepEqual(binaryDirectoryCandidates('3.0', { platform: 'win32', arch: 'ia32' }), ['x86-windows', 'win32']);
});

test('the binary chosen is the first one built for this machine, and the choice is said plainly', async () => {
    const files = (entries) => async (name) => entries[name] ?? null;
    const appleSilicon = { platform: 'darwin', arch: 'arm64' };

    // The FMI 2.0 Reference FMUs: no darwin64, the Apple Silicon binary under FMI 3.0's name.
    const fmi2 = await chooseFmuBinary({ fmiVersion: '2.0', modelIdentifier: 'BouncingBall' },
        files({ 'binaries/aarch64-darwin/BouncingBall.dylib': machO(arm64), 'binaries/linux64/BouncingBall.so': elf(62) }), appleSilicon);
    assert.equal(fmi2.relativePath, 'binaries/aarch64-darwin/BouncingBall.dylib');
    assert.equal(describeChosenBinary(fmi2, '2.0'), 'Runs binaries/aarch64-darwin/BouncingBall.dylib (the FMI 3.0 name for this computer\'s binaries).');

    // An Intel-only darwin64 binary is passed over on Apple Silicon for one built for it.
    const intelFirst = await chooseFmuBinary({ fmiVersion: '2.0', modelIdentifier: 'M' },
        files({ 'binaries/darwin64/M.dylib': machO(x8664), 'binaries/aarch64-darwin/M.dylib': machO(arm64) }), appleSilicon);
    assert.equal(intelFirst.relativePath, 'binaries/aarch64-darwin/M.dylib');

    // Konjugate's own FMI 2.0 export on Apple Silicon: an arm64 binary under darwin64, the standard name.
    const own = await chooseFmuBinary({ fmiVersion: '2.0', modelIdentifier: 'M' }, files({ 'binaries/darwin64/M.dylib': universal(x8664, arm64) }), appleSilicon);
    assert.equal(describeChosenBinary(own, '2.0'), 'Runs binaries/darwin64/M.dylib.');

    const fmi3 = await chooseFmuBinary({ fmiVersion: '3.0', modelIdentifier: 'M' },
        files({ 'binaries/x86_64-linux/M.so': elf(62), 'binaries/aarch64-linux/M.so': elf(183) }), { platform: 'linux', arch: 'x64' });
    assert.equal(fmi3.relativePath, 'binaries/x86_64-linux/M.so');

    // The FMI 3.0 Reference FMUs on an Intel Mac: binaries for every other computer, none for x86_64-darwin (nor darwin64).
    const referenceLayout = files({
        'binaries/aarch64-darwin/Stair.dylib': machO(arm64), 'binaries/aarch64-linux/Stair.so': elf(183), 'binaries/x86_64-linux/Stair.so': elf(62),
        'binaries/x86_64-windows/Stair.dll': pe(0x8664), 'binaries/x86-windows/Stair.dll': pe(0x14c)
    });
    const intelMac = await chooseFmuBinary({ fmiVersion: '3.0', modelIdentifier: 'Stair' }, referenceLayout, { platform: 'darwin', arch: 'x64' });
    assert.equal(intelMac.machine, 'x86_64-darwin');
    assert.equal(describeChosenBinary(intelMac, '3.0'), 'This computer cannot run it: it has no binary this computer (x86_64-darwin) can run.');
    assert.equal((await chooseFmuBinary({ fmiVersion: '3.0', modelIdentifier: 'Stair' }, referenceLayout, appleSilicon)).relativePath, 'binaries/aarch64-darwin/Stair.dylib');

    const none = await chooseFmuBinary({ fmiVersion: '2.0', modelIdentifier: 'M' }, files({ 'binaries/darwin64/M.dylib': machO(x8664) }), appleSilicon);
    assert.equal(describeChosenBinary(none, '2.0'),
        'This computer cannot run it: it has no binary this computer (aarch64-darwin) can run (binaries/darwin64/M.dylib is built for x86_64).');
});
