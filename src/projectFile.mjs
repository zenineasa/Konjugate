/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as deriveKey } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const scryptAsync = promisify(deriveKey);
const magic = Buffer.from('KJTF');
const version = 1;
const gzipFlag = 1;
const encryptedFlag = 2;
const fixedHeaderLength = 10;
const maxHeaderLength = 64 * 1024;
const maxOutputLength = 1024 * 1024 * 1024;

export class ProjectFileError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'ProjectFileError';
        this.code = code;
    }
}

function parseHeader(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length < fixedHeaderLength || !buffer.subarray(0, 4).equals(magic)) {
        throw new ProjectFileError('This is not a Konjugate project file.', 'INVALID_FORMAT');
    }
    if (buffer[4] !== version) {
        throw new ProjectFileError(`Konjugate project version ${buffer[4]} is not supported.`, 'UNSUPPORTED_VERSION');
    }
    const flags = buffer[5];
    const headerLength = buffer.readUInt32BE(6);
    if (headerLength > maxHeaderLength || fixedHeaderLength + headerLength > buffer.length) {
        throw new ProjectFileError('The project header is damaged.', 'INVALID_HEADER');
    }
    try {
        return {
            flags,
            metadata: JSON.parse(buffer.subarray(fixedHeaderLength, fixedHeaderLength + headerLength).toString('utf8')),
            payload: buffer.subarray(fixedHeaderLength + headerLength)
        };
    } catch {
        throw new ProjectFileError('The project header is damaged.', 'INVALID_HEADER');
    }
}

async function keyFromPassword(password, kdf) {
    if (!password) throw new ProjectFileError('A password is required.', 'PASSWORD_REQUIRED');
    if (kdf?.name !== 'scrypt') throw new ProjectFileError('The project uses an unsupported key derivation method.', 'UNSUPPORTED_KDF');
    const { cost, blockSize, parallelization } = kdf;
    if (!Number.isInteger(cost) || cost < 2 ** 14 || cost > 2 ** 18 ||
        blockSize !== 8 || !Number.isInteger(parallelization) || parallelization < 1 || parallelization > 4) {
        throw new ProjectFileError('The project contains unsafe key derivation settings.', 'INVALID_HEADER');
    }
    const salt = Buffer.from(kdf.salt, 'base64');
    if (salt.length !== 16) throw new ProjectFileError('The project salt is invalid.', 'INVALID_HEADER');
    return scryptAsync(password, salt, 32, {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: Math.max(256 * 1024 * 1024, 256 * cost * blockSize)
    });
}

export function inspectProjectFile(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const { flags } = parseHeader(bytes);
    return { format: 'kjt', encrypted: Boolean(flags & encryptedFlag), version };
}

