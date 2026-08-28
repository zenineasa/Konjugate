// Copyright © 2026 Zenin Easa Panthakkalakath

// Cross-checks every statically-shipped vcpkg dependency (any installed port with its own
// `copyright` file) against thirdPartyNotices.md, so a new dependency can't go undocumented
// silently. This is exactly how abseil/utf8-range were originally missed: both are undeclared
// transitive dependencies of protobuf, invisible in vcpkg.json, and only discoverable by
// inspecting a real installed tree -- the same tree this script reads.
//
// Two deliberate simplifications:
// - Host-only build tooling (vcpkg's own `vcpkg-*`-prefixed ports, e.g. vcpkg-cmake,
//   vcpkg-cmake-config) never ships inside the compiled engine and is excluded entirely.
// - Every `boost*` port (the property-tree port itself plus its ~60 transitive Boost sub-ports,
//   each of which vcpkg gives its own `copyright` file) is treated as one logical dependency,
//   matching thirdPartyNotices.md's own framing ("every Boost component this pulls in
//   transitively"): a single "boost" mention covers the whole group, rather than requiring each
//   individual sub-port name to appear literally.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDirectory } from './developmentEnvironment.mjs';

const engineDirectory = process.argv[2] ?? join(rootDirectory, 'out', 'engine');
const installedDirectory = join(engineDirectory, 'vcpkg_installed');

const triplets = (await readdir(installedDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== 'vcpkg')
    .map((entry) => entry.name);
if (triplets.length === 0) throw new Error(`No vcpkg triplet directories found under ${installedDirectory}.`);

const notice = (await readFile(join(rootDirectory, 'thirdPartyNotices.md'), 'utf8'))
    .toLowerCase().replace(/[^a-z]/g, '');

async function hasFile(path) {
    return readFile(path, 'utf8').then(() => true, () => false);
}

const undocumented = [];
let sawBoost = false;
for (const triplet of triplets) {
    const shareDirectory = join(installedDirectory, triplet, 'share');
    const ports = (await readdir(shareDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('vcpkg-'))
        .map((entry) => entry.name);
    for (const port of ports) {
        if (!(await hasFile(join(shareDirectory, port, 'copyright')))) continue;
        if (port === 'boost' || port.startsWith('boost-') || port.startsWith('boost_')) {
            sawBoost = true;
            continue;
        }
        // Digits are stripped along with punctuation before comparing: several vcpkg port names
        // encode an unrelated major-version digit (e.g. "eigen3" ships Eigen 5.0.1) that would
        // otherwise never literally appear in the notice text.
        const normalized = port.toLowerCase().replace(/[^a-z]/g, '');
        if (!notice.includes(normalized)) undocumented.push(`${port} (${triplet})`);
    }
}
if (sawBoost && !notice.includes('boost')) undocumented.push('boost (transitive Boost components)');

if (undocumented.length > 0) {
    throw new Error(`thirdPartyNotices.md does not mention: ${undocumented.join(', ')}. Add a section for each before packaging.`);
}

console.log(`Verified thirdPartyNotices.md covers every statically-shipped vcpkg dependency across ${triplets.join(', ')}.`);
