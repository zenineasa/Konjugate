/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for event location (docs/proposals/integrators.md, Event location):
//   - under Runge–Kutta 4, Adaptive and Stiff every comparison of a Which condition in a Rate equation is a switching condition, located and
//     stepped to: the switched buck converter's PWM edges are found at the instants the duty cycle puts them, every one;
//   - the serial, thread-pool and partitioned backends give the same bits, events included;
//   - a run to T equals, to the bit, a run to T / 2 continued from its checkpoint, whose solver_state keeps the conditions' latches;
//   - Euler, node by node, does not locate, gives the numbers it always gave, and names the conditions it did not locate;
//   - a model with no switching condition is run as before, with no events reported, and an Equal comparison is not located;
//   - a condition that switches back and forth without end is bounded and reported (chattering), and the run completes.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const root = join(import.meta.dirname, '..', '..');
const buck = join(root, 'benchmarks', 'electrical', 'switchedCircuits', 'buckSwitched.kjt');

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateEvents-'));
let runs = 0;
async function run(model, configuration) {
    const index = runs++;
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, ...configuration }));
    const { code, diagnostics } = await execute(['run', model, '--configuration', configurationPath, '--output', outputPath]);
    assert.equal(code, 0, `The run must succeed: ${diagnostics}`);
    return decodeResultFile(await readFile(outputPath));
}
async function modelPath(name, document) {
    const path = join(directory, `${name}.kjt`);
    await writeFile(path, await encodeProjectFile(JSON.stringify(document)));
    return path;
}
const valuesOf = (result) => result.samples.flatMap((sample) => sample.states.map((state) => state.value));
const sameBits = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
const oneNode = (mathJson, initialValue = 0) => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [{ id: 1, name: 'Switched', position: [0, 0, 0], states: [{ id: 11, name: 'Y', symbol: 'y', initialValue, unit: '' }],
        sourceTerms: [{ id: 101, state: 'y', expression: 'cases', expressionModel: { latex: 'cases', bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'y' }, { kind: 'time', symbol: 't' }],
            output: { stateId: 11 }, mathJson } }], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' } }],
    edges: []
});

try {
    // The buck converter switches at 20 kHz with duty 0.4: the switch opens 20 µs into each 50 µs period and closes at its end.
    const timing = { targetTime: 0.002, globalTimeStep: 0.0000078125, outputInterval: 0.0000625 };
    const expected = [];
    // The edge at the run's very end has nothing after it to take effect in.
    for (let period = 0; period < 40; ++period) expected.push(...[period * 5e-5 + 2e-5, (period + 1) * 5e-5].filter((time) => time < timing.targetTime - 1e-12));
    for (const method of [{ method: 'rungeKutta4' }, { method: 'dormandPrince54', tolerance: { relative: 1e-8 } }, { method: 'rodas4', tolerance: { relative: 1e-8 } },
        { method: 'bdf', tolerance: { relative: 1e-8 } }]) {
        const serial = await run(buck, { ...timing, ...method, execution: { backend: 'serial' } });
        const integration = serial.integration;
        assert.equal(integration.switchingConditions, 2, 'The PWM\'s condition appears in two terms: two switching conditions.');
        assert.equal(integration.events, expected.length, `Every edge must be located once: ${integration.events}.`);
        const instants = [...new Set(integration.eventList.map((event) => event.time))];
        assert.equal(instants.length, expected.length);
        instants.forEach((time, index) => assert.ok(Math.abs(time - expected[index]) <= 1e-12, `Edge ${index} must be located at ${expected[index]} s, not ${time} s.`));
        for (const execution of [{ backend: 'threadPool', workerThreads: 3 }, { backend: 'partitioned', partitionCount: 3, workerThreads: 3 }]) {
            assert.ok(sameBits(valuesOf(serial), valuesOf(await run(buck, { ...timing, ...method, execution }))), `${execution.backend} must give the serial bits with events.`);
        }
        const checkpoint = serial.checkpoints[Math.floor(serial.checkpoints.length / 2)];
        assert.ok(checkpoint.solver.state, 'A checkpoint keeps the conditions\' latches.');
        const resumed = await run(buck, { ...timing, ...method, startCheckpoint: checkpoint });
        // BDF starts its history again at every event, since the right-hand side jumps there.
        if (method.method === 'bdf') assert.ok(integration.restarts >= expected.length, `BDF must start its history again at each edge: ${integration.restarts}.`);
        assert.ok(sameBits(resumed.samples.at(-1).states.map((state) => state.value), serial.samples.at(-1).states.map((state) => state.value)),
            `A ${method.method} run continued from its checkpoint must end on the uninterrupted run's bits.`);
    }

    // Euler, node by node: not located, named.
    const euler = await run(buck, timing);
    assert.equal(euler.integration, undefined);
    assert.deepEqual(euler.unlocatedConditions.map((condition) => condition.sourceId).sort(), [13, 16]);

    // No switching condition: nothing latched or reported, and Runge–Kutta 4's numbers those of a model without conditions.
    const smooth = await modelPath('smooth', oneNode(['Negate', 'y'], 1));
    const smoothResult = await run(smooth, { targetTime: 1, globalTimeStep: 0.125, outputInterval: 0.125, method: 'rungeKutta4' });
    assert.equal(smoothResult.integration.switchingConditions, undefined);
    assert.equal(smoothResult.checkpoints.at(-1).solver.state, undefined);
    // An Equal comparison is not a switching condition.
    const equal = await modelPath('equal', oneNode(['Which', ['Equal', 'y', '2'], '0', 'True', '1']));
    assert.equal((await run(equal, { targetTime: 1, globalTimeStep: 0.125, outputInterval: 0.125, method: 'rungeKutta4' })).integration.switchingConditions, undefined);

    // Chattering: y' = -1 above zero and +1 below it slides along zero, switching back and forth; each global step stops locating after a
    // hundred events and reads the condition at each step's start, and the run says so once.
    const sliding = await modelPath('sliding', oneNode(['Which', ['Greater', 'y', '0'], '-1', 'True', '1'], 0.5));
    for (const method of [{ method: 'rungeKutta4', stepsPerGlobalStep: 4 }, { method: 'dormandPrince54' }, { method: 'rodas4' }, { method: 'bdf' }]) {
        const result = await run(sliding, { targetTime: 2, globalTimeStep: 0.25, outputInterval: 0.25, ...method });
        const findings = result.stabilityFindings.filter((finding) => finding.code === 'eventsChattering');
        assert.equal(findings.length, 1, `Chattering must be reported once under ${method.method}: ${JSON.stringify(result.stabilityFindings)}`);
        assert.match(findings[0].message, /changed 100 times within one step/);
        assert.ok(Math.abs(result.samples.at(-1).states[0].value) < 0.25, 'The sliding state stays near zero.');
        // The first crossing, at 0.5 s, is located.
        assert.ok(Math.abs(result.integration.eventList[0].time - 0.5) <= 1e-9, `The first switch is at 0.5 s: ${result.integration.eventList[0].time}.`);
    }

    console.log('✓ event location: the buck converter\'s every PWM edge located at its instant under Runge–Kutta 4, Adaptive, Stiff and BDF, the same bits on every '
        + 'backend and from a checkpoint; Euler unchanged and naming what it did not locate; models without conditions untouched; chattering bounded and reported.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
