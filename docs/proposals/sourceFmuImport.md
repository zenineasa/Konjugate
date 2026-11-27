---
type: Proposal
title: Building an FMU from its sources
description: "Accepted 27 November 2026 (all eight recommendations), built in five stages, stage 1 built: an FMU that carries its C sources but no binary for this computer is built on import by the desktop app, from FMI 3.0's buildDescription.xml, FMI 2.0's <SourceFiles> or a known exporter's recipe (OpenModelica first), never by running the FMU's own CMake, makefiles or scripts; a clear confirmation saying what will run, no network, no sandbox claimed; the computer's own C compiler, found per platform and named when missing; builds cached by the FMU's SHA-256, compiler and flags, kept on this computer and never in the project, which keeps the FMU as it came; the web edition says FMUs run in the desktop app; verified by building the FMI Reference FMUs and OpenModelica's PID controller from their sources and matching their shipped binaries' results bit for bit; five stages."
tags: [proposals, fmi, fmu, import, compilers, toolchains, security, caching]
status: draft
implementation: partial
---

<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Building an FMU from its sources

**Status: accepted.** This is the separate proposal decision 12 of [Ports at the top level](rootPorts.md#decisions) asked for: compile an FMU's `sources/` on import, so any source FMU runs on any platform Konjugate does. The user accepted the recommendation on all eight [questions](#decisions) on 27 November 2026; the design below follows them. Stage 1 (reading the build information) is built.

## In short

- **When.** An FMU with build information in `sources/` and no binary this computer can run is built, after the person confirms. One that has both can be rebuilt from its sources on request, from **About this FMU**.
- **From what.** FMI 3.0's `sources/buildDescription.xml` (which also takes precedence in an FMI 2.0.4 FMU), else FMI 2.0's `<CoSimulation><SourceFiles>`, plus, where an exporter's sources need more than the standard says, a recipe Konjugate keeps for that exporter (OpenModelica first). Konjugate never runs the FMU's own CMakeLists, makefiles or scripts.
- **With what.** The computer's own C compiler, found as programs find theirs today, or the one set in Settings › Provider toolchains; when there is none, a message per platform says what to install.
- **Trust.** Building and running an FMU's code is no safer than running its binary, and the confirmation says so. Konjugate runs the compiler only, with arguments it chooses, no shell, no network, a time limit. It claims no sandbox.
- **Where.** The built library is cached on this computer by the FMU's SHA-256, the compiler and the flags. The project keeps the FMU as it came, so a project is the same bytes before and after a build.
- **Web edition.** It cannot compile, and keeps saying "FMUs run in the desktop app only". WebAssembly binaries are a later proposal.
- **Proof.** The FMI Reference FMUs and OpenModelica's `PidController.fmu`, stripped of their binaries and built from sources, give their shipped binaries' results bit for bit.

## Today

`inspectFmuArchive` (`src/fmuPackage.mjs`) refuses an FMU without `binaries/`: "there is nothing to load". One with binaries but none for this machine is refused by **Add › FMU…** (`packageAddFmu`, `src/main.mjs`) with `chooseFmuBinary`'s reason (`src/fmiBinary.mjs`), "it has no binary this computer (x86_64-darwin) can run"; that function already tries both FMI versions' directory names and reads the binary's own Mach-O, ELF or PE header.

This is not rare. The FMI Reference FMUs 0.0.42, used by Konjugate's import fidelity tests, ship macOS binaries for Apple Silicon only (arm64, checked with `lipo`), so they do not run on an Intel Mac. `examples/pidController/PidController.fmu` has no Windows binary. Both carry their full C sources.

The desktop already compiles. Inline C++ programs are built by `buildCppProvider` (`engine/src/providerRuntime.cpp`) and cached by a SHA-256 of source and glue; FMU export uses the engine's `buildSharedLibrary` command. Both rest on `engine/src/cppToolchain.cpp`, which finds Xcode's clang++ and its SDK, sets up MSVC's paths on Windows, and starts the compiler without a shell (`execvp`, `CreateProcessA`). The app resolves the compiler in `resolveCppCompiler` (`src/main.mjs`), with an override in `toolchains.json` (`src/providerToolchainStore.mjs`).

Building the stage-7 PID controller by hand (`examples/pidController/generate.mjs`, CMake with Apple clang and Docker's gcc) taught three things. OpenModelica's `<SourceFiles>` (113 files) is not enough: its CMakeLists adds `OMC_MINIMAL_RUNTIME=1`, `OMC_FMI_RUNTIME=1`, `CMINPACK_NO_DLL` and `FMI2_OVERRIDE_FUNCTION_PREFIX`, links pthreads and `libm`, and needs CMake 3.21 or newer. Its install step writes outside `sources/`, into `../binaries/<platform>`. And it names an aarch64 Linux binary `linux64`, which FMI 2.0 reads as x86_64.

## What the standards say

- **FMI 2.0.4 §2.3 (FMU Distribution).** `sources/` holds "all needed C sources and C header files … with exception of: fmi2TypesPlatform.h, fmi2FunctionTypes.h and fmi2Functions.h"; the files to compile "have to be reported … under the structure <ModelExchange><SourceFiles> … and <CoSimulation><SourceFiles>" and may include others. A source distribution "might require manual interaction"; CMake is suggested as a template. New in 2.0.4: a `sources/buildDescription.xml` as FMI 3.0 defines it "should take precedence over the <SourceFiles> element".
- **FMI 2.0.4 §2.1.1 and FMI 3.0.2 §2.2.2 (Header Files and Naming of Functions).** Source is compiled with `FMI2_FUNCTION_PREFIX` / `FMI3_FUNCTION_PREFIX` set to the `modelIdentifier` and `_`; a shared library exports unprefixed names, which the standard headers give when `FMI2_OVERRIDE_FUNCTION_PREFIX` / `FMI3_OVERRIDE_FUNCTION_PREFIX` is defined.
- **FMI 3.0.2 §2.4.10 (Build Configurations).** One or more `<BuildConfiguration modelIdentifier platform?>`; the importer takes the one whose platform tuple matches, else the single one without `platform`, and must process every `<SourceFileSet>` in it (`language`, optional `compiler` and `compilerOptions`), with `<SourceFile name>` relative to `sources/`, `<PreprocessorDefinition>` and `<IncludeDirectory>`. `<Library>` (§2.4.10.6) names a static library in `binaries/` or, with `external="true"`, one the environment provides.
- **FMI 3.0.2 §2.5.1.3 (Directory sources) and the note in §2.4.10.5.** The FMI headers are not in the FMU; the importer supplies them, so that "the C compiler can check for consistent function arguments". **§2.5.1.4** defines platform tuples and asks ELF binaries to set `RPATH="$ORIGIN"`.

FMPy's `build_platform_binary` (0.3.32) reads exactly this and no more (first configuration, first source file set, its definitions, its own headers, built with CMake), so it would not build OpenModelica's FMU without the definitions above.

## When Konjugate builds

- **Sources and no binary for this computer.** `inspectFmuArchive` accepts an FMU without `binaries/` when it has build information (a `buildDescription.xml`, or `<SourceFiles>` in its Co-Simulation element) and still refuses one with neither, in today's words. **Add › FMU…**, drag-and-drop and opening a project that keeps such an FMU ask to build it.
- **A binary for this computer.** It is used, as today. **About this FMU** offers **Build from its sources**; the built library then replaces the shipped one for that FMU on this computer until **Use its own binary**.
- **Model Exchange only, or a `<Library>`.** Konjugate imports Co-Simulation, so an FMU whose sources describe only Model Exchange is refused before compiling (FMI 2.0's Co-Simulation `modelIdentifier` is the one built). A `<Library>` is refused by name in the first stages.

## How it builds

The app turns the build information into a **build plan** (source files, each set's language and definitions, include directories, `modelIdentifier`, platform), shown under **Details** in the confirmation and handed to a new engine command beside `buildSharedLibrary`, `buildFmuSources`, so `cppToolchain.cpp`'s compiler discovery, Apple SDK sysroot, macOS minimum version and MSVC environment are written once.

- **FMI 3.0, or 2.0.4 with a `buildDescription.xml`:** the matching configuration; every source file set compiled with its language standard and definitions, linked into one shared library.
- **FMI 2.0 with `<SourceFiles>` only:** every listed file, as C, `sources/` as the include directory.
- **Always:** Konjugate's own include directory first, holding the FMI 2.0 and 3.0 headers as published (BSD 2-Clause), with the override-prefix macro defined so the library exports the names Konjugate's glue loads. The headers in `engine/include/fmi2` and `fmi3` today are reduced copies (Co-Simulation only, no prefix macros) and stay for export; the full ones go beside them. The FMU's own copies of the headers (OpenModelica's `sources/fmi`) are not used, as §2.5.1.3 intends. CMake's Release optimisation (`-O3 -DNDEBUG`, `/O2 /DNDEBUG`), which the Reference FMUs' and OpenModelica's builds use; position-independent code; `RPATH=$ORIGIN` on Linux; the math library; no fast-math.
- **Exporter recipes.** Chosen by `generationTool` and a fingerprint of `sources/`, a recipe adds definitions, libraries and a C standard, never a script. The first, from the PID example: OpenModelica 1.2x, the four definitions above plus `OM_HAVE_PTHREADS`, pthreads and `libm`. An OpenModelica FMU that needs SUNDIALS (CVODE) is refused by name until a recipe covers it.
- **`compilerOptions`** are passed only when every flag is on a short allow-list (optimisation, language standard, warnings, `-fno-rtti` and the like); anything else (`-B`, `-fplugin`, `@file`, `-o`, `/FI`, a path outside `sources/`) refuses the build, naming the flag. A `compiler` attribute naming another compiler family is said, not obeyed.

The compiler runs in a fresh temporary directory holding a copy of `sources/` alone, with a five-minute limit and a cap on its output. A failure shows the first error, with **Show the whole log**.

## Finding a compiler

A C compiler comes with the C++ one programs already need. The build uses the C driver beside the resolved one (`clang` beside `clang++`, `gcc` beside `g++`; `cl.exe` compiles C with `/TC`), the same for the Provider toolchains override. The app checks it runs before asking; when it does not, the confirmation becomes the message, ending with **Set a compiler…** (the existing Provider toolchains page). CMake is never needed.

| Platform | Looked for | When there is none |
|---|---|---|
| macOS | `xcrun -find clang` | "Building this FMU needs Apple's command line tools. Open Terminal, run `xcode-select --install`, then add the FMU again." |
| Windows | MSVC's `cl.exe` via `vswhere` (not today's fixed paths), then `clang`, `gcc` | "Building this FMU needs a C compiler. Install Visual Studio Build Tools with 'Desktop development with C++', or set a compiler in Settings › Provider toolchains." |
| Linux | `cc`, `gcc`, `clang` | "Building this FMU needs a C compiler. Install your distribution's build tools (for example `sudo apt install build-essential`), or set one in Settings › Provider toolchains." |

## Trust and safety

An FMU's binary is native code that runs with the person's rights; so is its built library. Building from sources does not make an FMU safer, and nothing in the app suggests it was checked. What is new is a compiler running on files someone else wrote. The confirmation:

> **Build PidController from its sources?** It has no binary for this computer (x86_64-windows). Konjugate can compile its 113 C files with Microsoft C/C++ 19.44 and then run it, as it runs any FMU. Only build FMUs from people you trust: the code will run with your permissions, as a downloaded program would. Konjugate runs the compiler only, not the FMU's own build scripts, and uses no network. **Build** · **Cancel** · Details

**Guaranteed:** only the compiler and linker run, started with an argument list Konjugate builds, never a shell; nothing in `sources/` is executed at build time; the build opens no network connection; source paths are checked as archive paths are (no `..`, no absolute paths); include directories are `sources/` and Konjugate's own.

**Not guaranteed, said in Details and the help:** a C file may `#include` an absolute path, which the compiler will read (its contents can at most appear in an error on this computer); the compiler is not sandboxed (macOS's `sandbox-exec` is deprecated, Windows has nothing Konjugate can rely on, Linux namespaces are not on every distribution); the built library is loaded into the engine as any FMU's binary is, with no further isolation.

Nothing builds without the confirmation. A project that keeps a source-only FMU opens, says on the node and in the Run dialog that it "needs to be built from its sources on this computer", and asks when the person runs or presses **Build**.

## Caching

Builds live in the app's data folder, `fmuBuilds/<key>/`: the library and `build.json` (the plan, the compiler's path and version banner, the flags, the platform tuple, the time, and the library's SHA-256). The key is a SHA-256 over the FMU archive's SHA-256 (already in `fmuMeta.json`), the compiler's identity, the target tuple, the full argument list, the recipe's name and version, and the SHA-256 of Konjugate's FMI headers; any change rebuilds. A cached library is checked against its recorded SHA-256 before loading; a lock file keeps two windows from building one key twice. **About this FMU** says "Built here from its sources with Apple clang 21.0.0 on 27 November 2026", with **Rebuild** (ignores the cache) and **Show build log**. Uninstalling an FMU removes its builds; Settings gains **Clear FMU builds**.

## Where the built binary lives

| | In this computer's cache (recommended) | Inside the project's attachment |
|---|---|---|
| The project keeps | The FMU as it came; SHA-256 unchanged | A new FMU with this binary added; a new SHA-256 |
| Saving after a build | Byte-identical project | The project and the node's `fmuSha256` change |
| Another computer | Builds its own, or uses a shipped binary | Runs without building, if the same platform |
| Trust | The recipient builds from sources they can read | The recipient runs a binary built elsewhere |

Container version 2 keeps the FMU archive as an attachment named by its SHA-256 ([KJT format](../kjtFormat.md)), installed on open by `installProjectAttachments`. With the cache that path is untouched: a source-only FMU installs like any other, and the build belongs to this computer, like a compiled program's. For sharing with a computer that has no compiler, **Save FMU with this computer's binary…** in About this FMU writes a new `.fmu` the person chooses to use; the project never changes silently.

## Reproducibility

The same FMU, compiler and flags give the same library and the same numbers. Different compilers may round differently (a fused multiply-add above all), so a source-only FMU's last bits can differ between computers, as a binary FMU's do between its platforms today. The build record names the compiler and a run's metadata records "built from sources" and the cache key, so two runs can be told apart. Konjugate does not force identical builds across compilers.

## Web edition

The web edition can neither compile C nor load a native library. **Add › FMU…** keeps saying "FMUs run in the desktop app only" (`src/renderer/webShims/packages.mjs`), and so does the node of a project with a source-only FMU. WebAssembly is the later path, in its own proposal: the Reference FMUs 0.0.42 already carry a `wasm32-wasip2` binary ([The FMU round trip](fmuImportWorkflow.md)). Compiling C in the browser is not planned.

## Verification

- **Reference FMUs.** Each FMI 2.0 and 3.0 case in `tests/engine/fixtures/referenceFmus/cases.json`, its FMU with `binaries/` removed, built and run, then compared with the same case on the shipped binary at every communication point, bit for bit: macOS arm64 (whose shipped binary is clang-built, as ours is), Linux x86_64 and Windows x86_64. The libraries are not compared byte for byte (paths, Mach-O UUIDs and compiler versions differ); their results are. A differing case fails until the difference is explained and recorded.
- **Intel Mac.** The Reference FMUs, refused there today, built and compared with `fmpyReference.json` as the fidelity tests already do.
- **OpenModelica's PID controller.** `PidController.fmu` without `binaries/`, built with the recipe, run by `tests/engine/pidControllerExample.mjs`: FMPy's command at all 1440 points bit for bit on the Mac (the committed `darwin64` binary is Apple clang's build of the same sources); on Linux x86_64, any difference from gcc 11.4's binary reported with its size.
- **Refusals.** No compiler (each platform's message), a compile error, a disallowed flag, a `<Library>`, Model Exchange only, a `..` path, the time limit, neither binaries nor build information.
- **Cache and project.** A second import builds nothing; a new compiler identity rebuilds; a corrupted cached library is rebuilt; concurrent builds of one key build once; a project saved before and after a build is byte-identical.

## Stages

1. **Read build information.** *Built* (`src/fmuBuildInformation.mjs`, `tests/fmuBuildInformation.test.mjs`): an FMU with build information and no binaries is accepted by `inspectFmuArchive` and installs; About this FMU and the install review say "Sources only: Konjugate can build it, 113 C files from its <SourceFiles> (exported by OpenModelica 1.27.1)", "It also carries its sources" beside a binary, or why it cannot be built (a `<Library>`, a path leaving `sources/`, a listed file it does not carry, a language that is not C or C++, no configuration for this platform); Add › FMU… still refuses one with no binary for this computer, saying it carries its sources, until stage 3 builds it. Parse `buildDescription.xml` and `<SourceFiles>`, choose the configuration, recognise OpenModelica, accept source-only FMUs at inspection; About this FMU says "Sources only: Konjugate can build it". Unit tests on the Reference FMUs' and the PID FMU's descriptions, platform choice and fallback, 2.0.4 precedence.
2. **Compiler and plan.** The C driver, `vswhere`, the per-platform messages, the full FMI headers, and `buildFmuSources`. Tests: the Reference FMUs' plans compiled; fake compilers on `PATH` for the messages.
3. **Build on import.** Confirmation, progress and Cancel, failures in words, the cache and its lock, About this FMU's record and Rebuild, projects asking before building. Tests: the bit-for-bit comparison, cache, refusals, project byte identity.
4. **The OpenModelica recipe.** With the PID controller's verification on macOS and Linux, Windows when a runner has MSVC.
5. **Rebuild and share.** Build from its sources when a binary exists, Save FMU with this computer's binary, Clear FMU builds, and the FMU docs and tutorial's note on source FMUs.

## Risks

- **Exporter variety.** Many exporters' sources need more than the standard, as OpenModelica's do; each recipe is upkeep, and without one the build fails with the compiler's first error. Recipes are written only for exporters people bring, each with a test FMU.
- **Windows.** MSVC's environment is the most fragile part of `cppToolchain.cpp`, and C written for gcc may not build with MSVC. Try clang where MSVC fails, and say which was used.
- **Trust.** "Built from sources" may be read as "checked"; the confirmation's words, and no wording elsewhere suggesting review.
- **Bit-for-bit expectations.** A compiler update can change the last bits; the build record and run metadata make that visible.

## Decisions

The user accepted every recommendation below on 27 November 2026.


1. **Run the FMU's own CMakeLists when there is no recipe?** Configuring runs arbitrary code from the FMU and needs CMake (3.21 or newer for OpenModelica's). **Decided: no**; recipes instead, and a refusal naming the exporter that points to building outside Konjugate.
2. **Where does the built binary live?** This computer's cache, or inside the project's attachment. **Decided: the cache**, with **Save FMU with this computer's binary…** as an explicit action; projects stay byte-identical and recipients build from sources they can read.
3. **How often to confirm?** Every build, once per FMU, or a setting to always allow. **Decided: once per FMU archive (by SHA-256) on this computer**; a Rebuild after a compiler change asks nothing more.
4. **Which compiler setting?** Derive the C compiler from the C++ override, or add a C compiler field. **Decided: derive it**; add a field only when a real setup needs one.
5. **FMI 3.0 `compilerOptions`?** All, none, or an allow-list. **Decided: an allow-list**, refusing and naming any other flag.
6. **Build when a binary exists?** Only when none runs, or also on request. **Decided: also on request**, from About this FMU, never automatically.
7. **`<Library>` elements?** **Decided: refuse by name at first**; support static libraries in `binaries/` when a real FMU needs them.
8. **Verification bar.** Bit for bit against the shipped binaries, or FMPy's tolerance. **Decided: bit for bit where the shipped binary used the same compiler family**, and a recorded, explained difference elsewhere.

## Not in this proposal

Model Exchange, compiling to WebAssembly, SUNDIALS for OpenModelica's CVODE FMUs, C++ beyond what a source file set's `language` allows, cross-compiling for another platform, and FMI 1.0.
