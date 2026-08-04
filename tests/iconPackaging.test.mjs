// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('ICNS generation includes every required PNG representation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'konjugateIcnsTest-'));
    try {
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
            await writeFile(join(directory, `${size}.png`), Buffer.concat([pngHeader, Buffer.from(String(size))]));
        }
        const output = join(directory, 'app.icns');
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [
                join(import.meta.dirname, '..', 'scripts', 'pngToIcns.mjs'),
                `--icons=${directory}`,
                `--output=${output}`
            ]);
            child.once('error', reject);
            child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ICNS generation exited ${code}.`)));
        });
        const content = await readFile(output);
        assert.equal(content.subarray(0, 4).toString('ascii'), 'icns');
        assert.equal(content.readUInt32BE(4), content.length);
        for (const type of ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']) {
            assert.notEqual(content.indexOf(type), -1, `${type} is missing`);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
