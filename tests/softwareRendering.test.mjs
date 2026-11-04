/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGpuCrashWatch, softwareRenderingArgument, softwareRenderingRelaunch } from '../src/softwareRendering.mjs';

test('one GPU crash is not yet a reason to give up on the GPU', () => {
    assert.equal(createGpuCrashWatch().record(1000), false);
});

test('two GPU crashes close together are', () => {
    const watch = createGpuCrashWatch();
    assert.equal(watch.record(1000), false);
    assert.equal(watch.record(1500), true);
});

test('crashes far apart do not add up', () => {
    const watch = createGpuCrashWatch({ limit: 2, windowMs: 30000 });
    assert.equal(watch.record(0), false);
    assert.equal(watch.record(60000), false);
    assert.equal(watch.record(61000), true);
});

test('the relaunch keeps the arguments it was started with and adds the software rendering one', () => {
    assert.deepEqual(
        softwareRenderingRelaunch({ argv: ['/opt/Konjugate', '--no-sandbox', 'model.kjt'], appImagePath: undefined }),
        { args: ['--no-sandbox', 'model.kjt', softwareRenderingArgument] }
    );
});

test('an AppImage is relaunched through the AppImage itself', () => {
    assert.deepEqual(
        softwareRenderingRelaunch({ argv: ['/tmp/.mount_x/usr/lib/konjugate/Konjugate'], appImagePath: '/home/a/Konjugate.AppImage' }),
        { execPath: '/home/a/Konjugate.AppImage', args: [softwareRenderingArgument] }
    );
});
