/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The version 2 rewrites of the programs Convert cannot finish (each kept its memory by hand in evaluate()), through the real engine,
// against the older programs they replace for new users:
//   - the library's two PID assemblies (assets/componentLibrary/pidParallel.json, pidIsa.json; the older ones kept as
//     tests/fixtures/pidParallelV1.json, pidIsaV1.json), closed around a first-order plant as a user places them: every state at every
//     step the same bits under Euler, with the derivative, its filter, both output limits and the anti-windup at work;
//   - the PI-controlled tank (examples/providers/piControlledTank.json against piControlledTankProject.json), run at a global step equal
//     to the controller's sample period: every state at every step the same bits;
//   - the accumulator (examples/providers/accumulator.py against accumulatorNode.py, which the older format's own docs say is not meant
//     to run in a model): driven alike through the program SDK's harness and the older provider's contract, the same total, to the bit.
// Existing projects are not touched by any of this: a library assembly is copied into a project when placed.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/programRewrites.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateComponentTemplate } from '../../src/componentTemplate.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { remapGraphFragment } from '../../src/graphClipboard.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { programSourceVersion } from '../../src/providerTemplate.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const providers = { executionMode: 'inProcess', cpp: { sdkPath: join(root, 'engine') }, python: { sdkPath: join(root, 'engine', 'sdk', 'python') } };
const readJson = async (...path) => JSON.parse(await readFile(join(root, ...path), 'utf8'));

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramRewrites-'));
let runs = 0;

async function run(document, configuration) {
    const index = runs++;
    const modelPath = join(directory, `model${index}.kjt`);
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(modelPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, execution: { backend: 'serial' }, providers, ...configuration }));
    await new Promise((resolve, reject) => {
        const child = spawn(executable, ['run', modelPath, '--configuration', configurationPath, '--output', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `The engine exited with code ${code}.`))));
    });
    return decodeResultFile(await readFile(outputPath)).samples;
}

// Every state at every sample the same double.
function assertSameBits(older, newer, what) {
    assert.equal(newer.length, older.length, `${what}: the number of samples.`);
    for (const [index, sample] of older.entries()) {
        for (const state of sample.states) {
            const other = newer[index].states.find((candidate) => candidate.stateId === state.stateId);
            assert.ok(Object.is(other?.value, state.value), `${what}: state ${state.stateId} at t = ${sample.time} is ${other?.value}, not ${state.value}.`);
        }
    }
}

// A library assembly placed around a first-order plant, dx/dt = u - x, as tests/engine/pidTemplates.mjs places it.
function closedLoop(template, constants) {
    const placed = remapGraphFragment(validateComponentTemplate(template).fragment, 100, [0, 0, 0], { nameSuffix: '' });
    const controller = placed.nodes[0];
    const stateId = (symbol) => controller.states.find((state) => state.symbol === symbol).id;
    controller.implementation.bindings = controller.implementation.bindings.map((binding) => (
        binding.key === 'measurement' ? { key: 'measurement', kind: 'state', nodeId: 1, stateId: 2 } : binding
    ));
    return {
        format: 'konjugate', version: 1,
        sharedParameters: placed.sharedParameters.map((parameter) => (parameter.symbol in constants ? { ...parameter, value: constants[parameter.symbol] } : parameter)),
        nodes: [{ id: 1, name: 'Plant', states: [{ id: 2, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }], sourceTerms: [] }, controller],
        edges: [{
            id: 3, name: 'Actuation', source: { nodeId: controller.id, stateId: stateId('output') }, target: { nodeId: 1, stateId: 2 },
            directionality: 'directed', equation: 'sourceOutput - targetLevel',
            equationModel: {
                latex: '\\mathrm{sourceOutput} - \\mathrm{targetLevel}', output: { role: 'target', stateId: 2 },
                mathJson: ['Add', 'sourceOutput', ['Negate', 'targetLevel']],
                bindings: [
                    { kind: 'state', role: 'source', nodeId: controller.id, stateId: stateId('output'), symbol: 'sourceOutput' },
                    { kind: 'state', role: 'target', nodeId: 1, stateId: 2, symbol: 'targetLevel' }
                ]
            },
            parameters: []
        }]
    };
}

