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

See [Konjugate Web](proposals/webEdition.md) for the design and current scope. This is a separate, opt-in toolchain -- it installs nothing the normal desktop build above needs, and the normal desktop setup never touches it.

```bash
npm run setup:web
```

This installs the Emscripten SDK (a pinned version, matching `vcpkg.json`'s own pinned-baseline convention) into the ignored `.tools/emsdk` directory via `scripts/setupWebBuild.mjs`. It requires `cmake`, `git` and `python3` on `PATH` in addition to the platform prerequisites above. `make setupWeb` runs the same script from the Makefile.

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

## Verification

Run the JavaScript and native suites with:

```bash
npm run test:all
```

The dependency-free partitioner remains an intentionally separate test path:

```bash
npm run build:engine:no-metis
cd engine
ctest --preset development-no-metis
```

Application packaging has additional host-specific requirements and is documented separately from the development workflow.
