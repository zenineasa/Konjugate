/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, isNewerPackageVersion, isNewerVersion, isPrerelease, parseVersion } from '../src/versionCompare.mjs';

test('versions compare number by number, not as text', () => {
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(compareVersions('1.9.9', '1.10.0'), -1);
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('a missing trailing number counts as zero, and a leading v is ignored', () => {
    assert.equal(compareVersions('0.1', '0.1.0'), 0);
    assert.equal(compareVersions('1', '1.0.0'), 0);
    assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
    assert.equal(compareVersions('1.0.0.1', '1.0.0'), 1);
});

test('a pre-release is older than its release, and pre-releases follow semantic versioning order', () => {
    assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), -1);
    assert.equal(compareVersions('1.2.3', '1.2.3-rc.1'), 1);
    const ascending = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let index = 1; index < ascending.length; index += 1) {
        assert.equal(compareVersions(ascending[index - 1], ascending[index]), -1, `${ascending[index - 1]} < ${ascending[index]}`);
        assert.equal(compareVersions(ascending[index], ascending[index - 1]), 1);
    }
    assert.equal(compareVersions('1.2.4-beta', '1.2.3'), 1, 'the number part wins over the pre-release part');
});

test('build metadata is ignored', () => {
    assert.equal(compareVersions('1.2.3+build.5', '1.2.3+other'), 0);
    assert.equal(compareVersions('1.2.3-beta+x', '1.2.3-beta'), 0);
});

test('unreadable versions compare as null and are never newer', () => {
    for (const bad of ['', null, undefined, 'latest', '1.x', '1..2', '1.2.3-', '1.2.3 beta']) {
        assert.equal(parseVersion(bad), null, String(bad));
        assert.equal(compareVersions(bad, '1.0.0'), null);
        assert.equal(compareVersions('1.0.0', bad), null);
        assert.equal(isNewerVersion(bad, '1.0.0'), false);
        assert.equal(isNewerVersion('2.0.0', bad), false);
        assert.equal(isNewerPackageVersion(bad, '1.0.0'), false);
        assert.equal(isNewerPackageVersion('2.0.0', bad), false);
    }
});

test("the application's own comparison needs exactly three numbers, a package's does not", () => {
    assert.equal(isNewerVersion('1.2', '1.1.8'), false);
    assert.equal(isNewerVersion('1.2.0.1', '1.2.0'), false);
    assert.equal(parseVersion('1.2', { threeParts: true }), null);
    assert.equal(compareVersions('1.2.1', '1.2', { threeParts: true }), null);
    assert.equal(isNewerPackageVersion('0.2', '0.1.9'), true);
    assert.equal(isNewerPackageVersion('0.1', '0.1.0'), false);
    assert.equal(isNewerPackageVersion('1.0.0.1', '1.0.0'), true);
});

test('isNewerVersion is strict', () => {
    assert.equal(isNewerVersion('1.2.4', '1.2.3'), true);
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
    assert.equal(isNewerVersion('1.2.3', '1.2.4'), false);
    assert.equal(isNewerVersion('1.2.3', '1.2.3-beta'), true);
});

test('isPrerelease recognises a pre-release suffix only', () => {
    assert.equal(isPrerelease('1.2.3-beta.1'), true);
    assert.equal(isPrerelease('1.2.3'), false);
    assert.equal(isPrerelease('1.2.3+build'), false);
    assert.equal(isPrerelease('garbage'), false);
});
