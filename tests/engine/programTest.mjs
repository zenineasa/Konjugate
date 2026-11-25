/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Test (docs/proposals/codeEditor.md, stage 6), through the real engines:
//   - the PID example's trace over 10 steps, in C++ and in Python, equals to the bit what the program SDK's harness gives driven the
//     same way (testing.hpp compiled here; konjugate.v2.testing in Python): every output and every memory value at every step;
//   - the WebAssembly engine (through src/webEngineAdapter.mjs, with the Pyodide in node_modules) gives the desktop engine's answer;
//   - a program without a clock steps at the size asked, a NaN part way names its step, its time and its output's line, and a problem
//     the program raises names its line; each standard check says whether it passed, failed or did not run;
//   - Check program's answer is unchanged by Test's extra keys.
//
// Run manually (after `npm run build:engine` and `npm run build:web:threads` or `npm run build:web`):
//   node tests/engine/programTest.mjs [path/to/konjugateEngine] [path/to/konjugateEngine.js]

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { testProgramWithWebEngine } from '../../src/webEngineAdapter.mjs';
import { setPythonProviderSources } from '../../src/webPythonProviderBridge.mjs';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const webEngine = process.argv[3] ?? await (async () => {
    for (const directory of ['engineWebThreads', 'engineWeb']) {
        const path = join(root, 'out', directory, 'konjugateEngine.js');
        if (await access(path).then(() => true, () => false)) return path;
    }
    throw new Error('No web engine: run `npm run build:web:threads` or `npm run build:web` first.');
})();
const engineModuleUrl = pathToFileURL(webEngine).href;
const providers = { executionMode: 'inProcess', cpp: { sdkPath: join(root, 'engine') }, python: { sdkPath: join(root, 'engine', 'sdk', 'python') } };
const example = (name) => readFile(join(root, 'examples', 'providers', name), 'utf8');

const pyodideDirectory = join(root, 'node_modules', 'pyodide');
setPythonProviderSources({
    importPyodide: () => import(pathToFileURL(join(pyodideDirectory, 'pyodide.mjs')).href),
    indexURL: `${pyodideDirectory}/`,
    readSdkFile: (fileName) => readFile(join(root, 'engine', 'sdk', 'python', 'konjugate', fileName), 'utf8')
});

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramTest-'));
let calls = 0;

