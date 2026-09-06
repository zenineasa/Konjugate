/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Installs, lists and uninstalls imported FMUs -- the FMI-import counterpart to
// src/packageArchive.mjs's addon/plugin handling, but deliberately NOT built on top of that
// module: a real .fmu is a standards-defined zip (modelDescription.xml + binaries/<platform>/...)
// with no package.json/manifest wrapper, so forcing it through inspectPackageArchive's
// addon/plugin-shaped validation would corrupt the standard container format rather than embrace
// it. This reuses the same zip-safety posture (path-traversal guards, size limits) conceptually,
// not packageArchive.mjs's manifest-format assumptions. See docs/projectSchema.md's "kind: fmi"
// paragraph and docs/codeExport.md for the mirror-image export side.

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { parseModelDescription } from './fmiModelDescription.mjs';

export class FmuPackageError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'FmuPackageError';
        this.code = code;
    }
}

const maximumArchiveBytes = 64 * 1024 * 1024;
const maximumFileCount = 5000;
const maximumFileBytes = 64 * 1024 * 1024;
const maximumExpandedBytes = 256 * 1024 * 1024;
// Deliberately conservative rather than transforming an unusual guid into something safe: a real
// FMU's guid is typically a GUID literal or a hex checksum, both of which fit this easily, and
// rejecting anything else with a clear error is safer than silently reshaping an identifier that
// is supposed to be exact.
const guidPattern = /^[A-Za-z0-9._{}-]{1,200}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function safeArchivePath(name) {
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')) {
        throw new FmuPackageError(`Unsafe FMU entry path: ${name || '<empty>'}.`, 'UNSAFE_PATH');
    }
    const segments = name.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
        throw new FmuPackageError(`Unsafe FMU entry path: ${name}.`, 'UNSAFE_PATH');
    }
    return name;
}

function safeInstallPath(root, guid, version) {
    const target = resolve(root, 'fmus', guid, version);
    const expectedPrefix = `${resolve(root, 'fmus')}${sep}`;
    if (!target.startsWith(expectedPrefix)) throw new FmuPackageError('The FMU install path is unsafe.', 'UNSAFE_PATH');
    return target;
}

// Unzips and validates an .fmu's structure without installing it -- used both by install and by
// a "preview before installing" step the UI can call.
export function inspectFmuArchive(archive) {
    if (!Buffer.isBuffer(archive) && !(archive instanceof Uint8Array)) {
        throw new FmuPackageError('The FMU file must be binary data.', 'INVALID_ARCHIVE');
    }
    if (archive.length === 0 || archive.length > maximumArchiveBytes) {
        throw new FmuPackageError('The FMU file size is not allowed.', 'ARCHIVE_LIMIT');
    }
    let files;
    try {
        files = unzipSync(archive, {
            filter(file) {
                safeArchivePath(file.name);
                if (file.name.endsWith('/')) return false;
                if (file.originalSize > maximumFileBytes) throw new FmuPackageError('A file inside the FMU exceeds the per-file size limit.', 'ARCHIVE_LIMIT');
                return true;
            }
        });
    } catch (error) {
        if (error instanceof FmuPackageError) throw error;
        throw new FmuPackageError(`The FMU is not a valid zip archive: ${error.message}`, 'INVALID_ARCHIVE');
    }
    const names = Object.keys(files);
    if (names.length === 0 || names.length > maximumFileCount) throw new FmuPackageError('The FMU file count is not allowed.', 'ARCHIVE_LIMIT');
    const expandedBytes = names.reduce((total, name) => total + files[name].length, 0);
    if (expandedBytes > maximumExpandedBytes) throw new FmuPackageError('The expanded FMU size is not allowed.', 'ARCHIVE_LIMIT');

    if (!files['modelDescription.xml']) {
        throw new FmuPackageError("The file has no modelDescription.xml -- it doesn't look like an FMU.", 'NOT_AN_FMU');
    }
    const description = parseModelDescription(strFromU8(files['modelDescription.xml']));
    if (!guidPattern.test(description.guid)) {
        throw new FmuPackageError(`This FMU's guid ('${description.guid}') is not in a form Konjugate can use as an identifier.`, 'FMU_IDENTITY_UNSAFE');
    }
    const platforms = [...new Set(
        names.filter((name) => name.startsWith('binaries/')).map((name) => name.split('/')[1]).filter(Boolean)
    )];
    if (!platforms.length) throw new FmuPackageError('The FMU has no binaries/<platform>/ directory -- there is nothing to load.', 'NOT_AN_FMU');

    return { description, files, platforms };
}

