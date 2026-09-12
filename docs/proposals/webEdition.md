<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Konjugate Web: a browser edition, not a permanent preview

**Status: proposal.** Nothing described here is built. This document captures the brainstorm that produced the scoping decisions below, grounded in the actual current code (not assumptions about it), so an implementation attempt starts from a realistic picture rather than "compile the engine to WASM and it should mostly work."

## Ambition

The inspiration is [vscode.dev](https://vscode.dev): Visual Studio Code running in a browser, reachable with no install. **The long-term goal is near feature parity with the desktop app, not a permanently smaller "preview" product.** Compilers (and therefore programmable C++/Python providers) won't be available in the first working version — that's a real, structural gap on day one — but it is a gap with a genuine path to closing, not a wall. This document treats compiler availability as the thing that arrives in a *later phase*, not as a reason to scope the whole effort down to "equation-only, forever." The one piece that stays genuinely harder even long-term is FMU import, for reasons specific to what an FMU actually is — see below.

## What already ports cleanly

The numeric core has no OS-specific dependencies at all. `Eigen`, `boost::property_tree`, the protobuf runtime, the Explicit Euler solver, expression evaluation (`executionPlan.cpp`'s `CompiledExpression::evaluate`), and the entire numerical-stability-diagnostics engine (`stabilityAnalysis.cpp`, `modelValidator.cpp`) are all pure, portable C++. Emscripten handles this class of code well.

There's a second, more structural piece of good news: **the renderer already talks to everything through a small, named set of browser-global seams, never directly to Node.** `src/preload.mjs` exposes `window.engine`, `window.projectFiles`, `window.shapeLibrary`, `window.componentLibrary`, `window.providerEditor`, `window.providerToolchains`, `window.modelClipboard`, `window.extensions`, `window.addons`, `window.aiProviders`, and a few more — fourteen `contextBridge.exposeInMainWorld` calls in total — each backed today by an `ipcRenderer.invoke` call into `src/main.mjs`. `src/renderer/renderer.mjs` itself has zero direct `node:*` imports (`contextIsolation: true`, `nodeIntegration: false` — this is already enforced, not just a convention). That means a web build's real task is **reimplementing what sits behind each of those fourteen globals**, not rewriting the renderer. A large fraction of `renderer.mjs` — model editing, the Three.js canvas, the equation editor, causal inference, digital-twin tuning UI — could plausibly be reused close to as-is if `window.engine` (and enough of the others) behave the same from its point of view.

## The engine-as-subprocess contract itself needs replacing, regardless of phase

`src/engineAdapter.mjs` — the JS-side implementation behind `window.engine` — does not talk to a library today. It writes the model to a real temp file (`encodeProjectFile` + `writeFile` into a `mkdtemp(tmpdir())` directory), `spawn()`s the `konjugateEngine` binary as a child process with CLI arguments, and reads its result back from another real file on disk. Every engine operation (`validate`, `run`, `infer`, `fit`) goes through this same spawn-and-file-exchange contract. None of `spawn`, `node:fs`, or `node:os`'s `tmpdir()` exist in a browser. This is true regardless of which phase below is in progress — even the simplest equation-only build needs a **parallel implementation of `engineAdapter.mjs`'s entire contract**, calling into an in-memory Emscripten module (buffers/virtual-FS in, buffers out) instead of a real subprocess and real files.

## Two genuinely different classes of "missing native code" — worth not conflating

It's tempting to treat "programmable providers" and "FMU import" as the same problem (both currently involve native code the browser can't run) with the same fix (get a compiler running in-browser). They aren't the same problem:

### Programmable providers: solvable later, via an in-browser toolchain

A programmable source term or relationship is **our own source code**, authored inside Konjugate, compiled fresh at validate/run time (`engine/src/cppToolchain.cpp` invokes a real compiler via `CreateProcessA`/`fork`+`exec`; `engine/src/providerRuntime.cpp` then spawns the compiled result as a separate process). Since the *source* is always available, an in-browser toolchain that compiles it to WASM instead of a native binary is a real, if substantial, path:

- **Python providers**: [Pyodide](https://pyodide.org) (CPython compiled to WASM, mature, used in production elsewhere — e.g. JupyterLite) is a well-trodden route. This is the lower-risk half of "bring compilers back."
- **C++ providers**: a WASM-hosted C++ toolchain (clang/LLVM compiled to WASM, following the general shape of projects like `wasm-clang`) is real but considerably heavier — large toolchain payloads, slower in-browser compiles, and a less mature ecosystem than Pyodide's. This should be scoped and de-risked as its own dedicated phase, not assumed to fall out of "we already have Pyodide working."

Either way, once a provider's compiled output is a WASM module rather than a native binary/process, `providerRuntime.cpp`'s pipe/shared-memory transport also needs a browser-appropriate replacement (direct in-process calls into the WASM module, most likely) — a real design task, but a bounded one.

### FMU import: harder even long-term, for a different reason

FMI import (`engine/include/konjugate/fmiDynamicLoad.hpp`, `engine/src/fmiImport.cpp`) `dlopen`s a real compiled shared library bundled inside a `.fmu` package — but critically, **that shared library was compiled by a third party, and Konjugate never has its source.** An in-browser compiler doesn't help here at all; there's nothing to (re)compile. Realistic long-term options, none of them free:

- Require the FMU author to have shipped a WASM-targeted binary inside the package — not how FMI tooling works today, and not something Konjugate can retroactively fix for existing FMUs in the wild.
- An optional local companion process the web app can connect to for FMU-specific work only (the one place this document countenances "not purely static/client-side," and only for this one feature) — plausible, but a real piece of infrastructure and a security-model question (a web page talking to a local process) worth its own design pass, not a footnote here.
- Accept FMU import as the one feature that stays desktop-only even at "near parity," and say so plainly rather than imply it's coming.

Which of these (or something else) is worth pursuing is an open question below, not a decision made by this document.

## Parallel execution and METIS

The `threadPool`/`partitioned` execution backends (`engine/src/partitionRuntime.cpp`) and the optional METIS graph-partitioning dependency (`engine/CMakeLists.txt`'s `KONJUGATE_ENABLE_METIS`) parallelize execution across real OS threads/processes. The browser path is WASM threads via `SharedArrayBuffer`, which requires the page to be served with `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` response headers. **GitHub Pages cannot set custom response headers at all** — the common workaround is a service worker that injects those headers itself (the `coi-serviceworker` pattern), which works but is real infrastructure, not a hosting-config toggle. Given the long-term ambition here (not just a v1 static page), the hosting choice deserves an explicit decision rather than defaulting to GitHub Pages by inertia — Netlify/Cloudflare Pages/Vercel support custom headers natively and would sidestep this entirely.

## The Electron shell itself has no browser equivalent

`src/main.mjs` owns native file/save dialogs, real `.kjt` file I/O (including the scrypt-based encryption path), the auto-updater, and process lifecycle (multi-window management, macOS-specific behavior). A web build needs its own answers for at least: project storage (File System Access API where available, IndexedDB as a fallback), encryption (Web Crypto's PBKDF2/AES in place of the current Node `scrypt`-based scheme — a different KDF, so an existing encrypted `.kjt` file needs an explicit compatibility decision, not a silent assumption either way), and multi-window/auto-update, which have no obvious browser equivalent at all and may simply not exist in this edition.

## Proposed phased roadmap toward parity

1. **Spike, no UI**: get `konjugateEngine`'s equation-only core building under Emscripten, and successfully `validate`/`run` a trivial model from a plain browser console. Proves the core compiles and executes before any integration work starts, and surfaces Emscripten-specific issues in `boost::property_tree`/the protobuf runtime that aren't visible from reading the code alone.
2. **Browser-side `window.engine`**: build the new adapter against the spike from step 1, matching `engineAdapter.mjs`'s current method signatures closely enough that `renderer.mjs` needs minimal changes to call it.
3. **Minimal shell**: a page loading `renderer.mjs` against the new globals, project load/save via drag-drop first (defer File System Access API polish), a clear and honest in-UI indicator of what's available yet and what isn't — not a permanent "preview" framing, just accurate status while parity work is ongoing.
4. **Python providers via Pyodide.**
5. **C++ providers via a WASM toolchain** — its own dedicated design/spike, given the risk noted above.
6. **Parallel execution backends**, once a hosting decision that supports `SharedArrayBuffer` is made (see above).
7. **FMU import** — pending the open question below; may end up out of scope permanently rather than merely deferred.

Each phase is a real go/no-go checkpoint. Nothing here commits to a timeline — the point is ordering the work by genuine dependency and risk, not by assumed effort.

## Open questions

- **FMU import's long-term fate** — accept it as permanently desktop-only, or invest in a companion-process design? This is the one place this whole document doesn't have a clean answer.
- **Hosting provider** for phases beyond the first — GitHub Pages works fine until `SharedArrayBuffer` is needed; worth deciding up front whether to build the service-worker workaround or just pick a host that doesn't need one.
- **Encrypted-project compatibility** across the Node-`scrypt` vs. Web-Crypto boundary.
- **Where this build lives relative to the main repo** — a build target in this repo, or a separate package/branch? Affects how much of the phased work risks bit-rotting against ongoing desktop-app changes as phases 4-7 stretch out over time.
