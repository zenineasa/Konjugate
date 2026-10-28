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

// ---- The user's own uploaded shapes
//
// A shape a person uploads is kept beside the bundled ones (a folder on the desktop, the browser's own storage on the web) and
// listed under the "userUploaded" domain. What is kept, and the name it is kept under, is decided here, so both editions agree.

export const uploadedShapeFormats = ['stl', 'step', 'stp'];

// The extension a shape upload may have, or null for a file that is not a shape.
export function uploadedShapeFormat(fileName) {
    const format = /\.([^./\\]+)$/.exec(String(fileName))?.[1].toLowerCase();
    return uploadedShapeFormats.includes(format) ? format : null;
}

// The name an upload is kept under: its own name with only letters, digits, spaces, "_" and "-" left, and "(1)", "(2)"... added when
// a shape of that name is already kept. `taken(name)` says whether one is.
export function uploadedShapeFileName(fileName, taken = () => false) {
    const format = uploadedShapeFormat(fileName);
    if (!format) throw new Error('Only STL, STEP, or STP files can be saved to the shape library.');
    const base = String(fileName).split(/[\\/]/).pop();
    const stem = base.slice(0, -(format.length + 1)).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'shape';
    let candidate = `${stem}.${format}`;
    for (let counter = 1; taken(candidate); counter += 1) candidate = `${stem} (${counter}).${format}`;
    return candidate;
}

// The library entry for a kept upload.
export function uploadedShapeEntry(file) {
    const format = uploadedShapeFormat(file);
    return {
        id: `userUploaded/${file}`,
        name: file.slice(0, -(format.length + 1)),
        domains: ['userUploaded'],
        domain: 'userUploaded',
        format,
        file,
        tags: [],
        source: 'user'
    };
}
