/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMI review #4: an FMI 2.0 export says its own fixed step, which FMI 2.0 has no attribute for, in a Konjugate vendor annotation, so the
// Run dialog warns before a run whose step it would refuse, as it does for FMI 3.0's fixedInternalStepSize.

import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFmu } from '../src/fmiExport.mjs';
import { parseModelDescription } from '../src/fmiModelDescription.mjs';
import { fmuStepCheck } from '../src/fmuSteps.mjs';
import { document } from './engine/fixtures/fmuFidelityFixture.mjs';

const withStep = { ...document, runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }], activeRunConfigurationId: 900 };

test('an FMI 2.0 export says its fixed step, read as FMI 3.0\'s is, and the Run check warns of a step it would refuse', () => {
    const two = parseModelDescription(describeFmu(withStep, 'Stepped').xml);
    const three = parseModelDescription(describeFmu(withStep, 'Stepped', { fmiVersion: '3.0' }).xml);
    assert.equal(three.coSimulation.fixedInternalStepSize, 0.01);
    assert.equal(two.coSimulation.fixedInternalStepSize, 0.01, 'The FMI 2.0 export says the same step.');
    const check = fmuStepCheck({ globalTimeStep: 0.015, outputInterval: 0.03 }, [{ name: 'Stepped', fmuName: 'Stepped', substeps: 1, internalStep: two.coSimulation.fixedInternalStepSize }]);
    assert.equal(check.problems.length, 1, 'A step of 0.015 is not a whole number of 0.01: said before the run.');
});

test('another tool\'s vendor annotations do not give a step', () => {
    const xml = describeFmu(withStep, 'Stepped').xml.replace('<Tool name="Konjugate">', '<Tool name="SomeoneElse">');
    assert.equal(parseModelDescription(xml).coSimulation.fixedInternalStepSize, undefined);
});
