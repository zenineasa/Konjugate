// Copyright © 2026 Zenin Easa Panthakkalakath

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const resourcesDirectory = process.argv[2];
if (!resourcesDirectory) {
    throw new Error('Pass the packaged application resources directory.');
}

const expectedFiles = [
    'thirdPartyNotices.md',
    join('thirdPartyLicenses', 'apache2.txt'),
    join('thirdPartyLicenses', 'metis.txt')
];

for (const relativePath of expectedFiles) {
    await access(join(resolve(resourcesDirectory), relativePath));
}

const notice = await readFile(join(resolve(resourcesDirectory), 'thirdPartyNotices.md'), 'utf8');
if (!notice.includes('METIS 5.1.0') || !notice.includes('Regents of the University of Minnesota')) {
    throw new Error('The packaged third-party notice does not contain the expected METIS attribution.');
}

const apacheLicense = await readFile(
    join(resolve(resourcesDirectory), 'thirdPartyLicenses', 'apache2.txt'),
    'utf8'
);
if (!apacheLicense.includes('Apache License') || !apacheLicense.includes('Version 2.0, January 2004')) {
    throw new Error('The packaged Apache 2.0 license is incomplete.');
}

console.log(`Verified third-party notices in ${resolve(resourcesDirectory)}`);

