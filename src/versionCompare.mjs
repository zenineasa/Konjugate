/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Comparing "1.2.3"-style versions. Its own file, with no imports, because both the main process
// (the update check) and the Welcome page's model need it, and a web page cannot load a module that
// imports Node.

function parseVersion(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// Whether `latest` is a newer version than `running` (both like "1.2.3", with or without a leading
// "v", compared number by number so 1.10.0 is newer than 1.9.9). False if either is unreadable.
export function isNewerVersion(latest, running) {
    const remote = parseVersion(latest);
    const current = parseVersion(running);
    if (!remote || !current) return false;
    for (let index = 0; index < 3; index += 1) {
        if (remote[index] !== current[index]) return remote[index] > current[index];
    }
    return false;
}
