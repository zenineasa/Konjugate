// Copyright © 2026 Zenin Easa Panthakkalakath

// Generates flatpak/generatedSources.json from package-lock.json via flatpak-node-generator
// (https://github.com/flatpak/flatpak-builder-tools/tree/master/node), so the Flathub build --
// which runs with no network access -- can `npm install --offline` inside its sandbox. This is
// the Node/npm half of the Flathub work only; the vcpkg-fetched C++ side (boost-property-tree,
// eigen3, nlopt, openssl, protobuf, zlib) has no equivalent generator and is handled by hand-
// written flatpak-builder modules under flatpak/modules -- see docs/packageManagerDistribution.md.
//
// flatpak-node-generator is a Python tool, not an npm package, so it isn't a devDependency here.
// It's expected on PATH, installed via:
//   pipx install git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node
//
// NOT YET RUN AGAINST A REAL flatpak-builder BUILD -- this script's output is a starting point,
// not a verified-working one. Regenerate and re-verify before relying on it for a submission.

import { join } from 'node:path';
import { commandExists, rootDirectory, run } from './developmentEnvironment.mjs';

if (!(await commandExists('flatpak-node-generator'))) {
    throw new Error(
        'flatpak-node-generator was not found on PATH. Install it with:\n' +
        '  pipx install git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node'
    );
}

const lockfilePath = join(rootDirectory, 'package-lock.json');
const outputPath = join(rootDirectory, 'flatpak', 'generatedSources.json');

await run('flatpak-node-generator', ['npm', lockfilePath, '-o', outputPath]);
console.log(`Generated ${outputPath} from package-lock.json.`);
