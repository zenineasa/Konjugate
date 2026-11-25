/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The example FMUs of the FMI compatibility page (examples/fmi/), checked without a compiler or an FMI tool: every file the
// FMI tools page asks for is there and follows its rules (the CSV rules, the .opt's elements, at most ten variables, under 1 MB),
// the reference results cover the .opt's StartTime to StopTime at its StepSize, every name in them is an FMU variable, and each
// FMU's modelDescription.xml is what the exporter writes for its project today, byte for byte. Its guid is a hash of the
// generated C++ (src/fmiExport.mjs), so a change to code generation that would change an example FMU fails here until the
// examples are regenerated (node scripts/generateFmiExamples.mjs). tests/engine/fmiExamples.mjs (a release check) reruns the
// engine for the reference results and simulates the FMUs with FMPy.

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { describeFmu } from '../src/fmiExport.mjs';
import {
    examplesDirectory, exportDocument, fmiExamples, fmuPlatforms, parseReferenceCsv, parseReferenceOptions, readmeText, sampleTimes
} from '../scripts/fmiExamples.mjs';

test('examples/fmi holds exactly the examples scripts/fmiExamples.mjs defines', async () => {
    const folders = (await readdir(examplesDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.deepEqual(folders, fmiExamples.map((example) => example.name).sort());
});

for (const example of fmiExamples) {
    test(`${example.name}: the files the FMI tools page asks for, following its rules`, async () => {
        const folder = join(examplesDirectory, example.name);
        assert.deepEqual((await readdir(folder)).sort(), [`${example.name}.fmu`, `${example.name}_ref.csv`, `${example.name}_ref.opt`, 'Readme.txt'].sort());

        const options = parseReferenceOptions(await readFile(join(folder, `${example.name}_ref.opt`), 'utf8'));
        assert.deepEqual(options, { StartTime: example.startTime, StopTime: example.stopTime, StepSize: example.stepSize, RelTol: example.relTol });

        const csvPath = join(folder, `${example.name}_ref.csv`);
        assert.ok((await stat(csvPath)).size < 1_000_000, 'A reference CSV must stay under 1 MB.');
        const csvText = await readFile(csvPath, 'utf8');
        assert.doesNotMatch(csvText, /,\n|,$|\r/, 'A separator only goes between elements, and lines end in \\n.');
        const { names, rows } = parseReferenceCsv(csvText);
        assert.equal(names[0], 'time', 'The first column is the time.');
        assert.ok(names.length - 1 <= 10, 'At most ten variables.');
        assert.equal(new Set(names).size, names.length);
        rows.forEach((row, index) => assert.equal(row.length, names.length, `Row ${index + 2} has ${row.length} cells.`));
        assert.deepEqual(rows.map((row) => row[0]), sampleTimes(example), 'The rows go from StartTime to StopTime every StepSize.');
        rows.slice(1).forEach((row, index) => assert.ok(row[0] > rows[index][0], 'Time strictly increases.'));
        const internalSteps = example.stepSize / example.run.globalTimeStep;
        assert.ok(Math.abs(internalSteps - Math.round(internalSteps)) < 1e-9, 'StepSize is a whole number of the FMU\'s internal steps.');

        const fmu = unzipSync(new Uint8Array(await readFile(join(folder, `${example.name}.fmu`))));
        const committedXml = Buffer.from(fmu['modelDescription.xml']).toString('utf8');
        const variableNames = [...committedXml.matchAll(/<ScalarVariable name="([^"]*)"/g)].map((match) => match[1]);
        for (const name of names.slice(1)) assert.ok(variableNames.includes(name), `${name} is not a variable of ${example.name}.fmu.`);

        const { modelIdentifier, xml } = describeFmu(await exportDocument(example), example.name);
        assert.equal(committedXml, xml,
            `${example.name}.fmu was not made by today's exporter (its modelDescription.xml differs): regenerate the examples with node scripts/generateFmiExamples.mjs.`);
        const binaries = Object.keys(fmu).filter((path) => path.startsWith('binaries/'));
        assert.ok(binaries.length > 0, 'The FMU carries a binary.');
        for (const path of binaries) assert.match(path, new RegExp(`^binaries/[a-z0-9]+/${modelIdentifier}\\.(dylib|so|dll)$`));

        assert.equal(await readFile(join(folder, 'Readme.txt'), 'utf8'), readmeText(example, fmuPlatforms(fmu)));
    });
}
