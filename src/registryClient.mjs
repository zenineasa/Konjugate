/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The network side of the registry (see docs/registry.md, docs/extensionsExplorer.md): fetching entries
// from GitHub, and downloading/verifying/installing the packages a chosen entry lists. Kept
// separate from packageArchive.mjs, which stays fetch-free and disk/byte-only, so that module's
// tests never need a network mock. Everything here is a plain function taking a fetch
// implementation as a parameter (default: the global fetch) specifically so it's testable the same
// way -- with a fake fetchImpl, no real network access, no Electron.

import { unzipSync } from 'fflate';
import { compareVersions, isNewerPackageVersion, isPrerelease } from './versionCompare.mjs';
import { buildNamespaceRegistry, installPackageArchive, packageCompatibility, PackageArchiveError, readPackageCompatibilityFacts, registryImagePathPattern, registryScreenshotPathPattern, verifyPackageArchive } from './packageArchive.mjs';

export class RegistryClientError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'RegistryClientError';
        this.code = code;
    }
}

// The one official registry, unless overridden. Deliberately an environment variable, not a UI
// preference, for now -- see docs/extensionsExplorer.md's Design principles: this is a buried,
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
// used to block anything here, per the advisory-only principle in docs/extensionsExplorer.md. Returns
// one { packageType, packageId, version, verification } per package the entry declares.
//
// appVersion (Konjugate's own version) turns on release selection (docs/proposals/packageCompatibility.md): for an entry
// that points at GitHub Releases, the newest release this Konjugate can use is installed, not simply the latest, and each
// result carries `heldBack` ({ version, required, reason }) when a newer release exists that this Konjugate cannot use.
// `release` names one release tag to install instead (rolling back, or choosing a version); it must be compatible too.
// Without appVersion the entry's downloadUrl is downloaded as before and nothing is judged.
export async function installFromRegistryEntry(entry, { namespaces, directory, overwrite = true, fetchImpl = fetch, appVersion = null, release = null, factsCache = null, includePrereleases = false } = {}) {
    if (typeof entry?.downloadUrl !== 'string' || !entry.downloadUrl) throw new RegistryClientError('This registry entry has no downloadUrl.', 'NO_DOWNLOAD_URL');
    if (!Array.isArray(entry.packages) || !entry.packages.length) throw new RegistryClientError('This registry entry lists no packages.', 'NO_PACKAGES');
    const { archiveBytes, heldBack } = await fetchEntryArchive(entry, { fetchImpl, appVersion, release, factsCache, includePrereleases });
    let zipEntries;
    try {
        zipEntries = unzipSync(archiveBytes);
    } catch (error) {
        throw new RegistryClientError(`The downloaded file is not a valid zip: ${error.message}`, 'INVALID_DOWNLOAD');
    }
    const matches = matchDeclaredPackages(entry, archiveBytes, zipEntries);
    const results = [];
    for (const declared of entry.packages) {
        const extension = declared.packageType === 'addon' ? '.kja' : '.kjp';
        const match = matches.get(declared.packageId);
        if (!match) throw new RegistryClientError(`The download does not contain the declared package "${declared.packageId}".`, 'PACKAGE_MISSING');
        const bytes = match;
        const verification = verifyPackageArchive(bytes, { namespaces });
        // A registry install is always "this is the version to have" -- installing a newer release of
        // something already installed is exactly how Update works -- so older versions are replaced
        // rather than left installed alongside it.
        const installed = await installPackageArchive(bytes, { extension, directory, overwrite, appVersion });
        results.push({
            packageType: installed.packageManifest.packageType, packageId: installed.packageManifest.packageId,
            version: installed.packageManifest.version, verification, ...(heldBack ? { heldBack } : {})
        });
    }
    return results;
}

