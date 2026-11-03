/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The registry as the web edition reads it (docs/proposals/webEditionPackages.md, stage 4): the mirror the build writes beside the app
// (src/webRegistryMirror.mjs). Nothing here uses Node or the page, only `fetch` and WebCrypto passed in, so the rules are the same under
// test as in a browser. The page's window.extensions answers Discover, install and update checks from these.

import { registryImagePathPatternForWeb, registryScreenshotPathPatternForWeb } from './webRegistryPaths.mjs';
import { isNewerPackageVersion } from './versionCompare.mjs';

export class WebRegistryError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'WebRegistryError';
        this.code = code;
    }
}

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// `base`: the address of the mirror's directory, ending in a slash. Returns { registry: { prefixes }, mirror, stale: false }. A site without a
// mirror (404) is an empty registry, as a repository without one is on the desktop.
export async function fetchMirrorIndex({ fetchImpl = fetch, base }) {
    const response = await fetchImpl(new URL('index.json', base));
    if (response.status === 404) return { registry: { prefixes: {} }, mirror: {}, stale: false };
    if (!response.ok) throw new WebRegistryError(`Could not read the registry (HTTP ${response.status}).`, 'FETCH_FAILED');
    const data = await response.json();
    if (data?.format !== 'konjugate-web-registry' || typeof data.prefixes !== 'object' || data.prefixes === null) throw new WebRegistryError('The registry is not in a format this version can read.', 'INVALID_REGISTRY_FORMAT');
    return { registry: { prefixes: data.prefixes }, mirror: data.mirror ?? {}, stale: false };
}

// The package files of an entry, downloaded from the mirror and checked against the size and SHA-256 the index recorded:
// [{ declared, bytes }] in the order the entry lists them. Throws WebRegistryError when the entry was not mirrored or a file is not as recorded.
export async function fetchMirroredPackages(prefix, index, { fetchImpl = fetch, base, subtle = globalThis.crypto?.subtle }) {
    const mirrored = index.mirror?.[prefix]?.packages;
    if (!mirrored?.length) throw new WebRegistryError('This package is not available from the web edition\'s registry yet. Install it from a file instead.', 'NOT_MIRRORED');
    const results = [];
    for (const declared of mirrored) {
        if (/(^|\/)\.\.(\/|$)|^\/|:/.test(declared.file)) throw new WebRegistryError('The registry names a file outside itself.', 'INVALID_REGISTRY_FORMAT');
        const response = await fetchImpl(new URL(declared.file, base));
        if (!response.ok) throw new WebRegistryError(`Could not download ${declared.packageId} (HTTP ${response.status}).`, 'DOWNLOAD_FAILED');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== declared.bytes || (subtle && hex(new Uint8Array(await subtle.digest('SHA-256', bytes))) !== declared.sha256)) {
            throw new WebRegistryError(`${declared.packageId} was not downloaded intact. Try again.`, 'DOWNLOAD_CORRUPT');
        }
        results.push({ declared, bytes });
    }
    return results;
}

// An entry's image or screenshot as the mirror holds it: { mimeType, bytes }, or null when the entry has none or the file is not there.
export async function fetchMirroredImage(entry, screenshotIndex, { fetchImpl = fetch, base }) {
    const path = screenshotIndex === null ? entry?.image : entry?.screenshots?.[screenshotIndex]?.image;
    const pattern = screenshotIndex === null ? registryImagePathPatternForWeb : registryScreenshotPathPatternForWeb;
    if (typeof path !== 'string' || !pattern.test(path) || path.includes('..')) return null;
    const response = await fetchImpl(new URL(path, base));
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes[8] === 0x57 && bytes[9] === 0x45 ? 'image/webp' : null;
    return mimeType ? { mimeType, bytes } : null;
}

// What is newer in the mirror than what is installed, in the shape the Extensions window reads (the desktop's checkPackageUpdates):
// [{ prefix, latestVersion, releaseUrl, outdated: [{ packageId, installedVersion }], heldBackPackages }]. The mirror holds, for each entry,
// the newest release this build can use, so a newer one this build cannot use is never offered. `installed`: the store's list().
export function mirrorUpdates(index, installed) {
    const updates = [];
    for (const [prefix, { packages }] of Object.entries(index.mirror ?? {})) {
        const outdated = [];
        let latestVersion = null;
        for (const mirrored of packages ?? []) {
            for (const entry of installed.filter((item) => item.packageType === mirrored.packageType && item.packageId === mirrored.packageId)) {
                if (isNewerPackageVersion(mirrored.version, entry.version)) {
                    outdated.push({ packageId: mirrored.packageId, installedVersion: entry.version });
                    latestVersion = mirrored.version;
                }
            }
        }
        if (outdated.length) updates.push({ prefix, latestVersion, releaseUrl: null, outdated, heldBackPackages: [] });
    }
    return updates;
}
