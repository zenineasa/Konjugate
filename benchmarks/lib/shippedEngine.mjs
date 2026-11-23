/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The engine the app ships, and the one every benchmark, timed or not, runs unless told otherwise: the development preset's build
// (engine/CMakePresets.json) in out/engine, RelWithDebInfo (-O2), as npm run build:engine builds it and CI packages it. No dependencies,
// so the light modules (machine.mjs, setup.mjs) can share it: setup.mjs runs before src/generated/, which engine.mjs needs, exists.

import { join } from 'node:path';

export const repositoryRoot = join(import.meta.dirname, '..', '..');
export const shippedBuildType = 'RelWithDebInfo';
export const engineDirectory = join(repositoryRoot, 'out', 'engine');
export const engineExecutable = join(engineDirectory, process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
