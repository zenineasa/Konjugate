/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service's certificate, for listening on the network (docs/proposals/pushService.md, "Local or on the network"): keys sent
// in plain HTTP on a lab network can be read by anyone on it, so the service listens beyond this computer only encrypted, with
// HTTPS, secure WebSockets and gRPC over TLS on one certificate.
//
//   ensurePushCertificate(directory)        Konjugate's own certificate, made the first time and kept in `directory` (the key
//                                           readable by this user only); made again when this computer's addresses are no longer
//                                           all in it, or when it has less than a month to run
//   readOwnCertificate(certificate, key)    a certificate a person chose instead, checked to be one, with its key
//   describeCertificate(pem)                its SHA-256 fingerprint, the names and addresses it is for, and when it runs out
//   networkAddresses()                      the addresses a script on another computer can reach this one at
//
// The certificate is self-signed in the usual way, marked as able to vouch only for itself (a CA with a path length of 0) and for
// serving: what curl, Python (strict verification included) and Node accept as a trusted certificate once a script is given the
// file, so a script trusts this certificate rather than turning checking off.

import { webcrypto, randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { isIPv6 } from 'node:net';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';

export const pushCertificateFileName = 'pushCertificate.pem';
export const pushKeyFileName = 'pushKey.pem';
const validDays = 825;
const renewWithinDays = 30;

// The IP addresses a script on another computer can reach this one at (every interface but the loopback and IPv6's link-local
// addresses, which need an interface named to be used), and this computer's names.
export function networkAddresses() {
    const ips = Object.values(networkInterfaces()).flat()
        .filter((address) => address && !address.internal && !(address.family === 'IPv6' && /^fe80:/i.test(address.address)))
        .map((address) => address.address);
    const name = hostname();
    // A hostname that is itself an address (some networks name a computer by it) is an address, already among the IPs.
    const looksLikeAddress = /^[\d.]+$/.test(name) || name.includes(':');
    const names = looksLikeAddress ? [] : [name, ...(name.includes('.') ? [] : [`${name}.local`])];
    return { ips: [...new Set(ips)], names: [...new Set(names)] };
}

// A name or address in a form two spellings of the same one share. A certificate lists an IPv6 address in upper case with its zero
// groups written out, where the network interfaces report it in lower case with them compressed, so without this a computer with
// an IPv6 address would never find its own address in its own certificate and would make a new certificate every time.
function comparable(name) {
    const lower = name.toLowerCase();
    if (!isIPv6(lower) || lower.includes('.')) return lower;
    const [head, tail] = lower.split('::');
    const groups = (text) => (text ? text.split(':') : []);
    const written = tail === undefined ? groups(head) : [...groups(head), ...Array(8 - groups(head).length - groups(tail).length).fill('0'), ...groups(tail)];
    return written.map((group) => Number.parseInt(group, 16).toString(16)).join(':');
}

// A certificate's fingerprint, the names and addresses it is for, and when it runs out.
export function describeCertificate(pem) {
    const certificate = new X509Certificate(pem);
    const names = (certificate.subjectAltName ?? '').split(',').map((entry) => entry.trim()).flatMap((entry) => {
        const match = /^(DNS|IP Address):(.+)$/.exec(entry);
        return match ? [match[2].trim()] : [];
    });
    return { fingerprint: certificate.fingerprint256, names, notBefore: Date.parse(certificate.validFrom), notAfter: Date.parse(certificate.validTo), subject: certificate.subject };
}

let x509Module = null;
// @peculiar/x509 needs the reflect-metadata polyfill, loaded only when a certificate is made.
async function x509() {
    if (x509Module) return x509Module;
    await import('reflect-metadata');
    x509Module = await import('@peculiar/x509');
    x509Module.cryptoProvider.set(webcrypto);
    return x509Module;
}

async function makeCertificate({ ips, names }, now) {
    const library = await x509();
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const alternativeNames = [
        ...['localhost', ...names].map((value) => ({ type: 'dns', value })),
        ...['127.0.0.1', '::1', ...ips].map((value) => ({ type: 'ip', value }))
    ];
    const certificate = await library.X509CertificateGenerator.createSelfSigned({
        // A positive serial number of 128 bits.
        serialNumber: `01${randomBytes(15).toString('hex')}`,
        name: `CN=Konjugate push service on ${names[0] ?? 'this computer'}`,
        notBefore: new Date(now - 60000), notAfter: new Date(now + validDays * 86400000),
        keys, signingAlgorithm: algorithm,
        extensions: [
            new library.BasicConstraintsExtension(true, 0, true),
            new library.KeyUsagesExtension(library.KeyUsageFlags.digitalSignature | library.KeyUsageFlags.keyCertSign, true),
            new library.ExtendedKeyUsageExtension([library.ExtendedKeyUsage.serverAuth]),
            new library.SubjectAlternativeNameExtension(alternativeNames),
            await library.SubjectKeyIdentifierExtension.create(keys.publicKey),
            await library.AuthorityKeyIdentifierExtension.create(keys.publicKey)
        ]
    });
    return {
        certificate: `${certificate.toString('pem')}\n`,
        key: `${library.PemConverter.encode(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY')}\n`
    };
}

// Konjugate's own certificate in `directory`: { certificate, key, path, fingerprint, names, notAfter, made }. `made` says it was
// made just now (the first time, or because the old one no longer fitted), which changes the fingerprint scripts trust.
export async function ensurePushCertificate(directory, { now = Date.now(), addresses = networkAddresses() } = {}) {
    const path = join(directory, pushCertificateFileName);
    const keyPath = join(directory, pushKeyFileName);
    try {
        const [certificate, key] = await Promise.all([readFile(path, 'utf8'), readFile(keyPath, 'utf8')]);
        const described = describeCertificate(certificate);
        const certified = new Set(described.names.map(comparable));
        const covered = [...addresses.ips, ...addresses.names].every((name) => certified.has(comparable(name)));
        // Not yet valid (the clock was set back since it was made) counts as not fitting too.
        if (covered && described.notBefore <= now && described.notAfter - now > renewWithinDays * 86400000) {
            createSecureContext({ cert: certificate, key });
            return { certificate, key, path, ...described, made: false };
        }
    } catch {
        // None yet, or one that cannot be read or used: a new one is made.
    }
    const { certificate, key } = await makeCertificate(addresses, now);
    await mkdir(directory, { recursive: true });
    const temporary = `${keyPath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, key, { mode: 0o600 });
    await rename(temporary, keyPath);
    await chmod(keyPath, 0o600).catch(() => {});
    await writeFile(path, certificate);
    return { certificate, key, path, ...describeCertificate(certificate), made: true };
}

// A certificate and key a person chose, checked to be a certificate, its key, and a pair.
export async function readOwnCertificate(certificatePath, keyPath) {
    const [certificate, key] = await Promise.all([readFile(certificatePath, 'utf8'), readFile(keyPath, 'utf8')]);
    let described;
    try {
        described = describeCertificate(certificate);
    } catch {
        throw new Error(`${certificatePath} is not a certificate in PEM form.`);
    }
    try {
        createPrivateKey(key);
    } catch {
        throw new Error(`${keyPath} is not a private key in PEM form.`);
    }
    if (!new X509Certificate(certificate).checkPrivateKey(createPrivateKey(key))) throw new Error('That key is not the certificate\'s own.');
    createSecureContext({ cert: certificate, key });
    return { certificate, key, path: certificatePath, ...described, made: false, own: true };
}
