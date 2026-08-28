// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs clang-tidy (config: engine/.clang-tidy) over the engine's own C++ sources, using the
// compile_commands.json the "development" CMake preset already exports (see
// engine/CMakePresets.json's CMAKE_EXPORT_COMPILE_COMMANDS). Not wired into CI yet -- this is a
// local, opt-in tool for the memory-safety pass; making it a CI gate needs a first triage of
// whatever it surfaces on the existing codebase first, or every run would fail on a backlog
// rather than on a genuinely new regression.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists, rootDirectory, run } from './developmentEnvironment.mjs';

const compileCommandsDir = join(rootDirectory, 'out', 'engine');
if (!existsSync(join(compileCommandsDir, 'compile_commands.json'))) {
    throw new Error('out/engine/compile_commands.json is missing. Run npm run build:engine first.');
}

// Homebrew's llvm is keg-only on macOS (installed but not linked onto PATH, to avoid shadowing
// the system clang), so neither run-clang-tidy nor the clang-tidy binary it shells out to are
// found by name there even once installed -- run-clang-tidy's own PATH/build-dir heuristic for
// locating clang-tidy doesn't know about Homebrew's keg-only layout, so it must be pointed at
// explicitly via -clang-tidy-binary.
const macHomebrewLlvmDir = '/opt/homebrew/opt/llvm/bin';
const runClangTidy = await commandExists('run-clang-tidy') ? 'run-clang-tidy' :
    (process.platform === 'darwin' && existsSync(join(macHomebrewLlvmDir, 'run-clang-tidy'))) ?
        join(macHomebrewLlvmDir, 'run-clang-tidy') : null;
if (!runClangTidy) {
    throw new Error('run-clang-tidy was not found on PATH. Install LLVM (e.g. `brew install llvm` on macOS, '
        + 'or your platform\'s clang-tidy/clang-tools package) and ensure run-clang-tidy is reachable.');
}
const clangTidyBinaryArgs = runClangTidy === macHomebrewLlvmDir + '/run-clang-tidy'
    ? [`-clang-tidy-binary=${join(macHomebrewLlvmDir, 'clang-tidy')}`] : [];

// -config-file is passed explicitly rather than relying on clang-tidy's own upward-directory
// search for .clang-tidy: run-clang-tidy's own startup sanity check invokes clang-tidy once with
// a placeholder "-" (stdin) filename to confirm any checks are enabled at all, which has no real
// file path to search upward from and so silently finds nothing when run from the repo root
// (engine/.clang-tidy is a subdirectory away, not an ancestor) -- discovered by reproducing this
// exact failure locally, not assumed.
await run(runClangTidy, ['-p', compileCommandsDir, '-quiet', ...clangTidyBinaryArgs,
    `-config-file=${join(rootDirectory, 'engine', '.clang-tidy')}`, join(rootDirectory, 'engine', '(src|include)')]);
