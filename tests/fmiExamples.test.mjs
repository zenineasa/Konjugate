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
    exampleFolder, examplesDirectory, exportDocument, fmiExamples, fmiVersions, fmuPlatforms, parseReferenceCsv, parseReferenceOptions, readmeText, sampleTimes
} from '../scripts/fmiExamples.mjs';

const subfolders = async (path) => (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

test('examples/fmi holds exactly the examples scripts/fmiExamples.mjs defines, FMI 2.0 beside FMI 3.0 in 3.0/', async () => {
    assert.deepEqual(await subfolders(examplesDirectory), [...fmiExamples.map((example) => example.name), '3.0'].sort());
    assert.deepEqual(await subfolders(join(examplesDirectory, '3.0')), fmiExamples.map((example) => example.name).sort());
});

for (const fmiVersion of fmiVersions) for (const example of fmiExamples) {
    test(`${exampleFolder(example, fmiVersion)} (FMI ${fmiVersion}): the files the FMI tools page asks for, following its rules`, async () => {
        const folder = join(examplesDirectory, exampleFolder(example, fmiVersion));
        assert.deepEqual((await readdir(folder)).sort(), [`${example.name}.fmu`, `${example.name}_ref.csv`, `${example.name}_ref.opt`, 'Readme.txt'].sort());

        const options = parseReferenceOptions(await readFile(join(folder, `${example.name}_ref.opt`), 'utf8'));
        assert.deepEqual(options, { StartTime: example.startTime, StopTime: example.stopTime, StepSize: example.stepSize, RelTol: example.relTol });

        const csvPath = join(folder, `${example.name}_ref.csv`);
        assert.ok((await stat(csvPath)).size < 1_000_000, 'A reference CSV must stay under 1 MB.');
        const csvText = await readFile(csvPath, 'utf8');
        assert.doesNotMatch(csvText, /,\n|,$|\r/, 'A separator only goes between elements, and lines end in \\n.');
        const { names, rows } = parseReferenceCsv(csvText);
        assert.deepEqual(parseReferenceCsv(csvText.replaceAll('\n', '\r\n')), { names, rows }, 'Read the same with CRLF line ends.');
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
        assert.match(committedXml, new RegExp(`fmiVersion="${fmiVersion.replace('.', '\\.')}"`));
        const variableNames = [...committedXml.matchAll(/<(?:ScalarVariable|Float64) name="([^"]*)"/g)].map((match) => match[1]);
        for (const name of names.slice(1)) assert.ok(variableNames.includes(name), `${name} is not a variable of ${example.name}.fmu.`);

        const { modelIdentifier, xml } = describeFmu(await exportDocument(example), example.name, { fmiVersion, stopTime: example.stopTime });
        assert.equal(committedXml, xml,
            `${example.name}.fmu was not made by today's exporter (its modelDescription.xml differs): regenerate the examples with node scripts/generateFmiExamples.mjs.`);
        const binaries = Object.keys(fmu).filter((path) => path.startsWith('binaries/'));
        assert.ok(binaries.length > 0, 'The FMU carries a binary.');
        // FMI 2.0 names a platform darwin64, linux64, win64...; FMI 3.0 a tuple, aarch64-darwin, x86_64-linux...
        const platform = fmiVersion === '3.0' ? '[a-z0-9_]+-(darwin|linux|windows)' : '(darwin|linux|win)(32|64)';
        for (const path of binaries) assert.match(path, new RegExp(`^binaries/${platform}/${modelIdentifier}\\.(dylib|so|dll)$`));

        assert.equal(await readFile(join(folder, 'Readme.txt'), 'utf8'), readmeText(example, fmuPlatforms(fmu), fmiVersion));
    });
}
