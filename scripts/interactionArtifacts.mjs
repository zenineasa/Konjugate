// Copyright © 2026 Zenin Easa Panthakkalakath

// What an interaction run keeps for a CI job nobody watched (scripts/runInteractionTests.mjs,
// scripts/runPackagedInteractionTests.mjs): when KONJUGATE_INTERACTION_ARTIFACTS names a folder, the app's
// whole output goes to a log there as well as to the terminal, and the runner saves screenshots of each
// failure under it (tests/interactionRunner.mjs). The workflows upload that folder.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const artifactsDirectory = process.env.KONJUGATE_INTERACTION_ARTIFACTS || null;

// spawn(), with the child's output also written to `logName` in the artifacts folder when there is one.
export async function spawnLogged(executable, args, options, logName) {
    if (!artifactsDirectory) return spawn(executable, args, { ...options, stdio: 'inherit' });
    await mkdir(artifactsDirectory, { recursive: true });
    const log = createWriteStream(join(artifactsDirectory, logName), { flags: 'a' });
    const child = spawn(executable, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); log.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); log.write(chunk); });
    child.once('close', () => log.end());
    return child;
}

// A failed scenario as a summary line: its name, and the first line of what it said.
export const failureLine = ({ name, message }) => `- ${name}${message ? `\n  - ${message.replaceAll('\n', ' ')}` : ''}`;

// Lines printed and, on GitHub Actions, added to the job's summary.
export async function summarize(lines) {
    console.log(`\n${lines.join('\n')}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
