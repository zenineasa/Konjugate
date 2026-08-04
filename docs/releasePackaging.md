<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Release packaging

Release packaging uses the same pinned, METIS-required engine configuration as
development. CMake installs the executable and its required runtime libraries
into `out/packageResources/engine`; Electron packages that install layout rather
than the complete CMake build tree.

The package verifier starts the installed engine, reads its `capabilities`
response and requires an available METIS version. It also verifies the tracked
METIS attribution and Apache 2.0 text. A package therefore fails if the METIS
runtime cannot load, even when a library file happens to be present.

Run the host package with:

```bash
npm run package
```

Additional host tools are currently required:

- macOS uses `rsvg-convert` and the platform `hdiutil` utility. Konjugate writes
  its ICNS container directly from the generated PNG sizes to avoid depending
  on version-sensitive `iconutil` iconset validation.
- Windows uses Python 3 for icon and ZIP generation and currently requires a
  Make-compatible shell for the packaging recipes.
- Linux uses `rsvg-convert` and requires `appimagetool` for an AppImage.

The Windows Make dependency is a packaging limitation, not a development
requirement. Packaging orchestration should move to cross-platform Node scripts
before the Windows release workflow is considered final.
