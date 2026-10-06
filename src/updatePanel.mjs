/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the Updates section of the Welcome window shows, as plain data. It has no imports on purpose:
// the Welcome window is a web page with no Node, and src/updateCheck.mjs (which imports node:fs and
// friends) cannot be loaded there. The status it takes is what the update coordinator's status()
// returns (src/updateCoordinator.mjs); the window only has to draw the result.

export const allReleasesUrl = 'https://github.com/zenineasa/Konjugate/releases';

const homebrewLagNote = 'Homebrew can take a few minutes after a release to offer the new version.';
const appImageToolNote = "It needs AppImageUpdate's command-line tool (appimageupdatetool), a separate download that is not installed by default. Gear Lever and AppImageLauncher can do the same from their menus.";
const packageManagerHint = 'Installed with winget or Chocolatey? Update there instead: winget upgrade Konjugate.Konjugate  ·  choco upgrade konjugate  (new versions can take a few days to appear there).';

// Turns the status the main process holds into what the window shows: a headline, optional detail
// and hint text, buttons, and links. Plain data, so the wording and the choice of actions per install
// source are unit tested, and the window only has to draw them. `status` is what the update
// coordinator's status() returns (src/updateCoordinator.mjs).
export function describeUpdateStatus(status) {
    // A Store install makes no request, so there is nothing for "Check for updates" to do there.
    return { canCheck: status.state !== 'managedByStore', ...describeState(status) };
}

function describeState(status) {
    const links = [{ label: 'All releases', url: allReleasesUrl }];
    // A failed check after a good answer leaves that answer standing; this is how the window says so.
    const notice = status.lastAttemptFailed && status.state !== 'unknown' && status.state !== 'managedByStore'
        ? `The last check failed (${status.error}); this is what was known earlier.` : null;
    switch (status.state) {
        case 'managedByStore':
            return {
                headline: 'Updates are delivered by the Microsoft Store.',
                detail: 'The Store installs new versions automatically, usually within a few days of a release.',
                hint: null, notice: null, actions: [], links
            };
        case 'upToDate':
            return { headline: `Konjugate ${status.running} is up to date.`, detail: null, hint: null, notice, actions: [], links };
        case 'available': {
            const actions = [];
            let hint = null;
            if (status.source === 'homebrew') {
                actions.push({ kind: 'copy', label: 'Copy Command', command: status.command }, { kind: 'link', label: "What's new", url: status.latest.url, secondary: true });
                hint = homebrewLagNote;
            } else if (status.source === 'appimage') {
                if (status.command) actions.push({ kind: 'copy', label: 'Copy Command', command: status.command });
                actions.push({ kind: 'link', label: 'Download the new AppImage', url: status.latest.url, secondary: Boolean(status.command) });
                hint = appImageToolNote;
            } else {
                actions.push({ kind: 'link', label: `Download ${status.latest.version}`, url: status.latest.url });
                hint = packageManagerHint;
            }
            if (!status.skipped) actions.push({ kind: 'skip', label: 'Skip this version', version: status.latest.version });
            return {
                headline: `Konjugate ${status.latest.version} is available.`,
                detail: status.skipped ? `You're running ${status.running}. You skipped this version, so the title bar won't flag it.` : `You're running ${status.running}.`,
                command: status.command ?? null,
                hint, notice, actions, links
            };
        }
        default:
            return {
                headline: status.error ? "Couldn't check for updates." : "Konjugate hasn't checked for updates yet.",
                detail: status.error ?? 'Choose Check for updates to look now.',
                hint: null, notice: null, actions: [], links
            };
    }
}

// "Checked just now", "Checked 5 minutes ago", ... for the line under the section. null when there
// has been no successful check.
export function describeCheckedAt(checkedAt, now) {
    if (checkedAt === null || checkedAt === undefined) return null;
    const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
    if (seconds < 60) return 'Checked just now.';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Checked ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago.`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `Checked ${hours} ${hours === 1 ? 'hour' : 'hours'} ago.`;
    return `Checked ${Math.floor(hours / 24)} days ago.`;
}
