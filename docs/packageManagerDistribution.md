---
type: Guide
title: Package manager distribution
description: Automated packaging and distribution workflows for winget, Chocolatey, the Microsoft Store, Homebrew Cask, Snap, and Flathub.
tags: [distribution, winget, chocolatey, microsoft-store, homebrew, flatpak, release]
status: partially_implemented
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Package manager distribution

Konjugate's release pipeline (`.github/workflows/release.yml`) already builds an unsigned DMG/EXE/AppImage on every `v*` tag and publishes them to a GitHub Release — see [releasePackaging.md](releasePackaging.md). This document covers the next layer: getting those same builds discoverable through Homebrew Cask, winget, Chocolatey, the Microsoft Store, Snap, and Flathub.

Two decisions shape everything below, both made deliberately: Konjugate ships **unsigned** for now (no Apple Developer ID, no Windows code-signing certificate — revisit once there's real traction), and none of the channels here cost anything to register on or publish through, so nothing is being skipped for budget reasons.

**Current status:** winget and Chocolatey have CI jobs in `release.yml` (`wingetRelease`, `chocolateyRelease`) that run on every `v*` tag but are opt-in by secret — with `WINGET_TOKEN` / `CHOCOLATEY_API_KEY` unset, the job skips its real step with a notice instead of failing, so a release never goes red for a channel that isn't set up yet. Each needs a one-time human setup step first (see their sections). Homebrew Cask and Snap are deferred with no job (Cask is blocked by notarization and notability requirements; Snap by a missing store credential and an untested `snapcraft.yaml`), and Flathub is blocked by its own project-maturity and AI-content policies (see its section) — revisit once those no longer apply.

## Shared app metadata

`packaging/appMetadata.yml` is the one source for the descriptive text (name, summary, description, homepage, bugtracker, license, categories, screenshot) that more than one packaging format needs. It exists because that text was previously hand-copied separately into `packaging/linux/com.konjugate.Konjugate.metainfo.xml` and `distribution/snap/snapcraft.yaml`, and had already drifted — the two `description` fields differed by one punctuation mark before anyone noticed. Run `npm run generate:app-metainfo` (`scripts/generateAppMetainfo.mjs`) after editing it to regenerate the AppStream file; `appstreamcli validate` should still pass cleanly afterward.

`distribution/snap/snapcraft.yaml` is not generated from this yet — it isn't wired into `release.yml` today (see its own section below), so that's a real but lower-priority follow-up rather than something worth the risk of editing an unverified manifest alongside this change. Update it by hand to match if `appMetadata.yml` changes in the meantime.

The generated file's own `<releases>` entry and screenshot URL version tag are still only a last-known-good snapshot at the moment someone runs the generator — `Makefile`'s `distributableLinux` target unconditionally overwrites both with the live `package.json` version at actual AppImage build time regardless (see that target's own comment), so the shipped binary's embedded copy can never be stale even if the generator hasn't been re-run recently.

## Homebrew Cask — deferred, two real blockers found

**Status: on hold, not wired into CI.** A real `brew audit --cask --new konjugate` run (see below) surfaced two hard requirements this project doesn't meet yet, confirmed directly against Homebrew's own review tooling, not just their docs:

1. **Notarized, signed macOS binaries.** Homebrew Cask requires distributed macOS binaries to be signed and notarized with an Apple Developer ID and pass Gatekeeper — the `xattr -cr` workaround in the cask's own `caveats` (needed because Konjugate ships unsigned today, see [releasePackaging.md](releasePackaging.md)) is exactly the kind of thing official casks aren't allowed to paper over. Resolved once Konjugate has a real Apple Developer ID and notarized builds — see this doc's intro note on signing.
2. **Notability.** New casks need roughly 75 GitHub stars or 30 forks/watchers. Konjugate isn't there yet.

Neither is a one-time setup step the way winget's/Snap's credentials are — both take real time (getting an Apple Developer ID and notarizing builds, growing the project's traction) rather than an afternoon of account setup. That's why, unlike winget and Snap, **there is no `homebrewCaskBump` job in `release.yml`** — a job that can only ever fail until both of these are true would just be permanent CI noise. Revisit this section once both are met.

What's kept, ready for when that's true:
- `scripts/generateHomebrewCask.mjs` (`npm run homebrew:generate-cask`) generates `distribution/homebrew/konjugate.rb` (gitignored) from the latest published release — both macOS DMGs and the Linux AppImage, via the same `on_macos`/`on_linux` + `app_image` pattern real casks like `cursor.rb`/`warp.rb` use (confirmed Homebrew Cask has real Linux support, not just macOS).
- Once notarization + notability are both true, the submission flow is: run the generator, fork `Homebrew/homebrew-cask`, copy the output to `Casks/k/konjugate.rb`, and follow their real PR checklist (`brew audit --cask --new`, `brew style --fix`, a real local install/uninstall cycle, plus their mandatory AI-usage disclosure if a tool helped draft it — see `docs.brew.sh/Responsible-AI-Usage`). Re-add a `homebrewCaskBump` job to `release.yml` (mirroring `wingetRelease`'s shape, using `eugenesvk/action-homebrew-bump-cask`) once that first PR is merged.

## winget

**Automated:** the `wingetRelease` job in `release.yml` runs after the GitHub Release is published and uses `vedantmgoyal9/winget-releaser` to open a version-bump PR against `microsoft/winget-pkgs`. It only runs its real step when the `WINGET_TOKEN` secret is set. That action's own first build step explicitly checks that the `identifier` already exists in `microsoft/winget-pkgs` and errors out if not (confirmed by reading its source directly, not assumed from its docs) — it calls `komac update`, never `komac new`, so it can't create the first listing. That's why the token must only be added after step 3 below has merged.

**One-time setup, in order:**
1. Decide the winget `PackageIdentifier` (winget's `Publisher.Package` convention) — `release.yml` uses `Konjugate.Konjugate`; if you pick another, use the same value in step 3 and in the job.
2. Fork `microsoft/winget-pkgs` under your own GitHub account.
3. Submit the first manifest by hand — either `wingetcreate new` or `komac submit`, pointed at a published `-setup.exe` release asset — as a PR to `microsoft/winget-pkgs`, and wait for it to merge.
4. Generate a **classic** PAT with `public_repo` scope, stored as this repo's `WINGET_TOKEN` secret.

From the next tag on, the job opens the bump PR automatically. Microsoft's bots validate it and the merge is outside this project's control, so a new version appears in winget some hours or days after the release, not instantly. The installer is unsigned, so reviewers' Defender scan occasionally flags a false positive that needs a manual resubmission.

## Chocolatey

**Automated:** the `chocolateyRelease` job in `release.yml` runs on a Windows runner after the GitHub Release is published. It only runs its real step when the `CHOCOLATEY_API_KEY` secret is set. It runs `scripts/generateChocolateyPackage.mjs`, which fills the templates in `packaging/chocolatey/` (a `.nuspec`, `chocolateyInstall.ps1`, `chocolateyUninstall.ps1`) from the real published release and `packaging/appMetadata.yml`, then `choco pack` and `choco push` the result. The generator downloads the just-published `-setup.exe` and computes its sha256, so the checksum in the pushed package is verified against exactly what users get. The install script runs the NSIS installer with `/S` (the same silent path `release.yml` exercises in CI); the uninstall script finds the installer's Add/Remove Programs entry rather than hardcoding a path. Run `node scripts/generateChocolateyPackage.mjs [vTag]` locally to inspect the output in `out/chocolatey/` without pushing anything.

**One-time setup:**
1. Create an account on chocolatey.org and copy the API key from its account page.
2. Store it as this repo's `CHOCOLATEY_API_KEY` secret.

**What to expect:** a successful `choco push` only means the package entered Chocolatey's moderation queue, not that it's live. New packages go through automated checks (VirusTotal scan, install/uninstall test on a clean VM) and then human moderation, which for a first package can take days to weeks with back-and-forth. The unsigned installer can trigger a VirusTotal false positive; a rejection arrives by email and is answered on the package's page, not in CI. After a version has been approved, later versions are validated faster.

`iconUrl` in the nuspec points at `assets/icon.svg` on `master` on GitHub, because the PNG/ICO icons are generated and gitignored. If moderation objects to an SVG icon, commit a PNG and change that URL.

## Microsoft Store — spike passed, CI automation written but untested

**Status:** the spike passed on a real Windows machine (see "Spike results" below), and `release.yml` can build and submit the MSIX, but nothing has been submitted and the submission flow itself has never run. `make distributableWindowsMsix` (run on Windows, after the usual `make` prerequisites) wraps the same `out/package/Konjugate-win32-<arch>` folder the NSIS installer wraps into an unsigned `out/msix/Konjugate-<version>-<arch>.msix`, using `scripts/createMsixPackage.mjs` (manifest generated in code, logos rendered from `assets/icon.svg` with `rsvg-convert`, `makeappx pack` from the Windows SDK). It is deliberately written to `out/msix/`, not `out/release/`, because `release.yml` publishes everything in `out/release/` and an unsigned spike build must never be attached to a GitHub Release.

**Why bother:** the Store signs MSIX packages itself on ingestion, so a Store install shows no SmartScreen warning and needs no code-signing certificate of ours — the one Windows channel that removes the unsigned-installer problem rather than working around it. The manifest also declares the `.kjt` file association and a `konjugate.exe` execution alias (a `konjugate` command on `PATH`; whether `--cli` output actually reaches a terminal from an Electron GUI-subsystem executable is a separate, untested question).

**Spike results (sideloaded, self-signed test package):** the app installs and runs; inline C++ providers compile and run; add-ons install (the fintech toolbox); double-clicking a `.kjt` opens it; `konjugate --cli validate` prints its result in a terminal. The C++ provider check initially failed with `Cannot open compiler generated file: 'C:\WINDOWS\system32\providerWorker.obj': Permission denied` — a latent engine bug, not an MSIX limitation: MSVC's `cl.exe` writes its `.obj` files into its working directory and the engine never set one, so it inherited the host process's (`System32` under MSIX; `C:\Program Files\Konjugate` from a shortcut would fail the same way). `engine/src/cppToolchain.cpp` now runs the compiler in the artifact's directory and removes the `.obj` files afterwards.

**What the spike set out to prove, and why:**
1. **Inline C++ providers still compile.** The engine spawns a host compiler (`src/main.mjs` searches for `cl.exe` and others) and needs headers from inside the install folder, which for MSIX is the locked-down `WindowsApps` directory. Child processes inherit the package identity so this probably works, but it is the most likely failure. Test it by running a model with an inline C++ provider from the installed MSIX.
2. **User data still lands somewhere sensible.** Writes under `%APPDATA%` are redirected into a per-package store, so add-ons, plugins and provider toolchains won't be where a user hand-editing `%APPDATA%\Konjugate` expects them. Check that installing add-ons and plugins works and survives a restart.
3. **`runFullTrust` is acceptable.** It is a restricted capability the Store reviews and asks to be justified; spawning host compilers and interpreters is the justification.

**Automated (once set up):** on a `v*` tag, the `build` job's Windows leg builds the MSIX from the packaged folder `make distributable` just produced (`node scripts/createMsixPackage.mjs`) and uploads it as the `msix-Windows-X64` workflow artifact; the `microsoftStoreRelease` job then submits it with the `msstore` CLI. The build step is opt-in by the `MSIX_IDENTITY_NAME` repository **variable** (with `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME`) and the submission by the `MS_STORE_CLIENT_SECRET` **secret**, so releases are unaffected until you set them. The `release` job now downloads only `release-*` artifacts, because it publishes everything it downloads and the unsigned MSIX must never be attached to the GitHub Release. The first submission has to be made by hand in Partner Center; after that, each tag submits an update, which then waits in Microsoft's certification review (a few days) before going live.

**CI setup, after the first manual submission is accepted:** register a Microsoft Entra ID (Azure AD) application, associate it with your Partner Center account (Account settings → Tenant administration / Microsoft Entra ID applications) with the Manager role, and create a client secret for it. Then add these repository secrets: `MS_STORE_TENANT_ID`, `MS_STORE_CLIENT_ID`, `MS_STORE_CLIENT_SECRET`, `MS_STORE_SELLER_ID` (Partner Center → Account settings → Organization profile → Legal info) and `MS_STORE_PRODUCT_ID` (the app's Store ID, a 12-character id like `9N...`), plus the three `MSIX_*` repository variables from Partner Center's product identity page. The `msstore` flags in the job come from its documentation and haven't been run against a real submission, so expect to adjust them after the first attempt.

**Local test, step by step** (elevated PowerShell on a Windows machine): build with `make distributableWindowsMsix`, run `packaging/windows/msix/signForTesting.ps1 -Msix out\msix\Konjugate-<version>-x64.msix` (creates and trusts a throwaway self-signed certificate, then signs), then `Add-AppxPackage` the signed file. Remove it afterwards with `Get-AppxPackage *Konjugate* | Remove-AppxPackage`.

**If the spike passes, the Store submission needs:** a Microsoft Partner Center account (identity verification; free for individuals as far as I know — check the current sign-up terms), a reserved app name, and the `Identity Name` / `Publisher` Partner Center assigns to it, supplied to the build as `MSIX_IDENTITY_NAME` / `MSIX_PUBLISHER` (the defaults are local-test placeholders the Store rejects). The listing also needs a privacy policy URL, screenshots, an age rating and a `runFullTrust` justification; each submission goes through a certification review of a few days. Automating later submissions (the `msstore` CLI or the Store submission API from a release job) comes after the first manual one.

## Snap

**Automated today:** nothing — no `snapRelease` job exists in `release.yml` right now (removed rather than left permanently failing on a missing credential). It would rebuild the Linux package from source (there's no raw `out/package/Konjugate-linux-<arch>` tree published as an artifact, only the compressed AppImage) and publish via `canonical/action-build` + `canonical/action-publish`.

`distribution/snap/snapcraft.yaml` uses `confinement: classic`, not `strict`, deliberately: Konjugate's inline C++/Python provider feature spawns whichever host compiler/interpreter it finds (`src/main.mjs` — `clang++`/`cl.exe`/`g++`/`c++`, `python3`/`python`), which strict confinement's plug model has no clean way to grant. Classic confinement requires a one-time manual Canonical review before stable-channel publication — free, but human-gated, on top of the account setup below.

**One-time setup, in order:**
1. `snapcraft login`, then `snapcraft register konjugate` — claims the name under your own Ubuntu One account.
2. `snapcraft export-login --snaps=konjugate --acls package_access,package_push,package_update,package_release exported.txt` run locally.
3. Paste the contents of `exported.txt` into this repo's `SNAPCRAFT_STORE_CREDENTIALS` secret.
4. `distribution/snap/snapcraft.yaml` has not been run through a real `snapcraft pack` yet (no Linux machine was available while drafting it) — verify it builds locally before relying on CI to publish it.
5. Re-add a `snapRelease` job to `release.yml` (see this file's git history for the exact configuration that was removed) — `needs: release`, tag-gated, rebuilding the Linux package via `make packageLinux` then publishing via `canonical/action-build` + `canonical/action-publish`.
6. Once ready to leave the `edge` channel (which that job published to by default), request classic-confinement review via the Snap Store dashboard.

## Flathub

**Automated today:** nothing, and this one is materially further from ready than the other three. Flathub's build sandbox has no network access — every build-time dependency needs to be a pinned, checksummed source in the manifest, fetched before the sandboxed build starts. Because every vcpkg C++ dependency except METIS is statically linked (confirmed against a real build's `vcpkg_installed/*/lib/*.a`), the *runtime* needs none of them — this is purely a build-sandbox problem.

`distribution/flatpak/com.konjugate.Konjugate.yml` is a first-draft manifest, explicitly marked as not yet build-tested. What it captures: `boost-property-tree` and `eigen3` are header-only in this engine (no compiled library — `engine/CMakeLists.txt` only does `find_path`/uses `Eigen3::Eigen` as an INTERFACE target), so both use a single upstream tarball each, header-copied into the prefix, skipping vcpkg's own ~65-tarball transitive Boost port graph entirely. The remaining four (`zlib`, `openssl`, `abseil`, `protobuf`, `nlopt`) are genuinely compiled and need real `flatpak-builder` modules under `distribution/flatpak/modules/` — none of those files exist yet. Before hand-writing them: check `https://github.com/flathub/shared-modules` for existing definitions to reuse, and check whether `org.freedesktop.Sdk` already ships `zlib`/`openssl` dev headers (it's an unusually comprehensive base SDK — they may not need bundling at all).

The genuinely unsolved piece is the `konjugate` engine module: `engine/CMakePresets.json` always points `CMAKE_TOOLCHAIN_FILE` at vcpkg's own toolchain script, which would try to fetch every dependency over the network again inside the sandbox. This needs either a new CMake preset that skips the vcpkg toolchain file and resolves `find_package(...)` against the Flatpak module prefix (`CMAKE_PREFIX_PATH=/app`), or an additive `KONJUGATE_SKIP_VCPKG`-style CMake option. Neither exists yet — it's real engine-build-system work, scoped as its own task.

The npm/Electron half is more standard: `npm run flatpak:generate-sources` (`scripts/generateFlatpakNodeSources.mjs`) runs `flatpak-node-generator` against `package-lock.json` to produce an offline-installable `distribution/flatpak/generatedSources.json` (gitignored, regenerated on demand — mirrors `scripts/generateReportProtocol.mjs`'s codegen convention). `flatpak-node-generator` is a Python tool, installed via `pipx install git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node`, not an npm package.

**One-time setup, once the manifest actually builds:**
1. `flatpak-builder --user --install` locally against the manifest, iterating on the TODOs above until it's green — this is the real verification loop, not a one-shot check.
2. Submit as a new repo under the `flathub` GitHub org, per Flathub's new-submission intake — human-reviewed, same shape as Snap's classic-confinement review.
3. After acceptance, add an `x-checker-data` block to `packaging/linux/com.konjugate.Konjugate.metainfo.xml` so Flathub's own bot detects new GitHub releases automatically — no CI work needed in this repo for ongoing updates.
