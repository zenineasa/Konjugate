/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reading and judging a package archive (.kja add-on, .kjp plugin) without touching a disk: the manifest's shape, its
// compatibility with the running Konjugate, and the contribution manifest's own rules. Nothing here uses Node, so the desktop's
// installer (packageArchive.mjs) and the web edition's (webPackageStore.mjs) run the same checks and a package is accepted or
// refused identically by both.

import { strFromU8, unzipSync } from 'fflate';
import { validateAddonManifest } from './addonHost.mjs';
import { compareVersions } from './versionCompare.mjs';

export const packageArchiveFormat = 'konjugate-package';
export const packageArchiveVersion = 1;
export const packageExtensions = Object.freeze({ addon: '.kja', plugin: '.kjp' });

// Shared identity key for a specific installed/bundled package version, used by the extension
// state store, main.mjs's discovery/IPC handlers and pluginResolver.mjs's disabled-plugin check
// so all three can't drift out of format.
export function packageKey(packageType, packageId, version) {
    return `${packageType}:${packageId}:${version}`;
}
export const packageIdPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
// A namespace prefix (see docs/registry.md) is the same segment shape as a package id, but a full
// package id always has two or more segments (packageIdPattern's trailing "+") while a prefix
// may reserve just the first one -- "example" covering "example.*" -- hence "*" here, not "+".
export const namespacePrefixPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
// minimumKonjugateVersion (docs/proposals/packageCompatibility.md): exactly three numbers, like Konjugate's own version.
const minimumKonjugateVersionPattern = /^\d+\.\d+\.\d+$/;
// The add-on and plugin API version this Konjugate supports. A package declaring a higher one comes from a newer
// Konjugate; it is reported as incompatible, not as invalid.
const supportedApiVersion = 1;
const maximumArchiveBytes = 64 * 1024 * 1024;
const maximumFileCount = 5000;
const maximumFileBytes = 64 * 1024 * 1024;
const maximumExpandedBytes = 256 * 1024 * 1024;

export class PackageArchiveError extends Error {
    // `details` carries structured facts for the two incompatibility codes, INCOMPATIBLE_APP_VERSION
    // ({ required, running }) and UNSUPPORTED_API_VERSION ({ required }), so callers can choose another release
    // instead of parsing the message.
    constructor(message, code, details = null) {
        super(message);
        this.name = 'PackageArchiveError';
        this.code = code;
        if (details) this.details = details;
    }
}

// Whether a package can run on this Konjugate, judged by the minimumKonjugateVersion in its package.json. Absent means no
// requirement. `appVersion` is Konjugate's own version; unreadable or missing means there is nothing to compare against,
// and the package is allowed.
export function packageCompatibility(packageManifest, appVersion) {
    const required = packageManifest?.minimumKonjugateVersion;
    if (!required || !appVersion) return { compatible: true };
    return compareVersions(required, appVersion, { threeParts: true }) === 1
        ? { compatible: false, reason: 'app-version', required, running: appVersion }
        : { compatible: true };
}

function firstUnsupportedApiVersion(contributionManifest) {
    const versions = [contributionManifest.apiVersion, ...(Array.isArray(contributionManifest.contributes) ? contributionManifest.contributes.map((item) => item?.apiVersion) : [])];
    return versions.find((value) => Number.isInteger(value) && value > supportedApiVersion) ?? null;
}

function packageManifestPath(packageType) {
    return packageType === 'addon' ? 'addon.json' : 'plugin.json';
}

export function validatePackageManifest(manifest, expectedType = null) {
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
    if (manifest.minimumKonjugateVersion !== undefined && !minimumKonjugateVersionPattern.test(manifest.minimumKonjugateVersion)) {
        throw new PackageArchiveError('minimumKonjugateVersion must be a three-part version such as "1.2.0".', 'INVALID_MANIFEST');
    }
    return structuredClone(manifest);
}

export function safeArchivePath(name) {
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')) {
        throw new PackageArchiveError(`Unsafe package entry path: ${name || '<empty>'}.`, 'UNSAFE_PATH');
    }
    const segments = name.split('/');
    if (segments.some((segment) => segment === '..' || segment === '.')) {
        throw new PackageArchiveError(`Unsafe package entry path: ${name}.`, 'UNSAFE_PATH');
    }
    return name;
}

export function decodeJson(files, path, code) {
    const bytes = files[path];
    if (!bytes) throw new PackageArchiveError(`The package is missing ${path}.`, code);
    try {
        return JSON.parse(strFromU8(bytes));
    } catch {
        throw new PackageArchiveError(`${path} is not valid JSON.`, code);
    }
}

