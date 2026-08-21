/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { validateAddonManifest } from './addonHost.mjs';

export const packageArchiveFormat = 'konjugate-package';
export const packageArchiveVersion = 1;
export const packageExtensions = Object.freeze({ addon: '.kja', plugin: '.kjp' });

// Shared identity key for a specific installed/bundled package version, used by the extension
// state store, main.mjs's discovery/IPC handlers and pluginResolver.mjs's disabled-plugin check
// so all three can't drift out of format.
export function packageKey(packageType, packageId, version) {
    return `${packageType}:${packageId}:${version}`;
}
const packageIdPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const maximumArchiveBytes = 64 * 1024 * 1024;
const maximumFileCount = 5000;
const maximumFileBytes = 64 * 1024 * 1024;
const maximumExpandedBytes = 256 * 1024 * 1024;

export class PackageArchiveError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'PackageArchiveError';
        this.code = code;
    }
}

function packageManifestPath(packageType) {
    return packageType === 'addon' ? 'addon.json' : 'plugin.json';
}

function validatePackageManifest(manifest, expectedType = null) {
    if (!manifest || manifest.format !== packageArchiveFormat || manifest.formatVersion !== packageArchiveVersion) {
        throw new PackageArchiveError('The package manifest format is unsupported.', 'INVALID_MANIFEST');
    }
    if (!['addon', 'plugin'].includes(manifest.packageType) || (expectedType && manifest.packageType !== expectedType)) {
        throw new PackageArchiveError('The package type does not match the package file.', 'PACKAGE_TYPE_MISMATCH');
    }
    if (!packageIdPattern.test(manifest.packageId ?? '') || !manifest.name || !versionPattern.test(manifest.version ?? '')) {
        throw new PackageArchiveError('The package manifest is incomplete.', 'INVALID_MANIFEST');
    }
    if (manifest.contents?.manifest !== packageManifestPath(manifest.packageType)) {
        throw new PackageArchiveError('The package manifest points to an invalid contribution manifest.', 'INVALID_MANIFEST');
    }
    return structuredClone(manifest);
}

function safeArchivePath(name) {
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')) {
        throw new PackageArchiveError(`Unsafe package entry path: ${name || '<empty>'}.`, 'UNSAFE_PATH');
    }
    const segments = name.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
        throw new PackageArchiveError(`Unsafe package entry path: ${name}.`, 'UNSAFE_PATH');
    }
    return name;
}

function safeInstallPath(root, packageType, packageId, version) {
    const target = resolve(root, `${packageType}s`, packageId, version);
    const expectedPrefix = `${resolve(root, `${packageType}s`)}${sep}`;
    if (!target.startsWith(expectedPrefix)) throw new PackageArchiveError('The package install path is unsafe.', 'UNSAFE_PATH');
    return target;
}

function decodeJson(files, path, code) {
    const bytes = files[path];
    if (!bytes) throw new PackageArchiveError(`The package is missing ${path}.`, code);
    try {
        return JSON.parse(strFromU8(bytes));
    } catch {
        throw new PackageArchiveError(`${path} is not valid JSON.`, code);
    }
}

function inspectEntries(archive) {
    if (!Buffer.isBuffer(archive) && !(archive instanceof Uint8Array)) {
        throw new PackageArchiveError('The package archive must be binary data.', 'INVALID_ARCHIVE');
    }
    if (archive.length === 0 || archive.length > maximumArchiveBytes) {
        throw new PackageArchiveError('The package archive size is not allowed.', 'ARCHIVE_LIMIT');
    }
    let files;
    try {
        files = unzipSync(archive, {
            filter(file) {
                safeArchivePath(file.name);
                if (file.name.endsWith('/')) return false;
                if (file.originalSize > maximumFileBytes) throw new PackageArchiveError('A package file exceeds the per-file size limit.', 'ARCHIVE_LIMIT');
                return true;
            }
        });
    } catch (error) {
        if (error instanceof PackageArchiveError) throw error;
        throw new PackageArchiveError(`The package archive is invalid: ${error.message}`, 'INVALID_ARCHIVE');
    }
    const names = Object.keys(files);
    if (names.length === 0 || names.length > maximumFileCount) throw new PackageArchiveError('The package file count is not allowed.', 'ARCHIVE_LIMIT');
    const expandedBytes = names.reduce((total, name) => total + files[name].length, 0);
    if (expandedBytes > maximumExpandedBytes) throw new PackageArchiveError('The expanded package size is not allowed.', 'ARCHIVE_LIMIT');
    return files;
}

