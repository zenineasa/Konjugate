<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Package manager distribution

Konjugate's release pipeline (`.github/workflows/release.yml`) already builds an unsigned
DMG/EXE/AppImage on every `v*` tag and publishes them to a GitHub Release — see
[releasePackaging.md](releasePackaging.md). This document covers the next layer: getting those
same builds discoverable through Homebrew Cask, winget, Snap, and Flathub.

Two decisions shape everything below, both made deliberately: Konjugate ships **unsigned** for now
(no Apple Developer ID, no Windows code-signing certificate — revisit once there's real traction),
and none of the four channels here cost anything to register on or publish through, so nothing is
being skipped for budget reasons.

**Current status: all four channels are deferred.** None has a CI job in `release.yml` right now
— see each section below for why. Homebrew Cask is blocked by real requirements (notarization,
notability), not just a setup gap. winget and Snap are genuinely just a one-time human setup step
away (see their sections), but that setup hasn't happened yet, so their jobs were removed rather
than left in the workflow permanently failing. Flathub is blocked by its own project-maturity and
AI-content policies (see its section) — revisit once those no longer apply.

## Homebrew Cask — deferred, two real blockers found

**Status: on hold, not wired into CI.** A real `brew audit --cask --new konjugate` run (see
below) surfaced two hard requirements this project doesn't meet yet, confirmed directly against
Homebrew's own review tooling, not just their docs:

1. **Notarized, signed macOS binaries.** Homebrew Cask requires distributed macOS binaries to be
   signed and notarized with an Apple Developer ID and pass Gatekeeper — the `xattr -cr` workaround
   in the cask's own `caveats` (needed because Konjugate ships unsigned today, see
   [releasePackaging.md](releasePackaging.md)) is exactly the kind of thing official casks aren't
   allowed to paper over. Resolved once Konjugate has a real Apple Developer ID and notarized
   builds — see this doc's intro note on signing.
2. **Notability.** New casks need roughly 75 GitHub stars or 30 forks/watchers. Konjugate isn't
   there yet.

