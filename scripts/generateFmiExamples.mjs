/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Writes the example FMUs of the FMI compatibility page (examples/fmi/<Model_Name>/: the .fmu, its _ref.csv and _ref.opt, and
// Readme.txt) from the definitions in scripts/fmiExamples.mjs. Needs the engine built (npm run build:engine) and a C++ compiler.
//
//   node scripts/generateFmiExamples.mjs              every example
//   node scripts/generateFmiExamples.mjs HeatedRoom   only the ones named
//
// Each export holds this computer's binary only (src/fmiExport.mjs): regenerate on the platforms the page lists, or merge exports
// from several with "Merge platform FMUs…" in the app.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { generateFmuPackage } from '../src/fmiExport.mjs';
import {
    engineOptions, engineReference, examplesDirectory, exportDocument, fmiExamples, fmuPlatforms, readmeText, referenceCsv, referenceOptions
} from './fmiExamples.mjs';

const only = process.argv.slice(2);
const chosen = only.length ? fmiExamples.filter((example) => only.includes(example.name)) : fmiExamples;
if (only.length && chosen.length !== only.length) throw new Error(`Unknown example: ${only.filter((name) => !fmiExamples.some((example) => example.name === name)).join(', ')}.`);

const work = await mkdtemp(join(tmpdir(), 'konjugateFmiExamples-'));
try {
    for (const example of chosen) {
        const folder = join(examplesDirectory, example.name);
        await mkdir(folder, { recursive: true });
        const fmu = await generateFmuPackage(await exportDocument(example), { modelName: example.name, engineOptions });
        const platforms = fmuPlatforms(unzipSync(new Uint8Array(fmu)));
        const reference = await engineReference(example, work);
        await writeFile(join(folder, `${example.name}.fmu`), fmu);
        await writeFile(join(folder, `${example.name}_ref.csv`), referenceCsv(reference));
        await writeFile(join(folder, `${example.name}_ref.opt`), referenceOptions(example));
        await writeFile(join(folder, 'Readme.txt'), readmeText(example, platforms));
        console.log(`✓ ${example.name}: ${fmu.length} bytes (${platforms.join(', ')}), ${reference.rows.length} reference rows of ${reference.names.length} outputs`);
    }
} finally {
    await rm(work, { recursive: true, force: true });
}
