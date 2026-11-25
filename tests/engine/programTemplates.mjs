/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Every program Konjugate offers passes Check program (docs/proposals/codeEditor.md, stage 9), through the real engines:
//   - each template the app writes (src/providerTemplate.mjs: a relationship, a relationship with several outputs, a node, a sampled
//     controller; blank and filled in from bindings), in C++ and Python;
//   - each version 2 example in examples/providers, found by its source, so an example added there is checked without a change here;
//   - each older (version 1) program the app ships (examples/providers, the component library, the example projects), once Convert has
//     brought it to version 2, as the code editor offers Test only after Convert; a conversion the converter calls incomplete (state kept
//     by hand, a step size read in evaluate()) is left for the person to finish, and must say what is left in its notes;
//   - a Python one also in the WebAssembly engine (src/webEngineAdapter.mjs, with the Pyodide in node_modules), with the desktop's answer.
// Each is checked with every input that has no default at 1 (0 would divide by zero in Conduction), through the inputs Describe
// program reads.
//
// Run manually (after `npm run build:engine` and `npm run build:web:threads` or `npm run build:web`):
//   node tests/engine/programTemplates.mjs [path/to/konjugateEngine] [path/to/konjugateEngine.js]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertProgramToVersion2 } from '../../src/programConversion.mjs';
import { decodeProjectFile } from '../../src/projectFile.mjs';
import { defaultNodeProviderSource, defaultProviderSource, programSourceVersion, sampledControllerSource } from '../../src/providerTemplate.mjs';
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

const pyodideDirectory = join(root, 'node_modules', 'pyodide');
setPythonProviderSources({
    importPyodide: () => import(pathToFileURL(join(pyodideDirectory, 'pyodide.mjs')).href),
    indexURL: `${pyodideDirectory}/`,
    readSdkFile: (fileName) => readFile(join(root, 'engine', 'sdk', 'python', 'konjugate', fileName), 'utf8')
});

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramTemplates-'));
let calls = 0;

async function engineCommand(command, { kind, source, ...configuration }) {
    const index = calls++;
    const sourcePath = join(directory, `program${index}.${kind === 'cpp' ? 'cpp' : 'py'}`);
    const configurationPath = join(directory, `check${index}.json`);
    const reportPath = join(directory, `check${index}.report.json`);
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

// Every program an implementation in a document holds, with where it is.
function programsIn(document, where) {
    const found = [];
    const walk = (value, path) => {
        if (!value || typeof value !== 'object') return;
        if ((value.kind === 'python' || value.kind === 'cpp') && typeof value.source === 'string') found.push([`${where}${path}`, value.kind, value.source]);
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    };
    walk(document, '');
    return found;
}

try {
    const programs = [];
    // The templates, as the card and the editor write them, in both languages.
    const bindings = [{ key: 'sourceTemperature' }, { key: 'conductance' }];
    for (const kind of ['python', 'cpp']) {
        programs.push(
            [`a blank relationship (${kind})`, kind, defaultProviderSource(kind)],
            [`a relationship from its bindings (${kind})`, kind, defaultProviderSource(kind, bindings, 'gradient', 'Thermal coupling')],
            [`a relationship titled from a digit (${kind})`, kind, defaultProviderSource(kind, bindings, 'flow', '3-way valve')],
            [`a relationship with two outputs (${kind})`, kind, defaultProviderSource(kind, bindings, '', 'Heat and work', [{ key: 'heat' }, { key: 'work' }])],
            [`a blank node (${kind})`, kind, defaultNodeProviderSource(kind)],
            [`a node from its bindings (${kind})`, kind, defaultNodeProviderSource(kind, [{ key: 'temperature' }, { key: 'setpoint' }], [{ key: 'power' }, { key: 'valve' }], 'Heater')],
            [`a blank sampled controller (${kind})`, kind, sampledControllerSource(kind)],
            [`a sampled controller from its bindings (${kind})`, kind, sampledControllerSource(kind, [{ key: 'measurement' }, { key: 'setpoint' }], [{ key: 'power' }], 'Room controller', 0.05)]
        );
    }
    // The examples, version 2 as they are and older ones converted; the component library's and the example projects' programs.
    const older = [];
    const examples = join(root, 'examples', 'providers');
    for (const name of (await readdir(examples)).sort()) {
        const kind = name.endsWith('.py') ? 'python' : name.endsWith('.cpp') ? 'cpp' : null;
        if (kind) {
            const source = await readFile(join(examples, name), 'utf8');
            (programSourceVersion(kind, source) === 2 ? programs : older).push([`examples/providers/${name}`, kind, source]);
        } else if (name.endsWith('.json')) {
            older.push(...programsIn(JSON.parse(await readFile(join(examples, name), 'utf8')), `examples/providers/${name}`));
        }
    }
    const library = join(root, 'assets', 'componentLibrary');
    for (const name of (await readdir(library)).filter((file) => file.endsWith('.json')).sort()) {
        older.push(...programsIn(JSON.parse(await readFile(join(library, name), 'utf8')), `assets/componentLibrary/${name}`));
    }
    for (const name of (await readdir(join(root, 'examples'))).filter((file) => file.endsWith('.kjt')).sort()) {
        older.push(...programsIn(JSON.parse(await decodeProjectFile(await readFile(join(root, 'examples', name)))), `examples/${name}`));
    }
    const unfinished = [];
    for (const [where, kind, source] of older) {
        if (programSourceVersion(kind, source) === 2) {
            programs.push([where, kind, source]);
            continue;
        }
        const converted = convertProgramToVersion2(kind, source);
        if (converted.complete) programs.push([`${where}, converted`, kind, converted.source]);
        else {
            assert.ok(converted.notes.length > 0, `${where}: an incomplete conversion says what is left to do.`);
            unfinished.push(where);
        }
    }
    assert.ok(programs.filter(([where]) => where.startsWith('examples/providers/') && !where.endsWith('converted')).length >= 4, 'The version 2 examples are found.');
    assert.ok(programs.some(([where]) => where.endsWith('converted')), 'The older programs are found.');

    const failures = [];
    for (const [where, kind, source] of programs) {
        const described = await engineCommand('describeProgram', { kind, source });
        const inputs = Object.fromEntries((described.inputs ?? []).filter((port) => !('default' in port)).map((port) => [port.key, 1]));
        const desktop = await engineCommand('checkProgram', { kind, source, inputs, time: 0 });
        if (!desktop.ok) failures.push(`${where}: ${desktop.problems.join(' ')}`);
        if (kind === 'python') {
            const { available, ...web } = await checkProgramWithWebEngine(engineModuleUrl, { kind, source, inputs, time: 0 });
            assert.equal(available, true);
            assert.equal(JSON.stringify(web), JSON.stringify(desktop), `${where}: the web engine must give the desktop's answer.`);
        }
    }
    assert.deepEqual(failures, [], 'Every template and example passes Check program.');
    console.log(`Every template and example passes Check program (${programs.length} programs), alike on the desktop and the web.` +
        (unfinished.length ? ` Left to the person after Convert: ${unfinished.join(', ')}.` : ''));
} finally {
    await rm(directory, { recursive: true, force: true });
}
// Pyodide and the engine's threads keep Node alive.
process.exit(0);
