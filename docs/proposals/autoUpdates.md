<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Automatic app updates

**Status: proposed, not started.** Grounded in a real, working implementation examined directly
(a separate, unrelated Electron project's release pipeline — not Konjugate code, referenced here
only for its design) rather than assumed from `electron-updater`'s docs alone. Nothing below has
been built or tested against Konjugate's own packaging output yet.

## Problem

Konjugate has no update mechanism today. A user who installs v0.7.x has to notice a new release
exists (by revisiting the GitHub Releases page) and manually repeat the whole install flow. There's
no in-app "a new version is available" signal, no background download, no one-click apply.

## The mechanism: `electron-updater` against GitHub Releases as a static feed

The standard, well-trodden approach for an Electron app is
[`electron-updater`](https://www.electron.build/auto-update) (from the `electron-builder` project,
but usable independently of that packager). It doesn't need a custom update server: GitHub Releases
itself serves as the "feed" — a small YAML manifest (`latest-mac.yml`, `latest.yml` for Windows,
`latest-linux.yml`) uploaded as a release asset alongside the real installers tells a running app
whether a newer version exists, where to download it, and its SHA-512 for integrity verification.
This is confirmed as a real, production pattern (not just documented behavior) by direct inspection
of another Electron project's actual release pipeline:

- A packaged app calls `electron-updater`'s `checkForUpdates()` periodically (a real example: hourly
  on a stable channel, every 15 minutes on a nightly/beta channel, plus once at launch).
- It fetches `<repo>/releases/latest/download/latest-mac.yml` (macOS), `latest.yml` (Windows), or
  `latest-linux.yml` (Linux) — no custom endpoint, this resolves directly against GitHub's own
  release-asset URLs.
- If the manifest's version is newer, it downloads the matching installer asset, verifies its
  SHA-512 against the manifest entry, and stages it.
- `autoUpdater.quitAndInstall()` applies the update and relaunches. On macOS this hands off to
  Squirrel.Mac's `ShipIt` helper, which swaps the `.app` bundle on disk; Windows uses the NSIS
  installer's own silent-update mode; Linux (AppImage) replaces the file in place using a blockmap
  embedded in the AppImage itself.

No server-side component is required — the feed is genuinely just static files on GitHub's CDN.

## The hard blocker: this needs the same macOS signing Konjugate has deliberately deferred

**Squirrel.Mac (the mechanism `electron-updater` uses to apply macOS updates) requires a signed,
notarized app to function at all.** This is a *documented, incident-driven* requirement in the
reference implementation, not a theoretical concern: their release pipeline runs a dedicated
artifact-verification script before and after every update-mechanism test specifically because an
unsigned or improperly-sealed build produces a **false "damaged/corrupted" failure that looks like
a real bug but is actually just Gatekeeper rejecting an unsigned bundle**. Their own code comment on
this: *"An unsigned or unstapled baseline cannot auto-update, so a failure here is a real signal,
not harness noise."*

Concretely, this means auto-update on macOS is blocked by the exact same unresolved item already
tracked in [Package manager distribution](../packageManagerDistribution.md): no Apple Developer ID,
no notarized builds. Windows and Linux don't have this hard dependency — NSIS's own updater mode
and the AppImage blockmap mechanism work against an unsigned build (with the same SmartScreen-style
warning Konjugate's installers already show today) — so a phased rollout (Windows/Linux now, macOS
once signing lands) is a real, viable option, not just a hedge.

## What's different about Konjugate's build, versus the reference implementation