export function inspectPackageArchive(archive, { extension = null } = {}) {
    const files = inspectEntries(archive);
    const packageManifest = validatePackageManifest(decodeJson(files, 'package.json', 'INVALID_MANIFEST'), extension === '.kja' ? 'addon' : extension === '.kjp' ? 'plugin' : null);
    const contributionPath = packageManifest.contents.manifest;
    const contributionManifest = decodeJson(files, contributionPath, 'MISSING_MANIFEST');
    if (packageManifest.packageType === 'addon') {
        try {
            validateAddonManifest(contributionManifest);
        } catch (error) {
            throw new PackageArchiveError(`The add-on manifest is invalid: ${error.message}`, 'INVALID_MANIFEST');
        }
        if (contributionManifest.addonId !== packageManifest.packageId) {
            throw new PackageArchiveError('The package and add-on IDs do not match.', 'MANIFEST_MISMATCH');
        }
    } else {
        if (contributionManifest.pluginId !== packageManifest.packageId || contributionManifest.apiVersion !== 1 || !Array.isArray(contributionManifest.contributes) || !contributionManifest.contributes.length) {
            throw new PackageArchiveError('The plugin manifest is invalid or does not match the package.', 'INVALID_MANIFEST');
        }
        for (const contribution of contributionManifest.contributes) {
            if (contribution.kind === 'component') {
                if (!contribution.componentId || contribution.apiVersion !== 1) throw new PackageArchiveError('The plugin contains an invalid component contribution.', 'INVALID_MANIFEST');
            } else {
                if (!contribution.providerId || contribution.apiVersion !== 1 || !['cpp', 'python'].includes(contribution.runtime)) {
                    throw new PackageArchiveError('The plugin contains an unsupported provider contribution.', 'INVALID_MANIFEST');
                }
            }
            safeArchivePath(contribution.entry);
            if (!files[contribution.entry]) throw new PackageArchiveError(`The plugin contribution entry is missing: ${contribution.entry}.`, 'MISSING_ENTRY');
        }
    }
    return { packageManifest, contributionManifest, files };
}

export async function installPackageArchive(archive, { extension, directory, overwrite = false } = {}) {
    if (!directory) throw new PackageArchiveError('A package installation directory is required.', 'INVALID_DESTINATION');
    const inspected = inspectPackageArchive(archive, { extension });
    const { packageManifest, files } = inspected;
    const target = safeInstallPath(directory, packageManifest.packageType, packageManifest.packageId, packageManifest.version);
    if (!overwrite) {
        try {
            await readFile(join(target, 'package.json'));
            throw new PackageArchiveError('That package version is already installed.', 'ALREADY_INSTALLED');
        } catch (error) {
            if (error instanceof PackageArchiveError) throw error;
            if (error.code !== 'ENOENT') throw error;
        }
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    try {
        await mkdir(temporary, { recursive: true });
        for (const [name, bytes] of Object.entries(files)) {
            const output = resolve(temporary, name);
            if (!output.startsWith(`${temporary}${sep}`)) throw new PackageArchiveError('The package entry path is unsafe.', 'UNSAFE_PATH');
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, bytes);
        }
        await mkdir(dirname(target), { recursive: true });
        if (overwrite) await rm(target, { recursive: true, force: true });
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (error instanceof PackageArchiveError) throw error;
        throw new PackageArchiveError(`The package could not be installed: ${error.message}`, 'INSTALL_FAILED');
    }
    return { ...inspected, installPath: target };
}

export async function listInstalledPackages(directory) {
    const results = [];
    for (const packageType of ['addon', 'plugin']) {
        const typeRoot = resolve(directory, `${packageType}s`);
        const packageIds = await readdir(typeRoot, { withFileTypes: true }).catch(() => []);
        for (const idEntry of packageIds) {
            if (!idEntry.isDirectory()) continue;
            const versions = await readdir(join(typeRoot, idEntry.name), { withFileTypes: true }).catch(() => []);
            for (const versionEntry of versions) {
                if (!versionEntry.isDirectory()) continue;
                const installPath = join(typeRoot, idEntry.name, versionEntry.name);
                try {
                    const packageManifest = validatePackageManifest(
                        JSON.parse(await readFile(join(installPath, 'package.json'), 'utf8'))
                    );
                    const contributionManifest = JSON.parse(
                        await readFile(join(installPath, packageManifest.contents.manifest), 'utf8')
                    );
                    results.push({
                        packageType, packageId: packageManifest.packageId, name: packageManifest.name,
                        version: packageManifest.version, source: 'installed',
                        permissions: contributionManifest.permissions ?? [],
                        manifest: contributionManifest, installPath
                    });
                } catch (error) {
                    console.warn(`Skipping installed package ${idEntry.name}/${versionEntry.name}: ${error.message}`);
                }
            }
        }
    }
    return results;
}

export async function uninstallPackage({ directory, packageType, packageId, version }) {
    const target = safeInstallPath(directory, packageType, packageId, version);
    try {
        await readFile(join(target, 'package.json'));
    } catch (error) {
        if (error.code === 'ENOENT') throw new PackageArchiveError('That package version is not installed.', 'NOT_INSTALLED');
        throw error;
    }
    await rm(target, { recursive: true, force: true });
}

export function createPackageArchive({ packageManifest, contributionManifest, files = {} }) {
    const validated = validatePackageManifest(packageManifest);
    const contributionPath = validated.contents.manifest;
    for (const name of Object.keys(files)) {
        const safeName = safeArchivePath(name);
        if (safeName === 'package.json' || safeName === contributionPath) {
            throw new PackageArchiveError(`The package entry ${safeName} is reserved.`, 'DUPLICATE_ENTRY');
        }
    }
    const entries = {
        'package.json': strToU8(JSON.stringify(validated, null, 2)),
        [contributionPath]: strToU8(JSON.stringify(contributionManifest, null, 2)),
        ...Object.fromEntries(Object.entries(files).map(([name, value]) => [safeArchivePath(name), value instanceof Uint8Array ? value : strToU8(value)]))
    };
    return Buffer.from(zipSync(entries, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }));
}
