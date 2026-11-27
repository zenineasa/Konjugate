/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An imported FMU's start values (docs/proposals/fmuImportWorkflow.md, stage 2), checked with the FMI Reference FMUs of both FMI
// versions (the release the import fidelity checks use, tests/engine/fixtures/referenceFmus/):
//   1. With no bindings at all, every input and parameter keeps the FMU's own start value: the run equals, bit for bit, the
//      same FMU with each one bound to a constant state holding that start value, the way a file had to wire it before.
//   2. Values given in the file (`{ key, kind: "value", value }`) are set when the run starts: with each case's values given
//      that way, every output at every communication point equals FMPy's run of the case, bit for bit.
//   3. Where a case's values are the FMU's own start values, the run with no bindings equals FMPy's too.
// The documents say `requires: ["fmuStartValues"]`, which the host takes off before the engine sees it.
//
//   node tests/engine/fmiStartValues.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { engineOptionsFor, installReferenceFmu, referenceCases } from './fixtures/referenceFmuFidelity.mjs';

const fmpyReference = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'referenceFmus', 'fmpyReference.json'), 'utf8'));

function hostDocument({ installed, ports, bindingFor, extraStates = [] }) {
    const outputStates = ports.outputs.map((port, index) => ({ id: 200 + index, name: port.name, symbol: `o${index}`, initialValue: 0, unit: '' }));
    return {
        format: 'konjugate', version: 1, metadata: { projectName: `Reference FMU ${ports.name}` }, requires: ['fmuStartValues'],
        nodes: [{
            id: 1, name: ports.name, states: [...extraStates, ...outputStates], numerics: { substepsPerGlobalStep: 1 }, sourceTerms: [],
            implementation: {
                kind: 'fmi', fmuId: installed.guid, fmuVersion: installed.version,
                bindings: ports.inputs.map((port, index) => bindingFor(port, index)).filter(Boolean),
                outputs: ports.outputs.map((port, index) => ({ key: port.key, stateId: outputStates[index].id }))
            }
        }],
        edges: []
    };
}

async function run(document, testCase, packagesDirectory, what) {
    const outcome = await runWithEngine(JSON.stringify(document),
        { targetTime: testCase.stopTime, globalTimeStep: testCase.stepSize, outputInterval: testCase.stepSize, pacing: { mode: 'fastest' } },
        engineOptionsFor(packagesDirectory));
    if (!outcome.available) throw new Error(`${what}: the engine was not available.`);
    if (outcome.error || !outcome.result) throw new Error(`${what}: the run failed: ${outcome.error ?? outcome.diagnostics ?? 'no result'}`);
    return outcome.result.samples;
}

// Every output from the start (at t = 0, what the FMU gives once initialized), by output index.
function outputSeries(samples, ports) {
    return ports.outputs.map((port, index) => samples.map((sample) => sample.states.find((state) => state.stateId === 200 + index).value));
}

function assertSameBits(actual, expected, what) {
    assert.equal(actual.length, expected.length, `${what}: ${actual.length} outputs, not ${expected.length}.`);
    actual.forEach((series, output) => series.forEach((value, index) => {
        assert.ok(Object.is(value, expected[output][index]), `${what}: output ${output} at sample ${index} is ${value}, not ${expected[output][index]}.`);
    }));
}

const packagesDirectory = await mkdtemp(join(tmpdir(), 'konjugateFmiStartValues-'));
const lines = [];
try {
    for (const fmiVersion of ['2.0', '3.0']) {
        for (const testCase of referenceCases.cases) {
            const what = `FMI ${fmiVersion} ${testCase.name}`;
            const { installed, ports } = await installReferenceFmu(fmiVersion, testCase.name, packagesDirectory);
            const missingStart = ports.inputs.filter((port) => !Number.isFinite(port.start)).map((port) => port.name);
            assert.deepEqual(missingStart, [], `${what}: every input and parameter has a start value.`);

            // 1. Left to the FMU, against bound to its start values.
            const defaults = await run(hostDocument({ installed, ports, bindingFor: () => null }), testCase, packagesDirectory, `${what} with no bindings`);
            const startStates = ports.inputs.map((port, index) => ({ id: 100 + index, name: port.name, symbol: `i${index}`, initialValue: port.start, unit: '' }));
            const bound = await run(hostDocument({ installed, ports, extraStates: startStates, bindingFor: (port, index) => ({ key: port.key, kind: 'state', stateId: 100 + index }) }),
                testCase, packagesDirectory, `${what} bound to its start values`);
            assertSameBits(outputSeries(defaults, ports), outputSeries(bound, ports), `${what}, start values left to the FMU against bound`);

            // 2. The case's values given in the file, against FMPy.
            const expected = fmpyReference.runs.find((entry) => entry.fmiVersion === fmiVersion && entry.name === testCase.name);
            assert.ok(expected, `fmpyReference.json has no ${what} run.`);
            const fmpySeries = (count) => ports.outputs.map((port) => {
                const reference = expected.outputs[port.name];
                assert.ok(reference, `${what}: FMPy has no output '${port.name}'.`);
                // FMPy stops where the FMU ended the simulation; Konjugate holds the last values from there.
                return Array.from({ length: count }, (_, index) => reference[Math.min(index, reference.length - 1)]);
            });
            const valueFor = (port) => testCase.values[port.name] ?? 0;
            const given = await run(hostDocument({ installed, ports, bindingFor: (port) => ({ key: port.key, kind: 'value', value: valueFor(port) }) }),
                testCase, packagesDirectory, `${what} with given values`);
            const givenSeries = outputSeries(given, ports);
            assertSameBits(givenSeries, fmpySeries(givenSeries[0]?.length ?? 0), `${what}, given values against FMPy ${fmpyReference.fmpy}`);

            // 3. Where the case is the FMU's defaults, no bindings at all agree with FMPy as well.
            const caseIsDefaults = ports.inputs.every((port) => Object.is(valueFor(port), port.start));
            if (caseIsDefaults) assertSameBits(outputSeries(defaults, ports), fmpySeries(givenSeries[0]?.length ?? 0), `${what}, no bindings against FMPy`);
            lines.push(`${what} (${ports.inputs.length === 1 ? 'one input or parameter' : `${ports.inputs.length} inputs and parameters`}${caseIsDefaults ? ', its defaults also against FMPy' : ''})`);
        }
    }
    console.log(`FMU start values: left to the FMU equals bound to them, and given values equal FMPy ${fmpyReference.fmpy}, bit for bit: ${lines.join('; ')}.`);
} finally {
    await rm(packagesDirectory, { recursive: true, force: true });
}
