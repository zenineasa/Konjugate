/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Describe program (docs/proposals/codeEditor.md, stage 4, the Ports panel), through the real engines:
//   - the PID and Conduction examples described by the desktop engine and by the WebAssembly engine (through
//     src/webEngineAdapter.mjs, with the Pyodide in node_modules) give the same JSON;
//   - each port, memory field and clock carries the line that declares it, in C++ (found in the source) and in Python (said by the SDK);
//     memory shows its value after initialize(), and a clock its period;
//   - a bound port's conversion is the one a run applies (°C to K at an input, W to kW at an output into an Update state, a rate's unit
//     per second without an offset), an incompatible unit is said as an error, and a problem carries its line;
//   - src/programPortUnits.mjs, which the Ports panel uses without asking the engine, gives the engine's conversion for every pair of a
//     sweep of units, number for number.
//
// Run manually (after `npm run build:engine` and `npm run build:web:threads` or `npm run build:web`):
//   node tests/engine/programDescription.mjs [path/to/konjugateEngine] [path/to/konjugateEngine.js]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inputPortConversion, outputPortConversion } from '../../src/programPortUnits.mjs';
import { describeProgramWithWebEngine } from '../../src/webEngineAdapter.mjs';
import { setPythonProviderSources } from '../../src/webPythonProviderBridge.mjs';

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

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramDescription-'));
let calls = 0;

