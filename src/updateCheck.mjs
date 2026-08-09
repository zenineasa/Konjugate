/* Copyright © 2026 Zenin Easa Panthakkalakath */

const releasesEndpoint = 'https://api.github.com/repos/zenineasa/Konjugate/releases/latest';

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

// Checks GitHub Releases for a newer tagged version than the one currently running. Returns
// null when up to date (or when the check fails) so callers can silently skip notifying.
export async function findAvailableUpdate(currentVersion, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl(releasesEndpoint, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    const remoteVersion = parseVersion(release.tag_name);
    const current = parseVersion(currentVersion);
    if (!remoteVersion || !current || !isNewer(remoteVersion, current)) return null;
    return { version: release.tag_name.replace(/^v/, ''), url: release.html_url };
}
