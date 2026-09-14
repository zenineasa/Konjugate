/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Browser-native counterpart to src/projectFile.mjs's .kjt container encode/decode -- see
// docs/proposals/webEdition.md, phase 3. Same container format (docs/kjtFormat.md): magic
// "KJTF", 1-byte version, 1-byte flags (bit 0 gzip, bit 1 AES-256-GCM), 4-byte big-endian JSON
// header length, JSON header, then gzip(model JSON) + optional raw result bytes.
//
// Covers only the unencrypted case: projectFile.mjs's scrypt-based encryption has no Web Crypto
// equivalent decided yet (see webEdition.md's open question). encodeProjectContent never sets
// the encrypted flag; decodeProjectContent throws a distinctly-catchable error for a file that
// has it set, rather than guessing at a substitute KDF/cipher.

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

export async function encodeProjectContent(content, { result = null } = {}) {
    const compressedStream = new Blob([new TextEncoder().encode(content)]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
    const resultBytes = result ? (result instanceof Uint8Array ? result : new Uint8Array(result)) : new Uint8Array(0);
    const header = new TextEncoder().encode(JSON.stringify({
        compression: 'gzip', modelPayloadLength: compressed.length, resultPayloadLength: resultBytes.length
    }));
    const bytes = new Uint8Array(fixedHeaderLength + header.length + compressed.length + resultBytes.length);
    bytes.set(magic, 0);
    bytes[4] = version;
    bytes[5] = gzipFlag; // unencrypted only -- see header comment
    new DataView(bytes.buffer).setUint32(6, header.length, false);
    bytes.set(header, fixedHeaderLength);
    bytes.set(compressed, fixedHeaderLength + header.length);
    if (resultBytes.length) bytes.set(resultBytes, fixedHeaderLength + header.length + compressed.length);
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

export async function decodeProjectContent(bytes) {
    const { encrypted } = inspectProjectContent(bytes);
    if (encrypted) {
        throw new BrowserProjectFileError('Encrypted projects are not supported in the web edition yet.', 'UNSUPPORTED_ENCRYPTION');
    }
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
    if (metadata.compression !== 'gzip') {
        throw new BrowserProjectFileError('The project uses an unsupported compression method.', 'UNSUPPORTED_COMPRESSION');
    }
    const payload = bytes.subarray(fixedHeaderLength + headerLength);
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
