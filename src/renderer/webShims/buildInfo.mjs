/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Overwritten by scripts/buildWebShell.mjs with the real package.json version when assembling
// out/webShell/ -- this source copy is only ever seen when running the shell straight out of
// src/ without going through that build step.
export const version = 'dev';

// Also overwritten by scripts/buildWebShell.mjs: true for the pthread-enabled "threads" variant
// (out/webShellThreads/, served with COOP/COEP -- docs/proposals/webEdition.md, phase 6), false
// for the default shell. Lets runtime code (e.g. webShims/misc.mjs's providerToolchains.get('cpp'))
// answer honestly without re-deriving it from crossOriginIsolated/SharedArrayBuffer feature
// detection, which would also be true on a threads build that simply hasn't loaded @wasmer/sdk yet.
export const threads = false;
