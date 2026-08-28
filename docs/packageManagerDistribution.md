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

Every channel below has the same shape: a CI job in `release.yml` handles ongoing updates
automatically, but the *first* submission for each channel is a one-time step only a human with
the right account can do. Nothing below can be done from an agent session — these need your own
GitHub/Homebrew/Microsoft/Snapcraft/Flathub identity.

## Homebrew Cask

**Automated today:** nothing yet — `homebrewCaskBump` in `release.yml` runs on every tagged
release, but `brew bump-cask-pr` (which it wraps) only bumps a cask that already exists in
`Homebrew/homebrew-cask`. It will fail loudly until the first submission below is merged.

**One-time setup, in order:**
1. A draft cask already exists at `packaging/homebrew/konjugate.rb`, with real `sha256` values
   computed directly against the published v0.7.3 DMG assets. Re-verify the version and both
   hashes against the *latest* release before submitting — this draft goes stale the moment a
   newer release ships.
2. Fork `Homebrew/homebrew-cask`, copy that file to `Casks/k/konjugate.rb` in the fork, and open a
   PR. Homebrew's own cask contribution docs (`docs.brew.sh/Adding-Software-to-Homebrew`) cover
   the audit/lint steps their CI will run against it.
3. Generate a **classic** GitHub PAT (not fine-grained) with `public_repo` scope, at
   `github.com/settings/tokens`.
4. Add it as this repo's `HOMEBREW_CASK_TOKEN` secret (Settings → Secrets and variables →
   Actions).

Once the first PR is merged, `homebrewCaskBump` bumps the cask automatically on every future
release — no further manual PRs.

## winget

**Automated today:** nothing yet, for the same reason as Homebrew — `wingetRelease` uses
`vedantmgoyal9/winget-releaser`, and its own first build step explicitly checks that the
`identifier` already exists in `microsoft/winget-pkgs` and errors out if not (confirmed by reading
its source directly, not assumed from its docs). It calls `komac update`, never `komac new`.

**One-time setup, in order:**
1. Decide the winget `PackageIdentifier` (winget's `Publisher.Package` convention). The CI job
   currently defaults to `ZeninEasaPanthakkalakath.Konjugate` — change it in `release.yml`'s
   `wingetRelease` job if you want something else, and use the same value in step 2.
2. Fork `microsoft/winget-pkgs` under your own GitHub account.
3. Submit the first manifest by hand — either `wingetcreate new` or `komac submit`, pointed at a
   published `-setup.exe` release asset — as a PR to `microsoft/winget-pkgs`.
4. Generate a second **classic** PAT with `public_repo` scope, stored as this repo's
   `WINGET_TOKEN` secret.

Once merged, `wingetRelease` bumps the manifest automatically on every future release.

## Snap

**Automated today:** nothing yet — `snapRelease` in `release.yml` rebuilds the Linux package from
source (there's no raw `out/package/Konjugate-linux-<arch>` tree published as an artifact, only
the compressed AppImage) and publishes via `canonical/action-build` + `canonical/action-publish`,
but it needs a Snap Store login credential that only you can generate.

`snap/snapcraft.yaml` uses `confinement: classic`, not `strict`, deliberately: Konjugate's inline
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
4. `snap/snapcraft.yaml` has not been run through a real `snapcraft pack` yet (no Linux machine was
   available while drafting it) — verify it builds locally before relying on CI to publish it.
5. Once ready to leave the `edge` channel (which `snapRelease` publishes to by default), request
   classic-confinement review via the Snap Store dashboard.

## Flathub

**Automated today:** nothing, and this one is materially further from ready than the other three.
Flathub's build sandbox has no network access — every build-time dependency needs to be a pinned,
checksummed source in the manifest, fetched before the sandboxed build starts. Because every
vcpkg C++ dependency except METIS is statically linked (confirmed against a real build's
`vcpkg_installed/*/lib/*.a`), the *runtime* needs none of them — this is purely a build-sandbox
problem.

`flatpak/com.konjugate.Konjugate.yml` is a first-draft manifest, explicitly marked as not yet
build-tested. What it captures: `boost-property-tree` and `eigen3` are header-only in this engine
(no compiled library — `engine/CMakeLists.txt` only does `find_path`/uses `Eigen3::Eigen` as an
INTERFACE target), so both use a single upstream tarball each, header-copied into the prefix,
skipping vcpkg's own ~65-tarball transitive Boost port graph entirely. The remaining four
(`zlib`, `openssl`, `abseil`, `protobuf`, `nlopt`) are genuinely compiled and need real
`flatpak-builder` modules under `flatpak/modules/` — none of those files exist yet. Before
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
`package-lock.json` to produce an offline-installable `flatpak/generatedSources.json` (gitignored,
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
