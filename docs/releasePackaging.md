<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Release packaging

Release packaging uses the same pinned, METIS-required engine configuration as development. CMake installs the executable and its required runtime libraries into `out/packageResources/engine`; Electron packages that install layout rather than the complete CMake build tree.

The package verifier starts the installed engine, reads its `capabilities` response and requires an available METIS version. It also verifies the tracked METIS attribution and Apache 2.0 text. A package therefore fails if the METIS runtime cannot load, even when a library file happens to be present.

Run the host package with:

```bash
npm run package
```

Additional host tools are currently required:

- macOS uses `rsvg-convert` and the platform `hdiutil` utility. Konjugate writes its ICNS container directly from the generated PNG sizes to avoid depending on version-sensitive `iconutil` iconset validation.
- Windows uses Python 3 for icon generation and requires NSIS (`makensis`) on `PATH` to build the installer, plus a Make-compatible shell for the packaging recipes. `make distributable` produces a signed-shortcut, Add/Remove Programs-registered `*-setup.exe` from `packaging/windows/installer.nsi`; `make distributableWindowsPortable` still produces the plain ZIP for users who want an install-free copy.
- Linux uses `rsvg-convert` and requires `appimagetool` for an AppImage. The binary downloaded from the official releases page is named after its architecture (e.g. `appimagetool-x86_64.AppImage`), not `appimagetool` — the Makefile looks for `appimagetool` on `PATH`, so rename it or symlink it (`ln -s appimagetool-x86_64.AppImage appimagetool`) into a directory on `PATH`, and make sure it's executable (`chmod +x`).

The NSIS script only stages files already produced by `packageWindows` (the electron-packager output plus the CMake-installed engine and METIS runtime) — it does not itself decide what ships, so the packaging notice verifier continues to run against the same `packageWindows` output before `distributableWindows` ever invokes `makensis`.

The Windows Make dependency is a packaging limitation, not a development requirement. Packaging orchestration should move to cross-platform Node scripts before the Windows release workflow is considered final.
