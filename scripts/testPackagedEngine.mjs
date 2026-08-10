// Copyright © 2026 Zenin Easa Panthakkalakath

// Runs the same engine-level test scripts scripts/testEngine.mjs uses against the packaged
// engine binary instead of the dev build (out/engine/konjugateEngine). Catches packaging-only
// failure modes the dev build can't: a missing bundled library (METIS in particular, since it's
// an optional runtime dependency), a broken code-signing pass on macOS, or a resource path that
// only resolves correctly once actually laid out the way electron-packager's --extra-resource
// produces it. Requires a package built for the host platform -- run `make packageApp` (or the
// platform-specific target) first; this does not build one itself, since packaging is slow and
// callers may want to verify a build they already produced.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { rootDirectory, run } from './developmentEnvironment.mjs';
import { packagedEngineExecutable } from './packagedPaths.mjs';

const executable = packagedEngineExecutable(rootDirectory);
if (!existsSync(executable)) {
    throw new Error(`No packaged engine binary found at ${executable}. Run "make packageApp" (or the platform-specific package target) first.`);
}

await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'engineCompatibility.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'numericalRegression.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'edgeDirectionalityContract.mjs'), executable]);
await run(process.execPath, [join(rootDirectory, 'tests', 'engine', 'edgeNullStateIdContract.mjs'), executable]);
