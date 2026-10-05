/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The network side of the registry (see docs/registry.md, docs/addonExplorer.md): fetching entries
// from GitHub, and downloading/verifying/installing the packages a chosen entry lists. Kept
// separate from packageArchive.mjs, which stays fetch-free and disk/byte-only, so that module's
// tests never need a network mock. Everything here is a plain function taking a fetch
// implementation as a parameter (default: the global fetch) specifically so it's testable the same
// way -- with a fake fetchImpl, no real network access, no Electron.

import { unzipSync } from 'fflate';
import { buildNamespaceRegistry, inspectPackageArchive, installPackageArchive, registryImagePathPattern, registryScreenshotPathPattern, verifyPackageArchive } from './packageArchive.mjs';

export class RegistryClientError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'RegistryClientError';
        this.code = code;
    }
}

// The one official registry, unless overridden. Deliberately an environment variable, not a UI
// preference, for now -- see docs/addonExplorer.md's Design principles: this is a buried,
// admin-level concern (pointing an organization's installs at a private fork or mirror), not
// something worth a settings UI before anyone's actually asked for one.
const defaultOwner = 'zenineasa';
const defaultRepo = 'Konjugate';
// zenineasa/Konjugate's actual default branch, confirmed against the live repo -- not every
// zenineasa repo uses the same one (Konjugate-Fintech, for instance, defaults to "main").
const defaultRef = 'master';

// Lists registry/*.json via GitHub's contents API (or an alternate registry URL) -- works
// unauthenticated for a public repo (rate-limited to 60 requests/hour/IP, ample for something
// fetched occasionally and cached, not on every keystroke) -- rather than requiring a separately-
// maintained index file that could drift from the directory's real contents. A repo with no
// registry/ directory yet (a fresh fork) is an empty registry, not an error.
export async function fetchRemoteRegistry({
    registryUrl = process.env.KONJUGATE_REGISTRY_URL,
    owner = process.env.KONJUGATE_REGISTRY_OWNER || defaultOwner,
    repo = process.env.KONJUGATE_REGISTRY_REPO || defaultRepo,
    ref = process.env.KONJUGATE_REGISTRY_REF || defaultRef,
    fetchImpl = fetch
} = {}) {
    if (registryUrl) {
        const response = await fetchImpl(registryUrl);
        if (!response.ok) {
            if (response.status === 404) return { prefixes: {} };
            throw new RegistryClientError(`Could not fetch registry from ${registryUrl} (HTTP ${response.status}).`, 'FETCH_FAILED');
        }
        const data = await response.json();
        if (data && typeof data === 'object' && data.prefixes) return data;
        if (Array.isArray(data)) return buildNamespaceRegistry(data);
        throw new RegistryClientError('The remote registry URL returned an unrecognized format.', 'INVALID_REGISTRY_FORMAT');
    }
    const listingUrl = `https://api.github.com/repos/${owner}/${repo}/contents/registry?ref=${encodeURIComponent(ref)}`;
    const listingResponse = await fetchImpl(listingUrl, { headers: { Accept: 'application/vnd.github+json' } });
    if (!listingResponse.ok) {
        if (listingResponse.status === 404) return { prefixes: {} };
        if (listingResponse.status === 403) {
            throw new RegistryClientError('GitHub API rate limit exceeded while listing the registry.', 'RATE_LIMITED');
        }
        throw new RegistryClientError(`Could not list the registry (HTTP ${listingResponse.status}).`, 'LISTING_FAILED');
    }
    const listing = await listingResponse.json();
    if (!Array.isArray(listing)) throw new RegistryClientError('Registry listing is not a valid directory.', 'LISTING_FAILED');
    const jsonFiles = listing.filter((item) => item.type === 'file' && item.name.endsWith('.json'));
    const files = await Promise.all(jsonFiles.map(async (file) => {
        const contentResponse = await fetchImpl(file.download_url);
        if (!contentResponse.ok) throw new RegistryClientError(`Could not fetch registry entry "${file.name}" (HTTP ${contentResponse.status}).`, 'FETCH_FAILED');
        return { name: file.name, text: await contentResponse.text() };
    }));
    // A malformed entry throws PackageArchiveError here and is allowed to propagate -- a broken
    // registry entry should be visible as a real error, not silently dropped from the list.
    return buildNamespaceRegistry(files);
}