async function engineCommand(command, { kind, source, ...configuration }) {
    const index = calls++;
    const sourcePath = join(directory, `program${index}.${kind === 'cpp' ? 'cpp' : 'py'}`);
    const configurationPath = join(directory, `test${index}.json`);
    const reportPath = join(directory, `test${index}.report.json`);
    await writeFile(sourcePath, source);
    await writeFile(configurationPath, JSON.stringify({ kind, providers, ...configuration }));
    const { code, diagnostics } = await new Promise((resolve, reject) => {
        const child = spawn(executable, [command, sourcePath, '--configuration', configurationPath, '--report', reportPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let text = '';
        child.stderr.on('data', (chunk) => { text += chunk; });
        child.once('error', reject);
        child.once('exit', (exitCode) => resolve({ code: exitCode, diagnostics: text }));
    });
    assert.equal(code, 0, `The desktop engine must answer: ${diagnostics}`);
    return JSON.parse(await readFile(reportPath, 'utf8'));
}

async function webTest(request) {
    const { available, ...answer } = await testProgramWithWebEngine(engineModuleUrl, request);
    assert.equal(available, true);
    return answer;
}

// Every number the same double: an output and a memory value at each step. testing.hpp shows a random stream by its counter alone, where
// the trace shows its seed and counter: for those, `counterOnly`, the counter is compared.
function assertSameBits(actual, expected, what, counterOnly = []) {
    assert.equal(actual.length, expected.length, `${what}: the number of steps.`);
    for (const [index, row] of expected.entries()) {
        const got = actual[index];
        assert.ok(Object.is(got.time, row.time), `${what}, step ${index}: the time ${got.time} is not ${row.time}.`);
        for (const [key, value] of Object.entries(row.outputs)) assert.ok(Object.is(got.outputs[key], value), `${what}, step ${index}: ${key} = ${got.outputs[key]}, not ${value}.`);
        for (const [name, values] of Object.entries(row.memory)) {
            const traced = counterOnly.includes(name) ? got.memory[name].slice(1) : got.memory[name];
            assert.deepEqual(traced.map(String), values.map(String), `${what}, step ${index}: memory ${name}.`);
            values.forEach((value, at) => assert.ok(Object.is(traced[at], value), `${what}, step ${index}: memory ${name}[${at}].`));
        }
    }
}

// The harness driven as Test drives the engine: evaluate() at the start; then each step advance() (at a clock tick, at the start of the
// step) and evaluate().
const pythonHarness = (file, inputs, steps, size) => `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(root, 'engine', 'sdk', 'python'))})
import importlib.util
spec = importlib.util.spec_from_file_location("program", ${JSON.stringify(file)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from konjugate.v2.testing import Harness
h = Harness(module.PidController, constants=${JSON.stringify(inputs)}, seed=0, owner=1)
rows = []
def row(step, t):
    rows.append({"step": step, "time": t, "outputs": h.evaluate(t=t), "memory": {name: [float(v) for v in (value if isinstance(value, list) else [value])] for name, value in h.memory.items()}})
row(0, 0.0)
for step in range(1, ${steps} + 1):
    t = 0.0 + ${size} * (step - 1)
    h.advance(t, ${size})
    row(step, t)
print(json.dumps(rows))
`;

const cppHarness = (file, inputs, steps, size) => `
#include <konjugate/sdk/v2/testing.hpp>
#include "${file}"
#include <cstdio>
#include <string>

int main() {
    namespace t = konjugate::sdk::v2::testing;
    t::Harness<PidController> h{{.constants = {${Object.entries(inputs).map(([key, value]) => `{"${key}", ${value}}`).join(', ')}}, .seed = 0, .owner = 1}};
    std::string json = "[";
    const auto row = [&](int step, double at) {
        char buffer[64];
        const auto number = [&](double value) { std::snprintf(buffer, sizeof buffer, "%.17g", value); return std::string(buffer); };
        json += std::string(step ? "," : "") + "{\\"step\\":" + std::to_string(step) + ",\\"time\\":" + number(at) + ",\\"outputs\\":{\\"power\\":" +
            number(h.evaluate(at).at(0)) + "},\\"memory\\":{";
        bool first = true;
        for (const auto& [name, values] : h.memory()) {
            json += std::string(first ? "" : ",") + "\\"" + name + "\\":[";
            for (std::size_t index = 0; index < values.size(); ++index) json += (index ? "," : "") + number(values[index]);
            json += "]";
            first = false;
        }
        json += "}}";
    };
    row(0, 0.0);
    for (int step = 1; step <= ${steps}; ++step) {
        const double at = 0.0 + ${size} * (step - 1);
        h.advance(at, ${size});
        row(step, at);
    }
    std::puts((json + "]").c_str());
}
`;

try {
    const inputs = { kp: 50, ki: 5, kd: 1, maxPower: 2000, sensorNoise: 0.1, measurement: 290, setpoint: 293.15 };
    const size = 0.01;
    const steps = 10;

    // The PID, 10 steps, in each language: the engine's trace is the harness's, to the bit.
    for (const kind of ['python', 'cpp']) {
        const file = join(root, 'examples', 'providers', kind === 'python' ? 'pidController.py' : 'pidController.cpp');
        const answer = await engineCommand('testProgram', { kind, source: await readFile(file, 'utf8'), inputs, steps });
        assert.equal(answer.ok, true, `${kind}: ${answer.problems}`);
        assert.deepEqual(answer.checks, [{ name: 'ports', passed: true }, { name: 'outputs', passed: true }, { name: 'purity', passed: true },
            { name: 'memory', passed: true }, { name: 'jacobian', passed: null }]);
        assert.deepEqual([answer.trace.stepSize, answer.trace.clocked, answer.trace.rows.length], [size, true, steps + 1]);
        assert.ok(answer.trace.rows.at(-1).outputs.power > 0 && answer.trace.rows.at(-1).memory.noise[1] === 2 * steps, `${kind}: the controller acts, and draws noise.`);
        let expected;
        if (kind === 'python') {
            expected = JSON.parse((await run('python3', ['-c', pythonHarness(file, inputs, steps, size)])).stdout);
        } else {
            const harnessSource = join(directory, 'harness.cpp');
            const harness = join(directory, 'harness');
            await writeFile(harnessSource, cppHarness(file, inputs, steps, size));
            await run(process.env.CXX ?? 'c++', ['-std=c++20', '-O2', `-I${join(root, 'engine', 'include')}`, harnessSource, '-o', harness]);
            expected = JSON.parse((await run(harness)).stdout);
            // The harness lists memory by name, alphabetically; the trace in declaration order: the same fields either way.
            assert.deepEqual(Object.keys(answer.trace.rows[0].memory).sort(), Object.keys(expected[0].memory).sort());
        }
        assertSameBits(answer.trace.rows, expected, `The ${kind} PID against its SDK harness`, kind === 'cpp' ? ['noise'] : []);
        // Check program's answer is Test's without the extra keys.
        const { checks, problemDetails, trace, ...checked } = answer;
        assert.equal(JSON.stringify(await engineCommand('checkProgram', { kind, source: await readFile(file, 'utf8'), inputs, time: 0 })), JSON.stringify(checked));
    }

    // The web engine gives the desktop's answer, the PID's trace included.
    const conduction = await example('conduction.py');
    const nanLater = conduction.replace('return x.conductance', 'return (float("nan") if t > 0.025 else 1.0) * x.conductance');
    const raising = conduction.replace('return x.conductance', 'raise ValueError("too hot")\n        return x.conductance');
    const conductionInputs = { hot: 350, cold: 290, conductance: 12.5, capacity: 4180 };
    const cases = [
        ['the PID controller', { kind: 'python', source: await example('pidController.py'), inputs, steps }],
        ['the PID controller at a step of its own', { kind: 'python', source: await example('pidController.py'), inputs, steps: 3, stepSize: 0.05 }],
        ['Conduction, run once', { kind: 'python', source: conduction, inputs: conductionInputs }],
        ['Conduction stepped', { kind: 'python', source: conduction, inputs: conductionInputs, steps: 4, stepSize: 0.5 }],
        ['a NaN part way', { kind: 'python', source: nanLater, inputs: conductionInputs, steps: 5 }],
        ['a program that raises', { kind: 'python', source: raising, inputs: conductionInputs, steps: 2 }]
    ];
    const answers = {};
    for (const [what, request] of cases) {
        const desktop = await engineCommand('testProgram', request);
        const web = await webTest(request);
        assert.equal(JSON.stringify(web), JSON.stringify(desktop), `${what}: the web engine must give the desktop's answer.`);
        answers[what] = desktop;
    }
    assert.deepEqual(answers['the PID controller at a step of its own'].trace.rows.map((row) => row.time), [0, 0, 0.05, 0.1], 'A clock ticks at the start of each step asked for.');
    assert.deepEqual(answers['Conduction, run once'].trace.rows.map((row) => row.step), [0], 'Run once is one row.');
    {
        const { trace, checks } = answers['Conduction stepped'];
        assert.deepEqual([trace.clocked, trace.stepSize, trace.rows.map((row) => row.time)], [false, 0.5, [0, 0.5, 1, 1.5, 2]], 'Without a clock, each step ends a step of the size asked.');
        assert.deepEqual(checks.map((check) => check.passed), [true, true, true, null, null], 'Memory and the Jacobian did not run: there is neither.');
    }
    {
        const { ok, trace, problemDetails } = answers['a NaN part way'];
        assert.equal(ok, false);
        assert.equal(trace.rows.length, 3, 'The rows before the NaN are kept.');
        assert.equal(problemDetails.length, 1);
        const [problem] = problemDetails;
        assert.match(problem.message, /gave nan for ‘warming’ at t = 0\.03 s/);
        assert.deepEqual([problem.step, problem.time, problem.check, problem.line], [3, 0.03, null, nanLater.split('\n').findIndex((line) => line.includes('warming = ')) + 1]);
    }
    {
        const { ok, checks, problemDetails, trace } = answers['a program that raises'];
        assert.equal(ok, false);
        assert.deepEqual(checks.map((check) => check.passed), [true, false, null, null, null], 'The first evaluation failed: purity was never compared.');
        assert.equal(problemDetails[0].line, raising.split('\n').findIndex((line) => line.includes('raise ValueError')) + 1);
        assert.equal(problemDetails[0].check, 'outputs');
        assert.equal(trace, null, 'A program whose first evaluation fails is not traced.');
    }
    // A C++ problem's line is the line of the source as written: a compile error, and fail() part way through the trace.
    {
        const conductionCpp = await example('conduction.cpp');
        const lineOf = (source, text) => source.split('\n').findIndex((line) => line.includes(text)) + 1;
        const broken = conductionCpp.replace('x[capacity];', 'x[capactiy];');
        const compiled = await engineCommand('testProgram', { kind: 'cpp', source: broken, inputs: conductionInputs, steps: 2 });
        assert.deepEqual([compiled.ok, compiled.problemDetails[0].line, compiled.trace], [false, lineOf(broken, 'x[capactiy]'), null]);
        const failing = conductionCpp.replace('        return x[conductance]', '        if (t > 0.015) k::fail("too hot");\n        return x[conductance]')
            .replace('double evaluate(double, const k::Inputs& x)', 'double evaluate(double t, const k::Inputs& x)');
        const failed = await engineCommand('testProgram', { kind: 'cpp', source: failing, inputs: conductionInputs, steps: 3 });
        assert.equal(failed.ok, false, 'fail() part way stops the trace.');
        const [problem] = failed.problemDetails;
        assert.deepEqual([problem.line, problem.step, failed.trace.rows.length], [lineOf(failing, 'k::fail("too hot")'), 2, 2], `${problem.message}`);
    }
    // C++ is refused by the web engine, with the reason.
    const web = await webTest({ kind: 'cpp', source: await example('pidController.cpp'), inputs, steps: 2 });
    assert.ok(!web.ok && /The web edition cannot compile a C\+\+ program\. Check this C\+\+ program in the desktop app\./.test(web.problems[0]), `The web engine says why it cannot test C++: ${web.problems}`);
    console.log('Test traces a program step by step, to the bit of the SDK harness, alike on the desktop and the web.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
// Pyodide and the engine's threads keep Node alive.
process.exit(0);
