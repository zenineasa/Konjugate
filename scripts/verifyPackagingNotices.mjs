// Copyright © 2026 Zenin Easa Panthakkalakath

import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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

const metisLicense = await readFile(
    join(resolve(resourcesDirectory), 'thirdPartyLicenses', 'metis.txt'),
    'utf8'
);
if (!metisLicense.includes('Regents of the University of Minnesota') ||
    !metisLicense.includes('Apache License, Version 2.0')) {
    throw new Error('The packaged METIS notice is incomplete.');
}

const engineName = process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine';
const enginePath = join(resolve(resourcesDirectory), 'engine', engineName);
await access(enginePath);
const capabilities = await new Promise((resolveCapabilities, reject) => {
    const child = spawn(enginePath, ['capabilities'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let diagnostics = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
        if (code !== 0) reject(new Error(diagnostics || `The packaged engine exited with code ${code}.`));
        else {
            try {
                resolveCapabilities(JSON.parse(output));
            } catch (error) {
                reject(new Error(`The packaged engine returned invalid capabilities: ${error.message}`));
            }
        }
    });
});
if (capabilities.metis?.available !== true || !capabilities.metis.version) {
    throw new Error('The packaged engine does not provide the required METIS runtime.');
}

console.log(`Verified third-party notices and METIS ${capabilities.metis.version} in ${resolve(resourcesDirectory)}`);
