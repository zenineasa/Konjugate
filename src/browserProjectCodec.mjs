/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Browser-native counterpart to src/projectFile.mjs's .kjt container encode/decode -- see
// docs/proposals/webEdition.md. Same container format (docs/kjtFormat.md): magic "KJTF", 1-byte
// version, 1-byte flags (bit 0 gzip, bit 1 AES-256-GCM), 4-byte big-endian JSON header length,
// JSON header, then gzip(model JSON) + optional raw result bytes.
//
// Encryption mirrors projectFile.mjs's exact scheme -- scrypt (N/r/p as stored in the header's
// kdf field, 32-byte derived key, 16-byte salt) + AES-256-GCM (12-byte IV, 16-byte tag stored
// separately in the header, matching Node's own createCipheriv/getAuthTag split) -- deliberately
// the SAME KDF as desktop, not Web Crypto's native PBKDF2: Web Crypto has no scrypt at all, and a
// PBKDF2-only web edition would create a second, non-interoperable population of encrypted
// projects that could never move between the two editions. The scrypt implementation itself
// comes from the vendored `scrypt-js` package (loaded as a classic <script>, see indexWeb's own
// transform in scripts/buildWebShell.mjs -- it's a UMD bundle, `window.scrypt.scrypt(...)`, the
// same pattern already used for protobufjs's minimal runtime). Only the KDF needed replacing;
// AES-256-GCM itself is already a native SubtleCrypto algorithm, using the exact same iv/tag the
// container already stores -- Web Crypto appends the tag to its own ciphertext output/input,
// where Node's API keeps it separate, so encode/decode here split and rejoin it at that boundary.

const magic = new TextEncoder().encode('KJTF');
const version = 1;
const gzipFlag = 1;
const encryptedFlag = 2;
const fixedHeaderLength = 10;

export class BrowserProjectFileError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'BrowserProjectFileError';
        this.code = code;
    }
}

function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; ++index) {
        if (a[index] !== b[index]) return false;
    }
    return true;
}

function concatBytes(a, b) {
    const result = new Uint8Array(a.length + b.length);
    result.set(a, 0);
    result.set(b, a.length);
    return result;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; ++index) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