export function inspectEntries(archive) {
    // A Node Buffer is a Uint8Array, so this takes either.
    if (!(archive instanceof Uint8Array)) {
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

// What a release's compatibility depends on, read without judging the package: its identity and minimum Konjugate version
// (package.json), and the highest add-on or plugin API version its contribution manifest asks for beyond the one this
// Konjugate supports (null if none). Registry release selection uses this to decide whether a downloaded candidate suits
// the running app, and to match a downloaded archive to the package a registry entry declares, neither of which should
// fail just because the package comes from a newer Konjugate. Throws PackageArchiveError for an archive that is broken.
export function readPackageCompatibilityFacts(archive, { extension = null } = {}) {
    const files = inspectEntries(archive);
    const packageManifest = validatePackageManifest(decodeJson(files, 'package.json', 'INVALID_MANIFEST'), extension === '.kja' ? 'addon' : extension === '.kjp' ? 'plugin' : null);
    const contributionManifest = decodeJson(files, packageManifest.contents.manifest, 'MISSING_MANIFEST');
    return { packageManifest, unsupportedApiVersion: firstUnsupportedApiVersion(contributionManifest) };
}

// Compatibility (docs/proposals/packageCompatibility.md) is reported with two distinct codes, never as a generic invalid
// manifest: UNSUPPORTED_API_VERSION if the package uses an add-on or plugin API version this Konjugate does not have
// (always checked), and INCOMPATIBLE_APP_VERSION if it needs a newer Konjugate than `appVersion` (checked only when the
// caller passes Konjugate's own version, which tests and bundled packages leave out).
export function inspectPackageArchive(archive, { extension = null, appVersion = null } = {}) {
    const files = inspectEntries(archive);
    const packageManifest = validatePackageManifest(decodeJson(files, 'package.json', 'INVALID_MANIFEST'), extension === '.kja' ? 'addon' : extension === '.kjp' ? 'plugin' : null);
    const label = `${packageManifest.name} ${packageManifest.version}`;
    const compatibility = packageCompatibility(packageManifest, appVersion);
    if (!compatibility.compatible) {
        throw new PackageArchiveError(`${label} needs Konjugate ${compatibility.required} or later; this is Konjugate ${compatibility.running}.`, 'INCOMPATIBLE_APP_VERSION',
            { required: compatibility.required, running: compatibility.running, packageManifest });
    }
    const contributionPath = packageManifest.contents.manifest;
    const contributionManifest = decodeJson(files, contributionPath, 'MISSING_MANIFEST');
    const unsupportedApi = firstUnsupportedApiVersion(contributionManifest);
    if (unsupportedApi !== null) {
        throw new PackageArchiveError(`${label} uses ${packageManifest.packageType === 'addon' ? 'add-on' : 'plugin'} API version ${unsupportedApi}, which this version of Konjugate does not support.`,
            'UNSUPPORTED_API_VERSION', { required: unsupportedApi, packageManifest });
    }
    if (packageManifest.packageType === 'addon') {
        try {
            validateAddonManifest(contributionManifest);
        } catch (error) {
            throw new PackageArchiveError(`The add-on manifest is invalid: ${error.message}`, 'INVALID_MANIFEST');
        }
        if (contributionManifest.addonId !== packageManifest.packageId) {
            throw new PackageArchiveError('The package and add-on IDs do not match.', 'MANIFEST_MISMATCH');
        }
        if (contributionManifest.kind === 'launcher') {
            // Everything a launcher declares must ship in the archive, so a missing file is caught at install
            // time and not the first time a user clicks it.
            const declared = [
                contributionManifest.entry,
                ...(contributionManifest.contributes.importers ?? []).flatMap((importer) => [importer.entry, ...importer.files.flatMap((file) => [file.sample].flat()).filter(Boolean)]),
                ...(contributionManifest.contributes.pages ?? []).map((page) => page.entry)
            ];
            for (const path of declared) {
                safeArchivePath(path);
                if (!files[path]) throw new PackageArchiveError(`The launcher declares a file the package does not contain: ${path}.`, 'MISSING_ENTRY');
            }
        }
    } else {
        if (contributionManifest.pluginId !== packageManifest.packageId || contributionManifest.apiVersion !== 1 || !Array.isArray(contributionManifest.contributes) || !contributionManifest.contributes.length) {
            throw new PackageArchiveError('The plugin manifest is invalid or does not match the package.', 'INVALID_MANIFEST');
        }
        for (const contribution of contributionManifest.contributes) {
            if (contribution.kind === 'component') {
                if (!contribution.componentId || contribution.apiVersion !== 1) throw new PackageArchiveError('The plugin contains an invalid component contribution.', 'INVALID_MANIFEST');
            } else if (contribution.kind === 'example') {
                if (!/^[a-zA-Z][\w-]*$/.test(contribution.exampleId ?? '') || contribution.apiVersion !== 1 || !contribution.name || !String(contribution.entry ?? '').endsWith('.kjt')) {
                    throw new PackageArchiveError('The plugin contains an invalid example contribution.', 'INVALID_MANIFEST');
                }
                for (const optional of ['guide', 'thumbnail']) {
                    if (contribution[optional] === undefined) continue;
                    safeArchivePath(contribution[optional]);
                    if (!files[contribution[optional]]) throw new PackageArchiveError(`The plugin example ${optional} is missing: ${contribution[optional]}.`, 'MISSING_ENTRY');
                }
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

// ---- Publisher signatures (docs/registry.md): the parts both the desktop's check (packageArchive.mjs, node:crypto) and the web
// edition's (packageSignature.mjs, WebCrypto) need, so the two can only disagree about how a signature is computed, never about
// which prefix covers a package or what a signature file says.
export const signatureEntryName = 'signature.json';
export const signatureFormat = 'konjugate-package-signature';
export const signatureFormatVersion = 1;

export function isPrefixOf(prefix, packageId) {
    return packageId === prefix || packageId.startsWith(`${prefix}.`);
}

// The longest (most specific) reserved prefix covering packageId, if any -- if both "a" and
// "a.b" were ever reserved (docs/registry.md asks reviewers to reject that, but this stays correct
// even if one slipped through), a package under "a.b.c" is checked against "a.b"'s keys, not "a"'s.
export function matchingPrefix(packageId, prefixes) {
    let best = null;
    for (const candidate of Object.keys(prefixes ?? {})) {
        if (isPrefixOf(candidate, packageId) && (!best || candidate.length > best.length)) best = candidate;
    }
    return best;
}