// The download may be a zip container holding the entry's .kja and .kjp files, or (for a single-package entry) the package
// archive itself. Matched by each candidate file's own declared identity, not by file name -- file names carry a version
// number the registry entry doesn't (and shouldn't have to) know in advance. Returns a Map of packageId -> archive bytes.
function matchDeclaredPackages(entry, archiveBytes, zipEntries) {
    let candidates = Object.entries(zipEntries).filter(([name]) => name.endsWith('.kja') || name.endsWith('.kjp'));
    if (!candidates.length && entry.packages.length === 1) {
        // The download may be a direct .kja or .kjp package archive rather than a multi-package zip container
        const declared = entry.packages[0];
        const extension = declared.packageType === 'addon' ? '.kja' : '.kjp';
        try {
            const { packageManifest } = readPackageCompatibilityFacts(archiveBytes, { extension });
            if (packageManifest.packageType === declared.packageType && packageManifest.packageId === declared.packageId) candidates = [[`direct${extension}`, archiveBytes]];
        } catch {
            // Not a direct package archive
        }
    }
    const matches = new Map();
    for (const declared of entry.packages) {
        const extension = declared.packageType === 'addon' ? '.kja' : '.kjp';
        const found = candidates.find(([, bytes]) => {
            try {
                const { packageManifest } = readPackageCompatibilityFacts(bytes, { extension });
                return packageManifest.packageType === declared.packageType && packageManifest.packageId === declared.packageId;
            } catch {
                return false;
            }
        });
        if (found) matches.set(declared.packageId, found[1]);
    }
    return matches;
}

async function downloadBytes(url, fetchImpl) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new RegistryClientError(`Could not download ${url} (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
    return new Uint8Array(await response.arrayBuffer());
}

async function fetchEntryArchive(entry, { fetchImpl, appVersion, release, factsCache, includePrereleases }) {
    const plain = async () => ({ archiveBytes: await downloadBytes(entry.downloadUrl, fetchImpl), heldBack: null });
    if (!appVersion) {
        if (release) throw new RegistryClientError('Choosing a release needs the Konjugate version to check it against.', 'NO_APP_VERSION');
        return plain();
    }
    if (release) {
        const listing = await listGithubReleases(entry.downloadUrl, { fetchImpl, includePrereleases: true });
        const chosen = listing?.find((candidate) => candidate.tag === release || candidate.version === String(release).replace(/^v/, ''));
        const asset = chosen && releaseAsset(chosen, entry.downloadUrl);
        if (!asset) throw new RegistryClientError(`There is no release "${release}" with ${assetNameFromDownloadUrl(entry.downloadUrl)} to install.`, 'RELEASE_NOT_FOUND');
        const archiveBytes = await downloadBytes(asset.url, fetchImpl);
        const verdict = assessFacts(readReleaseFacts(entry, archiveBytes), appVersion);
        if (!verdict.compatible) throw new RegistryClientError(incompatibleMessage(entry, chosen.version, verdict, appVersion), 'INCOMPATIBLE_RELEASE');
        return { archiveBytes, heldBack: null };
    }
    const selection = await selectCompatibleRelease(entry, { appVersion, fetchImpl, factsCache, includePrereleases });
    if (!selection) return plain();   // not a GitHub releases address, or the release list could not be read: the entry's own download, judged at install
    if (!selection.chosen) {
        const newest = selection.skipped[0];
        throw new RegistryClientError(newest
            ? `No recent release of ${entry.title ?? 'this package'} works with Konjugate ${appVersion}. ${incompatibleMessage(entry, newest.version, newest, appVersion)}`
            : `${entry.title ?? 'This package'} has no release with ${assetNameFromDownloadUrl(entry.downloadUrl)} to install.`, 'NO_COMPATIBLE_RELEASE');
    }
    const { release: chosen, bytes } = selection.chosen;
    const heldBack = selection.skipped.length && selection.newest && selection.newest.version !== chosen.version ? { version: selection.skipped[0].version, required: selection.skipped[0].required ?? null, reason: selection.skipped[0].reason } : null;
    return { archiveBytes: bytes ?? await downloadBytes(releaseAsset(chosen, entry.downloadUrl).url, fetchImpl), heldBack };
}

function incompatibleMessage(entry, version, verdict, appVersion) {
    const name = entry.title ?? 'This package';
    if (verdict.reason === 'api-version') return `${name} ${version} uses add-on or plugin API version ${verdict.required}, which Konjugate ${appVersion} does not support.`;
    if (verdict.reason === 'invalid') return `${name} ${version} is not a valid package.`;
    return `${name} ${version} needs Konjugate ${verdict.required} or later; this is Konjugate ${appVersion}.`;
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

// ---- Update checking (see the Recommended add-ons/Update checking notes in docs/extensionsExplorer.md)
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

// The one version comparison lives in versionCompare.mjs (shared with the app's own update check); re-exported here so
// the registry code and its tests keep importing it from the module that uses it.
export { isNewerPackageVersion as isNewerVersion };

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

// ---- Release selection (docs/proposals/packageCompatibility.md)
//
// A registry entry's downloadUrl names the *latest* release. To install or update to the newest release the running
// Konjugate can actually use, list the repository's releases and look at them newest first: each candidate's archive is
// downloaded and its compatibility read from the archive itself (minimumKonjugateVersion in package.json, the API versions in
// the contribution manifest), because the archive is the authority the installer checks again anyway. What is learned about a
// release (its facts, not a verdict about this app) is cached per repository and tag: a published release does not change,
// and the verdict is recomputed against whatever Konjugate is running.

const releasesPerPage = 20;
const defaultMaximumCandidates = 5;

export function assetNameFromDownloadUrl(downloadUrl) {
    try {
        return decodeURIComponent(new URL(downloadUrl).pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
        return '';
    }
}

const releaseAsset = (release, downloadUrl) => release.assets.find((asset) => asset.name === assetNameFromDownloadUrl(downloadUrl)) ?? null;

// Releases of the GitHub repository a downloadUrl points at, newest version first: drafts are never listed, pre-releases only
// when asked for, and a release whose tag is not a readable version is skipped. null for an address that is not GitHub
// Releases, or when the list cannot be read (offline, rate-limited): advisory only, like fetchLatestReleaseVersion.
export async function listGithubReleases(downloadUrl, { fetchImpl = fetch, includePrereleases = false } = {}) {
    const repo = githubRepoFromDownloadUrl(downloadUrl);
    if (!repo) return null;
    try {
        const response = await fetchImpl(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=${releasesPerPage}`, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) return null;
        const releases = await response.json();
        if (!Array.isArray(releases)) return null;
        return releases
            .filter((item) => item && !item.draft && typeof item.tag_name === 'string' && compareVersions(item.tag_name, '0') !== null)
            .map((item) => ({
                tag: item.tag_name, version: item.tag_name.replace(/^v/, ''), prerelease: Boolean(item.prerelease) || isPrerelease(item.tag_name), url: item.html_url,
                assets: (item.assets ?? []).map((asset) => ({ name: asset.name, url: asset.browser_download_url })), repo: `${repo.owner}/${repo.repo}`
            }))
            .filter((item) => includePrereleases || !item.prerelease)
            .sort((a, b) => compareVersions(b.version, a.version));
    } catch {
        return null;
    }
}

