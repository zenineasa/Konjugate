// Copyright © 2026 Zenin Easa Panthakkalakath

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

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

test('every Electron package target includes and verifies third-party notices', async () => {
    const makefile = await readFile(join(rootDirectory, 'Makefile'), 'utf8');

    for (const target of ['packageMacos', 'packageWindows', 'packageLinux']) {
        const start = makefile.indexOf(`${target}:`);
        assert.notEqual(start, -1, `${target} must exist`);
        const nextTarget = makefile.indexOf('\n\n', start);
        const recipe = makefile.slice(start, nextTarget === -1 ? undefined : nextTarget);
        assert.match(recipe, /--extra-resource=thirdPartyNotices\.md/);
        assert.match(recipe, /--extra-resource=thirdPartyLicenses/);
        assert.match(recipe, /--extra-resource=\$\(enginePackageDir\)/);
        assert.match(recipe, /verifyPackagingNotices\.mjs/);
    }
});

test('packaging verifies the installed engine and its effective METIS runtime', async () => {
    const verifier = await readFile(join(rootDirectory, 'scripts', 'verifyPackagingNotices.mjs'), 'utf8');
    assert.match(verifier, /\['capabilities'\]/);
    assert.match(verifier, /capabilities\.metis\?\.available !== true/);
    assert.match(verifier, /packaged METIS notice is incomplete/);
});
