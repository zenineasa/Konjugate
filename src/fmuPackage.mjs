/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Installs, lists and uninstalls imported FMUs -- the FMI-import counterpart to
// src/packageArchive.mjs's addon/plugin handling, but deliberately NOT built on top of that
// module: a real .fmu is a standards-defined zip (modelDescription.xml + binaries/<platform>/...)
// with no package.json/manifest wrapper, so forcing it through inspectPackageArchive's
// addon/plugin-shaped validation would corrupt the standard container format rather than embrace
// it. This reuses the same zip-safety posture (path-traversal guards, size limits) conceptually,
// not packageArchive.mjs's manifest-format assumptions. See docs/projectSchema.md's "kind: fmi"
// paragraph and docs/codeExport.md for the mirror-image export side.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { parseModelDescription } from './fmiModelDescription.mjs';
import { fmuBuildInformation } from './fmuBuildInformation.mjs';
import { removeBuilds } from './fmuBuilds.mjs';

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
    // Each entry says its unpacked size before it is unpacked, so the limits hold as the entries come, before any over them is inflated.
    let declaredFiles = 0;
    let declaredBytes = 0;
    try {
        files = unzipSync(archive, {
            filter(file) {
                safeArchivePath(file.name);
                if (file.name.endsWith('/')) return false;
                if (file.originalSize > maximumFileBytes) throw new FmuPackageError('A file inside the FMU exceeds the per-file size limit.', 'ARCHIVE_LIMIT');
                declaredFiles += 1;
                declaredBytes += file.originalSize;
                if (declaredFiles > maximumFileCount) throw new FmuPackageError('The FMU file count is not allowed.', 'ARCHIVE_LIMIT');
                if (declaredBytes > maximumExpandedBytes) throw new FmuPackageError('The expanded FMU size is not allowed.', 'ARCHIVE_LIMIT');
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
    // What it says about building it from its sources (docs/proposals/sourceFmuImport.md): an FMU with no binaries at all is accepted
    // when it carries build information, and refused, as before, when it carries neither.
    const buildDescription = files['sources/buildDescription.xml'];
    const cmakeLists = files['sources/CMakeLists.txt'];
    const build = fmuBuildInformation({ description, names, buildDescriptionXml: buildDescription ? strFromU8(buildDescription) : null, cmakeListsText: cmakeLists ? strFromU8(cmakeLists) : null });
    if (!platforms.length && !build) throw new FmuPackageError('The FMU has no binaries/<platform>/ directory -- there is nothing to load.', 'NOT_AN_FMU');

    return { description, files, platforms, build };
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
        // The archive as it was installed, kept beside it (archive.fmu), and its SHA-256: what a project keeps of the FMU and refers
        // to it by (docs/proposals/fmuImportWorkflow.md, stage 8).
        archiveSha256: sha256Hex(archive), archiveBytes: archive.length,
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
        await writeFile(resolve(temporary, archiveFileName), archive);
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

const archiveFileName = 'archive.fmu';

export function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

// The installed FMU's archive, for a project to keep: the one it was installed from, or, for an FMU installed before archives were
// kept, its files zipped again in a fixed order with a fixed time (so the same files always give the same bytes and SHA-256), then
// kept beside it from then on. Returns { buffer, sha256, name } -- name what the archive is called in a project -- or null when the
// FMU is not installed.
export async function installedFmuArchive(directory, guid, version) {
    const target = safeInstallPath(directory, guid, version);
    let meta;
    try {
        meta = JSON.parse(await readFile(join(target, 'fmuMeta.json'), 'utf8'));
    } catch {
        return null;
    }
    const name = `${meta.modelName || meta.displayName || 'model'}.fmu`;
    const kept = await readFile(join(target, archiveFileName)).catch(() => null);
    if (kept) return { buffer: kept, sha256: meta.archiveSha256 ?? sha256Hex(kept), name };
    const files = {};
    const walk = async (folder, prefix) => {
        for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = `${prefix}${entry.name}`;
            if (entry.isDirectory()) await walk(join(folder, entry.name), `${path}/`);
            else if (path !== 'fmuMeta.json' && path !== archiveFileName) files[path] = [new Uint8Array(await readFile(join(folder, entry.name))), { mtime: new Date(Date.UTC(1980, 0, 1)) }];
        }
    };
    await walk(target, '');
    const buffer = Buffer.from(zipSync(files, { level: 6 }));
    const sha256 = sha256Hex(buffer);
    await writeFile(join(target, archiveFileName), buffer);
    await writeFile(join(target, 'fmuMeta.json'), JSON.stringify({ ...meta, archiveSha256: sha256, archiveBytes: buffer.length }, null, 2));
    return { buffer, sha256, name };
}

// A project's attachments made ready to run (src/projectFile.mjs): each FMU it keeps installed when this computer does not have it,
// by its SHA-256. content is the project's document as text; each FMU node refers to its archive by implementation.fmuSha256. An FMU
// whose id and version are installed with other contents is installed beside it, under the version with the hash's start after it,
// and the nodes refer to that. Returns { content, installed: [names] } -- content changed only for such nodes.
export async function installProjectAttachments(directory, content, attachments) {
    const fmus = (attachments ?? []).filter((attachment) => attachment.kind === 'fmu');
    if (!fmus.length) return { content, installed: [] };
    const document = JSON.parse(content);
    const nodes = (document.nodes ?? []).filter((node) => node.implementation?.kind === 'fmi' && node.implementation.fmuSha256);
    const installedList = await listInstalledFmus(directory);
    const installed = [];
    let changed = false;
    for (const attachment of fmus) {
        const users = nodes.filter((node) => node.implementation.fmuSha256 === attachment.sha256);
        if (!users.length) continue;
        const { fmuId, fmuVersion } = users[0].implementation;
        const same = installedList.find((entry) => entry.packageId === fmuId && entry.manifest?.archiveSha256 === attachment.sha256);
        if (same) {
            if (same.version !== fmuVersion) { users.forEach((node) => { node.implementation.fmuVersion = same.version; }); changed = true; }
            continue;
        }
        const taken = installedList.some((entry) => entry.packageId === fmuId && entry.version === fmuVersion);
        const version = taken ? `${fmuVersion}+${attachment.sha256.slice(0, 8)}` : fmuVersion;
        const result = await installFmuArchive(attachment.buffer, { directory, version, sourceFileName: attachment.name, overwrite: taken && installedList.some((entry) => entry.packageId === fmuId && entry.version === version) });
        if (result.guid !== fmuId) throw new FmuPackageError(`The project's FMU ${attachment.name} is not the FMU its node names.`, 'FMU_ATTACHMENT_MISMATCH');
        if (version !== fmuVersion) { users.forEach((node) => { node.implementation.fmuVersion = version; }); changed = true; }
        installedList.push({ packageId: fmuId, version, manifest: { archiveSha256: attachment.sha256 } });
        installed.push(result.displayName);
    }
    return { content: changed ? JSON.stringify(document) : content, installed };
}

export async function listInstalledFmus(directory) {
    const results = [];
    const fmusRoot = resolve(directory, 'fmus');
    const guidEntries = await readdir(fmusRoot, { withFileTypes: true }).catch(() => []);
    for (const guidEntry of guidEntries) {
        if (!guidEntry.isDirectory()) continue;
        const versionEntries = await readdir(join(fmusRoot, guidEntry.name), { withFileTypes: true }).catch(() => []);
        for (const versionEntry of versionEntries) {
            // An install still being written (installFmuArchive's temporary folder) is not an FMU yet.
            if (!versionEntry.isDirectory() || versionEntry.name.endsWith('.tmp')) continue;
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

// Add FMU and Replace FMU (FMI review #1): the library's copy of `archive` when it is the same archive (by SHA-256), else the archive
// installed, beside any copy with the same ID under the next free version, since a newer build that kept its ID is another FMU and
// must not run the old binary. `{ guid, version, displayName, reused, besideVersion }`, `besideVersion` the version of a copy with the
// same ID it was installed beside (to say so), or null.
export async function installOrReuseFmu(directory, archive, { sourceFileName = null } = {}) {
    const { description } = inspectFmuArchive(archive);
    const sha256 = sha256Hex(archive);
    const sameId = (await listInstalledFmus(directory)).filter((entry) => entry.packageId === description.guid);
    for (const entry of sameId) {
        const kept = entry.manifest?.archiveSha256 ?? (await installedFmuArchive(directory, entry.packageId, entry.version).catch(() => null))?.sha256;
        if (kept === sha256) return { guid: entry.packageId, version: entry.version, displayName: entry.name, reused: true, besideVersion: null };
    }
    const taken = new Set(sameId.map((entry) => entry.version));
    let version = '1.0.0';
    for (let patch = 1; taken.has(version); patch += 1) version = `1.0.${patch}`;
    const installed = await installFmuArchive(archive, { directory, version, sourceFileName });
    const besideVersion = sameId.length ? [...sameId].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0].version : null;
    return { guid: installed.guid, version: installed.version, displayName: installed.displayName, reused: false, besideVersion };
}

export async function uninstallFmu({ directory, guid, version }) {
    const target = safeInstallPath(directory, guid, version);
    let meta;
    try {
        meta = JSON.parse(await readFile(join(target, 'fmuMeta.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') throw new FmuPackageError('That FMU version is not installed.', 'NOT_INSTALLED');
        throw error;
    }
    await rm(target, { recursive: true, force: true });
    // Its builds from sources go with it (docs/proposals/sourceFmuImport.md), unless the same archive is still installed under another
    // version.
    if (meta?.archiveSha256 && !(await listInstalledFmus(directory)).some((entry) => entry.manifest?.archiveSha256 === meta.archiveSha256)) {
        await removeBuilds(directory, meta.archiveSha256);
    }
}