// The desktop's answer, as src/engineAdapter.mjs's describeProgramWithEngine() asks for it.
async function nativeDescribe({ kind, source, inputs = {}, ports = {} }) {
    const index = calls++;
    const sourcePath = join(directory, `program${index}.${kind === 'cpp' ? 'cpp' : 'py'}`);
    const configurationPath = join(directory, `describe${index}.json`);
    const reportPath = join(directory, `describe${index}.report.json`);
    await writeFile(sourcePath, source);
    await writeFile(configurationPath, JSON.stringify({ kind, providers, inputs, ports }));
    const { code, diagnostics } = await new Promise((resolve, reject) => {
        const child = spawn(executable, ['describeProgram', sourcePath, '--configuration', configurationPath, '--report', reportPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let text = '';
        child.stderr.on('data', (chunk) => { text += chunk; });
        child.once('error', reject);
        child.once('exit', (exitCode) => resolve({ code: exitCode, diagnostics: text }));
    });
    assert.equal(code, 0, `The desktop engine must answer: ${diagnostics}`);
    return JSON.parse(await readFile(reportPath, 'utf8'));
}

async function webDescribe(request) {
    const { available, ...answer } = await describeProgramWithWebEngine(engineModuleUrl, request);
    assert.equal(available, true);
    return answer;
}

// A line's number in a source: the first line holding `text`.
const lineOf = (source, text) => source.split('\n').findIndex((line) => line.includes(text)) + 1;

try {
    const pidPorts = { inputs: { measurement: '°C', setpoint: 'Pa', kp: 'W/K' }, outputs: { power: { unit: 'kW', rate: false } } };
    const pidPython = await example('pidController.py');
    const pidCpp = await example('pidController.cpp');
    const conductionPython = await example('conduction.py');
    const conductionPorts = { inputs: { hot: '°C', cold: 'degF', conductance: 'W/K', capacity: 'kJ/K' }, outputs: { warming: { unit: '°C', rate: true } } };

    // The web engine gives the desktop's answer.
    const cases = [
        ['the PID controller', { kind: 'python', source: pidPython, inputs: { kp: 50 }, ports: pidPorts }],
        ['Conduction', { kind: 'python', source: conductionPython, inputs: {}, ports: conductionPorts }],
        ['Conduction with nothing bound', { kind: 'python', source: conductionPython }],
        ['a misspelt port', { kind: 'python', source: conductionPython.replace('x.capacity', 'x.capactiy') }]
    ];
    const answers = {};
    for (const [what, request] of cases) {
        const desktop = await nativeDescribe(request);
        const web = await webDescribe(request);
        assert.equal(JSON.stringify(web), JSON.stringify(desktop), `${what}: the web engine must give the desktop's answer.`);
        answers[what] = desktop;
    }

    // The PID controller, in both languages: its ports, memory and clock, with their lines.
    for (const [kind, source, clockText] of [['python', pidPython, 'clock = Clock'], ['cpp', pidCpp, 'k::Clock clock']]) {
        const answer = kind === 'python' ? answers['the PID controller'] : await nativeDescribe({ kind, source, inputs: { kp: 50 }, ports: pidPorts });
        const declared = (name) => (kind === 'python' ? source.split('\n').findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line)) + 1 : lineOf(source, `"${name}"`));
        assert.equal(answer.ok, true, `${kind}: ${JSON.stringify(answer.problems)}`);
        assert.equal(answer.language, kind);
        assert.equal(answer.program, 'PidController');
        assert.equal(answer.kind, 'node');
        assert.deepEqual(answer.inputs.map((port) => [port.key, port.kind, port.unit]), [
            ['measurement', 'input', 'K'], ['setpoint', 'parameter', 'K'], ['kp', 'constant', 'W/K'], ['ki', 'constant', 'W/(K*s)'],
            ['kd', 'constant', 'W*s/K'], ['maxPower', 'constant', 'W'], ['sensorNoise', 'constant', 'K']
        ]);
        const attribute = (key) => (kind === 'python' ? key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`) : key);
        for (const port of answer.inputs) assert.equal(port.line, declared(attribute(port.key)), `${kind}: the line of ${port.key}`);
        assert.equal(answer.inputs.at(-1).default, 0);
        assert.deepEqual(answer.inputs[0].conversion, { scale: 1, offset: 273.15, identity: false, text: '°C → K at the port' });
        assert.deepEqual(answer.inputs[1].conversion, { error: 'Pa and K measure different kinds of quantity' });
        assert.deepEqual(answer.inputs[2].conversion, { scale: 1, offset: 0, identity: true, text: null });
        assert.equal(answer.inputs[3].conversion, undefined, 'A port nothing is said to be bound to has no conversion.');
        assert.deepEqual(answer.outputs, [{ key: 'power', unit: 'W', line: declared('power'), conversion: { scale: 0.001, offset: 0, identity: false, text: 'W → kW at the port' } }]);
        assert.deepEqual(answer.memory.map(({ name, type, unit, start, line }) => [name, type, unit, start, line]), [
            ['integral', 'real', 'K*s', [0], declared(kind === 'python' ? 'integral' : 'integral')],
            ['previousError', 'real', 'K', [0], declared(attribute('previousError'))],
            ['held', 'real', 'W', [0], declared('held')],
            ['noise', 'random', '', null, declared('noise')]
        ]);
        assert.deepEqual(answer.clock, { period: 0.01, constant: null, line: lineOf(source, clockText) });
        assert.deepEqual(answer.problems, []);
    }

    // Conduction: a relationship, a rate into a °C Rate state (K/s onto °C/s, no offset), and no clock or memory.
    {
        const answer = answers.Conduction;
        assert.equal(answer.kind, 'relationship');
        assert.deepEqual(answer.inputs.map((port) => [port.key, port.line, port.conversion.text]),
            [['hot', lineOf(conductionPython, 'hot = '), '°C → K at the port'], ['cold', lineOf(conductionPython, 'cold = '), 'degF → K at the port'],
                ['conductance', lineOf(conductionPython, 'conductance = '), null], ['capacity', lineOf(conductionPython, 'capacity = '), 'kJ/K → J/K at the port']]);
        assert.deepEqual(answer.outputs[0].conversion, { scale: 1, offset: 0, identity: true, text: null });
        assert.equal(answer.inputs[3].conversion.scale, 1000);
        assert.deepEqual([answer.memory, answer.clock], [[], null]);
        assert.ok(answers['Conduction with nothing bound'].inputs.every((port) => !('conversion' in port)));
    }

    // Problems carry their lines: a Python program that reads a port it does not declare, and a C++ program that does not compile.
    {
        const misspelt = answers['a misspelt port'];
        assert.equal(misspelt.ok, false);
        assert.equal(misspelt.problems[0].line, lineOf(conductionPython, 'x.capacity'));
        assert.match(misspelt.problems[0].message, /reads 'capactiy'/);
        const broken = await nativeDescribe({ kind: 'cpp', source: pidCpp.replace('x[setpoint] - measured', 'x[setpont] - measured') });
        assert.equal(broken.ok, false);
        assert.equal(broken.problems[0].line, lineOf(pidCpp, 'x[setpoint] - measured'));
        assert.deepEqual([broken.program, broken.inputs, broken.clock], ['', [], null]);
        const web = await webDescribe({ kind: 'cpp', source: pidCpp });
        assert.ok(!web.ok && /The web edition cannot compile a C\+\+ program\. Check this C\+\+ program in the desktop app\./.test(web.problems[0].message), 'The web engine says why it cannot describe C++.');
        // A declaration in a comment is not taken for the real one.
        const commented = pidCpp.replace('class PidController', '// k::Input measurement{this, "measurement", "K"};\nclass PidController');
        assert.equal((await nativeDescribe({ kind: 'cpp', source: commented })).inputs[0].line, lineOf(commented, 'k::Input     measurement'));
    }

    // The page's conversions are the engine's: every ordered pair of a sweep of units, at an input and at an output into a Rate and
    // an Update state.
    {
        const units = ['K', '°C', 'degF', '°R', 'C', 'W', 'kW', 'hp', 'W/K', 'J/K', 'kJ/K', 'Pa', 'kPa', 'bar', 'psi', 'mmHg', 'm', 'ft', 'in', 'mm',
            's', 'min', 'h', 'Hz', 'rpm', 'rad/s', 'rad', '°', 'rev', '', '%', 'ppm', 'J', 'Wh', 'BTU', 'W/(m*K)', 'm3/h', 'L/min', 'kg/s', 'N', 'lbf',
            'm/s', 'km/h', 'K/s', '°C/s', 'furlongs'];
        const pairs = units.flatMap((from) => units.map((to) => [from, to]));
        const quote = (text) => JSON.stringify(text);
        const source = ['from konjugate.v2 import Input, Node, Output', '', 'class Sweep(Node):',
            ...pairs.map(([, to], index) => `    p${index} = Input(${quote(to)}, default=0)`),
            ...pairs.map(([from], index) => `    o${index} = Output(${quote(from)})`),
            '', '    def evaluate(self, t, x):', `        return self.outputs(${pairs.map((_, index) => `o${index}=0.0`).join(', ')})`, ''].join('\n');
        for (const rate of [true, false]) {
            const ports = {
                inputs: Object.fromEntries(pairs.map(([from], index) => [`p${index}`, from])),
                outputs: Object.fromEntries(pairs.map(([, to], index) => [`o${index}`, { unit: to, rate }]))
            };
            const answer = await nativeDescribe({ kind: 'python', source, ports });
            assert.equal(answer.ok, true, JSON.stringify(answer.problems));
            for (const [index, [from, to]] of pairs.entries()) {
                assert.deepEqual(inputPortConversion(from, to), answer.inputs[index].conversion, `An input in ${to} bound to ${from}.`);
                assert.deepEqual(outputPortConversion(from, { unit: to, rate }), answer.outputs[index].conversion, `An output in ${from} into a ${rate ? 'Rate' : 'Update'} state in ${to}.`);
            }
        }
    }
    console.log('Describe program gives each port, memory field and clock with its line and conversion, alike on the desktop, the web and the page.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
// Pyodide and the engine's threads keep Node alive.
process.exit(0);
