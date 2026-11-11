---
type: Guide
title: Development setup
description: Prerequisites, platform toolchains, CMake configuration, and developer workflows for building Konjugate.
tags: [setup, development, cmake, compiler]
status: stable
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Development setup

Konjugate uses Node.js for Electron and CMake with a pinned vcpkg baseline for the native engine dependencies. The normal development build requires METIS; it never silently substitutes the built-in partitioner.

## Platform prerequisites

- **macOS:** Node.js 24.19 or newer, CMake 3.20 or newer, Git and the Xcode Command Line Tools (`xcode-select --install`).
- **Windows:** Node.js 24.19 or newer, CMake 3.20 or newer, Git and Visual Studio 2022 Build Tools with **Desktop development with C++**. Run the commands from a Developer PowerShell or Developer Command Prompt.
- **Linux:** Node.js 24.19 or newer, CMake 3.20 or newer, Git, a C++20 compiler and the desktop libraries required by Electron. On Debian or Ubuntu, install `build-essential`, `cmake`, `git`, `curl`, `zip`, `unzip`, `tar` and `pkg-config` before following the common procedure.

## Common procedure

From the repository root:

```bash
npm ci
npm run setup
npm run dev
```

`npm run setup` downloads vcpkg into the ignored `.tools/` directory, checks out the revision recorded by `vcpkg.json`, installs every dependency `vcpkg.json` lists (currently Boost.PropertyTree, Eigen3, METIS, NLopt, OpenSSL, Protobuf and Zlib) then configures `out/engine`. It does not install an operating-system compiler or SDK.

Later development sessions normally require only `npm run dev`. Run setup again after `vcpkg.json`, the vcpkg baseline or native build configuration changes.

## Windows build performance

Native C++ compilation on Windows can take longer than on macOS/Linux due to default MSBuild generator overhead, real-time antivirus file scanning, and MSVC compiler front-end processing. The build is optimized automatically with `/MP` (multi-processor parallel compilation). To maximize build speed on Windows:

- **Use Ninja:** If installed (via Visual Studio CMake tools or `winget install Ninja-build.Ninja`), pass `-G Ninja` when invoking CMake manually for zero-overhead parallel builds.
- **Antivirus Exclusions:** Exclude the project's `out/` and `.tools/` directories from real-time antivirus / Windows Defender scanning to avoid I/O bottlenecks during `.obj` and `.pdb` writes.
- **Developer Shell:** Always run Node and CMake commands from a Visual Studio Developer PowerShell or Command Prompt.

## Web build (experimental)

