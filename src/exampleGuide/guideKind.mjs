/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared by both src/main.mjs (window title) and this directory's own renderer.mjs (in-page
// title) -- kept as one function specifically because those two call sites drifted into two
// separately-maintained copies once before (main.mjs's own now-removed local version carried a
// comment warning about exactly this), and a fourth guide kind (welcome) is as good a time as any
// to stop that from happening a second time.
export function guideKindSuffix(kind) {
    if (kind === 'help') return 'Help';
    if (kind === 'welcome') return 'Welcome';
    return 'Example Guide';
}
