// Copyright © 2026 Zenin Easa Panthakkalakath

// Turns a folder of .deb files into a signed flat apt repository: the packages themselves plus the
// Packages, Release, InRelease and Release.gpg files apt reads, and the public key users trust.
// Everything lands in one folder, which is what a flat repository is, so that folder can be the
// assets of a single GitHub release (see docs/packageManagerDistribution.md).
//
// Usage: node scripts/createAptRepository.mjs <debDirectory> <outputDirectory>
//
// Needs apt-ftparchive (the apt-utils package) and gpg. The key to sign with is APT_SIGNING_KEY (a
// key id or fingerprint in the current GnuPG home); APT_SIGNING_PASSPHRASE is its passphrase, if it has one.
//
// The repository lists exactly the .deb files in <debDirectory>: it keeps no history, so a release's
// folder holds the newest version of each architecture and nothing older.

import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const [debDirectoryArgument, outputDirectoryArgument] = process.argv.slice(2);
if (!debDirectoryArgument || !outputDirectoryArgument) {
    console.error('Usage: node scripts/createAptRepository.mjs <debDirectory> <outputDirectory>');
    process.exit(64);
}
const debDirectory = resolve(debDirectoryArgument);
const outputDirectory = resolve(outputDirectoryArgument);
const signingKey = process.env.APT_SIGNING_KEY;
if (!signingKey) throw new Error('APT_SIGNING_KEY is not set: there is no key to sign the repository with.');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: options.binary ? 'buffer' : 'utf8', input: options.input, cwd: options.cwd, maxBuffer: 1 << 28 });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.error}`);
    return result.stdout;
}

const debs = (await readdir(debDirectory)).filter((name) => /^konjugate_.+_(amd64|arm64)\.deb$/.test(name)).sort();
if (debs.length === 0) throw new Error(`No konjugate_*_amd64.deb or _arm64.deb files in ${debDirectory}.`);
const architectures = [...new Set(debs.map((name) => name.match(/_(amd64|arm64)\.deb$/)[1]))].sort();

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
for (const deb of debs) await copyFile(join(debDirectory, deb), join(outputDirectory, deb));

// Run from inside the folder so each Filename: is "./konjugate_....deb", relative to the repository's URL.
const packages = run('apt-ftparchive', ['packages', '.'], { cwd: outputDirectory });
await writeFile(join(outputDirectory, 'Packages'), packages);
await writeFile(join(outputDirectory, 'Packages.gz'), gzipSync(packages, { level: 9 }));

const release = run('apt-ftparchive', [
    '-o', 'APT::FTPArchive::Release::Origin=Konjugate',
    '-o', 'APT::FTPArchive::Release::Label=Konjugate',
    '-o', `APT::FTPArchive::Release::Architectures=${architectures.join(' ')}`,
    'release', '.'
], { cwd: outputDirectory });
await writeFile(join(outputDirectory, 'Release'), release);

// Both signed forms: modern apt reads InRelease, older tools Release plus Release.gpg.
const signing = ['--batch', '--yes', '--pinentry-mode', 'loopback', '--local-user', signingKey, ...(process.env.APT_SIGNING_PASSPHRASE ? ['--passphrase-fd', '0'] : [])];
const passphrase = process.env.APT_SIGNING_PASSPHRASE ? `${process.env.APT_SIGNING_PASSPHRASE}\n` : undefined;
run('gpg', [...signing, '--clearsign', '--output', join(outputDirectory, 'InRelease'), join(outputDirectory, 'Release')], { input: passphrase });
run('gpg', [...signing, '--armor', '--detach-sign', '--output', join(outputDirectory, 'Release.gpg'), join(outputDirectory, 'Release')], { input: passphrase });

// The public key, in the binary form apt's Signed-By accepts everywhere, and armored for people.
await writeFile(join(outputDirectory, 'konjugate-archive-keyring.gpg'), run('gpg', ['--export', signingKey], { binary: true }));
await writeFile(join(outputDirectory, 'konjugate-archive-keyring.asc'), run('gpg', ['--armor', '--export', signingKey]));

console.log(`Created the apt repository in ${outputDirectory}: ${debs.join(', ')}`);
