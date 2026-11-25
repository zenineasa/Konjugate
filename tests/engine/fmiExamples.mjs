/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The example FMUs of the FMI compatibility page (examples/fmi/README.md), checked end to end (a release check,
// scripts/runReleaseChecks.mjs). For each example, in its FMI 2.0 folder and its FMI 3.0 one (examples/fmi/3.0/):
//
//   1. the engine is run again on the example's project and must give its committed reference result ({Model_Name}_ref.csv);
//   2. the FMU is exported again with today's exporter (needs a C++ compiler) and its modelDescription.xml must be the committed one;
//   3. FMPy (an independent FMI tool, and one of the validators fmi-standard.org/validation lists) validates the committed FMU and
//      the fresh one, and simulates each with the example's _ref.opt; both must give the reference result. The committed FMU is
//      simulated only where its binary runs (it carries the binary of the computer that generated it; see Readme.txt).
//
// tests/fmiExamples.test.mjs checks the files' format and the exporter's code generation without a compiler. Skips (not a failure)
// what needs FMPy when it is not importable (pip install fmpy; PYTHON selects the interpreter).
//
//   node tests/engine/fmiExamples.mjs [engine]

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { chooseFmuBinary } from '../../src/fmiBinary.mjs';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import {
    engineOptions, engineReference, enginePath, exampleFolder, examplesDirectory, execute, exportDocument, fmiExamples, fmiVersions, parseReferenceCsv
} from '../../scripts/fmiExamples.mjs';

const executable = process.argv[2] ?? enginePath();
const python = process.env.PYTHON || 'python3';
// Each FMU and the engine compute the same operations in the same order, so they agree to rounding; this is far tighter than the
// .opt's RelTol, which is for other tools' comparisons.
const tolerance = 1e-12;

function largestDifference(rows, reference) {
    let largest = 0;
    rows.forEach((row, rowIndex) => row.forEach((value, column) => {
        const expected = reference[rowIndex][column];
        largest = Math.max(largest, Math.abs(value - expected) / Math.max(1, Math.abs(expected)));
    }));
    return largest;
}

const simulateScript = `
import json, sys, fmpy
from fmpy import simulate_fmu
from fmpy.validation import validate_fmu
path, start, stop, step, names = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), json.loads(sys.argv[5])
problems = validate_fmu(path)
result = None if problems else simulate_fmu(path, start_time=start, stop_time=stop, output_interval=step, output=names)
print(json.dumps({'fmpy': fmpy.__version__, 'problems': problems,
    'rows': [] if result is None else [[float(row['time'])] + [float(row[name]) for name in names] for row in result]}))
`;

const directory = await mkdtemp(join(tmpdir(), 'konjugateFmiExamples-'));
try {
    const fmpy = (await execute(python, ['-c', 'import fmpy'])).code === 0;
    const scriptPath = join(directory, 'simulate.py');
    await writeFile(scriptPath, simulateScript, 'utf8');

    async function simulate(fmuPath, example, names) {
        const run = await execute(python, [scriptPath, fmuPath, String(example.startTime), String(example.stopTime), String(example.stepSize), JSON.stringify(names)]);
        assert.equal(run.code, 0, `FMPy could not simulate ${fmuPath}: ${run.stderr}`);
        return JSON.parse(run.stdout.trim().split('\n').at(-1));
    }

    for (const example of fmiExamples) for (const fmiVersion of fmiVersions) {
        const exampleLabel = `${exampleFolder(example, fmiVersion)} (FMI ${fmiVersion})`;
        const folder = join(examplesDirectory, exampleFolder(example, fmiVersion));
        const reference = parseReferenceCsv(await readFile(join(folder, `${example.name}_ref.csv`), 'utf8'));
        const names = reference.names.slice(1);

        // 1. The engine gives the committed reference result.
        const engine = await engineReference(example, directory, executable);
        assert.deepEqual(engine.names, names, `${exampleLabel}: the engine's outputs are not the reference result's columns.`);
        const engineDifference = largestDifference(engine.rows, reference.rows);
        assert.ok(engineDifference <= tolerance,
            `${exampleLabel}: the engine's run diverges from ${example.name}_ref.csv by ${engineDifference} (relative): regenerate the examples with node scripts/generateFmiExamples.mjs if the change is intended.`);
        console.log(`✓ ${exampleLabel}: the engine gives ${example.name}_ref.csv (largest difference ${engineDifference}).`);

        // 2. Today's exporter makes the same FMU.
        const committedPath = join(folder, `${example.name}.fmu`);
        const committed = unzipSync(new Uint8Array(await readFile(committedPath)));
        const fresh = await generateFmuPackage(await exportDocument(example), { modelName: example.name, engineOptions, fmiVersion });
        const freshPath = join(directory, `${example.name}-${fmiVersion}.fmu`);
        await writeFile(freshPath, fresh);
        assert.equal(Buffer.from(unzipSync(new Uint8Array(fresh))['modelDescription.xml']).toString('utf8'), Buffer.from(committed['modelDescription.xml']).toString('utf8'),
            `${exampleLabel}: today's export has another modelDescription.xml than the committed FMU: regenerate the examples with node scripts/generateFmiExamples.mjs.`);
        console.log(`✓ ${exampleLabel}: today's export has the committed FMU's modelDescription.xml.`);

        // 3. FMPy validates and simulates them, giving the reference result.
        if (!fmpy) {
            console.log(`  (skipping ${exampleLabel} in FMPy: fmpy not importable -- pip install fmpy)`);
            continue;
        }
        const modelIdentifier = /modelIdentifier="([^"]*)"/.exec(Buffer.from(committed['modelDescription.xml']).toString('utf8'))[1];
        const choice = await chooseFmuBinary({ fmiVersion, modelIdentifier }, async (path) => committed[path] ?? null);
        const binary = choice.error ? null : choice;
        const candidates = [['the fresh export', freshPath], ...(binary ? [['the committed FMU', committedPath]] : [])];
        for (const [label, path] of candidates) {
            const simulation = await simulate(path, example, names);
            assert.deepEqual(simulation.problems, [], `${exampleLabel}: FMPy ${simulation.fmpy} finds ${label} invalid.`);
            assert.equal(simulation.rows.length, reference.rows.length, `${exampleLabel}: FMPy gave ${simulation.rows.length} rows for ${label}, not ${reference.rows.length}.`);
            const difference = largestDifference(simulation.rows, reference.rows);
            assert.ok(difference <= tolerance, `${exampleLabel}: FMPy's simulation of ${label} diverges from ${example.name}_ref.csv by ${difference} (relative).`);
            console.log(`✓ ${exampleLabel}: FMPy ${simulation.fmpy} validates ${label} and its simulation gives ${example.name}_ref.csv (largest difference ${difference}).`);
        }
        if (!binary) console.log(`  (skipping the committed ${exampleLabel} in FMPy: it has no binary for ${process.platform} ${process.arch})`);
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
