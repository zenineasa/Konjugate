/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { fmuRunSuggestion, fmuStepCheck, fmuStepSentences, stepNumber, wholeNumberOf } from '../src/fmuSteps.mjs';

// The springMassDamper FMU (Konjugate's own FMI 3.0 export) steps by 0.01 s inside and refuses any other step.
const spring = { name: 'springMassDamper', fmuName: 'springMassDamper', substeps: 1, internalStep: 0.01 };

test('a step that is a whole number of an FMU\'s own is fine, within rounding', () => {
    assert.equal(wholeNumberOf(0.01, 0.01), true);
    assert.equal(wholeNumberOf(0.3, 0.1), true, '0.3 / 0.1 is 2.9999999999999996');
    assert.equal(wholeNumberOf(0.005, 0.01), false);
    assert.equal(wholeNumberOf(0.015, 0.01), false);
    assert.equal(wholeNumberOf(0.1, undefined), true, 'An FMU that says no step of its own takes any.');
    assert.equal(stepNumber(3 * 0.1), 0.3);
});

test('a 0.005 s step is said and offered 0.01 s, with the output interval kept a whole number of steps', () => {
    const check = fmuStepCheck({ globalTimeStep: 0.005, outputInterval: 0.005 }, [spring]);
    assert.deepEqual(check, {
        problems: [{ name: 'springMassDamper', fmuName: 'springMassDamper', step: 0.005, internalStep: 0.01 }],
        fix: { globalTimeStep: 0.01, outputInterval: 0.01 }, disagree: []
    });
    assert.deepEqual(fmuStepSentences(check), ['\'springMassDamper\' steps by 0.01 s inside; this run steps it by 0.005 s, which is not a whole number of its steps. Some FMUs refuse that (Konjugate\'s own exports do); others approximate.']);
    assert.deepEqual(fmuStepCheck({ globalTimeStep: 0.01, outputInterval: 0.1 }, [spring]), { problems: [], fix: null, disagree: [] });
    // A node with substeps steps its FMU by a part of the global step; the fix is a global step that makes that part right.
    const substepped = fmuStepCheck({ globalTimeStep: 0.03, outputInterval: 0.25 }, [{ ...spring, name: 'Suspension', substeps: 2 }]);
    assert.deepEqual(substepped.fix, { globalTimeStep: 0.04, outputInterval: 0.24 });
    assert.match(fmuStepSentences(substepped)[0], /^The FMU in 'Suspension' steps by 0\.01 s inside; this run steps it by 0\.015 s/);
});

test('one fix that suits every FMU is offered; when none does, the FMUs that disagree are named', () => {
    const dahlquist = { name: 'Dahlquist', fmuName: 'Dahlquist', substeps: 1, internalStep: 0.1 };
    const both = fmuStepCheck({ globalTimeStep: 0.05, outputInterval: 0.1 }, [spring, dahlquist]);
    assert.deepEqual(both.fix, { globalTimeStep: 0.1, outputInterval: 0.1 }, '0.1 s is a whole number of both.');
    const awkward = { name: 'Odd', fmuName: 'Odd', substeps: 1, internalStep: 0.03 };
    const none = fmuStepCheck({ globalTimeStep: 0.05, outputInterval: 0.1 }, [dahlquist, awkward]);
    assert.equal(none.fix, null);
    assert.deepEqual(none.disagree, ['Dahlquist', 'Odd']);
    assert.match(fmuStepSentences(none).at(-1), /^No one global step suits every FMU here \('Dahlquist', 'Odd'\)/);
});

test('the run an FMU suggests is its default experiment, from the first FMU that says one', () => {
    assert.deepEqual(fmuRunSuggestion([{ name: 'A' }, { name: 'Dahlquist', defaultExperiment: { startTime: 0, stopTime: 10, stepSize: 0.1 } }]), { name: 'Dahlquist', stopTime: 10, stepSize: 0.1 });
    assert.deepEqual(fmuRunSuggestion([{ name: 'Feedthrough', defaultExperiment: { startTime: 0, stopTime: 2 } }]), { name: 'Feedthrough', stopTime: 2, stepSize: null });
    assert.equal(fmuRunSuggestion([{ name: 'A', defaultExperiment: {} }]), null);
});
