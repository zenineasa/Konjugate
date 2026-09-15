/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Shared between src/main.mjs (the desktop projectListExamples/openExampleGuide handlers) and
// scripts/buildWebShell.mjs (which generates examples/webManifest.json at build time) -- both
// run under Node (the build script is Node tooling, not browser code), so this needs no
// browser-portability treatment. It exists purely to stop the two from silently drifting: they
// were hand-copied from each other once already, while building the web edition.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function exampleIdFromFileName(fileName) {
    return fileName.replace(/\.kjt$/, '');
}

export function exampleLabel(fileName) {
    const stem = exampleIdFromFileName(fileName);
    return `${stem.charAt(0).toUpperCase()}${stem.slice(1)}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// The guide's own "## Overview" paragraph doubles as the explorer card's description, rather
// than duplicating it by hand in the manifest -- every example guide already opens with exactly
// this structure (see docs/examples restructuring), so it stays in sync with the guide for free.
export async function exampleDescription(examplesDirectory, stem) {
    const markdown = await readFile(join(examplesDirectory, `${stem}.md`), 'utf8').catch(() => '');
    const match = markdown.match(/## Overview\r?\n\r?\n([\s\S]+?)(?=\r?\n##\s|\r?\n*$)/);
    return match ? match[1].trim() : '';
}

// Everything about a catalog entry except thumbnailUrl, which desktop (a local file:// URL) and
// the web build (a plain relative path served alongside the .kjt) each construct differently.
export async function exampleCatalogEntry(examplesDirectory, fileName, manifest) {
    const stem = exampleIdFromFileName(fileName);
    return {
        id: fileName,
        label: exampleLabel(fileName),
        suggestedFilename: fileName,
        domains: manifest.get(stem)?.domains ?? [],
        description: await exampleDescription(examplesDirectory, stem)
    };
}