// What is remembered about each release, keyed "owner/repo@tag". `initial` is a plain object (for example read from disk) and
// `onChange` receives the whole object after each addition, so a caller can persist it.
export function createReleaseFactsCache({ initial = {}, onChange = () => {} } = {}) {
    const facts = new Map(Object.entries(initial));
    return {
        get: (key) => facts.get(key) ?? null,
        set(key, value) {
            facts.set(key, value);
            onChange(Object.fromEntries(facts));
        },
        toJSON: () => Object.fromEntries(facts)
    };
}

// The facts of a downloaded archive for an entry: the strictest minimumKonjugateVersion across the packages the entry
// declares, and the API version of any that needs one this Konjugate lacks. `invalid` if the download is not usable at all.
function readReleaseFacts(entry, archiveBytes) {
    let zipEntries;
    try {
        zipEntries = unzipSync(archiveBytes);
    } catch (error) {
        return { invalid: true, reason: `not a valid zip: ${error.message}` };
    }
    const matches = matchDeclaredPackages(entry, archiveBytes, zipEntries);
    let minimumKonjugateVersion = null, unsupportedApiVersion = null;
    for (const declared of entry.packages) {
        const bytes = matches.get(declared.packageId);
        if (!bytes) return { invalid: true, reason: `missing package ${declared.packageId}` };
        try {
            const facts = readPackageCompatibilityFacts(bytes, { extension: declared.packageType === 'addon' ? '.kja' : '.kjp' });
            const required = facts.packageManifest.minimumKonjugateVersion ?? null;
            if (required && (minimumKonjugateVersion === null || compareVersions(required, minimumKonjugateVersion, { threeParts: true }) === 1)) minimumKonjugateVersion = required;
            if (facts.unsupportedApiVersion !== null && (unsupportedApiVersion === null || facts.unsupportedApiVersion > unsupportedApiVersion)) unsupportedApiVersion = facts.unsupportedApiVersion;
        } catch (error) {
            if (error instanceof PackageArchiveError) return { invalid: true, reason: error.message };
            throw error;
        }
    }
    return { minimumKonjugateVersion, unsupportedApiVersion };
}