// entry: one registry entry (as returned by fetchRemoteRegistry/loadNamespaceRegistry's prefixes
// map), with its packages/downloadUrl fields. namespaces: passed straight through to
// verifyPackageArchive for each installed package -- trust status is reported per package, never
// used to block anything here, per the advisory-only principle in docs/addonExplorer.md. Returns
// one { packageType, packageId, version, verification } per package the entry declares.
export async function installFromRegistryEntry(entry, { namespaces, directory, overwrite = true, fetchImpl = fetch } = {}) {
    if (typeof entry?.downloadUrl !== 'string' || !entry.downloadUrl) throw new RegistryClientError('This registry entry has no downloadUrl.', 'NO_DOWNLOAD_URL');
    if (!Array.isArray(entry.packages) || !entry.packages.length) throw new RegistryClientError('This registry entry lists no packages.', 'NO_PACKAGES');
    const response = await fetchImpl(entry.downloadUrl);
    if (!response.ok) throw new RegistryClientError(`Could not download ${entry.downloadUrl} (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    let zipEntries;
    try {
        zipEntries = unzipSync(archiveBytes);
    } catch (error) {
        throw new RegistryClientError(`The downloaded file is not a valid zip: ${error.message}`, 'INVALID_DOWNLOAD');
    }
    // Matched by each candidate file's own declared identity, not by file name -- file names carry
    // a version number the registry entry doesn't (and shouldn't have to) know in advance.
    let candidates = Object.entries(zipEntries).filter(([name]) => name.endsWith('.kja') || name.endsWith('.kjp'));
    if (!candidates.length && entry.packages.length === 1) {
        // The download may be a direct .kja or .kjp package archive rather than a multi-package zip container
        const declared = entry.packages[0];
        const extension = declared.packageType === 'addon' ? '.kja' : '.kjp';
        try {
            const inspected = inspectPackageArchive(archiveBytes, { extension });
            if (inspected.packageManifest.packageType === declared.packageType && inspected.packageManifest.packageId === declared.packageId) {
                candidates = [[`direct${extension}`, archiveBytes]];
            }
        } catch {
            // Not a direct package archive
        }
    }
    const results = [];
    for (const declared of entry.packages) {
        const extension = declared.packageType === 'addon' ? '.kja' : '.kjp';
        const match = candidates.find(([, bytes]) => {
            try {
                const inspected = inspectPackageArchive(bytes, { extension });
                return inspected.packageManifest.packageType === declared.packageType && inspected.packageManifest.packageId === declared.packageId;
            } catch {
                return false;
            }
        });
        if (!match) throw new RegistryClientError(`The download does not contain the declared package "${declared.packageId}".`, 'PACKAGE_MISSING');
        const [, bytes] = match;
        const verification = verifyPackageArchive(bytes, { namespaces });
        // A registry install is always "this is the version to have" -- installing a newer release of
        // something already installed is exactly how Update works -- so older versions are replaced
        // rather than left installed alongside it.
        const installed = await installPackageArchive(bytes, { extension, directory, overwrite, replaceOtherVersions: true });
        results.push({
            packageType: installed.packageManifest.packageType, packageId: installed.packageManifest.packageId,
            version: installed.packageManifest.version, verification
        });
    }
    return results;
}

// ---- Entry images (see the image field in docs/registry.md)
//
// An entry's image sits in the registry's own images/ directory, so it's resolved against the same
// registry location fetchRemoteRegistry reads: next to an alternate registry URL's JSON file, or in
// the registry repository's registry/ directory on raw.githubusercontent.com.
// Resolves a path an entry names (an image or a screenshot) against the registry location -- the
// one place that knows where the registry's own files live, shared by every kind of asset.
function registryAssetUrl(relativePath, {
    registryUrl = process.env.KONJUGATE_REGISTRY_URL,
    owner = process.env.KONJUGATE_REGISTRY_OWNER || defaultOwner,
    repo = process.env.KONJUGATE_REGISTRY_REPO || defaultRepo,
    ref = process.env.KONJUGATE_REGISTRY_REF || defaultRef
} = {}) {
    if (registryUrl) return new URL(relativePath, registryUrl).href;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/registry/${relativePath}`;
}

export function registryImageUrl(entry, location = {}) {
    if (typeof entry?.image !== 'string' || !registryImagePathPattern.test(entry.image)) return null;
    return registryAssetUrl(entry.image, location);
}

// The URL of entry.screenshots[index]'s file, or null for an entry without that screenshot.
export function registryScreenshotUrl(entry, index, location = {}) {
    const screenshot = Array.isArray(entry?.screenshots) ? entry.screenshots[index] : undefined;
    if (typeof screenshot?.image !== 'string' || !registryScreenshotPathPattern.test(screenshot.image) || screenshot.image.includes('..')) return null;
    return registryAssetUrl(screenshot.image, location);
}

// Identified by their leading bytes rather than a file extension or a response's Content-Type,
// either of which could claim anything.
const registryImageSignatures = [
    { mimeType: 'image/png', matches: (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
    { mimeType: 'image/jpeg', matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { mimeType: 'image/webp', matches: (bytes) => String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' }
];
// Every bundled image ships inside the app download, so this is kept deliberately small; see
// docs/registry.md for the recommended size and format.
export const registryImageMaxBytes = 512 * 1024;

// The image's MIME type, after checking it's a PNG, JPEG or WebP no larger than
// registryImageMaxBytes. Shared by bundled images read from disk and downloaded ones, so both pass
// the same checks. Throws RegistryClientError otherwise.
export function identifyRegistryImage(bytes, source = 'The image') {
    if (bytes.byteLength > registryImageMaxBytes) throw new RegistryClientError(`${source} is larger than ${registryImageMaxBytes / 1024} KB.`, 'IMAGE_TOO_LARGE');
    const signature = registryImageSignatures.find((candidate) => candidate.matches(bytes));
    if (!signature) throw new RegistryClientError(`${source} is not a PNG, JPEG or WebP image.`, 'INVALID_IMAGE');
    return signature.mimeType;
}

// Returns { mimeType, bytes } for entry.image, downloaded from registryImageUrl. Throws
// RegistryClientError for an entry without one, a failed download, or a file
// identifyRegistryImage rejects.
export async function fetchRegistryImage(entry, { fetchImpl = fetch, ...location } = {}) {
    const url = registryImageUrl(entry, location);
    if (!url) throw new RegistryClientError('This registry entry has no image.', 'NO_IMAGE');
    const response = await fetchImpl(url);
    if (!response.ok) throw new RegistryClientError(`Could not download ${url} (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { mimeType: identifyRegistryImage(bytes, url), bytes };
}

// Returns { mimeType, bytes } for entry.screenshots[index], downloaded and checked exactly like an
// entry's image (same formats, same size limit).
export async function fetchRegistryScreenshot(entry, index, { fetchImpl = fetch, ...location } = {}) {
    const url = registryScreenshotUrl(entry, index, location);
    if (!url) throw new RegistryClientError('This registry entry has no such screenshot.', 'NO_IMAGE');
    const response = await fetchImpl(url);
    if (!response.ok) throw new RegistryClientError(`Could not download ${url} (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { mimeType: identifyRegistryImage(bytes, url), bytes };
}

// ---- Update checking (see the Recommended add-ons/Update checking notes in docs/addonExplorer.md)
//
// A registry entry deliberately carries no version number of its own (see docs/registry.md -- it
// would just be a second, staler copy of what the actual release already declares), so "is there an
// update" can't be answered by reading the registry alone. Instead: GitHub's own Releases API gives
// the latest release's tag directly, for whatever repo a downloadUrl of the expected
// releases/latest/download/... shape points at -- cheap (one API call per installed entry, not a
// download) and always exactly as current as the release the registry's downloadUrl would actually
// resolve to.

function githubRepoFromDownloadUrl(downloadUrl) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\//.exec(downloadUrl ?? '');
    return match ? { owner: match[1], repo: match[2] } : null;
}

// true if `latest` is a newer dotted-numeric version than `current` (e.g. "0.2.0" > "0.1.0") --
// every package.json/addon.json/plugin.json version seen in this ecosystem follows this simple
// scheme, so a minimal per-segment numeric compare is enough; no need for a full semver library
// (pre-release tags, build metadata) nothing here actually uses.
export function isNewerVersion(latest, current) {
    const a = String(latest).split('.').map(Number);
    const b = String(current).split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}

// Returns { version, url } for the latest GitHub release of the repo entry.downloadUrl points at,
// or null for anything that isn't a recognizable GitHub releases download URL, has no releases yet,
// or couldn't be reached -- advisory only, same as the rest of this module, so a failure here just
// means "no update information," never an error that should interrupt Discover/Installed.
export async function fetchLatestReleaseVersion(downloadUrl, { fetchImpl = fetch } = {}) {
    const repo = githubRepoFromDownloadUrl(downloadUrl);
    if (!repo) return null;
    try {
        const response = await fetchImpl(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json' }
        });
        if (!response.ok) return null;
        const release = await response.json();
        if (typeof release.tag_name !== 'string') return null;
        return { version: release.tag_name.replace(/^v/, ''), url: release.html_url };
    } catch {
        return null;
    }
}
