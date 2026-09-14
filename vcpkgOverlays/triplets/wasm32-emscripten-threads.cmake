# Copyright © 2026 Zenin Easa Panthakkalakath
#
# Overlay triplet for the pthread-enabled web build (docs/proposals/webEdition.md, phase 6):
# identical to vcpkg's own upstream `wasm32-emscripten` community triplet (checked directly --
# .tools/vcpkg/triplets/community/wasm32-emscripten.cmake, tracked in vcpkg's own git history,
# not something this repo can edit in place since .tools/ is gitignored and recloned by
# scripts/setupWebBuild.mjs), except every dependency is additionally compiled with -pthread.
#
# This has to be a genuinely separate triplet, not a flag added to the existing one: Emscripten's
# linker hard-errors mixing pthread and non-pthread object files (shared-memory/atomics feature
# mismatch), and every dependency already installed under the plain wasm32-emscripten triplet
# (boost, eigen3, metis, nlopt, openssl, protobuf, zlib) was built without it. vcpkg caches
# installations per triplet, so building this one is additive disk cost, not a rebuild of the
# existing non-threaded install.
#
# Referenced via VCPKG_OVERLAY_TRIPLETS (engine/CMakePresets.json's "web-threads" preset) rather
# than placed inside .tools/vcpkg/ directly, since anything written there is lost on the next
# `npm run setup:web` (a fresh clone at the pinned vcpkg commit).

set(VCPKG_ENV_PASSTHROUGH_UNTRACKED EMSCRIPTEN_ROOT EMSDK PATH)

if(NOT DEFINED ENV{EMSCRIPTEN_ROOT})
   find_path(EMSCRIPTEN_ROOT "emcc")
else()
   set(EMSCRIPTEN_ROOT "$ENV{EMSCRIPTEN_ROOT}")
endif()

if(NOT EMSCRIPTEN_ROOT)
   if(NOT DEFINED ENV{EMSDK})
      message(FATAL_ERROR "The emcc compiler not found in PATH")
   endif()
   set(EMSCRIPTEN_ROOT "$ENV{EMSDK}/upstream/emscripten")
endif()

if(NOT EXISTS "${EMSCRIPTEN_ROOT}/cmake/Modules/Platform/Emscripten.cmake")
   message(FATAL_ERROR "Emscripten.cmake toolchain file not found")
endif()

set(VCPKG_TARGET_ARCHITECTURE wasm32)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)
set(VCPKG_CMAKE_SYSTEM_NAME Emscripten)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${VCPKG_ROOT_DIR}/scripts/toolchains/emscripten.cmake")

# The only real difference from the upstream triplet: every dependency gets -pthread so its
# object files are link-compatible with konjugateEngine's own -pthread build (see
# engine/CMakeLists.txt's KONJUGATE_WEB_THREADS-gated block).
set(VCPKG_C_FLAGS "-pthread")
set(VCPKG_CXX_FLAGS "-pthread")
set(VCPKG_LINKER_FLAGS "-pthread")