// Whether a release with these facts suits the running Konjugate. Reasons: 'invalid', 'api-version' (required = the API
// version it needs), 'app-version' (required = the Konjugate version it needs).
export function assessFacts(facts, appVersion) {
    if (facts.invalid) return { compatible: false, reason: 'invalid', required: null };
    if (facts.unsupportedApiVersion !== null && facts.unsupportedApiVersion !== undefined) return { compatible: false, reason: 'api-version', required: facts.unsupportedApiVersion };
    const verdict = packageCompatibility({ minimumKonjugateVersion: facts.minimumKonjugateVersion }, appVersion);
    return verdict.compatible ? { compatible: true } : { compatible: false, reason: 'app-version', required: verdict.required };
}

// Walks the entry's releases newest first, reading each one's facts, and stops at the first that suits `appVersion`.
// Returns null if the entry is not on GitHub Releases or the release list could not be read; otherwise
// { newest, chosen, skipped }: `newest` is the newest release with the entry's file (whether or not it suits), `chosen` is
// { release, facts, bytes } for the newest that does (bytes only if it was downloaded in this call), or null, and `skipped`
// lists { version, reason, required } for every newer release passed over, newest first. Gives up after maxCandidates.
// `releases` may be passed in when the caller has already listed them.
export async function selectCompatibleRelease(entry, { appVersion, fetchImpl = fetch, factsCache = null, includePrereleases = false, maxCandidates = defaultMaximumCandidates, releases = null } = {}) {
    const cache = factsCache ?? createReleaseFactsCache();
    const listing = releases ?? await listGithubReleases(entry.downloadUrl, { fetchImpl, includePrereleases });
    if (!listing) return null;
    const candidates = listing.filter((release) => releaseAsset(release, entry.downloadUrl));
    const skipped = [];
    for (const release of candidates.slice(0, maxCandidates)) {
        const key = `${release.repo}@${release.tag}`;
        let facts = cache.get(key), bytes = null;
        if (!facts) {
            bytes = await downloadBytes(releaseAsset(release, entry.downloadUrl).url, fetchImpl);
            facts = readReleaseFacts(entry, bytes);
            cache.set(key, facts);
        }
        const verdict = assessFacts(facts, appVersion);
        if (verdict.compatible) return { newest: candidates[0], chosen: { release, facts, bytes }, skipped };
        skipped.push({ version: release.version, reason: verdict.reason, required: verdict.required });
    }
    return { newest: candidates[0] ?? null, chosen: null, skipped };
}

// The update check for one registry entry against what is installed (docs/extensionsExplorer.md, Update checking). Looks at
// the newest release and downloads nothing unless something newer than an installed version exists, so an up-to-date
// package costs one API call, as before. Returns { status, latest, heldBack }:
//   status 'unknown'   -- not GitHub, no releases, offline or rate-limited
//   status 'current'   -- nothing newer than what is installed, or nothing newer that this Konjugate can use and nothing held back
//   status 'update'    -- a newer release this Konjugate can use; `latest` is it
//   status 'held-back' -- a newer release exists but this Konjugate cannot use it, and there is no newer one it can
// `heldBack` is { version, required, reason } for the newest release this Konjugate cannot use (present with 'update' too, when
// the update is to an older release than the newest), otherwise null.
export async function checkEntryUpdate(entry, installedVersions, { appVersion, fetchImpl = fetch, factsCache = null, includePrereleases = false } = {}) {
    const unknown = { status: 'unknown', latest: null, heldBack: null };
    const listing = await listGithubReleases(entry.downloadUrl, { fetchImpl, includePrereleases });
    if (!listing) return unknown;
    const candidates = listing.filter((release) => releaseAsset(release, entry.downloadUrl));
    if (!candidates.length) return unknown;
    const newerThanInstalled = (version) => installedVersions.some((installed) => isNewerPackageVersion(version, installed));
    if (!newerThanInstalled(candidates[0].version)) return { status: 'current', latest: candidates[0], heldBack: null };
    let selection;
    try {
        selection = await selectCompatibleRelease(entry, { appVersion, fetchImpl, factsCache, includePrereleases, releases: listing });
    } catch {
        return unknown;
    }
    if (!selection) return unknown;
    const best = selection.chosen?.release ?? null;
    const heldBackEntry = selection.skipped.find((item) => newerThanInstalled(item.version)) ?? null;
    const heldBack = heldBackEntry ? { version: heldBackEntry.version, required: heldBackEntry.required, reason: heldBackEntry.reason } : null;
    if (best && newerThanInstalled(best.version)) return { status: 'update', latest: best, heldBack };
    return { status: heldBack ? 'held-back' : 'current', latest: best, heldBack };
}
