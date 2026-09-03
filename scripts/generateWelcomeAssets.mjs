// Copyright © 2026 Zenin Easa Panthakkalakath

// Downloads the hqdefault.jpg thumbnail for every video in assets/welcome/videos.json (the same
// file src/main.mjs reads at runtime to build the Welcome window's video cards) and writes each to
// assets/welcome/<id>.jpg. Run manually whenever a developer edits videos.json -- not wired into
// build:engine or CI, matching how generate:example-thumbnails is invoked. Output is committed to
// git, like examples/*.png, since it's small, curated, and only changes on a deliberate edit.
//
// hqdefault.jpg (480x360) is used rather than maxresdefault.jpg because YouTube doesn't guarantee
// a maxres thumbnail exists for every video, while hqdefault effectively always does.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rootDirectory } from './developmentEnvironment.mjs';

const welcomeAssetsDir = join(rootDirectory, 'assets', 'welcome');
const manifest = JSON.parse(await readFile(join(welcomeAssetsDir, 'videos.json'), 'utf8'));

await mkdir(welcomeAssetsDir, { recursive: true });
for (const video of manifest.videos) {
    const response = await fetch(`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`);
    if (!response.ok) throw new Error(`Could not download thumbnail for ${video.id} (${video.videoId}): ${response.status} ${response.statusText}`);
    const outputPath = join(welcomeAssetsDir, `${video.id}.jpg`);
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    console.log(`Wrote ${outputPath}`);
}
