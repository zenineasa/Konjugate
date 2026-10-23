/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs the two bundled PID library assemblies through the real engine, closed around a first-order plant, exactly as a
// user places them: the assembly is renumbered and dropped into a model, its Measurement input is pointed at the plant's
// state, and a relationship carries its control output into the plant. Checks that each form removes the steady-state
// error, and that the two forms give the same trajectory when their constants describe the same controller
// (Ki = P / I and Kd = P * D), which is what makes them two ways of reporting one controller and not two controllers.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/pidTemplates.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateComponentTemplate } from '../../src/componentTemplate.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { remapGraphFragment } from '../../src/graphClipboard.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');

async function template(id) {
    return validateComponentTemplate(JSON.parse(await readFile(join(root, 'assets', 'componentLibrary', `${id}.json`), 'utf8')));
}

// The plant is a first-order lag, dx/dt = (u - x) / 1, driven by the controller's output through a relationship.
async function closedLoop(templateId, constants) {
    const { fragment } = await template(templateId);
    const placed = remapGraphFragment(fragment, 100, [0, 0, 0], { nameSuffix: '' });
    const controller = placed.nodes[0];
    const stateId = (symbol) => controller.states.find((state) => state.symbol === symbol).id;
    const plantNodeId = 1;
    const plantStateId = 2;
    const shared = placed.sharedParameters.map((parameter) => (parameter.symbol in constants ? { ...parameter, value: constants[parameter.symbol] } : parameter));
    controller.implementation.bindings = controller.implementation.bindings.map((binding) => (
        binding.key === 'measurement' ? { key: 'measurement', kind: 'state', nodeId: plantNodeId, stateId: plantStateId } : binding
    ));
    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        sharedParameters: shared,
        nodes: [
            { id: plantNodeId, name: 'Plant', states: [{ id: plantStateId, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }], sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#34727a' } },
            controller
        ],
        edges: [{
            id: 3, name: 'Actuation', source: { nodeId: controller.id, stateId: stateId('output') }, target: { nodeId: plantNodeId, stateId: plantStateId },
            directionality: 'directed', equation: 'sourceOutput - targetLevel',
            equationModel: {
                latex: '\\mathrm{sourceOutput} - \\mathrm{targetLevel}', output: { role: 'target', stateId: plantStateId },
                mathJson: ['Add', 'sourceOutput', ['Negate', 'targetLevel']],
                bindings: [
                    { kind: 'state', role: 'source', nodeId: controller.id, stateId: stateId('output'), symbol: 'sourceOutput' },
                    { kind: 'state', role: 'target', nodeId: plantNodeId, stateId: plantStateId, symbol: 'targetLevel' }
                ]
            },
            parameters: []
        }]
    };
}

function runEngine(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(diagnostics || `Engine exited with code ${code}.`))));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugatePidTemplates-'));
let runNumber = 0;
async function levels(templateId, constants) {
    runNumber += 1;
    const inputPath = join(directory, `run${runNumber}.kjt`);
    const configurationPath = join(directory, `run${runNumber}.json`);
    const outputPath = join(directory, `run${runNumber}.bin`);
    await writeFile(inputPath, await encodeProjectFile(`${JSON.stringify(await closedLoop(templateId, constants), null, 4)}\n`));
    await writeFile(configurationPath, `${JSON.stringify({
        name: 'PID closed loop', targetTime: 20, globalTimeStep: 0.01, outputInterval: 0.5,
        execution: { backend: 'serial' },
        providers: { executionMode: 'inProcess', cpp: { sdkPath: join(root, 'engine') } }
    })}\n`);
    await runEngine(['run', inputPath, '--configuration', configurationPath, '--output', outputPath]);
    return decodeResultFile(await readFile(outputPath)).samples.map((sample) => sample.states.find((state) => state.stateId === 2).value);
}

try {
    // Parallel: Kp = 4, Ki = 4.  ISA: P = 4, I = 1 s  (Ki = P / I = 4).
    const parallel = await levels('pidParallel', { setpoint: 1, kp: 4, ki: 4, kd: 0 });
    const isa = await levels('pidIsa', { setpoint: 1, p: 4, i: 1, d: 0 });
    assert.ok(parallel.length > 20 && Math.abs(parallel[0]) < 0.5 && parallel[10] > parallel[1], 'The closed loop did not produce a rising trajectory to compare.');
    assert.ok(Math.abs(parallel.at(-1) - 1) < 0.01, `The parallel controller settled at ${parallel.at(-1)}, not the setpoint.`);
    assert.ok(Math.abs(isa.at(-1) - 1) < 0.01, `The ISA controller settled at ${isa.at(-1)}, not the setpoint.`);
    assert.ok(parallel.every((level, index) => Math.abs(level - isa[index]) < 1e-9), 'The two forms differ though their constants describe the same controller.');

    // With a derivative term: Kd = 0.5 is P * D for P = 4, D = 0.125 s.
    const parallelD = await levels('pidParallel', { setpoint: 1, kp: 4, ki: 4, kd: 0.5 });
    const isaD = await levels('pidIsa', { setpoint: 1, p: 4, i: 1, d: 0.125 });
    assert.ok(parallelD.every((level, index) => Math.abs(level - isaD[index]) < 1e-9), 'The two forms differ with a derivative term.');
    assert.ok(parallelD.some((level, index) => Math.abs(level - parallel[index]) > 1e-6), 'The derivative term had no effect.');

    // Proportional only settles short of the setpoint, at Kp / (1 + Kp).
    const proportional = await levels('pidParallel', { setpoint: 1, kp: 4, ki: 0, kd: 0 });
    assert.ok(Math.abs(proportional.at(-1) - 0.8) < 0.01, `Proportional-only control settled at ${proportional.at(-1)}, not 0.8.`);

    // A limit holds the output, and so the plant's rate, down.
    const limited = await levels('pidParallel', { setpoint: 10, kp: 4, ki: 4, kd: 0, outputMax: 2 });
    assert.ok(limited.at(-1) <= 2 + 1e-6, `The limited controller drove the plant to ${limited.at(-1)}, past its output limit of 2.`);

    console.log('PID assemblies behave as designed through the real engine.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