// archive is the .fmu's raw bytes. displayName/version are supplied by the user at import time
// (FMI itself has no package-version concept, unlike a plugin.json's own declared version) --
// version defaults to "1.0.0" when not given. Returns
// { description, platforms, guid, version, displayName, installPath }.
export async function installFmuArchive(archive, { directory, displayName, version, sourceFileName, overwrite = false } = {}) {
    if (!directory) throw new FmuPackageError('An FMU installation directory is required.', 'INVALID_DESTINATION');
    const inspected = inspectFmuArchive(archive);
    const { description, files, platforms } = inspected;
    const guid = description.guid;
    const fmuVersion = version && versionPattern.test(version) ? version : '1.0.0';
    const target = safeInstallPath(directory, guid, fmuVersion);

    if (!overwrite) {
        try {
            await readFile(join(target, 'fmuMeta.json'));
            throw new FmuPackageError('That FMU version is already installed.', 'ALREADY_INSTALLED');
        } catch (error) {
            if (error instanceof FmuPackageError) throw error;
            if (error.code !== 'ENOENT') throw error;
        }
    }

    const meta = {
        guid, version: fmuVersion,
        displayName: displayName || description.modelName || guid,
        fmiVersion: description.fmiVersion,
        modelName: description.modelName,
        modelIdentifier: description.modelIdentifier,
        sourceFileName: sourceFileName || null,
        importedAt: new Date().toISOString()
    };

    const temporary = `${target}.${randomUUID()}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    try {
        await mkdir(temporary, { recursive: true });
        for (const [name, bytes] of Object.entries(files)) {
            const output = resolve(temporary, name);
            if (!output.startsWith(`${temporary}${sep}`)) throw new FmuPackageError('An FMU entry path is unsafe.', 'UNSAFE_PATH');
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, bytes);
        }
        await writeFile(resolve(temporary, 'fmuMeta.json'), JSON.stringify(meta, null, 2));
        await mkdir(dirname(target), { recursive: true });
        if (overwrite) await rm(target, { recursive: true, force: true });
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (error instanceof FmuPackageError) throw error;
        throw new FmuPackageError(`The FMU could not be installed: ${error.message}`, 'INSTALL_FAILED');
    }

    return { description, platforms, guid, version: fmuVersion, displayName: meta.displayName, installPath: target };
}

export async function listInstalledFmus(directory) {
    const results = [];
    const fmusRoot = resolve(directory, 'fmus');
    const guidEntries = await readdir(fmusRoot, { withFileTypes: true }).catch(() => []);
    for (const guidEntry of guidEntries) {
        if (!guidEntry.isDirectory()) continue;
        const versionEntries = await readdir(join(fmusRoot, guidEntry.name), { withFileTypes: true }).catch(() => []);
        for (const versionEntry of versionEntries) {
            if (!versionEntry.isDirectory()) continue;
            const installPath = join(fmusRoot, guidEntry.name, versionEntry.name);
            try {
                const meta = JSON.parse(await readFile(join(installPath, 'fmuMeta.json'), 'utf8'));
                results.push({ packageType: 'fmu', packageId: meta.guid, name: meta.displayName, version: meta.version, source: 'installed', permissions: [], manifest: meta, installPath });
            } catch (error) {
                console.warn(`Skipping installed FMU ${guidEntry.name}/${versionEntry.name}: ${error.message}`);
            }
        }
    }
    return results;
}

export async function uninstallFmu({ directory, guid, version }) {
    const target = safeInstallPath(directory, guid, version);
    try {
        await readFile(join(target, 'fmuMeta.json'));
    } catch (error) {
        if (error.code === 'ENOENT') throw new FmuPackageError('That FMU version is not installed.', 'NOT_INSTALLED');
        throw error;
    }
    await rm(target, { recursive: true, force: true });
}
