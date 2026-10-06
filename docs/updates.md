---
type: Guide
title: How Konjugate gets updated
description: Who updates Konjugate for each install channel, what the app tells you about updates, and the decisions about the Microsoft Store and the AppImage.
tags: [updates, distribution, microsoft-store, appimage, homebrew]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# How Konjugate gets updated

Konjugate is distributed through several channels (see [Package manager distribution](packageManagerDistribution.md)), and each has its own way of updating. This document records who updates what, what the app itself says about updates, and the decisions that keep those two from contradicting each other. Everything described here is built except where a row says otherwise.

## What the app does

It asks GitHub's releases API for the latest release every launch, and again when a window regains focus once the last good answer is a day old (see "When it checks" below). If that release is newer than the running version **and** has an installer for the current platform, a small dot appears on the title bar's **Konjugate** button, and the **Updates** section at the top of the Welcome window (which that button opens) says what is available and what to do about it. It is notify-only: it never downloads or installs anything, and it never interrupts with a dialog. A failed automatic check is silent; a failed manual check says so. Full in-app download-and-install is a separate, larger idea that is blocked on macOS code signing; see the [automatic updates proposal](proposals/autoUpdates.md).

## How each install channel gets updates

| Installed from | Updated by | Delay after a release is published | What the Updates section shows |
| --- | --- | --- | --- |
| Microsoft Store | The Store, automatically | Up to three business days of certification, then about 15 minutes | **Not shown** |
| Windows installer from GitHub | The user downloads the new `-setup.exe`; it upgrades in place | None | Shown |
| winget | `winget upgrade Konjugate.Konjugate` | The bump pull request has to be merged by Microsoft's moderators: hours to days | Shown |
| Chocolatey | `choco upgrade konjugate` | Moderation: days to weeks for a first version, faster afterwards | Shown |
| macOS DMG from GitHub | The user downloads the new DMG | None | Shown |
| Homebrew tap (macOS) | `brew upgrade --cask konjugate` | Minutes (the release workflow commits the new cask) | Shown with that command and a **Copy Command** button |
| AppImage from GitHub | The user downloads the new AppImage, or updates it in place with AppImageUpdate (below) | None | Shown with the `appimageupdatetool` command for that file and a **Copy Command** button |
| Homebrew on Linux (AppImage cask) | `brew upgrade --cask konjugate` | Minutes | Shown with the `brew` command, not the AppImage one |

Two things follow from the table. The update appears the moment a GitHub release exists, which is before winget, Chocolatey and the Store have the new version. And the app cannot tell a winget, Chocolatey or Homebrew install from a manual one, so those users see "View Release" and can reasonably ignore it.

## Decision 1: Store installs are told the Store handles it

A Store install is updated by the Store. Showing a Store user the GitHub download is wrong in two ways: it announces the update days before the Store has certified it, and following it installs the NSIS installer from GitHub **alongside** the Store copy, leaving two copies of Konjugate that fight over the `.kjt` file association.

**How:** Electron sets `process.windowsStore` to `true` when the app runs as a Store/MSIX app. In that case the coordinator never makes a request, the badge never appears, and the Updates section says "Updates are delivered by the Microsoft Store" instead. The check is unchanged everywhere else. The decision lives in small pure functions in `src/updateCheck.mjs` — `installSource` (from the platform, `process.windowsStore` and the `APPIMAGE` environment variable) and `shouldCheckForUpdates` — so it is unit tested without Electron (`tests/updateCheck.test.mjs`, and `tests/updateCoordinator.test.mjs` checks that a Store install makes no request on launch, on focus or on the button). One thing not yet confirmed: that `process.windowsStore` really is `true` in a Store-installed build; check that no update notice appears on a Store copy after the next release.

**The MSIX is not published on GitHub, deliberately.** The MSIX that CI builds is unsigned; Windows refuses to install an unsigned MSIX, and the Store only signs a package when it is submitted through Partner Center. Making it installable from GitHub would need a code-signing certificate, or asking users to trust a self-signed one, which is the warning the Store route exists to avoid. So the GitHub release keeps carrying only the NSIS installer, the DMGs and the AppImage, and the MSIX stays a workflow artifact (see the Microsoft Store section of [Package manager distribution](packageManagerDistribution.md)).

## Decision 2: the AppImage stays notify-only; zsync is for external tools

Every AppImage the release builds carries update information (`gh-releases-zsync|zenineasa|Konjugate|latest|Konjugate-*-x86_64.AppImage.zsync`, set by `appImageUpdateInformation` in the `Makefile`), and each release publishes the matching `Konjugate-<version>-x86_64.AppImage.zsync` file next to the AppImage. Tools such as AppImageUpdate, Gear Lever and AppImageLauncher read that information and update the AppImage in place, downloading only the changed parts. This already works today without any code in Konjugate.

