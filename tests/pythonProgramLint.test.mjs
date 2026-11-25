/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code editor's checks of a Python program (src/pythonProgramLint.mjs), run here through Pyodide as the web edition runs them; the
// desktop runs the same function in a Python process.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runPythonSyntaxCheck, setPythonProviderSources } from '../src/webPythonProviderBridge.mjs';

const root = join(import.meta.dirname, '..');
const pyodideDirectory = join(root, 'node_modules', 'pyodide');
setPythonProviderSources({
    importPyodide: () => import(pathToFileURL(join(pyodideDirectory, 'pyodide.mjs')).href),
    indexURL: `${pyodideDirectory}/`,
    readSdkFile: (fileName) => readFile(join(root, 'engine', 'sdk', 'python', 'konjugate', fileName), 'utf8')
});
const example = (name) => readFile(join(root, 'examples', 'providers', name), 'utf8');
const program = (...lines) => ['from konjugate.v2 import Clock, Constant, Input, Memory, Node, Output, Relationship', '', ...lines, ''].join('\n');
const brief = (answer) => answer.diagnostics.map(({ line, severity, message }) => [line, severity, message]);

test('the bundled examples have nothing to say', async () => {
    for (const name of ['pidController.py', 'piController.py', 'conduction.py', 'accumulator.py']) {
        assert.deepEqual(await runPythonSyntaxCheck(await example(name)), { valid: true, diagnostics: [] }, name);
    }
});

test('a read of a port the program does not declare, by attribute or by key, with what it does declare', async () => {
    const answer = await runPythonSyntaxCheck(program(
        'class Heater(Relationship):',
        '    setpoint = Input("K")',
        '    measurement = Input("K")',
        '    integral = Memory(0.0)',
        '    output = Output()',
        '',
        '    def evaluate(self, t, x):',
        '        return x.setpoint - x.measurment + x["integral"] + x["missing"] + x.measurement'
    ));
    assert.equal(answer.valid, false);
    assert.deepEqual(brief(answer), [
        [10, 'error', '\'measurment\' is not a port of this program: integral, measurement, setpoint'],
        [10, 'error', '\'missing\' is not a port of this program: integral, measurement, setpoint']
    ]);
    assert.deepEqual([answer.diagnostics[0].column, answer.diagnostics[0].endColumn], [29, 41], 'At the read, x.measurment, and no more.');
});

test('ports read by their camelCase key, constants in initialize(), memory through x and a port named in the class all count', async () => {
    const answer = await runPythonSyntaxCheck(program(
        'class Tank(Node):',
        '    sample_period = Constant("s", default=0.05)',
        '    level_now = Input("m")',
        '    gain = Constant(name="k")',
        '    held = Memory(0.0)',
        '    rate = Output("m/s")',
        '    clock = Clock(sample_period)',
        '',
        '    def initialize(self, setup, m):',
        '        m.held = setup.k',
        '',
        '    def evaluate(self, t, x):',
        '        return self.outputs(rate=x.levelNow + x.held)'
    ));
    assert.deepEqual(answer, { valid: true, diagnostics: [] });
});

test('an input never read is a hint, not a problem; x passed on keeps it quiet', async () => {
    const unread = await runPythonSyntaxCheck(program(
        'class C(Relationship):',
        '    hot = Input("K")',
        '    cold = Input("K")',
        '    output = Output()',
        '',
        '    def evaluate(self, t, x):',
        '        return x.hot'
    ));
    assert.equal(unread.valid, true);
    assert.deepEqual(brief(unread), [[5, 'info', 'Input \'cold\' is never read.']]);
    assert.deepEqual([unread.diagnostics[0].column, unread.diagnostics[0].endColumn], [5, 9], 'Its name, and no more.');
    const passedOn = await runPythonSyntaxCheck(program(
        'class C(Relationship):',
        '    hot = Input("K")',
        '    cold = Input("K")',
        '    output = Output()',
        '',
        '    def evaluate(self, t, x):',
        '        return difference(x)'
    ));
    assert.deepEqual(passedOn, { valid: true, diagnostics: [] });
});

test('Python\'s own warnings at their lines, and only the first syntax error, as Python stops there', async () => {
    const warned = await runPythonSyntaxCheck(program(
        'class C(Relationship):',
        '    hot = Input("K")',
        '    output = Output()',
        '',
        '    def evaluate(self, t, x):',
        '        if x.hot is 1:',
        '            return 0.0',
        '        return x.hot'
    ));
    assert.equal(warned.valid, true, 'A warning is not an error.');
    assert.deepEqual(brief(warned).map(([line, severity]) => [line, severity]), [[8, 'warning']]);
    const broken = await runPythonSyntaxCheck('x = 1\ndef broken(:\n    pass\nalso broken(\n');
    assert.equal(broken.valid, false);
    assert.equal(broken.diagnostics.length, 1);
    assert.equal(broken.diagnostics[0].line, 2);
});

test('a class built on one of its own, or an older program, is not read', async () => {
    const answer = await runPythonSyntaxCheck(program(
        'class Base(Relationship):',
        '    hot = Input("K")',
        '',
        'class C(Base):',
        '    def evaluate(self, t, x):',
        '        return x.hot + x.inherited'
    ));
    assert.deepEqual(answer.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), []);
});
