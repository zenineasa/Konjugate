// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { staleEngineSource } from '../scripts/engineFreshness.mjs';

async function layout(engineAge, sourceAge) {
    const root = await mkdtemp(join(tmpdir(), 'engineFreshness-'));
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    const engine = join(root, 'engine.wasm');
    const source = join(root, 'src', 'nested', 'a.cpp');
    await writeFile(engine, 'wasm');
    await writeFile(source, 'cpp');
    const now = Date.now() / 1000;
    await utimes(engine, now - engineAge, now - engineAge);
    await utimes(source, now - sourceAge, now - sourceAge);
    return { root, engine, source };
}

test('an engine older than a source under its folders is reported with that source', async () => {
    const { root, engine, source } = await layout(100, 10);
    try { assert.equal(await staleEngineSource(engine, [join(root, 'src'), join(root, 'missing')]), source); }
    finally { await rm(root, { recursive: true, force: true }); }
});

test('an engine built after every source, or not built at all, is not reported', async () => {
    const { root, engine } = await layout(10, 100);
    try {
        assert.equal(await staleEngineSource(engine, [join(root, 'src')]), null);
        assert.equal(await staleEngineSource(join(root, 'none.wasm'), [join(root, 'src')]), null);
    } finally { await rm(root, { recursive: true, force: true }); }
});