Konjugate does not drive that update itself. It would have to find or bundle one of those tools, run it against the AppImage that is currently executing, and restart afterwards, for a platform where the people most likely to use AppImages already have a manager that does this. What it does instead is put the update command in front of the person: when `process.env.APPIMAGE` is set (the AppImage runtime sets it), the notice shows the command already filled in with the real location of the running file, read from that variable (for example `appimageupdatetool '/home/me/Apps/Konjugate-1.1.8-x86_64.AppImage'`), so nothing has to be typed or looked up; it comes with a **Copy Command** button, and the path is shell-quoted so it pastes as one word, and says that the tool is a separate download (AppImageUpdate's command-line tool; it is not installed by default) and that Gear Lever and AppImageLauncher can do the same from their menus. **Not yet confirmed:** the tool's name comes from the AppImageUpdate project, but its exact command line was not checked against a running copy, so try the command on a real Linux machine before relying on it, and say so in the ReadMe only once it works.

Not measured: how small the delta download actually is. An Electron app is mostly one large compressed file system, and block-level deltas against it can save much less than the file size suggests. Measure it (update from one release to the next with AppImageUpdate and compare bytes downloaded) before promoting the in-place route in the ReadMe.

## Decision 3: Homebrew users are shown the command; package-manager lag keeps it off the others

For a Homebrew install the right action is `brew upgrade --cask konjugate`, and following the plain download link instead (a DMG) leaves Homebrew believing the old version is installed. So when the app can tell it was installed by Homebrew, the Updates section shows the command, with **Copy Command**, and a link to what's new, and no download button. The app tells by looking for the cask's folder in Homebrew's Caskroom (`/opt/homebrew/Caskroom/konjugate`, `/usr/local/Caskroom/konjugate`, the Linux prefixes, and `$HOMEBREW_PREFIX` when set — it usually is not for an app launched from Finder, so fixed paths are needed). A Linux cask install is also an AppImage, and Homebrew wins: `brew upgrade` is the right way to update it. The tap's cask is updated by the release workflow within minutes, so the command works almost as soon as the notice appears, and the notice says Homebrew can lag by a few minutes.

**Not done for Chocolatey or winget.** Chocolatey installs are detectable (the package folder `%ChocolateyInstall%\lib\konjugate`), but a new version can sit in moderation for days, so "run `choco upgrade konjugate`" would send people to a command that says there is nothing to upgrade. winget leaves nothing the app can detect and has the same lag. Both are served by the plain download plus the package-manager hint line.

## The update experience

Konjugate first told people about updates with a native dialog shown at every launch. That nagged (a "Later" only lasted until the next launch), it opened at the same moment as the Welcome window, it interrupted for something optional, and there was no way to find it again or to look on purpose. The experience below replaced it. Every decision above (the Store, the `brew` command, the `appimageupdatetool` command, the package-manager hint) moved into it unchanged; only where and when it is shown changed. It is built; the sections below describe how it behaves and why.

**Principles.** Tell the right person the action that works for how they installed it. Be quiet by default: an optional update never takes over the screen. Say it once: a skipped version stays skipped until a newer one exists. Never contradict a channel (no notice for the Store, no command that would say "nothing to upgrade"). Always leave a way to find the releases by hand. Be honest about what cannot be detected (winget, Chocolatey and a plain DMG look alike).

**Two surfaces, no launch dialog.**
1. **A badge on the title bar's Konjugate button** (`#welcomeButton`), in the style of the Extensions button's existing update badge. It appears once a check finds a newer version that has not been skipped or snoozed, with the tooltip "Konjugate 1.1.9 is available". Nothing else happens: no dialog, no sound, no focus change.
2. **An "Updates" section at the top of the Welcome window,** which that button opens from anywhere (so it is always reachable, including after the launch Welcome window has been closed or skipped). It shows the running version and one of: "You're up to date", "Konjugate 1.1.9 is available", "Updates are delivered by the Microsoft Store" (Store installs, which never get a badge), or "Couldn't check for updates" with the reason. It always has a **Check for updates** button and an **All releases** link to the GitHub releases page.

**What the available-update section offers, by install source.** Always a link to what's new (the release page). Then: Homebrew — `brew upgrade --cask konjugate` with **Copy Command**. AppImage — the `appimageupdatetool '<real path>'` command with **Copy Command**, and a download link as the alternative. Everything else — a **Download** button (the release page), plus one line for people who installed with a package manager: "Installed with winget or Chocolatey? Update there instead: `winget upgrade Konjugate.Konjugate` · `choco upgrade konjugate` (new versions can take a few days to appear there)". That hint is how winget and Chocolatey users are served without detecting them: the primary action stays the plain download, and a lagging channel is never the main advice. Last, **Skip this version**.

**What each control does.** *Skip this version* is remembered for that version number, across restarts; the badge disappears and stays gone until a newer version is found. There is deliberately no "remind me later": the badge is quiet, so there is nothing to be reminded of. *Check for updates* ignores the skip, asks GitHub now, and shows the result in place; it is the only thing that reaches GitHub on demand. A failed automatic check is silent (no network, a rate limit), but a failed manual check says so.

**When it checks.** Every launch, immediately after the first window opens, and again whenever a window regains focus and the last successful check is more than 24 hours old. That second rule is what covers an app left running for days, and it needs no timer: there is no sleep problem to work around (a timer that does not count the time the computer is asleep), no background activity, and the badge appears when the person returns to the app, which is when they will notice it. A failed check does not count as a success, so the next focus tries again, but never more than once every 15 minutes, so an offline laptop is not retried on every click. It is one check per app run, made by the main process, not one per window; a window opened later just reads the latest answer. A Store install makes no request at all. Any check that finds a newer, not-skipped version shows the badge in every open window; none of them opens a dialog. The schedule is two small pure functions — `isCheckDue(now, lastSuccess, lastAttempt)` and `shouldShowBadge(latest, running, skipped)` — so it is tested with a fake clock.

**What is stored.** One value, kept across restarts in a tiny file in the user data folder: the version the person skipped. Nothing identifies the user, and nothing is sent anywhere beyond the same GitHub request as today, which the privacy policy's existing line about the release check already covers. The latest answer is kept in memory only, so a launch with no network shows no badge until a check succeeds. What was considered and left out as more machinery than it earns: a stored ETag for conditional requests, a persisted copy of the last answer, an hourly timer with a one-hour retry schedule, and a "remind me later" with its own expiry.

**What it deliberately does not do:** download or install anything, restart the app, or record anything about the person. Those belong to the full auto-update proposal, which is blocked on macOS signing.

**Where it lives in the code.** `src/updateCheck.mjs`: fetching and reading the release, the install-source and command rules, and the two pure schedule functions `isCheckDue` and `shouldShowBadge`. `src/updateCoordinator.mjs`: the in-memory answer and the schedule, with the release fetch, the clock, the skip store and the change callback all passed in so it is tested with a fake clock. `src/updateSkipStore.mjs`: the skipped version, the one persisted value (`updateSkipped.json`). `src/updatePanel.mjs`: what the Updates section shows, as plain data; it imports nothing, because the Welcome window is a web page without Node. The main process (`src/main.mjs`) creates one coordinator, starts the launch check, asks again on window focus, pushes status to every open window, and answers four channels (`appUpdateStatus`, `appUpdateCheckNow`, `appUpdateSkip`, `appUpdateCopyCommand`; the copy handler takes no text from the window). The badge is in `src/renderer`, the section in `src/exampleGuide`. `tests/updateWiring.test.mjs` checks that the main process, both preloads and both pages agree with each other.

## Known issues found while writing this

- **The Homebrew cask used to declare `auto_updates true`,** copied from official-cask conventions, although Konjugate does not update itself. As I understand Homebrew's behaviour, such casks are left out of a plain `brew upgrade` and `brew outdated` unless the user adds `--greedy`, so users could have missed updates. The line is removed from the template in `scripts/generateHomebrewCask.mjs` (both flavors); the tap's published cask loses it with the next release.
- **winget and Chocolatey are not told apart from a manual install.** Those users see the plain GitHub link (decision 3 explains why they get no command). Accepted for now.

## Status

| Item | State |
| --- | --- |
| Check at launch and on focus once 24 hours old, throttled to one attempt per 15 minutes, with tests on a fake clock | Built |
| Skip this version, remembered across restarts | Built |
| Badge on the title bar's Konjugate button | Built |
| Updates section in the Welcome window: status, Check for updates, All releases, per-channel actions, skip | Built, rendered and exercised in a browser with a stand-in for Electron's bridge; not yet seen in the packaged app |
| The launch dialog | Removed |
| No request and no badge for a Store install (`process.windowsStore`) | Built; to be confirmed on a Store-installed build |
| The `appimageupdatetool` command with Copy Command (`APPIMAGE`) | Built; the command itself still to be tried on a real Linux machine |
| Homebrew detection (Caskroom folder) and the `brew upgrade --cask konjugate` command with Copy Command | Built; to be tried once the public tap exists |
| Remove `auto_updates true` from the generated Homebrew cask | Built; reaches the tap with the next release |
| Measure the AppImage zsync delta size | Not started |
| In-app download-and-install | Proposal only, blocked on macOS signing ([proposal](proposals/autoUpdates.md)) |
