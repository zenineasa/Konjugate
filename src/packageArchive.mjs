/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
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
// A namespace prefix (see docs/registry.md) is the same segment shape as a package id, but a full
// package id always has two or more segments (packageIdPattern's trailing "+") while a prefix
// may reserve just the first one -- "example" covering "example.*" -- hence "*" here, not "+".
const namespacePrefixPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
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

// replaceOtherVersions: remove every other installed version of the same package once this one is
// in place. Install paths are per-version (<type>s/<packageId>/<version>), so without this an
// update leaves the old version on disk next to the new one -- both then get discovered and loaded,
// and the update check keeps reporting the old one as outdated. Only removed after the new version
// has been written successfully, so a failed install never leaves the package missing entirely.
export async function installPackageArchive(archive, { extension, directory, overwrite = false, replaceOtherVersions = false } = {}) {
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
    if (replaceOtherVersions) {
        const packageRoot = dirname(target);
        const siblings = await readdir(packageRoot, { withFileTypes: true }).catch(() => []);
        for (const sibling of siblings) {
            if (!sibling.isDirectory() || sibling.name === basename(target) || sibling.name.endsWith('.tmp')) continue;
            await rm(join(packageRoot, sibling.name), { recursive: true, force: true });
        }
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

// ---- Publisher signing (see docs/registry.md) ----------------------------------------------------
//
// A namespace prefix reservation (a registry entry) only means something if a package claiming
// that identity can be checked against it -- this is that check. It is deliberately independent
// of installPackageArchive/inspectPackageArchive: verifyPackageArchive never throws for anything
// short of a malformed signature.json, and nothing in this file (or main.mjs's install path)
// calls it as a precondition of installing or running a package. An unreserved prefix, an
// unsigned package under a reserved one, and a signature that fails to verify are all reported
// as different statuses for a caller to *show*, not reasons to refuse anything -- Konjugate's
// plugin ecosystem is permissionless by design, and turning a trust signal into a gate would be
// a much bigger change than adding one.
const signatureEntryName = 'signature.json';
const signatureFormat = 'konjugate-package-signature';
const signatureFormatVersion = 1;

function isPrefixOf(prefix, packageId) {
    return packageId === prefix || packageId.startsWith(`${prefix}.`);
}

// The longest (most specific) reserved prefix covering packageId, if any -- if both "a" and
// "a.b" were ever reserved (docs/registry.md asks reviewers to reject that, but this stays correct
// even if one slipped through), a package under "a.b.c" is checked against "a.b"'s keys, not "a"'s.
function matchingPrefix(packageId, prefixes) {
    let best = null;
    for (const candidate of Object.keys(prefixes ?? {})) {
        if (isPrefixOf(candidate, packageId) && (!best || candidate.length > best.length)) best = candidate;
    }
    return best;
}

// Independent of zip byte layout (compression, entry order) -- only the set of (name, content)
// pairs matters, so re-zipping identical contents (as signPackageArchive does, to add
// signature.json) can't change what was signed.
function contentDigest(files) {
    const lines = Object.keys(files).sort().map((name) => `${name}:${createHash('sha256').update(files[name]).digest('hex')}`);
    return createHash('sha256').update(lines.join('\n')).digest();
}

// privateKey: a PEM string or a crypto KeyObject for an Ed25519 private key (see docs/registry.md
// for generating one). prefix: the namespace prefix this key is (expected to be) registered
// under -- signing doesn't check the registry itself, only verifying does, so this can be done
// entirely offline/in CI with no access to the registry.
export function signPackageArchive(archive, { privateKey, prefix }) {
    if (typeof prefix !== 'string' || !namespacePrefixPattern.test(prefix)) throw new PackageArchiveError('A signing prefix must be a valid namespace prefix.', 'INVALID_PREFIX');
    const files = inspectEntries(archive);
    if (files[signatureEntryName]) throw new PackageArchiveError('The package is already signed.', 'ALREADY_SIGNED');
    const digest = contentDigest(files);
    const keyObject = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
    const signature = cryptoSign(null, digest, keyObject);
    const signatureEntry = {
        format: signatureFormat, formatVersion: signatureFormatVersion, prefix, algorithm: 'ed25519',
        digest: `sha256:${digest.toString('hex')}`, signature: signature.toString('base64'), signedAt: new Date().toISOString()
    };
    return Buffer.from(zipSync({ ...files, [signatureEntryName]: strToU8(JSON.stringify(signatureEntry, null, 2)) }, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }));
}

// namespaces: the parsed contents of loadNamespaceRegistry's return value (or { prefixes: {...} }; pass {} or omit
// entirely to always get 'unclaimed'/'unsigned' rather than 'verified', e.g. if the caller has
// no registry available). Returns { status, prefix?, owner?, reason? } and never throws for a
// well-formed archive -- see the module comment above for why a failure here is a status to
// display, not an error to propagate.
export function verifyPackageArchive(archive, { namespaces } = {}) {
    const { packageManifest, files } = inspectPackageArchive(archive);
    const packageId = packageManifest.packageId;
    const reservedPrefix = matchingPrefix(packageId, namespaces?.prefixes);
    const signatureRaw = files[signatureEntryName];
    if (!signatureRaw) return { status: reservedPrefix ? 'unsigned' : 'unclaimed', reservedPrefix };
    let signatureEntry;
    try {
        signatureEntry = JSON.parse(strFromU8(signatureRaw));
    } catch {
        return { status: 'invalid', reason: 'signature.json is not valid JSON.' };
    }
    if (signatureEntry.format !== signatureFormat || signatureEntry.formatVersion !== signatureFormatVersion || signatureEntry.algorithm !== 'ed25519') {
        return { status: 'invalid', reason: 'The signature format or algorithm is unsupported.' };
    }
    if (typeof signatureEntry.prefix !== 'string' || !isPrefixOf(signatureEntry.prefix, packageId)) {
        return { status: 'invalid', reason: 'The signature claims a prefix that is not a prefix of this package id.' };
    }
    const entry = namespaces?.prefixes?.[signatureEntry.prefix];
    if (!entry) return { status: 'invalid', reason: `"${signatureEntry.prefix}" is not a reserved prefix.`, prefix: signatureEntry.prefix };
    const filesWithoutSignature = Object.fromEntries(Object.entries(files).filter(([name]) => name !== signatureEntryName));
    const digest = contentDigest(filesWithoutSignature);
    if (`sha256:${digest.toString('hex')}` !== signatureEntry.digest) {
        return { status: 'invalid', reason: 'The signed digest does not match the package contents.', prefix: signatureEntry.prefix };
    }
    let signatureBytes;
    try {
        signatureBytes = Buffer.from(signatureEntry.signature, 'base64');
    } catch {
        return { status: 'invalid', reason: 'The signature is not valid base64.', prefix: signatureEntry.prefix };
    }
    const publicKeys = Array.isArray(entry.publicKeys) ? entry.publicKeys : [];
    const verified = publicKeys.some((pem) => {
        try {
            return cryptoVerify(null, digest, createPublicKey(pem), signatureBytes);
        } catch {
            return false;
        }
    });
    return verified
        ? { status: 'verified', prefix: signatureEntry.prefix, owner: entry.owner }
        : { status: 'invalid', reason: 'The signature does not verify against any registered key for this prefix.', prefix: signatureEntry.prefix };
}

// ---- Registry (see docs/registry.md) -----------------------------------------------------------
//
// One file per reserved prefix, not one shared file for all of them (a shared file would be a
// merge-conflict hotspot once more than a couple of people submit entries concurrently). The
// prefix itself is the filename, not a field inside it -- registry/konjugate.fintech.json's
// content describes the konjugate.fintech prefix, full stop, so there is nothing inside the file
// that could disagree with where it lives.
const namespaceEntryFormat = 'konjugate-namespace-entry';
const namespaceEntryFormatVersion = 1;
const packageTypes = ['addon', 'plugin'];
// An entry's image (see validateNamespaceEntry) lives beside the entries themselves, in the
// registry's own images/ directory: one file, no subdirectories, PNG/JPEG/WebP.
export const registryImagePathPattern = /^images\/[\w-][\w.-]*\.(png|jpe?g|webp)$/i;
// An entry's screenshots live in their own directory, not images/: everything in images/ ships
// inside the app, but screenshots are only ever shown next to an Install button (which needs the
// network anyway), so the app downloads and caches them on demand instead (see
// packageRegistryScreenshot in src/main.mjs and docs/registry.md).
export const registryScreenshotPathPattern = /^screenshots\/[\w-][\w.-]*\.(png|jpe?g|webp)$/i;
export const maxRegistryScreenshots = 6;
export const maxRegistryVideos = 4;
// Only YouTube's two watch-link forms, with nothing after the 11-character video id: a registry
// entry's link opens in the person's own browser, and keeping it to a video id means a listing
// can't smuggle in a playlist, a redirect or an arbitrary page.
export const registryVideoUrlPattern = /^https:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}$/;

