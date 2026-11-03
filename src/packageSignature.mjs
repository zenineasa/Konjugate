/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Checking a package's publisher signature with WebCrypto, for the web edition (docs/proposals/webEditionPackages.md, stage 4). The
// desktop checks with node:crypto in packageArchive.mjs; this gives the same answers for the same archive and registry, and the tests
// check that the two agree on archives the desktop signed. The check is asynchronous because WebCrypto is, and it is advisory as on
// the desktop: it reports a status for the person to read and refuses nothing.
//
// Statuses: 'verified', 'unsigned' (a reserved prefix, no signature), 'unclaimed' (no reserved prefix, no signature), 'invalid' (a
// signature that does not hold, with the reason) and 'unverifiable' (this browser cannot check Ed25519 signatures, so nothing is
// claimed either way).

import { strFromU8 } from 'fflate';
import { inspectPackageArchive, isPrefixOf, matchingPrefix, signatureEntryName, signatureFormat, signatureFormatVersion } from './packageInspection.mjs';

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Same digest as packageArchive.mjs's contentDigest: only the set of (name, content) pairs matters, not the zip's byte layout.
async function contentDigest(files, subtle) {
    const lines = [];
    for (const name of Object.keys(files).sort()) lines.push(`${name}:${hex(new Uint8Array(await subtle.digest('SHA-256', files[name])))}`);
    return new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n'))));
}

function pemToDer(pem) {
    const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

// Whether this browser has Ed25519 at all, found by asking it for a key once.
const supported = new WeakMap();
async function ed25519Supported(subtle) {
    if (!supported.has(subtle)) supported.set(subtle, subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(() => true, () => false));
    return supported.get(subtle);
}

export async function verifyPackageArchiveAsync(archive, { namespaces, subtle = globalThis.crypto?.subtle } = {}) {
    const { packageManifest, files } = inspectPackageArchive(archive);
    const packageId = packageManifest.packageId;
    const reservedPrefix = matchingPrefix(packageId, namespaces?.prefixes);
    const signatureRaw = files[signatureEntryName];
    if (!signatureRaw) return { status: reservedPrefix ? 'unsigned' : 'unclaimed', reservedPrefix };
    let signatureEntry;
    try {
        signatureEntry = JSON.parse(strFromU8(signatureRaw));
    } catch {
        return { status: 'invalid', reason: 'signature.json is not valid JSON.' };
    }
    if (signatureEntry.format !== signatureFormat || signatureEntry.formatVersion !== signatureFormatVersion || signatureEntry.algorithm !== 'ed25519') {
        return { status: 'invalid', reason: 'The signature format or algorithm is unsupported.' };
    }
    if (typeof signatureEntry.prefix !== 'string' || !isPrefixOf(signatureEntry.prefix, packageId)) {
        return { status: 'invalid', reason: 'The signature claims a prefix that is not a prefix of this package id.' };
    }
    const entry = namespaces?.prefixes?.[signatureEntry.prefix];
    if (!entry) return { status: 'invalid', reason: `"${signatureEntry.prefix}" is not a reserved prefix.`, prefix: signatureEntry.prefix };
    if (!subtle || !await ed25519Supported(subtle)) return { status: 'unverifiable', reason: 'This browser cannot check Ed25519 signatures.', prefix: signatureEntry.prefix };
    const filesWithoutSignature = Object.fromEntries(Object.entries(files).filter(([name]) => name !== signatureEntryName));
    const digest = await contentDigest(filesWithoutSignature, subtle);
    if (`sha256:${hex(digest)}` !== signatureEntry.digest) {
        return { status: 'invalid', reason: 'The signed digest does not match the package contents.', prefix: signatureEntry.prefix };
    }
    let signatureBytes;
    try {
        signatureBytes = Uint8Array.from(atob(signatureEntry.signature), (character) => character.charCodeAt(0));
    } catch {
        return { status: 'invalid', reason: 'The signature is not valid base64.', prefix: signatureEntry.prefix };
    }
    for (const pem of Array.isArray(entry.publicKeys) ? entry.publicKeys : []) {
        try {
            const key = await subtle.importKey('spki', pemToDer(pem), { name: 'Ed25519' }, false, ['verify']);
            if (await subtle.verify({ name: 'Ed25519' }, key, signatureBytes, digest)) return { status: 'verified', prefix: signatureEntry.prefix, owner: entry.owner };
        } catch {
            // A key that cannot be read is not a key that verifies.
        }
    }
    return { status: 'invalid', reason: 'The signature does not verify against any registered key for this prefix.', prefix: signatureEntry.prefix };
}
