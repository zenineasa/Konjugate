/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Export of a model that says its kinds (FMI review #3): Updates worked out once per step and a relationship's single equation setting a
// value are written (their numbers are checked against the engine by tests/engine/kindsExportFidelity.mjs); what export still cannot
// write is refused saying how to proceed and that it changes timing.

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateStandaloneProgram } from '../src/codeExport.mjs';
import { describeFmu } from '../src/fmiExport.mjs';
import { kindsDocument } from './engine/kindsExportFidelity.mjs';

const model = () => structuredClone(kindsDocument);

test('Updates worked out once per step and a value-setting relationship are written to C++, Python and an FMU', () => {
    const cpp = generateStandaloneProgram(model(), 'cpp');
    assert.match(cpp, /\/\/ Updates worked out once per step/);
    assert.match(cpp, /std::vector<double> read = globalState;/);
    assert.match(generateStandaloneProgram(model(), 'python'), /# Updates worked out once per step/);
    assert.match(describeFmu(model(), 'Kinds').source, /std::vector<double> read = state_;/);
    assert.match(describeFmu(model(), 'Kinds', { fmiVersion: '3.0' }).source, /std::vector<double> read = state_;/);
});

test('what cannot be written yet is refused, saying how to proceed and that it changes timing', () => {
    const settling = model();
    settling.nodes[1].updates = 'settle';
    // Without the counter, which reads itself and is refused first, in the same words.
    assert.throws(() => generateStandaloneProgram(settling, 'cpp'), /State "Gauge · Count" reads itself in a node that settles its Updates within the step, which code export cannot write yet\. To export it, set "Gauge"'s Updates to "Once per step"/);
    settling.nodes[1].sourceTerms = settling.nodes[1].sourceTerms.filter((term) => term.state !== 'count');
    assert.throws(() => generateStandaloneProgram(settling, 'cpp'),
        /Relationship "Gauge reads the tank" sets the value of "Gauge · Reading" with a single equation, in a node that settles its Updates within the step, which code export cannot write yet\. To export it, set "Gauge"'s Updates to "Once per step" \(its Numerics tab\), the default: .* so its numbers can differ from this run's\./);
    const rk4 = model();
    rk4.runConfigurations[0].method = 'rungeKutta4';
    assert.throws(() => generateStandaloneProgram(rk4, 'cpp'), /Node "Gauge" works its Updates out once per step, which code export writes under Euler, node by node only, so far: choose it in the Run settings, or set its Updates to "Settle within the step"/);
    const program = model();
    program.nodes[1].sourceTerms[0] = { ...program.nodes[1].sourceTerms[0], implementation: { kind: 'cpp', providerApiVersion: 1, source: 'x', bindings: [], output: { stateId: 6 } } };
    assert.throws(() => generateStandaloneProgram(program, 'cpp'), /is a program setting an Update that is worked out once per step, which code export cannot write yet\. To export it, set "Gauge"'s Updates to "Settle within the step"/);
});