try {
    // The library's PID assemblies: version 2 now, the same bits as the older ones they replace.
    const cases = {
        pidParallel: [
            { setpoint: 1, kp: 4, ki: 4, kd: 0.5 },
            { setpoint: 10, kp: 4, ki: 4, kd: 0, outputMax: 2 },
            { setpoint: -10, kp: 4, ki: 4, kd: 0.3, outputMin: -2, outputMax: 2, filterTime: 0.05 },
            { setpoint: 3, kp: 2, ki: 1.5, kd: 0.2, filterTime: 0.2, outputMin: -1, outputMax: 1.2 }
        ],
        pidIsa: [
            { setpoint: 1, p: 4, i: 1, d: 0.125 },
            { setpoint: 10, p: 4, i: 1, d: 0, outputMax: 2 },
            { setpoint: -10, p: 2, i: 0, d: 0.1, outputMin: -2, outputMax: 2, filterTime: 0.05 },
            { setpoint: 3, p: 2, i: 0.7, d: 0.3, filterTime: 0.2, outputMin: -1, outputMax: 1.2 }
        ]
    };
    for (const [id, constantsList] of Object.entries(cases)) {
        const newer = await readJson('assets', 'componentLibrary', `${id}.json`);
        const older = await readJson('tests', 'fixtures', `${id}V1.json`);
        const source = (template) => template.fragment.nodes[0].implementation;
        assert.deepEqual([source(newer).providerApiVersion, programSourceVersion('cpp', source(newer).source)], [2, 2], `The library's ${id} is version 2.`);
        assert.deepEqual([source(older).providerApiVersion, programSourceVersion('cpp', source(older).source)], [1, 1], `The fixture keeps the older ${id}.`);
        // Only the program changed: the same nodes, states, bindings, outputs and shared parameters.
        const without = (template) => JSON.stringify({ ...template, fragment: { ...template.fragment, nodes: template.fragment.nodes.map((node) => ({ ...node, implementation: { ...node.implementation, source: null, providerApiVersion: null } })) } });
        assert.equal(without(newer), without(older), `Only ${id}'s program changed.`);
        for (const constants of constantsList) {
            const timing = { targetTime: 5, globalTimeStep: 0.01, outputInterval: 0.01 };
            assertSameBits(await run(closedLoop(older, constants), timing), await run(closedLoop(newer, constants), timing), `${id} ${JSON.stringify(constants)}`);
        }
    }

    // The PI-controlled tank, at a global step equal to the controller's sample period.
    {
        const older = await readJson('examples', 'providers', 'piControlledTankProject.json');
        const newer = await readJson('examples', 'providers', 'piControlledTank.json');
        assert.equal(newer.nodes[0].implementation.source, await readFile(join(root, 'examples', 'providers', 'piController.py'), 'utf8'),
            'The project carries piController.py as it is.');
        const timing = { targetTime: 20, globalTimeStep: 0.05, outputInterval: 0.05 };
        const before = await run(older, timing);
        assertSameBits(before, await run(newer, timing), 'The PI-controlled tank');
        assert.ok(Math.abs(before.at(-1).states.find((state) => state.stateId === 11).value - 10) < 1, 'The tank fills toward its setpoint.');
    }

    // The accumulator: the older provider's contract and the program SDK's harness, driven alike, keep the same total.
    {
        const script = `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(join(root, 'engine', 'sdk', 'python'))})
def load(name):
    spec = importlib.util.spec_from_file_location(name, ${JSON.stringify(join(root, 'examples', 'providers'))} + "/" + name + ".py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
from konjugate import EvaluationContext, InputView, NodeOutputCollector
from konjugate.v2.testing import Harness
older = load("accumulatorNode").AccumulatorNode()
harness = Harness(load("accumulator").Accumulator)
same = []
for step, (value, size) in enumerate([(4.0, 0.5), (-1.25, 0.1), (3.0, 0.01), (0.7, 0.3), (2.0, 1e-3)] * 20):
    outputs = NodeOutputCollector()
    older.evaluate(EvaluationContext(0.0, size), InputView({"input": value}), outputs)
    harness.advance(step * 0.1, size, input=value)
    same.append(outputs.gradients["output"].hex() == harness.evaluate(input=value)["output"].hex() == float(harness.memory["total"]).hex())
print(json.dumps(same))
`;
        const same = JSON.parse((await promisify(execFile)('python3', ['-c', script])).stdout);
        assert.ok(same.length === 100 && same.every(Boolean), `The accumulator's total differs from the older one's at step ${same.indexOf(false)}.`);
    }
    console.log('The version 2 rewrites give the older programs\' numbers to the bit: both library PIDs, the PI-controlled tank and the accumulator.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
