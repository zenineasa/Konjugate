<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Development setup

Konjugate uses Node.js for Electron and CMake with a pinned vcpkg baseline for
the native engine dependencies. The normal development build requires METIS;
it never silently substitutes the built-in partitioner.

## Platform prerequisites

- **macOS:** Node.js 24.19 or newer, CMake 3.20 or newer, Git and the Xcode
  Command Line Tools (`xcode-select --install`).
- **Windows:** Node.js 24.19 or newer, CMake 3.20 or newer, Git and Visual
  Studio 2022 Build Tools with **Desktop development with C++**. Run the
  commands from a Developer PowerShell or Developer Command Prompt.
- **Linux:** Node.js 24.19 or newer, CMake 3.20 or newer, Git, a C++20 compiler
  and the desktop libraries required by Electron. On Debian or Ubuntu, install
  `build-essential`, `cmake`, `git`, `curl`, `zip`, `unzip`, `tar` and `pkg-config`
  before following the common procedure.

## Common procedure

From the repository root:

```bash
npm ci
npm run setup
npm run dev
```

`npm run setup` downloads vcpkg into the ignored `.tools/` directory, checks
out the revision recorded by `vcpkg.json`, installs Zlib, OpenSSL,
Boost.PropertyTree and METIS then configures `out/engine`. It does not install
an operating-system compiler or SDK.

Later development sessions normally require only `npm run dev`. Run setup
again after `vcpkg.json`, the vcpkg baseline or native build configuration
changes.

## Windows build performance

Native C++ compilation on Windows can take longer than on macOS/Linux due to default MSBuild generator overhead, real-time antivirus file scanning, and MSVC compiler front-end processing. The build is optimized automatically with `/MP` (multi-processor parallel compilation). To maximize build speed on Windows:

- **Use Ninja:** If installed (via Visual Studio CMake tools or `winget install Ninja-build.Ninja`), pass `-G Ninja` when invoking CMake manually for zero-overhead parallel builds.
- **Antivirus Exclusions:** Exclude the project's `out/` and `.tools/` directories from real-time antivirus / Windows Defender scanning to avoid I/O bottlenecks during `.obj` and `.pdb` writes.
- **Developer Shell:** Always run Node and CMake commands from a Visual Studio Developer PowerShell or Command Prompt.

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

Application packaging has additional host-specific requirements and is
documented separately from the development workflow.
