/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The registry as the web edition's own static site carries it (docs/proposals/webEditionPackages.md, stage 4). The desktop reads the
// registry through GitHub's API and downloads a package from a release asset, neither of which a page can do reliably (the API is
// rate-limited per address, and a release asset redirects to a host that sends no CORS headers). So the build writes, beside the app,
// `registry/index.json` (the entries, and for each the package files mirrored from its newest release this build can use), the entries'
// images and screenshots, and the package files. A package is still checked against its publisher's key when it is installed, so the
// mirror is a convenience and not a new point of trust. Runs at build time in Node; src/webRegistry.mjs is what the page runs.

import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { fetchEntryArchive, matchDeclaredPackages } from './registryClient.mjs';
import { inspectPackageArchive, packageExtensions } from './packageInspection.mjs';

export const mirrorDirectory = 'registry';

// `registry`: { prefixes } as loaded from registry/*.json. `readAsset(path)`: the bytes of an image or screenshot beside those entries, or
// null. With `mirrorPackages`, each entry's newest release that suits `appVersion` is downloaded (through `fetchImpl`) and its packages are
// written; without it (a local build, which has no business on the network) the index carries the entries and images only, and a
// package cannot be installed from it. An entry whose packages cannot be fetched is left without any, with a note in `problems`.
// Returns { index, files, problems }: `files` maps a path under the web root to its bytes.
export async function buildRegistryMirror({ registry, readAsset, appVersion, fetchImpl = fetch, mirrorPackages = false }) {
    const files = new Map();
    const problems = [];
    const mirror = {};
    for (const [prefix, entry] of Object.entries(registry.prefixes)) {
        const assets = [entry.image, ...(Array.isArray(entry.screenshots) ? entry.screenshots.map((shot) => shot.image) : [])].filter(Boolean);
        for (const path of assets) {
            const bytes = await readAsset(path);
            if (bytes) files.set(`${mirrorDirectory}/${path}`, bytes);
            else problems.push(`${prefix}: ${path} is not in the registry directory.`);
        }
        if (!mirrorPackages || typeof entry.downloadUrl !== 'string' || !Array.isArray(entry.packages)) continue;
        try {
            const { archiveBytes } = await fetchEntryArchive(entry, { fetchImpl, appVersion, release: null, factsCache: null, includePrereleases: false });
            const matches = matchDeclaredPackages(entry, archiveBytes, unzipSync(archiveBytes));
            const mirrored = [];
            for (const declared of entry.packages) {
                const bytes = matches.get(declared.packageId);
                if (!bytes) throw new Error(`the download does not contain "${declared.packageId}".`);
                const extension = packageExtensions[declared.packageType];
                const { packageManifest } = inspectPackageArchive(bytes, { extension });
                const file = `packages/${prefix}/${packageManifest.packageId}-${packageManifest.version}${extension}`;
                files.set(`${mirrorDirectory}/${file}`, new Uint8Array(bytes));
                mirrored.push({
                    packageType: packageManifest.packageType, packageId: packageManifest.packageId, version: packageManifest.version, file,
                    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), minimumKonjugateVersion: packageManifest.minimumKonjugateVersion ?? null
                });
            }
            mirror[prefix] = { packages: mirrored };
        } catch (error) {
            problems.push(`${prefix}: not mirrored (${error.message})`);
        }
    }
    const index = { format: 'konjugate-web-registry', formatVersion: 1, prefixes: registry.prefixes, mirror };
    files.set(`${mirrorDirectory}/index.json`, new TextEncoder().encode(JSON.stringify(index)));
    return { index, files, problems };
}