// resultBranches (an array of {buffer, branchUuid, parentBranchUuid, forkTime, label}) saves an
// entire branch tree instead of the single active result `result` saves -- mutually exclusive
// with `result`; pass at most one. A single-branch save (bare `result`, or `resultBranches` with
// exactly one entry and no branch metadata) still writes the plain `resultPayloadLength` field
// alone, so a file saved this way is byte-for-byte the same shape a build that predates branching
// would produce and can still open in one. Once a save actually carries two or more branches (or
// one branch tagged with real UUIDs), `resultSections` is the only way to recover them, and an
// older build attempting to open it will cleanly fail with CORRUPT_PAYLOAD (its resultPayloadLength
// arithmetic can't add up against every branch's concatenated bytes) rather than silently losing
// or corrupting data -- deliberately not mirrored into a redundant legacy single-result section,
// which would double the file's size on every multi-branch save just to support opening a
// multi-branch file in a build that predates the concept entirely.
export async function encodeProjectFile(content, { password = null, scryptCost = 2 ** 17, result = null, resultBranches = null } = {}) {
    const compressed = await gzipAsync(Buffer.from(content, 'utf8'), { level: 9 });
    const branches = (resultBranches ?? (result ? [{ buffer: result }] : []))
        .map((branch) => ({ ...branch, buffer: Buffer.isBuffer(branch.buffer) ? branch.buffer : Buffer.from(branch.buffer) }));
    const isLegacyShape = branches.length <= 1 && !branches.some((branch) => branch.branchUuid);
    let flags = gzipFlag;
    let payload = Buffer.concat([compressed, ...branches.map((branch) => branch.buffer)]);
    const metadata = {
        compression: 'gzip',
        modelPayloadLength: compressed.length,
        resultPayloadLength: isLegacyShape ? (branches[0]?.buffer.length ?? 0) : 0,
        ...(isLegacyShape ? {} : {
            resultSections: branches.map(({ buffer, ...branchMetadata }) => ({ length: buffer.length, ...branchMetadata }))
        })
    };

    if (password) {
        flags |= encryptedFlag;
        const salt = randomBytes(16);
        const iv = randomBytes(12);
        const kdf = { name: 'scrypt', salt: salt.toString('base64'), cost: scryptCost, blockSize: 8, parallelization: 1 };
        const key = await keyFromPassword(password, kdf);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        payload = Buffer.concat([cipher.update(payload), cipher.final()]);
        metadata.kdf = kdf;
        metadata.cipher = { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
        key.fill(0);
    }

    const header = Buffer.from(JSON.stringify(metadata), 'utf8');
    const prefix = Buffer.alloc(fixedHeaderLength);
    magic.copy(prefix);
    prefix[4] = version;
    prefix[5] = flags;
    prefix.writeUInt32BE(header.length, 6);
    return Buffer.concat([prefix, header, payload]);
}

export async function decodeProjectBundle(buffer, { password = null } = {}) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const { flags, metadata, payload } = parseHeader(bytes);
    let plaintext = payload;

    if (flags & encryptedFlag) {
        const key = await keyFromPassword(password, metadata.kdf);
        try {
            if (metadata.cipher?.name !== 'aes-256-gcm') throw new Error('Unsupported cipher');
            const iv = Buffer.from(metadata.cipher.iv, 'base64');
            const tag = Buffer.from(metadata.cipher.tag, 'base64');
            if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid cipher metadata');
            const decipher = createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
        } catch {
            throw new ProjectFileError('The password is incorrect or the project has been modified.', 'DECRYPTION_FAILED');
        } finally {
            key.fill(0);
        }
    }

    if (!(flags & gzipFlag) || metadata.compression !== 'gzip') {
        throw new ProjectFileError('The project uses an unsupported compression method.', 'UNSUPPORTED_COMPRESSION');
    }
    const modelPayloadLength = metadata.modelPayloadLength === undefined
        ? plaintext.length : Number(metadata.modelPayloadLength);
    // A pre-branching file (or a single-branch save from this build, which writes the identical
    // shape -- see encodeProjectFile) has no resultSections at all; a multi-branch save has one
    // entry per branch and an unused (zero) resultPayloadLength -- see this function's own doc
    // comment for why the two are never both populated.
    const sections = Array.isArray(metadata.resultSections) && metadata.resultSections.length
        ? metadata.resultSections
        : (metadata.resultPayloadLength ? [{ length: metadata.resultPayloadLength }] : []);
    const sectionLengths = sections.map((section) => Number(section.length));
    const totalResultLength = sectionLengths.reduce((total, length) => total + length, 0);
    if (!Number.isSafeInteger(modelPayloadLength) || modelPayloadLength <= 0 ||
        sectionLengths.some((length) => !Number.isSafeInteger(length) || length < 0) ||
        modelPayloadLength + totalResultLength !== plaintext.length) {
        throw new ProjectFileError('The project payload sections are damaged.', 'CORRUPT_PAYLOAD');
    }
    try {
        const content = (await gunzipAsync(plaintext.subarray(0, modelPayloadLength), { maxOutputLength })).toString('utf8');
        let offset = modelPayloadLength;
        const resultBranches = sections.map((section, index) => {
            const length = sectionLengths[index];
            const buffer = length ? Buffer.from(plaintext.subarray(offset, offset + length)) : null;
            offset += length;
            return { ...section, buffer };
        }).filter((branch) => branch.buffer);
        return {
            content,
            // result stays the first (in a legacy/single-branch file, the only) branch's buffer,
            // so every existing caller reading .result alone keeps working unchanged.
            result: resultBranches[0]?.buffer ?? null,
            resultBranches: resultBranches.length ? resultBranches : null
        };
    } catch {
        throw new ProjectFileError('The project payload is damaged.', 'CORRUPT_PAYLOAD');
    }
}

export async function decodeProjectFile(buffer, options = {}) {
    return (await decodeProjectBundle(buffer, options)).content;
}
