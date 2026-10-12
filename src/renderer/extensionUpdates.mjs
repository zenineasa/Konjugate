/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Extensions dialog does with the update check's answer, as plain data: which installed
// packages are outdated, how to say so, which registry entries an "Update all" has to install, and how
// to report what happened. The check itself is main.mjs's packageCheckUpdates; the buttons are the
// dialog's.

export const installedTypeLabels = { addon: 'Add-on', plugin: 'Plugin', fmu: 'FMU' };

// The installed entries that have a newer release, in the order they are listed. `updateInfoFor` is the
// dialog's own lookup of a package's update (or null).
export function outdatedEntries(entries, updateInfoFor) {
    return entries.filter((entry) => updateInfoFor(entry.packageId));
}

export function outdatedCountsByType(outdated) {
    const counts = {};
    outdated.forEach((entry) => { counts[entry.packageType] = (counts[entry.packageType] ?? 0) + 1; });
    return counts;
}

// "3 updates available: A, B and C" -- the names are what a person scans for, so a long list is cut
// short with a count rather than pushing the buttons off the strip.
export function describeOutdated(outdated, { namesShown = 3 } = {}) {
    if (!outdated.length) return '';
    const names = outdated.map((entry) => entry.name);
    const shown = names.slice(0, namesShown);
    const hidden = names.length - shown.length;
    const list = hidden > 0 ? `${shown.join(', ')} and ${hidden} more`
        : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
    return `${outdated.length} update${outdated.length === 1 ? '' : 's'} available: ${list}`;
}

// A registry entry is installed whole, so a bundle with two outdated packages is one install, not two.
// `packageUpdates` is the dialog's prefix -> { latestVersion, outdated: [...] } map.
export function updatePlan(packageUpdates) {
    return [...packageUpdates.entries()]
        .filter(([, update]) => update.outdated.length > 0)
        .map(([prefix, update]) => ({ prefix, latestVersion: update.latestVersion }));
}

// The outcomes are one per planned install: { prefix, latestVersion, results: [{ packageId, version }] }
// on success, { prefix, latestVersion, error } on failure. A release tagged newer than the package
// inside it reinstalls the same version; that is reported as nothing updated, not as an update.
export function summarizeUpdateAll(outcomes) {
    const succeeded = outcomes.filter((outcome) => !outcome.error);
    const failed = outcomes.filter((outcome) => outcome.error);
    const installed = succeeded.flatMap((outcome) => outcome.results.map((result) => ({ ...result, latestVersion: outcome.latestVersion })));
    const updated = installed.filter((result) => result.version === result.latestVersion);
    const stale = installed.filter((result) => result.version !== result.latestVersion);
    const label = (result) => `${result.packageId} ${result.version}`;
    const sentences = [];
    if (updated.length) sentences.push(`Updated ${updated.map(label).join(', ')}.`);
    if (stale.length) {
        sentences.push(`${stale.map(label).join(', ')} ${stale.length === 1 ? 'is' : 'are'} still at ${stale.length === 1 ? 'that version' : 'those versions'} although a newer release is tagged: the publisher needs to rebuild the release with the package version bumped to match its tag.`);
    }
    failed.forEach((outcome) => sentences.push(`Could not update ${outcome.prefix}: ${outcome.error}`));
    if (updated.length) sentences.push('Restart Konjugate to activate them.');
    return {
        message: sentences.join(' '),
        severity: failed.length ? 'error' : stale.length ? 'warning' : null,
        updatedCount: updated.length
    };
}