async function deriveScryptKey(password, kdf) {
    if (!password) throw new BrowserProjectFileError('A password is required.', 'PASSWORD_REQUIRED');
    if (kdf?.name !== 'scrypt') throw new BrowserProjectFileError('The project uses an unsupported key derivation method.', 'UNSUPPORTED_KDF');
    const { cost, blockSize, parallelization } = kdf;
    if (!Number.isInteger(cost) || cost < 2 ** 14 || cost > 2 ** 18 ||
        blockSize !== 8 || !Number.isInteger(parallelization) || parallelization < 1 || parallelization > 4) {
        throw new BrowserProjectFileError('The project contains unsafe key derivation settings.', 'INVALID_HEADER');
    }
    const salt = base64ToBytes(kdf.salt ?? '');
    if (salt.length !== 16) throw new BrowserProjectFileError('The project salt is invalid.', 'INVALID_HEADER');
    const keyBytes = await window.scrypt.scrypt(new TextEncoder().encode(password), salt, cost, blockSize, parallelization, 32);
    return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encodeProjectContent(content, { result = null, password = null, scryptCost = 2 ** 17 } = {}) {
    const compressedStream = new Blob([new TextEncoder().encode(content)]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
    const resultBytes = result ? (result instanceof Uint8Array ? result : new Uint8Array(result)) : new Uint8Array(0);
    let flags = gzipFlag;
    let payload = concatBytes(compressed, resultBytes);
    const metadata = {
        compression: 'gzip', modelPayloadLength: compressed.length, resultPayloadLength: resultBytes.length
    };

    if (password) {
        flags |= encryptedFlag;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const kdf = { name: 'scrypt', salt: bytesToBase64(salt), cost: scryptCost, blockSize: 8, parallelization: 1 };
        const key = await deriveScryptKey(password, kdf);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
        // SubtleCrypto appends the 16-byte GCM tag to its ciphertext output -- split it off so
        // the container keeps it in a separate header field, matching Node's own
        // createCipheriv/getAuthTag convention (see this file's header comment).
        payload = encrypted.subarray(0, encrypted.length - 16);
        metadata.kdf = kdf;
        metadata.cipher = { name: 'aes-256-gcm', iv: bytesToBase64(iv), tag: bytesToBase64(encrypted.subarray(encrypted.length - 16)) };
    }

    const header = new TextEncoder().encode(JSON.stringify(metadata));
    const bytes = new Uint8Array(fixedHeaderLength + header.length + payload.length);
    bytes.set(magic, 0);
    bytes[4] = version;
    bytes[5] = flags;
    new DataView(bytes.buffer).setUint32(6, header.length, false);
    bytes.set(header, fixedHeaderLength);
    bytes.set(payload, fixedHeaderLength + header.length);
    return bytes;
}

export function inspectProjectContent(bytes) {
    if (bytes.length < fixedHeaderLength || !equalBytes(bytes.subarray(0, 4), magic)) {
        throw new BrowserProjectFileError('This is not a Konjugate project file.', 'INVALID_FORMAT');
    }
    if (bytes[4] !== version) {
        throw new BrowserProjectFileError(`Konjugate project version ${bytes[4]} is not supported.`, 'UNSUPPORTED_VERSION');
    }
    return { format: 'kjt', encrypted: Boolean(bytes[5] & encryptedFlag), version };
}

export async function decodeProjectContent(bytes, { password = null } = {}) {
    const { encrypted } = inspectProjectContent(bytes);
    const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 6, 4).getUint32(0, false);
    if (fixedHeaderLength + headerLength > bytes.length) {
        throw new BrowserProjectFileError('The project header is damaged.', 'INVALID_HEADER');
    }
    let metadata;
    try {
        metadata = JSON.parse(new TextDecoder('utf-8').decode(bytes.subarray(fixedHeaderLength, fixedHeaderLength + headerLength)));
    } catch {
        throw new BrowserProjectFileError('The project header is damaged.', 'INVALID_HEADER');
    }
    let payload = bytes.subarray(fixedHeaderLength + headerLength);

    if (encrypted) {
        // Deliberately thrown before any decryption attempt when no password is supplied yet
        // (deriveScryptKey's own PASSWORD_REQUIRED check) -- projectFiles.mjs's open()/unlock()
        // rely on catching exactly this to drive the same requiresPassword retry loop
        // renderer.mjs's loadOpenedProjectFile() already implements for the desktop path.
        const key = await deriveScryptKey(password, metadata.kdf);
        try {
            if (metadata.cipher?.name !== 'aes-256-gcm') throw new Error('Unsupported cipher');
            const iv = base64ToBytes(metadata.cipher.iv ?? '');
            const tag = base64ToBytes(metadata.cipher.tag ?? '');
            if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid cipher metadata');
            payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, concatBytes(payload, tag)));
        } catch {
            throw new BrowserProjectFileError('The password is incorrect or the project has been modified.', 'DECRYPTION_FAILED');
        }
    }

    if (metadata.compression !== 'gzip') {
        throw new BrowserProjectFileError('The project uses an unsupported compression method.', 'UNSUPPORTED_COMPRESSION');
    }
    const modelPayloadLength = Number(metadata.modelPayloadLength ?? payload.length);
    const resultPayloadLength = Number(metadata.resultPayloadLength ?? 0);
    if (!Number.isSafeInteger(modelPayloadLength) || modelPayloadLength <= 0 ||
        !Number.isSafeInteger(resultPayloadLength) || resultPayloadLength < 0 ||
        modelPayloadLength + resultPayloadLength !== payload.length) {
        throw new BrowserProjectFileError('The project payload sections are damaged.', 'CORRUPT_PAYLOAD');
    }
    try {
        const decompressedStream = new Blob([payload.subarray(0, modelPayloadLength)]).stream().pipeThrough(new DecompressionStream('gzip'));
        const content = new TextDecoder('utf-8').decode(await new Response(decompressedStream).arrayBuffer());
        return { content, result: resultPayloadLength ? payload.subarray(modelPayloadLength) : null };
    } catch {
        throw new BrowserProjectFileError('The project payload is damaged.', 'CORRUPT_PAYLOAD');
    }
}
