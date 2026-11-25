/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Check program in the web engine (docs/proposals/codeEditor.md, stage 1): the WebAssembly engine, driven through
// src/webEngineAdapter.mjs's checkProgramWithWebEngine() with the Pyodide in node_modules serving Python, gives exactly the desktop
// engine's answer, the same JSON, for the PID and Conduction examples, and for programs that fail a check. A C++ program cannot be
// loaded in the web engine yet, and it says so as a problem rather than stopping.
//
// Run manually (after `npm run build:engine` and `npm run build:web:threads` or `npm run build:web`):
//   node tests/engine/webCheckProgram.mjs [path/to/konjugateEngine] [path/to/konjugateEngine.js]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkProgramWithWebEngine } from '../../src/webEngineAdapter.mjs';
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

const directory = await mkdtemp(join(tmpdir(), 'konjugateWebCheckProgram-'));
let checks = 0;

// The desktop's answer: the engine's checkProgram command, as src/engineAdapter.mjs's checkProgramWithEngine() runs it.
async function nativeCheck({ kind, source, inputs, time }) {
    const index = checks++;
    const sourcePath = join(directory, `check${index}.${kind === 'cpp' ? 'cpp' : 'py'}`);
    const configurationPath = join(directory, `check${index}.json`);
    const reportPath = join(directory, `check${index}.report.json`);
    await writeFile(sourcePath, source);
    await writeFile(configurationPath, JSON.stringify({ kind, providers, inputs, time }));
    const { code, diagnostics } = await new Promise((resolve, reject) => {
        const child = spawn(executable, ['checkProgram', sourcePath, '--configuration', configurationPath, '--report', reportPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let text = '';
        child.stderr.on('data', (chunk) => { text += chunk; });
        child.once('error', reject);
        child.once('exit', (exitCode) => resolve({ code: exitCode, diagnostics: text }));
    });
    assert.equal(code, 0, `The desktop engine must answer: ${diagnostics}`);
    return JSON.parse(await readFile(reportPath, 'utf8'));
}

async function webCheck(request) {
    const { available, ...answer } = await checkProgramWithWebEngine(engineModuleUrl, request);
    assert.equal(available, true);
    return answer;
}

try {
    const pidInputs = { kp: 50, ki: 5, kd: 1, maxPower: 2000, sensorNoise: 0.1, measurement: 290, setpoint: 293.15 };
    const conductionInputs = { hot: 350, cold: 290, conductance: 12.5, capacity: 4180 };
    const misspelt = (await example('conduction.py')).replace('x.capacity', 'x.capactiy');
    const unfinished = (await example('conduction.py')).replace('return x.conductance', 'return float("nan") * x.conductance');
    const cases = [
        ['the PID controller', { kind: 'python', source: await example('pidController.py'), inputs: pidInputs, time: 0 }],
        ['the PID controller at a later time, its inputs defaulted', { kind: 'python', source: await example('pidController.py'), inputs: { kp: 2 }, time: 1.25 }],
        ['Conduction', { kind: 'python', source: await example('conduction.py'), inputs: conductionInputs, time: 0 }],
        ['a misspelt port', { kind: 'python', source: misspelt, inputs: conductionInputs, time: 0 }],
        ['an output that is not a number', { kind: 'python', source: unfinished, inputs: conductionInputs, time: 0 }]
    ];
    for (const [what, request] of cases) {
        const desktop = await nativeCheck(request);
        const web = await webCheck(request);
        assert.deepEqual(web, desktop, `${what}: the web engine must give the desktop's answer.`);
        assert.equal(JSON.stringify(web), JSON.stringify(desktop), `${what}: the same JSON, key for key.`);
    }
    // The cases above do what they say.
    assert.ok((await webCheck(cases[0][1])).ok, 'The PID controller passes.');
    assert.ok((await webCheck(cases[2][1])).ok, 'Conduction passes.');
    assert.ok(!(await webCheck(cases[3][1])).ok, 'A misspelt port fails.');
    assert.ok(!(await webCheck(cases[4][1])).ok, 'An output that is not a number fails.');

    // The desktop checks C++; the web engine cannot load a C++ program yet, and answers with the reason.
    for (const [file, inputs] of [['pidController.cpp', pidInputs], ['conduction.cpp', conductionInputs]]) {
        assert.ok((await nativeCheck({ kind: 'cpp', source: await example(file), inputs, time: 0 })).ok, `The desktop passes ${file}.`);
        const web = await webCheck({ kind: 'cpp', source: await example(file), inputs, time: 0 });
        assert.ok(!web.ok && /The web edition cannot compile a C\+\+ program\. Check this C\+\+ program in the desktop app\./.test(web.problems[0]), `The web engine says why it cannot check ${file}: ${web.problems}`);
    }
    console.log('Check program in the web engine gives the desktop engine\'s answer.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
// Pyodide and the engine's threads keep Node alive.
process.exit(0);
