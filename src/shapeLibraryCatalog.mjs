/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared between src/main.mjs's shapeLibraryManifest() (reads assets/shapes/manifest.json via
// node:fs) and src/renderer/webShims/misc.mjs's own shapeLibraryManifest() (reads the same file
// via fetch() -- a genuinely different I/O mechanism the read itself can't share) -- both need
// the exact same per-entry normalization afterward, which is what actually lived duplicated
// here before. Pure function, no node:*/browser-only dependency, portable either way.

export function normalizeShapeLibraryEntry(shape) {
    const domains = Array.isArray(shape.domains) ? shape.domains : (shape.domain ? [shape.domain] : []);
    return { ...shape, domains, domain: domains[0] ?? 'general', source: 'bundled' };
}
