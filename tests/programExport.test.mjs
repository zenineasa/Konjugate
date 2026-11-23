/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { generateStandaloneProgram } from '../src/codeExport.mjs';
import { programSdkCpp, programSdkPython } from '../src/programSdkSources.mjs';

const root = join(import.meta.dirname, '..');

test('the program SDK code export carries is the SDK as it is, to the byte', async () => {
    assert.equal(programSdkCpp, await readFile(join(root, 'engine', 'include', 'konjugate', 'sdk', 'v2', 'program.hpp'), 'utf8'));
    assert.equal(programSdkPython, await readFile(join(root, 'engine', 'sdk', 'python', 'konjugate', 'v2', '__init__.py'), 'utf8'));
});

const conduction = (kind, source, extra = {}) => ({
    format: 'konjugate', version: 1, metadata: { projectName: 'Conduction' },
    nodes: [
        { id: 1, name: 'Wall', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 310, unit: 'K' }], sourceTerms: [] },
        { id: 2, name: 'Room', states: [{ id: 21, name: 'Temperature', symbol: 'temperature', initialValue: 295, unit: 'K' }], sourceTerms: [] }
    ],
    edges: [{
        id: 31, name: 'Conduction', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', equation: '',
        parameters: [{ id: 41, name: 'Conductance', symbol: 'conductance', value: 4, unit: 'W/K' }, { id: 42, name: 'Capacity', symbol: 'capacity', value: 2, unit: 'J/K' }],
        implementation: {
            kind, providerApiVersion: 2, source,
            bindings: [
                { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 }, { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 },
                { key: 'conductance', kind: 'parameter', parameterId: 41 }, { key: 'capacity', kind: 'parameter', parameterId: 42 }
            ],
            output: { role: 'target', key: 'warming', stateId: 21 }
        }
    }],
    runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1, ...extra }],
    activeRunConfigurationId: 900
});

test('a program in the current format is exported with the SDK pasted in, its inputs in its declaration order', async () => {
    const cpp = generateStandaloneProgram(conduction('cpp', await readFile(join(root, 'examples', 'providers', 'conduction.cpp'), 'utf8')), 'cpp');
    assert.match(cpp, /namespace konjugate::sdk::v2 \{/);
    assert.doesNotMatch(cpp, /#pragma once/);
    assert.match(cpp, /const double programInputs\[\] = \{ snapshot\[0\], state\[0\], 4\.0, 2\.0 \};/);
    const python = generateStandaloneProgram(conduction('python', await readFile(join(root, 'examples', 'providers', 'conduction.py'), 'utf8')), 'python');
    assert.match(python, /\.evaluate\(step_time, \[snapshot\[0\], state\[0\], 4\.0, 2\.0\]\)/);
    // One instance, kept as the engine keeps it: started before the run with its inputs there.
    assert.match(cpp, /provider0Instance\.start\(1, "relationship Wall → Room", 31, 0, programInputs\);/);
    assert.match(python, /\.start\(1, "relationship Wall \\u2192 Room", 31, 0, \[/);
    assert.doesNotMatch(python, /^from konjugate\.v2 import/m);
});

test('what export cannot write yet is refused by name', async () => {
    const conductionPython = await readFile(join(root, 'examples', 'providers', 'conduction.py'), 'utf8');
    // Memory, clocks and whole-model methods are written; a program's own Jacobian under Stiff is not, nor are threads.
    const remembering = conduction('python', conductionPython.replace('from konjugate.v2 import Input,', 'from konjugate.v2 import Input, Memory,')
        .replace('    warming = Output("K/s")', '    warming = Output("K/s")\n    passed = Memory(0.0)'));
    assert.match(generateStandaloneProgram(remembering, 'python'), /ProgramInstance\(/);
    for (const method of ['rungeKutta4', 'dormandPrince54', 'rodas4', 'bdf']) assert.match(generateStandaloneProgram(conduction('python', conductionPython, { method }), 'python'), /def evaluate_stage/);
    const jacobian = `${conductionPython}\n    def jacobian(self, t, x):\n        return {}\n`;
    assert.throws(() => generateStandaloneProgram(conduction('python', jacobian, { method: 'rodas4' }), 'python'), /gives its own Jacobian, which Stiff uses and code export cannot write yet/);
    assert.doesNotThrow(() => generateStandaloneProgram(conduction('python', jacobian, { method: 'dormandPrince54' }), 'python'));
    const conductionCpp = await readFile(join(root, 'examples', 'providers', 'conduction.cpp'), 'utf8');
    assert.throws(() => generateStandaloneProgram(conduction('cpp', conductionCpp, { method: 'rungeKutta4' }), 'cpp', { parallelism: 'openmp' }),
        /which code export writes to run in one thread under Runge–Kutta 4: choose "serial"/);
});