See [Konjugate Web](proposals/webEdition.md) for the design and current scope. This is a separate, opt-in toolchain the normal desktop setup never touches -- but it is not fully independent in the other direction: the web CMake presets pull the same portable C++ dependencies (Eigen, Boost.PropertyTree, METIS, ...) through vcpkg that the native desktop preset does, just cross-compiled, so `npm run setup:web` also bootstraps vcpkg (shared with `npm run setup` above via `scripts/developmentEnvironment.mjs`'s `ensureVcpkgBootstrapped()`) if it isn't already. Running `npm run setup` first is not required -- `setup:web` alone is enough for a truly fresh checkout.

```bash
npm run setup:web
```

This installs the Emscripten SDK (a pinned version, matching `vcpkg.json`'s own pinned-baseline convention) into the ignored `.tools/emsdk` directory, and vcpkg into `.tools/vcpkg` if not already present, via `scripts/setupWebBuild.mjs`. It requires `cmake`, `git` and `python3` on `PATH` in addition to the platform prerequisites above. `make setupWeb` runs the same script from the Makefile.

```bash
npm run build:web
```

Builds the engine (the real, complete `konjugateEngine` target -- no source changes needed) via the `web` CMake preset (`engine/CMakePresets.json`), producing `out/engineWeb/konjugateEngine.js`/`.wasm` -- an ES module exporting a `createKonjugateEngine()` factory (`-sMODULARIZE=1 -sEXPORT_ES6=1`), not an auto-running script. `make buildWeb` runs `setupWeb` first, then this.

Same `validate`/`run`/etc. CLI contract as the desktop engine (see [Engine CLI contract](engineCli.md)), just driven explicitly instead of via `process.argv`: instantiate the module, write input files into its exported virtual filesystem (`Module.FS`), invoke a command with an argv array (`Module.callMain([...])`), then read output files back out the same way. Verified to produce byte-for-byte identical output to the desktop CLI, both under plain Node and in a real Chromium renderer (Electron) -- not just Node, since a real browser has no filesystem passthrough to lean on:

```js
import createKonjugateEngine from './out/engineWeb/konjugateEngine.js';

const Module = await createKonjugateEngine();
Module.FS.writeFile('/model.kjt', modelBytes);           // Uint8Array
Module.FS.writeFile('/runConfig.json', configBytes);
Module.callMain(['run', '/model.kjt', '--configuration', '/runConfig.json', '--output', '/result.bin']);
const resultBytes = Module.FS.readFile('/result.bin');   // decode with src/engineProtocol.mjs, same as the desktop result
```

```bash
npm run build:webShell
npm run serve:webShell
```

Assembles `out/webShell/` -- the phase-3 "minimal shell" (see [Konjugate Web](proposals/webEdition.md)): the real desktop renderer (`src/renderer/renderer.mjs`, unmodified) served as a static site against `src/renderer/webShims/*` instead of `src/preload.mjs`'s Electron IPC bridge, using the `build:web` output above. `scripts/buildWebShell.mjs` requires `out/engineWeb/` to already exist. `scripts/serveWebShell.mjs` then serves that directory over local HTTP (`http://localhost:4173/` by default, `PORT` to override) -- also a reasonable stand-in for what a static host serves. `make buildWebShell`/`make serveWebShell` run the same scripts from the Makefile.

```bash
npm run build:web:threads
npm run build:webShell:threads
npm run serve:webShell:threads
```

The phase-6 pthread-enabled variant, entirely separate from everything above: a second CMake preset (`web-threads`) and vcpkg triplet (`vcpkgOverlays/triplets/wasm32-emscripten-threads.cmake` -- a real, tracked overlay, unlike the plain `wasm32-emscripten` triplet, which ships with vcpkg itself and lives in the gitignored `.tools/vcpkg`) build `konjugateEngine` with `-pthread`, producing `out/engineWebThreads/` and, via the same shell-assembly script, `out/webShellThreads/`. This is what makes the `threadPool`/`partitioned` execution backends (see [Parallel execution](parallelExecution.md)) actually work in a browser instead of aborting. `serveWebShell.mjs` always sends `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` response headers (harmless for the default build, required here for `SharedArrayBuffer` to exist at all). The default `web`/`webShell` build clamps an explicit `threadPool`/`partitioned` request to a clear error and quietly downgrades an automatic selection to `serial` instead of aborting (`engine/src/simulationRunner.cpp`, `#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)`) -- use the threads variant to actually exercise parallel execution.

```bash
npx playwright install chromium
npm run test:interaction:web
```

Runs the exact same scenario definitions `npm run test:interaction` runs against the desktop Electron app (`tests/interactionRunner.mjs`), but against `out/webShellThreads` in a real headless Chromium instead, via [Playwright](https://playwright.dev) (a real `devDependency`, not part of the desktop build). See `tests/drivers/electronWindowDriver.mjs`/`playwrightWebDriver.mjs` and `interactionRunner.mjs`'s own top-of-file comment for how one set of scenarios drives either target; scenarios exercising a genuinely desktop-only capability (multi-window, native file dialogs, FMU export, the AI-provider credential vault, provider-toolchain execution-mode selection, add-on windows, C++ providers) skip themselves under this driver rather than failing, each with its own stated reason. `npx playwright install chromium` only needs to be run once per machine (downloads a real, standalone Chromium -- not the one Electron embeds, deliberately: see the top-level feedback note on why this project verifies web-edition behavior in a real browser, not Electron's `BrowserWindow`). `npm run test:interaction:web` builds `web-threads`/`webShellThreads` first, matching what the portable subset of these scenarios (in particular, the live-run pause/resume core) actually needs to mean anything -- the default, non-threads build is not exercised by this command.

### Deployment

`.github/workflows/webEdition.yml` builds `out/webShell/` in CI on every run (`workflow_dispatch`, or a `v*` version-tag push) and uploads it two ways: a plain `actions/upload-artifact@v4` for anyone to download and inspect, and an `actions/upload-pages-artifact@v3` package a `deploy` job hands to `actions/deploy-pages@v4`. That `deploy` job only runs on an actual version-tag push (`if: startsWith(github.ref, 'refs/tags/v')`, the same condition `release.yml`'s own `release` job uses for the desktop build) -- a manual `workflow_dispatch` run still only builds and uploads artifacts for inspection, same as before. See [Konjugate Web](proposals/webEdition.md)'s hosting-provider decision for which host applies to which build variant (GitHub Pages for the default `web`/`webShell` build, deployed by this workflow; a COOP/COEP-capable host for `web-threads`/`webShellThreads` specifically, since GitHub Pages cannot set the response headers `SharedArrayBuffer` needs -- that variant is not deployed by this workflow).

One remaining manual, one-time step this workflow cannot do on its own: GitHub Pages must be enabled under this repository's Settings > Pages, with "GitHub Actions" selected as the source. Until that's done, the `deploy` job fails with a clear permissions/environment error rather than deploying nothing silently.

## Verification

Run the JavaScript and native suites with:

```bash
npm run test:all
```

That is the unit tests, the interaction suite, and the command line run end to end (`tests/cliMode.e2e.mjs`, also `npm run test:cli`). The interaction suite runs every scenario and lists the ones that failed at the end, so one run finds them all; it exits with an error if any did. To run some scenarios only, set `KONJUGATE_INTERACTION_ONLY` to part of a scenario's name (several separated by `||`). To stop at the first failure instead, as when looking at one, set `KONJUGATE_INTERACTION_STOP_ON_FAILURE=1`. A scenario checks what it is about by ids, data attributes and state, and words only where the words are the point (see the top of `tests/interactionRunner.mjs`).

Each scenario's line says how long it took, and the run ends with the ten slowest: the suite is meant to cover as much as it can in as little time as it can, and a scenario that waits for what the engine tests already prove (a twin playing hours of a recording at its own pace to reach a drift, say) is a candidate to speed up, by playing it faster or looking at the move where it happened, not to drop. 

A watchdog keeps a leak from taking the computer with it: every process of the app is looked at every two seconds, and one past `KONJUGATE_INTERACTION_MEMORY_LIMIT_MB` (2500 by default) stops the run, saying which. `KONJUGATE_INTERACTION_MEMORY_LOG=1` also prints the app's memory every fifteen seconds between the scenarios' lines, and what the main process holds (its heap, the engine results it keeps, the jobs, the live twins with their windows and moves, the windows): a collection that keeps growing is then seen by name. With `KONJUGATE_INTERACTION_REPORTS` set to a folder, the main process writes Node's report of itself there (with the JavaScript stack) when it dies of a fatal error, and when the watchdog sees it past 70% of the limit. That is how a twin left running with another project's timing, whose catch-ups kept millions of samples, was found.

### Coverage

```bash
npm run coverage
```

Runs the unit tests and the interaction suite with V8's coverage on and writes `out/coverage/report.txt`: for each file under `src/`, the share of its lines of code the unit tests run, the interaction tests run, either runs, and how many neither runs (each such line is listed in `notRun.json`). `node scripts/coverageReport.mjs out/coverage` reports again from what is there. It is a map for deciding what to test next, not a target, and nothing passes or fails on it. It measures every window the scenarios open (each project window, the twin's, the example guide, the provider editor), the command line, and the web edition's suite in Chromium, whose shell it assembles again first so it serves today's `src/` (it is counted against a `src/` file only where the shell serves that file unchanged, so a shell left from before would read as code not run). That needs a web engine as new as the engine's sources (`npm run build:web:threads`, which takes minutes, so it is not built here); without one, the report says so and leaves the web edition out. What it does not see: the web engine's worker, the add-on launcher's own process, the push service's process, and the provider editor's renderer (its window is opened, but its code does not reach the report yet), so those read as not run even where a scenario exercises them.

### Testing a packaged build

The suites above run against `out/engine/` and a plain `electron .` launch. Some failures only appear once the app is packaged: a missing bundled library, a resource path that only resolves in the packaged layout, or a code-signing side effect. To catch those, run the same suites against a real package:

```bash
npm run test:package
```

This packages the app for the host platform (as `npm run package` does), then runs the engine and interaction suites against that package. It builds a fresh package each time, so it is a check before a release rather than part of the everyday loop. `make verifyPackagedEngine` or `make verifyPackagedInteraction` runs one half (each also builds the package first).

The dependency-free partitioner remains an intentionally separate test path:

```bash
npm run build:engine:no-metis
cd engine
ctest --preset development-no-metis
```

## Building a release

```bash
make
```

`make` (or `make build`) installs missing dependencies, generates the application and web icons, packages Electron and writes the installer for the host platform to `out/release/`: a DMG on macOS, an installer (`*-setup.exe`) on Windows, and an AppImage on Linux. The packaged application folder is kept in `out/package/`. `make distributableWindowsPortable` also builds a portable ZIP on Windows, and `make clean` removes the dependencies, the lockfile, generated icons, caches and every build output.

Windows needs NSIS (`makensis`) on `PATH`, and Linux needs `appimagetool`. Every package includes `ThirdPartyNotices.md` and the license texts under `thirdPartyLicenses/`, and packaging fails without them. [Release packaging](releasePackaging.md) covers each platform's host tools and the checks run on the packaged app.
