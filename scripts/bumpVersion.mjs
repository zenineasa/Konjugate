/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Bumps package.json's version, then regenerates the Linux AppStream metainfo from it (see
// scripts/generateAppMetainfo.mjs) -- the two used to be separate manual steps, which meant
// forgetting the second one was only ever caught by release.yml's verifyAppMetainfo job failing a
// real release build, not before. Chained here instead, since they're done together every time
// anyway.
//
// It also redraws the ReadMe's downloads chart (see scripts/releaseStats.mjs). That's done here
// because a bump is run regularly from the maintainer's machine; the release being bumped to isn't
// published yet, so it isn't counted until the next one.
// Offline or rate-limited, that step only warns.
//
// Usage: node scripts/bumpVersion.mjs <newVersion>  (e.g. node scripts/bumpVersion.mjs 1.1.3)

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, '..');

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.error('Usage: node scripts/bumpVersion.mjs <newVersion>  (e.g. 1.1.3)');
    process.exit(1);
}

const packageJsonPath = join(projectRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const previousVersion = packageJson.version;
if (previousVersion === newVersion) throw new Error(`package.json is already at ${newVersion}.`);
packageJson.version = newVersion;
await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 4)}\n`);
console.log(`package.json: ${previousVersion} -> ${newVersion}`);

execFileSync('node', [join(root, 'generateAppMetainfo.mjs')], { cwd: projectRoot, stdio: 'inherit' });
execFileSync('node', [join(root, 'releaseStats.mjs')], { cwd: projectRoot, stdio: 'inherit' });
