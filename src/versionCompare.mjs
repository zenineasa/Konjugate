/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Comparing "1.2.3"-style versions. Its own file, with no imports, because the main process (the app update check,
// package compatibility and release selection) and the Welcome page's model both need it, and a web page cannot load a
// module that imports Node.
//
// A version is dot-separated numbers (so "0.1" and "0.1.0" are equal), with an optional leading "v", an optional
// pre-release after a hyphen ("1.2.3-beta.1") and an optional build suffix after a plus, which is ignored. Package
// versions may have any number of numbers; Konjugate's own version and the app update check require exactly three, so
// "nightly" or "1.2" read as unreadable there (`threeParts`).
// Ordering follows semantic versioning's precedence: a pre-release is older than the same version without one, and
// pre-release identifiers compare as numbers when both are numeric, otherwise as text, with numbers before text and a
// shorter list before a longer one that starts the same.

const versionPattern = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value, { threeParts = false } = {}) {
    const match = versionPattern.exec(String(value ?? '').trim());
    if (!match) return null;
    const numbers = match[1].split('.').map(Number);
    if (threeParts && numbers.length !== 3) return null;
    return { numbers, prerelease: match[2] ? match[2].split('.') : [] };
}

function comparePrerelease(a, b) {
    // No pre-release sorts after any pre-release of the same version.
    if (!a.length || !b.length) return a.length === b.length ? 0 : (a.length ? -1 : 1);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        const left = a[index], right = b[index];
        const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) {
            if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
        } else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        } else if (left !== right) {
            return left < right ? -1 : 1;
        }
    }
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

// -1, 0 or 1; null if either value is not a readable version.
export function compareVersions(a, b, options = {}) {
    const left = parseVersion(a, options), right = parseVersion(b, options);
    if (!left || !right) return null;
    for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
        const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return comparePrerelease(left.prerelease, right.prerelease);
}

// Whether `latest` is a newer version than `running` (both like "1.2.3", with or without a leading "v", compared number
// by number so 1.10.0 is newer than 1.9.9). False if either is unreadable, and both must have exactly three numbers.
// This is the application's own comparison: the app update check, the Welcome window and package compatibility.
export function isNewerVersion(latest, running) {
    return compareVersions(latest, running, { threeParts: true }) === 1;
}

// The same for the versions of packages, which may have any number of numbers ("0.1" equals "0.1.0").
export function isNewerPackageVersion(latest, current) {
    return compareVersions(latest, current) === 1;
}

// Whether `version` is a stable release, not a pre-release.
export const isPrerelease = (version) => (parseVersion(version)?.prerelease.length ?? 0) > 0;
