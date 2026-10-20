/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    checkSeveralEquations, compileSeveralEquations, equationCandidates, equationLatex, moved, newDefinitionSymbol, nextFreeOutput,
    severalFromSingle, singleFromSeveral
} from '../src/relationshipEquations.mjs';

const parent = { id: 1, states: [{ id: 2, symbol: 'x' }, { id: 3, symbol: 'speed' }] };
const child = { id: 4, states: [{ id: 5, symbol: 'angle' }, { id: 6, symbol: 'reading' }] };
const parameters = [{ id: 7, symbol: 'gain' }];

test('a single equation becomes the first of several, now setting its state, and reads only what it uses', () => {
    const single = { latex: String.raw`\mathrm{gain}\cdot\mathrm{sourceX}`, output: { role: 'target', stateId: 6 }, bindings: [] };
    const candidates = equationCandidates(single, parent, child, parameters);
    const several = severalFromSingle(single, candidates, parent, child);
    assert.deepEqual(several.outputs, [{ role: 'target', stateId: 6, latex: single.latex, mathJson: ['Multiply', 'gain', 'sourceX'], setsValue: true }]);
    assert.deepEqual(several.definitions, []);
    assert.deepEqual(several.bindings.map(({ symbol }) => symbol).sort(), ['gain', 'sourceX']);
    // And back: the first equation, its definitions written into it.
    const withDefinition = compileSeveralEquations({
        bindings: several.bindings,
        definitions: [{ symbol: 'twice', latex: String.raw`2\cdot\mathrm{sourceX}` }],
        outputs: [{ role: 'target', stateId: 6, latex: String.raw`\mathrm{twice}+1` }, { role: 'target', stateId: 5, latex: '0' }]
    }, candidates, parent, child);
    const back = singleFromSeveral(withDefinition);
    assert.deepEqual(back.output, { role: 'target', stateId: 6 });
    assert.deepEqual(back.mathJson, ['Add', ['Multiply', 2, 'sourceX'], 1]);
    assert.match(back.latex, /sourceX/);
});

test('a relationship a toolbox wrote keeps its own binding symbols, and gains a binding only when an equation reads it', () => {
    const written = {
        bindings: [{ symbol: 'pX', kind: 'state', role: 'source', nodeId: 1, stateId: 2 }],
        definitions: [{ symbol: 'twice', mathJson: ['Multiply', 2, 'pX'], latex: String.raw`2\,\mathrm{p}_{X}` }],
        outputs: [{ role: 'target', stateId: 5, mathJson: ['Add', 'twice', 1], setsValue: true }]
    };
    const candidates = equationCandidates(written, parent, child, parameters);
    assert.equal(candidates.find((binding) => binding.stateId === 2).symbol, 'pX');
    const unchanged = compileSeveralEquations(written, candidates, parent, child);
    assert.deepEqual(unchanged.bindings, written.bindings, 'the toolbox\'s binding objects are kept as they were');
    // An item that still has its MathJSON is kept exactly; LaTeX that is only for show (it does not read back) is shown
    // as written from the MathJSON instead.
    assert.deepEqual(unchanged.definitions, written.definitions);
    assert.deepEqual(unchanged.outputs, written.outputs);
    assert.equal(checkSeveralEquations(written, candidates, parent, child).definitions[0].latex, String.raw`2\cdot \mathrm{pX}`);
    assert.equal(equationLatex(written.outputs[0]), String.raw`\mathrm{twice}+1`);
    // The user types an equation reading the gain: the gain is bound, the rest stays.
    const edited = compileSeveralEquations({ ...unchanged, outputs: [...unchanged.outputs, { role: 'target', stateId: 6, latex: String.raw`\mathrm{gain}\cdot\mathrm{pX}` }] },
        candidates, parent, child);
    assert.deepEqual(edited.bindings.map(({ symbol }) => symbol), ['pX', 'gain']);
    assert.deepEqual(edited.outputs[1].mathJson, ['Multiply', 'gain', 'pX']);
});

test('every mistake is named on its own row', () => {
    const candidates = equationCandidates({}, parent, child, parameters);
    const check = checkSeveralEquations({
        definitions: [
            { symbol: 'Bad', latex: '1' }, { symbol: 'gain', latex: '1' }, { symbol: 'q1', latex: String.raw`\mathrm{q2}` },
            { symbol: 'q2', latex: '2' }, { symbol: 'q2', latex: '3' }
        ],
        outputs: [{ role: 'target', stateId: 5, latex: String.raw`\mathrm{q1}` }, { role: 'target', stateId: 5, latex: '1' }, { role: 'source', stateId: 99, latex: '1' }]
    }, candidates, parent, child);
    assert.equal(check.valid, false);
    assert.match(check.definitions[0].errors[0], /not a valid name/);
    assert.match(check.definitions[1].errors[0], /already the name of a state, a parameter or time/);
    assert.match(check.definitions[2].errors.join(' '), /Unknown symbol: q2/, 'a definition reads only the definitions before it');
    assert.match(check.definitions[4].errors[0], /defined twice/);
    assert.deepEqual(check.outputs[0].errors, []);
    assert.match(check.outputs[1].errors[0], /target\.angle is set by another equation/);
    assert.match(check.outputs[2].errors[0], /Choose the state/);
    assert.deepEqual(checkSeveralEquations({ definitions: [], outputs: [] }, candidates, parent, child).errors, ['Add an equation.']);
    // A row the user typed into has no MathJSON to fall back on, so its typing error shows.
    const typed = compileSeveralEquations({ definitions: [], outputs: [{ role: 'target', stateId: 5, latex: String.raw`\mathrm{nowhere}` }] }, candidates, parent, child);
    assert.equal(typed.outputs[0].mathJson, null);
});

test('new rows take a free name and a free state; rows move one place at a time', () => {
    const candidates = equationCandidates({}, parent, child, parameters);
    assert.equal(newDefinitionSymbol({ definitions: [{ symbol: 'q1' }] }, candidates), 'q2');
    assert.deepEqual(nextFreeOutput({ outputs: [{ role: 'target', stateId: 5 }] }, parent, child), { role: 'target', stateId: 6 });
    assert.deepEqual(nextFreeOutput({ outputs: [{ role: 'target', stateId: 5 }, { role: 'target', stateId: 6 }] }, parent, child), { role: 'source', stateId: 2 });
    assert.deepEqual(moved(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    const list = ['a', 'b'];
    assert.equal(moved(list, 0, -1), list);
});