// Every field beyond owner/contact/publicKeys is optional -- an entry with only those three is a
// prefix reserved for private/internal use, not listed anywhere; loadNamespaceRegistry accepts it
// exactly the same as a fully-filled-in entry (see docs/registry.md for why that's the intended
// way to express "reserved but not discoverable", rather than a second, separate mechanism).
// Exported so a network-based loader (fetching entries from GitHub instead of a local directory --
// see src/registryClient.mjs) can apply the exact same rules loadNamespaceRegistry does, rather
// than a second, possibly-drifting copy of them.
export function validateNamespaceEntry(entry, prefix) {
    const invalid = (message) => { throw new PackageArchiveError(`Registry entry "${prefix}" is invalid: ${message}`, 'INVALID_REGISTRY_ENTRY'); };
    if (!entry || entry.format !== namespaceEntryFormat || entry.formatVersion !== namespaceEntryFormatVersion) invalid('unsupported format.');
    if (typeof entry.owner !== 'string' || !entry.owner) invalid('owner is required.');
    if (typeof entry.contact !== 'string' || !entry.contact) invalid('contact is required.');
    if (!Array.isArray(entry.publicKeys) || !entry.publicKeys.length || entry.publicKeys.some((key) => typeof key !== 'string' || !key)) {
        invalid('publicKeys must be a non-empty list of PEM-encoded keys.');
    }
    for (const optional of ['title', 'description', 'license', 'commercialLicenseUrl', 'domain', 'url', 'downloadUrl']) {
        if (entry[optional] !== undefined && (typeof entry[optional] !== 'string' || !entry[optional])) invalid(`${optional}, if present, must be a non-empty string.`);
    }
    // Kept in the registry next to the entry rather than in the publisher's own repository, so the
    // picture is reviewed in the same pull request as the entry and can't be swapped out afterwards,
    // and so the copy bundled with the app can be shown without any network access at all.
    if (entry.image !== undefined && (typeof entry.image !== 'string' || !registryImagePathPattern.test(entry.image) || entry.image.includes('..'))) {
        invalid('image, if present, must name a .png, .jpg, .jpeg or .webp file in the registry\'s images/ directory, e.g. "images/example.fintech.webp".');
    }
    // Pictures of the add-on at work, kept in the registry (not the publisher's repository) for the
    // same reason image is: they are reviewed in the entry's own pull request and can't be swapped
    // afterwards. Every one needs a caption, which is also its alternative text.
    if (entry.screenshots !== undefined) {
        if (!Array.isArray(entry.screenshots) || !entry.screenshots.length || entry.screenshots.length > maxRegistryScreenshots) {
            invalid(`screenshots, if present, must be a list of 1 to ${maxRegistryScreenshots} items.`);
        }
        for (const [index, item] of entry.screenshots.entries()) {
            if (!item || typeof item.image !== 'string' || !registryScreenshotPathPattern.test(item.image) || item.image.includes('..')) {
                invalid(`screenshots[${index}].image must name a .png, .jpg, .jpeg or .webp file in the registry's screenshots/ directory, e.g. "screenshots/example.fintech.1.webp".`);
            }
            if (typeof item.caption !== 'string' || !item.caption.trim() || item.caption.length > 140) {
                invalid(`screenshots[${index}].caption is required and must be at most 140 characters.`);
            }
        }
    }
    // Links, not files: a video is only ever opened in the person's own browser, never embedded or
    // fetched by the app, so nothing about a registry entry causes a request to YouTube until the
    // person clicks one.
    if (entry.videos !== undefined) {
        if (!Array.isArray(entry.videos) || !entry.videos.length || entry.videos.length > maxRegistryVideos) {
            invalid(`videos, if present, must be a list of 1 to ${maxRegistryVideos} items.`);
        }
        for (const [index, item] of entry.videos.entries()) {
            if (!item || typeof item.url !== 'string' || !registryVideoUrlPattern.test(item.url)) {
                invalid(`videos[${index}].url must be a YouTube link of the form https://www.youtube.com/watch?v=<11-character id> or https://youtu.be/<id>.`);
            }
            if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100) {
                invalid(`videos[${index}].title is required and must be at most 100 characters.`);
            }
        }
    }
    // Surfaced in the Welcome window's one-time starter-pack offer (see the Recommended add-ons
    // section of docs/addonExplorer.md) -- meaningless on an entry with nothing to install, so it
    // requires the same fields Discover's one-click install already requires.
    if (entry.recommended !== undefined) {
        if (typeof entry.recommended !== 'boolean') invalid('recommended, if present, must be a boolean.');
        if (entry.recommended && (!entry.downloadUrl || !entry.packages)) invalid('recommended entries must also declare downloadUrl and packages.');
    }
    if (entry.packages !== undefined) {
        if (!Array.isArray(entry.packages) || !entry.packages.length) invalid('packages, if present, must be a non-empty list.');
        for (const [index, item] of entry.packages.entries()) {
            if (!item || !packageTypes.includes(item.packageType)) invalid(`packages[${index}].packageType must be "addon" or "plugin".`);
            if (typeof item.packageId !== 'string' || !packageIdPattern.test(item.packageId)) invalid(`packages[${index}].packageId is not a valid package id.`);
            if (!isPrefixOf(prefix, item.packageId)) invalid(`packages[${index}].packageId ("${item.packageId}") is not under this entry's own prefix ("${prefix}") -- see the Multi-package bundles note in docs/addonExplorer.md for why a bundle can't name another prefix's package.`);
        }
    }
}