Neither is a one-time setup step the way winget's/Snap's credentials are — both take real time
(getting an Apple Developer ID and notarizing builds, growing the project's traction) rather than
an afternoon of account setup. That's why, unlike winget and Snap,
**there is no `homebrewCaskBump` job in `release.yml`** — a job that can only ever fail until both
of these are true would just be permanent CI noise. Revisit this section once both are met.

What's kept, ready for when that's true:
- `scripts/generateHomebrewCask.mjs` (`npm run homebrew:generate-cask`) generates
  `distribution/homebrew/konjugate.rb` (gitignored) from the latest published release — both macOS
  DMGs and the Linux AppImage, via the same `on_macos`/`on_linux` + `app_image` pattern real casks
  like `cursor.rb`/`warp.rb` use (confirmed Homebrew Cask has real Linux support, not just macOS).
- Once notarization + notability are both true, the submission flow is: run the generator, fork
  `Homebrew/homebrew-cask`, copy the output to `Casks/k/konjugate.rb`, and follow their real PR
  checklist (`brew audit --cask --new`, `brew style --fix`, a real local install/uninstall cycle,
  plus their mandatory AI-usage disclosure if a tool helped draft it — see
  `docs.brew.sh/Responsible-AI-Usage`). Re-add a `homebrewCaskBump` job to `release.yml`
  (mirroring `wingetRelease`'s shape, using `eugenesvk/action-homebrew-bump-cask`) once that first
  PR is merged.

## winget

**Automated today:** nothing — no `wingetRelease` job exists in `release.yml` right now (removed
rather than left permanently failing). It would use `vedantmgoyal9/winget-releaser`, but that
action's own first build step explicitly checks that the `identifier` already exists in
`microsoft/winget-pkgs` and errors out if not (confirmed by reading its source directly, not
assumed from its docs) — it calls `komac update`, never `komac new`, so it can't create the first
listing.

**One-time setup, in order:**
1. Decide the winget `PackageIdentifier` (winget's `Publisher.Package` convention) — the job used
   `ZeninEasaPanthakkalakath.Konjugate` before it was removed; reuse that value or pick another,
   just use the same one in step 2 and in the re-added job (see below).
2. Fork `microsoft/winget-pkgs` under your own GitHub account.
3. Submit the first manifest by hand — either `wingetcreate new` or `komac submit`, pointed at a
   published `-setup.exe` release asset — as a PR to `microsoft/winget-pkgs`.
4. Generate a **classic** PAT with `public_repo` scope, stored as this repo's `WINGET_TOKEN`
   secret.
5. Re-add a `wingetRelease` job to `release.yml` (see this file's git history for the exact
   configuration that was removed) — `needs: release`, tag-gated, using `winget-releaser` with the
   `identifier`/`installers-regex`/`token` inputs.

Once merged and the job is back, it bumps the manifest automatically on every future release.

## Snap

**Automated today:** nothing — no `snapRelease` job exists in `release.yml` right now (removed
rather than left permanently failing on a missing credential). It would rebuild the Linux package
from source (there's no raw `out/package/Konjugate-linux-<arch>` tree published as an artifact,
only the compressed AppImage) and publish via `canonical/action-build` + `canonical/action-publish`.

`distribution/snap/snapcraft.yaml` uses `confinement: classic`, not `strict`, deliberately:
Konjugate's inline
C++/Python provider feature spawns whichever host compiler/interpreter it finds
(`src/main.mjs` — `clang++`/`cl.exe`/`g++`/`c++`, `python3`/`python`), which strict confinement's
plug model has no clean way to grant. Classic confinement requires a one-time manual Canonical
review before stable-channel publication — free, but human-gated, on top of the account setup
below.

**One-time setup, in order:**
1. `snapcraft login`, then `snapcraft register konjugate` — claims the name under your own Ubuntu
   One account.
2. `snapcraft export-login --snaps=konjugate --acls package_access,package_push,package_update,package_release exported.txt`
   run locally.
3. Paste the contents of `exported.txt` into this repo's `SNAPCRAFT_STORE_CREDENTIALS` secret.
4. `distribution/snap/snapcraft.yaml` has not been run through a real `snapcraft pack` yet (no
   Linux machine was
   available while drafting it) — verify it builds locally before relying on CI to publish it.
5. Re-add a `snapRelease` job to `release.yml` (see this file's git history for the exact
   configuration that was removed) — `needs: release`, tag-gated, rebuilding the Linux package via
   `make packageLinux` then publishing via `canonical/action-build` + `canonical/action-publish`.
6. Once ready to leave the `edge` channel (which that job published to by default), request
   classic-confinement review via the Snap Store dashboard.

## Flathub

**Automated today:** nothing, and this one is materially further from ready than the other three.
Flathub's build sandbox has no network access — every build-time dependency needs to be a pinned,
checksummed source in the manifest, fetched before the sandboxed build starts. Because every
vcpkg C++ dependency except METIS is statically linked (confirmed against a real build's
`vcpkg_installed/*/lib/*.a`), the *runtime* needs none of them — this is purely a build-sandbox
problem.

`distribution/flatpak/com.konjugate.Konjugate.yml` is a first-draft manifest, explicitly marked
as not yet
build-tested. What it captures: `boost-property-tree` and `eigen3` are header-only in this engine
(no compiled library — `engine/CMakeLists.txt` only does `find_path`/uses `Eigen3::Eigen` as an
INTERFACE target), so both use a single upstream tarball each, header-copied into the prefix,
skipping vcpkg's own ~65-tarball transitive Boost port graph entirely. The remaining four
(`zlib`, `openssl`, `abseil`, `protobuf`, `nlopt`) are genuinely compiled and need real
`flatpak-builder` modules under `distribution/flatpak/modules/` — none of those files exist yet.
Before
hand-writing them: check `https://github.com/flathub/shared-modules` for existing definitions to
reuse, and check whether `org.freedesktop.Sdk` already ships `zlib`/`openssl` dev headers (it's an
unusually comprehensive base SDK — they may not need bundling at all).

The genuinely unsolved piece is the `konjugate` engine module: `engine/CMakePresets.json` always
points `CMAKE_TOOLCHAIN_FILE` at vcpkg's own toolchain script, which would try to fetch every
dependency over the network again inside the sandbox. This needs either a new CMake preset that
skips the vcpkg toolchain file and resolves `find_package(...)` against the Flatpak module
prefix (`CMAKE_PREFIX_PATH=/app`), or an additive `KONJUGATE_SKIP_VCPKG`-style CMake option.
Neither exists yet — it's real engine-build-system work, scoped as its own task.

The npm/Electron half is more standard: `npm run flatpak:generate-sources`
(`scripts/generateFlatpakNodeSources.mjs`) runs `flatpak-node-generator` against
`package-lock.json` to produce an offline-installable `distribution/flatpak/generatedSources.json`
(gitignored,
regenerated on demand — mirrors `scripts/generateReportProtocol.mjs`'s codegen convention).
`flatpak-node-generator` is a Python tool, installed via
`pipx install git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node`, not an
npm package.

**One-time setup, once the manifest actually builds:**
1. `flatpak-builder --user --install` locally against the manifest, iterating on the TODOs above
   until it's green — this is the real verification loop, not a one-shot check.
2. Submit as a new repo under the `flathub` GitHub org, per Flathub's new-submission intake —
   human-reviewed, same shape as Snap's classic-confinement review.
3. After acceptance, add an `x-checker-data` block to
   `packaging/linux/com.konjugate.Konjugate.metainfo.xml` so Flathub's own bot detects new GitHub
   releases automatically — no CI work needed in this repo for ongoing updates.