The reference project uses Electron Forge, and its packaging pipeline still doesn't natively emit
the `latest*.yml` feed manifests `electron-updater` expects (that's normally `electron-builder`'s
job, and Forge isn't `electron-builder`) — so they hand-write a small script that generates the YAML
itself, including the SHA-512 hash and file size per artifact. Konjugate is in the same position for
a different reason: it uses `@electron/packager` directly (`scripts/packageElectron.mjs`), not
`electron-builder` and not Forge — so this feed-generation step would need to be hand-written for
Konjugate too, following the same manifest shape (`version`, `files: [{url, sha512, size}]`, `path`,
`sha512`, `releaseDate`). There's no shortcut here specific to either packager; this is inherent to
not using `electron-builder`.

Two more concrete gaps, found by comparing to Konjugate's actual `Makefile`/`release.yml`:

- **No ZIP artifact for macOS today.** `distributableMacos` produces only a `.dmg` (for manual
  first-time installs). Squirrel.Mac's update mechanism needs a **ZIP of the `.app` bundle**, not a
  DMG — the reference implementation's macOS update artifact is literally
  `<app>-darwin-<arch>.zip`, built and signed the same way the `.app` itself is. This would be a new,
  additional build output alongside the existing DMG, not a replacement for it.
- **Artifact naming doesn't match `electron-updater`'s expectations.** Konjugate's current naming
  (`Konjugate-<version>-macos-<arch>.dmg`, `-windows-<arch>-setup.exe`, `-linux-<arch>.AppImage`,
  all defined in `Makefile`) is a project-specific convention, not what `electron-updater` looks for
  by default. Since the feed manifest is hand-written either way (previous point), this isn't a
  blocker — the manifest just needs to point at whatever Konjugate actually names its files — but
  it's a real detail to get right, not something to assume works unmodified.

## A Konjugate-scoped version of this — deliberately smaller than the reference implementation

The reference project splits releases across two repositories (a public unsigned-build repo and a
private signing "conductor" repo) and supports stable/nightly/per-PR-preview channels. That split
exists for a team operating at a scale and security posture Konjugate doesn't need yet — a
single-maintainer, single-repo project doesn't gain much from a second private repo just to hold
signing credentials that could equally be GitHub Actions secrets in this one repo (the same model
`release.yml` already uses, or would use, for winget/Snap credentials — see
[Package manager distribution](../packageManagerDistribution.md)). A first version for Konjugate
should stay single-repo and single-channel (stable only — no nightly/preview channel until there's
a real reason for one):

1. **Add a signed+notarized macOS ZIP build step** to `distributableMacos` (or a new Makefile
   target) once signing exists — packaging the same `.app` the DMG already stages, as a ZIP instead.
2. **Write a feed-manifest generator script** (`scripts/generateUpdateFeed.mjs`, following this
   repo's existing `scripts/generate*.mjs` convention) that hashes the built release artifacts
   (SHA-512, per `electron-updater`'s manifest format) and writes `latest-mac.yml`/`latest.yml`/
   `latest-linux.yml`.
3. **Add `electron-updater` as a dependency** and wire it into `src/main.mjs` — a `configureFeed`-
   style setup (channel, allow-prerelease flags), the event listeners (`checking-for-update`,
   `update-available`, `download-progress`, `update-downloaded`, `error`) forwarded to the renderer
   over IPC so the UI can show progress, and a `quitAndInstallUpdate()` call wired to a menu item or
   settings action. Konjugate doesn't yet have a Settings-style panel this would naturally live in —
   that's a real, separate small UI task, not just backend wiring.
4. **Extend `release.yml`** to run the feed-generator step and upload `latest*.yml` alongside the
   existing DMG/EXE/AppImage release assets, right after the existing `release` job.
5. **A macOS App Translocation check** is worth carrying over deliberately, not just as a nice-to-
   have: if a user launches Konjugate straight from `~/Downloads` (Gatekeeper's randomized read-only
   translocation mount) rather than `/Applications`, an update can silently fail to apply. The
   reference implementation detects this specific case and disables auto-install with an explicit
   message telling the user to move the app first, rather than let it silently no-op. That failure
   mode isn't hypothetical — it's the natural way most users first run a downloaded macOS app.

## Testing

The reference implementation's own end-to-end update test is a useful model, and its framing is
worth keeping deliberately: it runs **after** a release is published, against the real live GitHub
feed (not a pre-release gate) — install the previous version, launch it, trigger a real update
check against the real published manifest, wait for it to stage, quit (triggering the actual
install swap), relaunch, and assert the version and a basic health check both come back correct. A
failure means "something's wrong with the release that just went out," not "block the release about
to go out" — those are different failure modes and the reference project is explicit that
conflating them is a mistake. This would be a new, macOS-runner-only workflow for Konjugate
(`.github/workflows/`), dispatched manually or right after `release.yml` completes — not attempted
here, since it depends on the signing/ZIP/feed work above existing first.

## Scope note

This whole proposal is downstream of the same signing decision already deferred in
[Package manager distribution](../packageManagerDistribution.md). A reasonable incremental path,
if this is picked up before signing happens: build the Windows/Linux half first (feed generator,
`electron-updater` wiring, `release.yml` integration) since neither needs signing to function, and
add the macOS ZIP/Squirrel half once notarized builds exist. Doing Windows/Linux alone is a real,
shippable improvement on its own, not a stub waiting on macOS.
