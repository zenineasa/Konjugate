/* Copyright © 2026 Zenin Easa Panthakkalakath */

#pragma once

#include <cstddef>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

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
// "the C++ relationship provider" or "the shared library"). needsDynamicLoaderLibrary links libdl
// on Linux (a no-op everywhere else -- macOS's dlopen lives in libSystem, Windows uses
// LoadLibrary): only an artifact whose own glue code dlopen()s a further, external library (e.g.
// providerInProcessNodeShim.cpp dlopening an imported FMU's binary) needs it. Throws
// std::runtime_error, with the compiler's captured stdout+stderr, on a nonzero exit. selfContained
// links the compiler's own runtime into the artifact on Windows, for a library another program
// loads (an exported FMU's DLL): MinGW-w64's g++ otherwise links libstdc++-6.dll, libgcc_s_seh-1.dll
// and libwinpthread-1.dll, which Konjugate finds on PATH but a host such as FMPy (Python's ctypes,
// which does not search PATH) does not; MSVC is asked for its static runtime (/MT) explicitly.
void buildNativeArtifact(const std::filesystem::path& sourcePath, const std::filesystem::path& gluePath,
    const std::filesystem::path& includeDirectory, const std::filesystem::path& artifactPath,
    bool sharedLibrary, const std::string& compilerOverride, const std::string& failureContext,
    bool needsDynamicLoaderLibrary = false, bool selfContained = false);

// ---- A shared library built from someone else's C or C++ sources (docs/proposals/sourceFmuImport.md) --------------------------
// Each source file set is compiled file by file with its own language, standard, definitions and include directories, then all
// are linked into one shared library. Nothing here knows about FMI: the caller (src/fmuSourceBuild.mjs) supplies the standard
// headers' directory, the definitions and the files. Only the compiler and linker run, started with these argument lists and
// never through a shell.
struct SourceSet {
    std::string language;                       // "c" or "c++"
    std::string standard;                       // "c99", "c11", "c++17", ...; empty for the compiler's own default
    std::vector<std::string> files;             // relative to the source root
    std::vector<std::string> definitions;       // "NAME" or "NAME=VALUE"
    std::vector<std::string> includeDirectories; // relative to the source root
    std::vector<std::string> options;            // the build description's own flags, already checked against an allow-list
};

struct SourceLibraryPlan {
    std::filesystem::path sourceRoot;
    std::filesystem::path objectDirectory;
    std::filesystem::path artifactPath;
    std::vector<std::filesystem::path> includeFirst; // searched before the source root's own folders
    std::vector<SourceSet> sets;
    std::vector<std::string> libraries;          // "m", "pthread": linked where the platform has them
    bool threads = false;
    int timeoutSeconds = 300;
};

struct BuildStep {
    std::string what;                            // "Compiling model.c", "Linking"
    std::string compiler;
    std::vector<std::string> arguments;
};

// The steps that build `plan`, with the C compiler `cCompiler` (resolveCompiler when empty) and, for C++ sets and linking
// them, `cxxCompiler`. Pure but for the macOS SDK path and MSVC's folders, which it looks up as buildNativeArtifact does.
std::vector<BuildStep> sourceLibrarySteps(const SourceLibraryPlan& plan, const std::string& cCompiler, const std::string& cxxCompiler);

// Runs the steps in order, each in the object directory, the whole build ending after plan.timeoutSeconds and each step's
// output kept to its first 256 KiB. Throws std::runtime_error naming the step and with its output when one fails, or when the
// time runs out (the running compiler is stopped).
// `onStep(index, count, step)`, when given, is called before each step runs (the app's progress).
void buildSourceLibrary(const SourceLibraryPlan& plan, const std::vector<BuildStep>& steps,
    const std::function<void(std::size_t, std::size_t, const BuildStep&)>& onStep = {});

} // namespace konjugate::cppToolchain
