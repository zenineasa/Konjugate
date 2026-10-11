// Copyright © 2026 Zenin Easa Panthakkalakath

// Builds a ready-to-`choco pack` Chocolatey package directory at out/chocolatey/ from the
// templates in packaging/chocolatey/, a real published GitHub release, and the shared app
// metadata in packaging/appMetadata.yml. The installer's sha256 is computed against the real
// published asset (the same one users download), not hand-maintained in git, so it can't go stale.
//
// Usage: node scripts/generateChocolateyPackage.mjs [vTag]   (defaults to the latest release)
// Called by release.yml's chocolateyRelease job once the GitHub Release is published; also safe to
// run locally to inspect what would be pushed.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { rootDirectory } from './developmentEnvironment.mjs';

const repo = 'zenineasa/Konjugate';
const requestedTag = process.argv[2];
const releaseUrl = requestedTag
    ? `https://api.github.com/repos/${repo}/releases/tags/${requestedTag}`
    : `https://api.github.com/repos/${repo}/releases/latest`;

const apiHeaders = { Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) apiHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const releaseResponse = await fetch(releaseUrl, { headers: apiHeaders });
if (!releaseResponse.ok) {
    throw new Error(`Could not fetch release metadata from ${releaseUrl}: ${releaseResponse.status} ${releaseResponse.statusText}`);
}
const release = await releaseResponse.json();
const version = release.tag_name.replace(/^v/, '');

// Only x64 Windows exists today -- release.yml's build matrix has no Windows arm64 runner.
const installerName = `Konjugate-${version}-x64-setup.exe`;
const asset = release.assets.find((candidate) => candidate.name === installerName);
if (!asset) throw new Error(`Release ${release.tag_name} has no ${installerName} asset.`);
const assetResponse = await fetch(asset.browser_download_url);
if (!assetResponse.ok) throw new Error(`Could not download ${installerName}: ${assetResponse.status} ${assetResponse.statusText}`);
const sha256 = createHash('sha256').update(Buffer.from(await assetResponse.arrayBuffer())).digest('hex').toUpperCase();

const metadata = load(await readFile(join(rootDirectory, 'packaging', 'appMetadata.yml'), 'utf8'));
const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tokens = {
    version,
    name: metadata.name,
    developerName: metadata.developerName,
    homepage: metadata.homepage,
    bugtracker: metadata.bugtracker,
    summary: metadata.summary,
    description: metadata.description.join('\n\n'),
    url: asset.browser_download_url,
    sha256
};
// Only the nuspec is XML; the .ps1 templates only take the url/sha256 tokens, which need no escaping.
const fill = (template, escape) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in tokens)) throw new Error(`Template references unknown token {{${key}}}.`);
    return escape ? escapeXml(String(tokens[key])) : String(tokens[key]);
});

const templateDirectory = join(rootDirectory, 'packaging', 'chocolatey');
const outputDirectory = join(rootDirectory, 'out', 'chocolatey');
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, 'tools'), { recursive: true });
await writeFile(join(outputDirectory, 'konjugate.nuspec'), fill(await readFile(join(templateDirectory, 'konjugate.nuspec'), 'utf8'), true));
for (const script of ['chocolateyInstall.ps1', 'chocolateyUninstall.ps1']) {
    await writeFile(join(outputDirectory, 'tools', script), fill(await readFile(join(templateDirectory, 'tools', script), 'utf8'), false));
}
console.log(`Generated ${outputDirectory} for ${release.tag_name} (installer sha256 ${sha256}).`);
