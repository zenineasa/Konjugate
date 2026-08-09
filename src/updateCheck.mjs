/* Copyright © 2026 Zenin Easa Panthakkalakath */

const releasesEndpoint = 'https://api.github.com/repos/zenineasa/Konjugate/releases/latest';

// Matches the installer filenames the Makefile actually produces (see packageMacos/
// packageWindows/packageLinux in the Makefile): *-macos-*.dmg, *-windows-*-setup.exe,
// *-linux-*.AppImage.
const platformAssetPatterns = {
    darwin: /\.dmg$/i,
    win32: /\.exe$/i,
    linux: /\.AppImage$/i
};

function parseVersion(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(remote, current) {
    for (let index = 0; index < 3; index += 1) {
        if (remote[index] !== current[index]) return remote[index] > current[index];
    }
    return false;
}

// Checks GitHub Releases for a newer tagged version than the one currently running, with an
// installer actually attached for this platform. Returns null when up to date, when the check
// fails, or when the release doesn't (yet) have this platform's asset uploaded -- so callers
// can silently skip notifying rather than send someone to a release with nothing to download.
export async function findAvailableUpdate(currentVersion, { fetchImpl = fetch, platform = process.platform } = {}) {
    const response = await fetchImpl(releasesEndpoint, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    const remoteVersion = parseVersion(release.tag_name);
    const current = parseVersion(currentVersion);
    if (!remoteVersion || !current || !isNewer(remoteVersion, current)) return null;
    const assetPattern = platformAssetPatterns[platform];
    const hasAsset = assetPattern ? (release.assets ?? []).some((entry) => assetPattern.test(entry.name)) : false;
    if (!hasAsset) return null;
    return { version: release.tag_name.replace(/^v/, ''), url: release.html_url };
}