// Reads every *.json file in directoryPath (a "registry/" directory) into the { prefixes: {...} }
// shape verifyPackageArchive expects, keyed by each file's own name (minus ".json") rather than
// anything declared inside it. Throws PackageArchiveError on a malformed entry rather than
// silently skipping it -- a broken registry entry should fail loudly in review/CI, not disappear.
// Shared by loadNamespaceRegistry (below, reading a local directory) and src/registryClient.mjs's
// network-based equivalent (fetching from GitHub instead), so "derive the prefix from the file
// name, parse, validate" exists as one pipeline, not two copies that could drift apart. files: an
// array of { name, text } -- name is the file's own name (e.g. "konjugate.fintech.json"), text is
// its raw JSON content, from disk or from a network fetch, this function doesn't care which.
export function buildNamespaceRegistry(files) {
    const prefixes = {};
    for (const { name, text } of files) {
        const prefix = basename(name, '.json');
        if (!namespacePrefixPattern.test(prefix)) throw new PackageArchiveError(`Registry file name "${name}" is not a valid namespace prefix.`, 'INVALID_PREFIX');
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new PackageArchiveError(`Could not read registry entry "${prefix}": ${error.message}`, 'INVALID_REGISTRY_ENTRY');
        }
        validateNamespaceEntry(parsed, prefix);
        prefixes[prefix] = parsed;
    }
    return { prefixes };
}

export async function loadNamespaceRegistry(directoryPath) {
    const entries = (await readdir(directoryPath, { withFileTypes: true })).filter((item) => item.isFile() && item.name.endsWith('.json'));
    const files = await Promise.all(entries.map(async (item) => {
        try {
            return { name: item.name, text: await readFile(join(directoryPath, item.name), 'utf8') };
        } catch (error) {
            throw new PackageArchiveError(`Could not read registry entry "${basename(item.name, '.json')}": ${error.message}`, 'INVALID_REGISTRY_ENTRY');
        }
    }));
    return buildNamespaceRegistry(files);
}
