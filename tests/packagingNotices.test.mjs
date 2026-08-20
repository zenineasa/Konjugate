// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPackageOptions } from '../scripts/packageElectron.mjs';

const rootDirectory = join(import.meta.dirname, '..');

test('tracked METIS notices contain the required attribution and Apache license', async () => {
    const notice = await readFile(join(rootDirectory, 'thirdPartyNotices.md'), 'utf8');
    const metisNotice = await readFile(join(rootDirectory, 'thirdPartyLicenses', 'metis.txt'), 'utf8');
    const apacheLicense = await readFile(join(rootDirectory, 'thirdPartyLicenses', 'apache2.txt'), 'utf8');

    assert.match(notice, /METIS 5\.1\.0/);
    assert.match(metisNotice, /Regents of the University of Minnesota/);
    assert.match(apacheLicense, /Apache License/);
    assert.match(apacheLicense, /Version 2\.0, January 2004/);
    assert.match(apacheLicense, /4\. Redistribution\./);
    assert.match(apacheLicense, /END OF TERMS AND CONDITIONS/);
    assert.match(apacheLicense, /APPENDIX: How to apply the Apache License/);
});

test('every Electron package target packages and verifies third-party notices', async () => {
    const makefile = await readFile(join(rootDirectory, 'Makefile'), 'utf8');

    for (const target of ['packageMacos', 'packageWindows', 'packageLinux']) {
        const start = makefile.indexOf(`${target}:`);
        assert.notEqual(start, -1, `${target} must exist`);
        const nextTarget = makefile.indexOf('\n\n', start);
        const recipe = makefile.slice(start, nextTarget === -1 ? undefined : nextTarget);
        assert.match(recipe, /packageElectron\.mjs/);
        assert.match(recipe, /verifyPackagingNotices\.mjs/);
    }
});

test('packageElectron.mjs bundles third-party notices and the packaged engine as extra resources', () => {
    const { extraResource } = createPackageOptions({
        platform: 'darwin', arch: 'arm64', appVersion: '1.0.0', icon: 'icon.icns', name: 'Konjugate', appBundleId: 'com.konjugate.app'
    });
    assert.ok(extraResource.includes('out/packageResources/engine'));
    assert.ok(extraResource.includes('thirdPartyNotices.md'));
    assert.ok(extraResource.includes('thirdPartyLicenses'));
});

test('packaging verifies the installed engine and its effective METIS runtime', async () => {
    const verifier = await readFile(join(rootDirectory, 'scripts', 'verifyPackagingNotices.mjs'), 'utf8');
    assert.match(verifier, /\['capabilities'\]/);
    assert.match(verifier, /capabilities\.metis\?\.available !== true/);
    assert.match(verifier, /packaged METIS notice is incomplete/);
});
