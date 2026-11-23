/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Which of an FMU's binaries this machine runs. FMI 2.0 names a binary's directory by operating system and bitness
// (binaries/darwin64, linux64, win64, win32); FMI 3.0 by a platform tuple, architecture then operating system
// (binaries/aarch64-darwin, x86_64-darwin, x86_64-linux, aarch64-linux, x86_64-windows, x86-windows). The FMI 2.0
// names do not say the architecture, and "darwin64" was written before Apple Silicon: some FMI 2.0 FMUs (the FMI
// Reference FMUs among them) ship their Apple Silicon binary under the FMI 3.0 name aarch64-darwin, and a darwin64
// binary may be built for either Intel or Apple Silicon. So each FMU is looked for under its own standard's name
// first and then under the other standard's, and a binary is taken only when its own header (Mach-O, ELF or PE) says
// it is built for this machine's processor -- the binary itself is the only thing that knows.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// process.arch in FMI 3.0's architecture names.
export function fmiArchitecture(arch = process.arch) {
    if (arch === 'arm64') return 'aarch64';
    if (arch === 'x64') return 'x86_64';
    if (arch === 'ia32' || arch === 'x86') return 'x86';
    return arch;
}

function operatingSystems(platform) {
    if (platform === 'win32') return { tuple: 'windows', legacy: 'win', extension: '.dll' };
    if (platform === 'darwin') return { tuple: 'darwin', legacy: 'darwin', extension: '.dylib' };
    return { tuple: 'linux', legacy: 'linux', extension: '.so' };
}

// The binaries/ directories an FMU's binary for this machine may be in, in the order they are tried: the FMU's own
// standard's name first.
export function binaryDirectoryCandidates(fmiVersion, { platform = process.platform, arch = process.arch } = {}) {
    const architecture = fmiArchitecture(arch);
    const system = operatingSystems(platform);
    const tuple = `${architecture}-${system.tuple}`;
    const legacy = `${system.legacy}${architecture === 'x86' || architecture === 'arm' ? '32' : '64'}`;
    return String(fmiVersion).startsWith('3.') ? [tuple, legacy] : [legacy, tuple];
}

const machOCpuTypes = new Map([[0x01000007, 'x86_64'], [0x0100000c, 'aarch64'], [7, 'x86'], [12, 'arm']]);
const elfMachines = new Map([[62, 'x86_64'], [183, 'aarch64'], [3, 'x86'], [40, 'arm']]);
const peMachines = new Map([[0x8664, 'x86_64'], [0xaa64, 'aarch64'], [0x14c, 'x86'], [0x1c4, 'arm']]);

// The processor architectures a shared library is built for, from its own header: one for a plain Mach-O, ELF or PE
// file, several for a macOS universal binary. Null when the header is not one of these (the binary is then tried
// anyway, and the operating system says whether it loads).
export function binaryArchitectures(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 8) return null;
    const magicBig = view.getUint32(0, false);
    if (magicBig === 0xcffaedfe || magicBig === 0xcefaedfe) {
        const name = machOCpuTypes.get(view.getUint32(4, true));
        return name ? [name] : null;
    }
    if (magicBig === 0xcafebabe || magicBig === 0xcafebabf) {
        const count = view.getUint32(4, false);
        const entrySize = magicBig === 0xcafebabe ? 20 : 32;
        if (count === 0 || count > 32 || 8 + count * entrySize > bytes.length) return null;
        const names = [];
        for (let index = 0; index < count; index += 1) {
            const name = machOCpuTypes.get(view.getUint32(8 + index * entrySize, false));
            if (name) names.push(name);
        }
        return names.length ? names : null;
    }
    if (magicBig === 0x7f454c46 && bytes.length >= 20) {
        const littleEndian = bytes[5] !== 2;
        const name = elfMachines.get(view.getUint16(18, littleEndian));
        return name ? [name] : null;
    }
    if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 0x40) {
        const peOffset = view.getUint32(0x3c, true);
        if (peOffset + 6 > bytes.length || view.getUint32(peOffset, false) !== 0x50450000) return null;
        const name = peMachines.get(view.getUint16(peOffset + 4, true));
        return name ? [name] : null;
    }
    return null;
}

// The binary this machine runs from an installed or inspected FMU. readBinary(relativePath) returns its bytes, or
// null when the FMU has no such file. Returns { directory, relativePath, bytes, architectures, standardName } --
// standardName false when the binary was found under the other FMI version's directory name -- or
// { error, found } naming what the FMU has instead.
export async function chooseFmuBinary(description, readBinary, { platform = process.platform, arch = process.arch } = {}) {
    const system = operatingSystems(platform);
    const wanted = fmiArchitecture(arch);
    const candidates = binaryDirectoryCandidates(description.fmiVersion, { platform, arch });
    const refused = [];
    for (const [index, directory] of candidates.entries()) {
        const relativePath = `binaries/${directory}/${description.modelIdentifier}${system.extension}`;
        const bytes = await readBinary(relativePath);
        if (!bytes) continue;
        const architectures = binaryArchitectures(bytes);
        if (architectures && !architectures.includes(wanted)) {
            refused.push(`${relativePath} is built for ${architectures.join(' and ')}`);
            continue;
        }
        return { directory, relativePath, bytes, architectures, standardName: index === 0 };
    }
    const machine = `${wanted}-${system.tuple}`;
    const detail = refused.length ? ` (${refused.join('; ')})` : '';
    return { error: `it has no binary this computer (${machine}) can run${detail}`, machine };
}

// chooseFmuBinary over an FMU installed at fmuRoot.
export function chooseInstalledFmuBinary(fmuRoot, description, options) {
    return chooseFmuBinary(description, async (relativePath) => {
        try {
            return await readFile(resolve(fmuRoot, ...relativePath.split('/')));
        } catch {
            return null;
        }
    }, options);
}

// A plain sentence saying which binary is used, for the install dialog and the node editor.
export function describeChosenBinary(chosen, fmiVersion) {
    if (chosen.error) return `This computer cannot run it: ${chosen.error}.`;
    const note = chosen.standardName ? '' : ` (the FMI ${String(fmiVersion).startsWith('3.') ? '2.0' : '3.0'} name for this computer's binaries)`;
    return `Runs ${chosen.relativePath}${note}.`;
}
