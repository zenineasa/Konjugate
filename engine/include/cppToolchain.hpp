/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <filesystem>
#include <string>

namespace konjugate::cppToolchain {

// Resolves the C++ compiler to invoke: overrideCompiler verbatim if non-empty, else best-effort
// auto-detection (xcrun-discovered clang++ on macOS, otherwise the bare "c++" on PATH -- MSVC has
// no auto-detection here; a Windows caller with no override falls through to "c++" too, exactly
// as buildNativeArtifact's predecessor did).
std::string resolveCompiler(const std::string& overrideCompiler);

// Compiles sourcePath together with gluePath (two existing files on disk, linked in one compiler
// invocation) against includeDirectory, producing either a shared library (sharedLibrary=true) or
// an executable at artifactPath. compilerOverride, if non-empty, is used verbatim instead of
// auto-detecting. failureContext names what was being built, for the thrown error message (e.g.
// "the C++ relationship provider" or "the shared library"). Throws std::runtime_error, with the
// compiler's captured stdout+stderr, on a nonzero exit.
void buildNativeArtifact(const std::filesystem::path& sourcePath, const std::filesystem::path& gluePath,
    const std::filesystem::path& includeDirectory, const std::filesystem::path& artifactPath,
    bool sharedLibrary, const std::string& compilerOverride, const std::string& failureContext);

} // namespace konjugate::cppToolchain
