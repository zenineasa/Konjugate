/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes the example FMUs of the FMI compatibility page (examples/fmi/<Model_Name>/ for FMI 2.0 and examples/fmi/3.0/<Model_Name>/
// for FMI 3.0: the .fmu, its _ref.csv and _ref.opt, and Readme.txt) from the definitions in scripts/fmiExamples.mjs. Needs the engine
// built (npm run build:engine) and a C++ compiler.
//
//   node scripts/generateFmiExamples.mjs                        every example, FMI 2.0 and FMI 3.0
//   node scripts/generateFmiExamples.mjs HeatedRoom             only the ones named
//   node scripts/generateFmiExamples.mjs --fmi-version 3.0      only one FMI version
//
// Each export holds this computer's binary only (src/fmiExport.mjs): regenerate on the platforms the page lists, or merge exports
// from several with "Merge platform FMUs…" in the app.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { generateFmuPackage } from '../src/fmiExport.mjs';
import { parseArgs } from 'node:util';
import {
    engineOptions, engineReference, exampleFolder, examplesDirectory, exportDocument, fmiExamples, fmiVersions, fmuPlatforms, readmeText,
    referenceCsv, referenceOptions
} from './fmiExamples.mjs';

const { values: options, positionals: only } = parseArgs({ options: { 'fmi-version': { type: 'string' } }, allowPositionals: true });
const versions = options['fmi-version'] ? [options['fmi-version']] : fmiVersions;
if (versions.some((version) => !fmiVersions.includes(version))) throw new Error(`Unknown FMI version: ${options['fmi-version']} (${fmiVersions.join(' or ')}).`);
const chosen = only.length ? fmiExamples.filter((example) => only.includes(example.name)) : fmiExamples;
if (only.length && chosen.length !== only.length) throw new Error(`Unknown example: ${only.filter((name) => !fmiExamples.some((example) => example.name === name)).join(', ')}.`);

const work = await mkdtemp(join(tmpdir(), 'konjugateFmiExamples-'));
try {
    for (const example of chosen) {
        const reference = await engineReference(example, work);
        for (const fmiVersion of versions) {
            const folder = join(examplesDirectory, exampleFolder(example, fmiVersion));
            await mkdir(folder, { recursive: true });
            const fmu = await generateFmuPackage(await exportDocument(example), { modelName: example.name, engineOptions, fmiVersion });
            const platforms = fmuPlatforms(unzipSync(new Uint8Array(fmu)));
            await writeFile(join(folder, `${example.name}.fmu`), fmu);
            await writeFile(join(folder, `${example.name}_ref.csv`), referenceCsv(reference));
            await writeFile(join(folder, `${example.name}_ref.opt`), referenceOptions(example));
            await writeFile(join(folder, 'Readme.txt'), readmeText(example, platforms, fmiVersion));
            console.log(`✓ ${exampleFolder(example, fmiVersion)} (FMI ${fmiVersion}): ${fmu.length} bytes (${platforms.join(', ')}), ${reference.rows.length} reference rows of ${reference.names.length} outputs`);
        }
    }
} finally {
    await rm(work, { recursive: true, force: true });
}
