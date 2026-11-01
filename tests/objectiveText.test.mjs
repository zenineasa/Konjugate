/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { latexToObjectiveText, objectiveSummaries } from '../src/objectiveText.mjs';

const names = ['tank', 'k', 'reading'];
const text = (latex) => {
    const result = latexToObjectiveText(latex, names);
    assert.ok(result.valid, `${latex}: ${result.errors.join(' ')}`);
    return result.text;
};
const errors = (latex) => {
    const result = latexToObjectiveText(latex, names);
    assert.equal(result.valid, false, latex);
    return result.errors.join(' ');
};

test('each summary button writes something the parser reads and the engine understands', () => {
    assert.equal(text('\\lim_{t\\to T}\\left(\\mathrm{tank}\\right)'), 'final(tank)');
    assert.equal(text('\\max\\left(\\mathrm{tank}\\right)'), 'max(tank)');
    assert.equal(text('\\min\\left(\\mathrm{tank}\\right)'), 'min(tank)');
    assert.equal(text('\\operatorname{mean}\\left(\\mathrm{tank}\\right)'), 'mean(tank)');
    assert.equal(text('\\int_{0}^{T}\\mathrm{tank}\\,dt'), 'integral(tank)');
    for (const summary of objectiveSummaries) {
        const filled = summary.template.replace('#@', '\\mathrm{tank}');
        assert.match(text(filled), new RegExp(`^${summary.text}\\(tank\\)$`), summary.id);
    }
});

test('a formula of summaries and parameters keeps its structure', () => {
    assert.equal(text('\\int_{0}^{T}\\left(\\mathrm{tank}-320\\right)^{2}\\,dt+0.1\\cdot k^{2}'), '(0.1 * (k ^ 2)) + integral(((tank + (-320)) ^ 2))');
    assert.equal(text('\\sqrt{k}'), 'sqrt(k)');
    assert.equal(text('-k^2+3'), '(-(k ^ 2)) + 3');
    assert.equal(text('\\frac{k}{2}'), '(1 / 2) * k');
    assert.equal(text('k'), 'k');
});

test('what cannot be an objective is said in words', () => {
    assert.match(errors('\\max\\left(\\mathrm{tank},3\\right)'), /takes one expression/);
    assert.match(errors('k+T'), /end of the run, and only belongs in an integral/);
    assert.match(errors('\\int_{0}^{5}k\\,dt'), /goes from 0 to T/);
    assert.match(errors('\\lim_{t\\to T}\\left(\\mathrm{nothing}\\right)'), /Unknown symbol: nothing/);
    assert.match(errors('k+'), /could not be parsed/);
    assert.match(errors(''), /Enter an expression/);
    assert.match(errors('\\log\\left(k\\right)'), /cannot be used in an objective|Unsupported/);
});
