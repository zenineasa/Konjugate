/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pythonPortKey, sourcePorts } from '../src/providerEditor/sourcePorts.mjs';

const example = (name) => readFile(join(import.meta.dirname, '..', 'examples', 'providers', name), 'utf8');
const summary = (ports) => ({
    inputs: ports.inputs.map(({ key, kind, unit, default: fallback }) => [key, kind, unit, fallback]),
    outputs: ports.outputs.map(({ key, unit }) => [key, unit])
});

test('the PID controller\'s ports as its C++ and its Python declare them, the same in both', async () => {
    const expected = {
        inputs: [['measurement', 'input', 'K', undefined], ['setpoint', 'parameter', 'K', undefined], ['kp', 'constant', 'W/K', undefined],
            ['ki', 'constant', 'W/(K*s)', undefined], ['kd', 'constant', 'W*s/K', undefined], ['maxPower', 'constant', 'W', undefined], ['sensorNoise', 'constant', 'K', 0]],
        outputs: [['power', 'W']]
    };
    const cpp = sourcePorts('cpp', await example('pidController.cpp'));
    const python = sourcePorts('python', await example('pidController.py'));
    assert.deepEqual(summary(cpp), expected);
    assert.deepEqual(summary(python), expected);
    const source = (await example('pidController.cpp')).split('\n');
    assert.match(source[cpp.inputs[0].line - 1], /k::Input\s+measurement\{this, "measurement", "K"\}/, 'Each port with the line that declares it.');
    assert.deepEqual([cpp.memory, cpp.clock, cpp.fromSource], [[], null, true]);
});

test('a Python attribute binds by its camelCase key, or by the name it is given; comments and other lines are not ports', () => {
    assert.equal(pythonPortKey('level_rate'), 'levelRate');
    assert.equal(pythonPortKey('previous_error'), 'previousError');
    const ports = sourcePorts('python', [
        'class P(Node):',
        '    # hot = Input("K")',
        '    level_rate = Output("m/s")   # into the level',
        '    gain = Constant(name="k", default=2.5)',
        '    total = self.integral + 1',
        '    other = Input(\'Pa\')'
    ].join('\n'));
    assert.deepEqual(summary(ports), { inputs: [['k', 'constant', '', 2.5], ['other', 'input', 'Pa', undefined]], outputs: [['levelRate', 'm/s']] });
    assert.deepEqual(ports.outputs[0].line, 3);
});

test('C++ declarations in a comment are not ports', () => {
    const ports = sourcePorts('cpp', '// k::Input hot{this, "hot", "K"};\n    k::Input cold{this, "cold"};\n');
    assert.deepEqual(summary(ports), { inputs: [['cold', 'input', '', undefined]], outputs: [] });
});
