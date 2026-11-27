/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Merge platform FMUs for two processors of one system (FMI review #7), with stand-in binaries carrying real Mach-O and ELF headers. FMI
// 2.0 names a binary's folder by system and bitness only (darwin64, linux64, win64), so an export for Apple Silicon and one for Intel both
// write darwin64, and an ARM Linux export wrote linux64, the x86-64 name. Merged, the two macOS binaries are one universal binary under
// darwin64 (as Apple's own tools make one, which every host loads), and an ARM binary elsewhere goes under its FMI 3.0 platform tuple
// (aarch64-linux), where Konjugate's importer and the FMI Reference FMUs look; an export on ARM Linux or Windows writes it there.

import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { mergeFmuPackages, platformDirectory } from '../src/fmiExport.mjs';
import { binaryArchitectures } from '../src/fmiBinary.mjs';

const encoder = new TextEncoder();
// A thin Mach-O: its magic, CPU type and subtype, then a body that tells the stand-ins apart.
const machO = (cpuType, cpuSubtype, body) => {
    const bytes = new Uint8Array(64 + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xfeedfacf, true);
    view.setUint32(4, cpuType, true);
    view.setUint32(8, cpuSubtype, true);
    bytes.set(encoder.encode(body), 64);
    return bytes;
};
const elf = (machine, body) => {
    const bytes = new Uint8Array(64 + body.length);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    new DataView(bytes.buffer).setUint16(18, machine, true);
    bytes.set(encoder.encode(body), 64);
    return bytes;
};
const arm64Mac = machO(0x0100000c, 0, 'built on an Apple Silicon Mac');
const intelMac = machO(0x01000007, 3, 'built on an Intel Mac');
const x86Linux = elf(62, 'built on x86-64 Linux');
const armLinux = elf(183, 'built on ARM Linux');
const fmu = (binaries) => zipSync({
    'modelDescription.xml': encoder.encode('<?xml version="1.0"?><fmiModelDescription fmiVersion="2.0" modelName="M" guid="{same-model}"><CoSimulation modelIdentifier="M"/></fmiModelDescription>'),
    ...Object.fromEntries(Object.entries(binaries).map(([path, bytes]) => [`binaries/${path}`, bytes]))
});
const merge = (...archives) => unzipSync(new Uint8Array(mergeFmuPackages(archives.map((data, index) => ({ name: `export${index}.fmu`, data })))));

// The slices of a universal Mach-O, by processor.
function slices(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(0, false), 0xcafebabe, 'A universal Mach-O.');
    const found = {};
    for (let index = 0; index < view.getUint32(4, false); index += 1) {
        const entry = 8 + index * 20;
        const [offset, size, align] = [view.getUint32(entry + 8, false), view.getUint32(entry + 12, false), view.getUint32(entry + 16, false)];
        assert.equal(offset % 2 ** align, 0, 'Each slice is aligned as its entry says.');
        found[binaryArchitectures(bytes.subarray(offset, offset + size))[0]] = bytes.subarray(offset, offset + size);
    }
    return found;
}

test('two macOS exports for different processors merge into one universal binary under darwin64', () => {
    const merged = merge(fmu({ 'darwin64/M.dylib': arm64Mac }), fmu({ 'darwin64/M.dylib': intelMac }));
    assert.deepEqual(Object.keys(merged).filter((path) => path.startsWith('binaries/')), ['binaries/darwin64/M.dylib']);
    const binary = merged['binaries/darwin64/M.dylib'];
    assert.deepEqual(binaryArchitectures(binary).sort(), ['aarch64', 'x86_64']);
    const parts = slices(binary);
    assert.deepEqual([...parts.aarch64], [...arm64Mac], 'The Apple Silicon slice is the export\'s binary, byte for byte.');
    assert.deepEqual([...parts.x86_64], [...intelMac], 'The Intel slice too.');
    // Merged again with one of them, it is the same file.
    const again = merge(fmu({ 'darwin64/M.dylib': binary }), fmu({ 'darwin64/M.dylib': intelMac }));
    assert.deepEqual([...again['binaries/darwin64/M.dylib']], [...binary]);
});

test('an ARM Linux binary filed under linux64 goes under aarch64-linux, beside the x86-64 one', () => {
    const merged = merge(fmu({ 'linux64/M.so': x86Linux }), fmu({ 'linux64/M.so': armLinux }));
    assert.deepEqual([...merged['binaries/linux64/M.so']], [...x86Linux]);
    assert.deepEqual([...merged['binaries/aarch64-linux/M.so']], [...armLinux]);
});

test('the same processor with different bytes is still not the same export', () => {
    assert.throws(() => merge(fmu({ 'darwin64/M.dylib': arm64Mac }), fmu({ 'darwin64/M.dylib': machO(0x0100000c, 0, 'another build') })),
        /both contain 'binaries\/darwin64\/M.dylib' built for aarch64 with different contents/);
});

test('an FMI 2.0 export on ARM Linux or Windows files its binary under its platform tuple; on a Mac, under darwin64', () => {
    assert.equal(platformDirectory('2.0', { platform: 'linux', arch: 'arm64' }), 'aarch64-linux');
    assert.equal(platformDirectory('2.0', { platform: 'win32', arch: 'arm64' }), 'aarch64-windows');
    assert.equal(platformDirectory('2.0', { platform: 'linux', arch: 'x64' }), 'linux64');
    assert.equal(platformDirectory('2.0', { platform: 'win32', arch: 'x64' }), 'win64');
    assert.equal(platformDirectory('2.0', { platform: 'darwin', arch: 'arm64' }), 'darwin64');
    assert.equal(platformDirectory('2.0', { platform: 'darwin', arch: 'x64' }), 'darwin64');
});
