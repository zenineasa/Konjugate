/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The comparisons' runners (benchmarks/comparisons/scipyRunner.py, julia/juliaRunner.jl) speak JSON lines to compare.mjs on their stdout
// and run the quiet check (benchmarks/lib/quiet.mjs --wait) as a child before every timed run. A timed session once stopped when that
// child printed "[quiet] not quiet ..." onto the protocol pipe. These check, without the engine or the tools, that nothing the quiet check
// says reaches stdout, that a wait is not a failure, that the runner keeps a child's output off its stdout, and that compare.mjs's side
// survives a stray line all the same.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { protocolMessage, startServer } from '../benchmarks/comparisons/runnerServer.mjs';
import { electronProcesses } from '../benchmarks/lib/quiet.mjs';

const root = join(import.meta.dirname, '..');
const quietModule = pathToFileURL(join(root, 'benchmarks', 'lib', 'quiet.mjs')).href;
const noisyQuietCommand = `console.log('[quiet] not quiet before a timed run: other processes using 1.07 cores (limit 1.01)');
console.log('[quiet] ready after 1 s (load 1.00 1.00 1.00)');`;

function scratch(t) {
    const directory = mkdtempSync(join(tmpdir(), 'konjugate-quiet-pipe-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('only a JSON object on a runner\'s stdout is a protocol message', () => {
    assert.deepEqual(protocolMessage('{"records":[]}'), { records: [] });
    assert.equal(protocolMessage('[quiet] not quiet before a timed run: other processes using 1.07 cores (limit 1.01)'), null);
    assert.equal(protocolMessage('[1, 2]'), null);
    assert.equal(protocolMessage('{ not json'), null);
    assert.equal(protocolMessage(''), null);
});

test('the protocol survives a noisy quiet command that prints onto the runner\'s stdout', async (t) => {
    const directory = scratch(t);
    const noisy = join(directory, 'noisyQuiet.mjs');
    writeFileSync(noisy, noisyQuietCommand);
    // A runner that makes the old mistake: its quiet command inherits its stdout, the protocol pipe.
    const runner = join(directory, 'runner.mjs');
    writeFileSync(runner, `import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line);
    spawnSync(process.execPath, [${JSON.stringify(noisy)}], { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log(JSON.stringify({ records: [{ method: command.method, ok: true }] }));
}`);
    const server = await startServer(process.execPath, [runner]);
    t.after(() => server.stop());
    assert.equal(server.hello.ready, true);
    for (const method of ['BDF', 'Radau']) assert.deepEqual((await server.ask({ method })).records, [{ method, ok: true }]);
});

test('the quiet gate says nothing on stdout, and a wait before a timed run is not a failure', (t) => {
    const directory = scratch(t);
    const script = join(directory, 'gate.mjs');
    writeFileSync(script, `import { createQuietGate } from ${JSON.stringify(quietModule)};
let calls = 0;
const check = () => (calls++ === 0 ? ['other processes using 1.07 cores (limit 1.01)'] : []);
const gate = createQuietGate({ check, holdSeconds: 0.05, sampleEvery: 0.02 });
await gate.beforeTimedRun('SciPy BDF robertson rtol 1e-07');
const summary = gate.summary();
if (summary.quickFailures !== 1 || summary.fullGates !== 1) throw new Error(JSON.stringify(summary));`);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, KONJUGATE_QUIET_LOG: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[quiet\] not quiet before a timed run \(SciPy BDF robertson rtol 1e-07\)/);
    assert.match(result.stderr, /\[quiet\] ready for SciPy BDF robertson rtol 1e-07/);
});

test('the SciPy runner keeps its quiet command off the protocol pipe and fails a timed run only on a refusal', (t) => {
    const python = ['python3', 'python'].find((name) => spawnSync(name, ['--version']).status === 0);
    if (!python) return t.skip('no Python on this computer');
    const directory = scratch(t);
    const noisy = join(directory, 'noisyQuiet.mjs');
    writeFileSync(noisy, noisyQuietCommand);
    const refusing = join(directory, 'refusingQuiet.mjs');
    writeFileSync(refusing, `console.log('[quiet] refused'); process.exitCode = 2;`);
    // The runner's own quiet() and QuietCheckFailed, taken from scipyRunner.py without its NumPy and SciPy imports.
    const harness = join(directory, 'harness.py');
    writeFileSync(harness, `import ast, json, os, shlex, subprocess, sys
source = open(sys.argv[1]).read()
tree = ast.parse(source)
wanted = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in ('quiet', 'QuietCheckFailed')]
exec(compile(ast.Module(body=wanted, type_ignores=[]), sys.argv[1], 'exec'))
print(json.dumps({'ready': True}), flush=True)
quiet(sys.argv[2])
print(json.dumps({'records': [{'ok': True}]}), flush=True)
try:
    quiet(sys.argv[3])
    print(json.dumps({'refused': False}), flush=True)
except QuietCheckFailed as error:
    print(json.dumps({'refused': True, 'error': str(error)}), flush=True)
`);
    const quote = (path) => `'${path.replaceAll("'", "'\\''")}'`;
    const result = spawnSync(python, ['-I', harness, join(root, 'benchmarks', 'comparisons', 'scipyRunner.py'),
        `${quote(process.execPath)} ${quote(noisy)}`, `${quote(process.execPath)} ${quote(refusing)}`], { encoding: 'utf8', stdin: 'ignore' });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    for (const line of lines) assert.ok(protocolMessage(line), `not a protocol line: ${line}`);
    assert.deepEqual(lines.map((line) => JSON.parse(line)).slice(0, 2), [{ ready: true }, { records: [{ ok: true }] }]);
    const refusal = JSON.parse(lines[2]);
    assert.equal(refusal.refused, true);
    assert.match(refusal.error, /quiet check before the timed run failed \(exit 2\)/);
    assert.match(result.stderr, /\[quiet\] not quiet before a timed run/);
});

test('the Julia runner sends its quiet command\'s output to stderr', () => {
    const source = readFileSync(join(root, 'benchmarks', 'comparisons', 'julia', 'juliaRunner.jl'), 'utf8');
    assert.match(source, /function quietCheck\(command\)[\s\S]*?run\(pipeline\(ignorestatus\(Cmd\(.*\)\); stdin = devnull, stdout = stderr, stderr = stderr\)\)/);
    assert.match(source, /isempty\(quiet\) \|\| quietCheck\(quiet\)/);
    assert.doesNotMatch(source, /\brun\(Cmd\(String\.\(split\(quiet\)\)\)\)/);
});

test('the preflight ignores crash reporters and names what a quit Electron application left behind', () => {
    const home = process.env.HOME ?? '/Users/someone';
    const table = [
        { pid: 11, ppid: 1, cpu: 0, command: '/Applications/Antigravity.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --monitor-self' },
        { pid: 12, ppid: 1, cpu: 0, command: '/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=x' },
        { pid: 13, ppid: 1, cpu: 0, command: `${home}/.gemini/bin/agy --hub --electron /Applications/Antigravity.app/Contents/Frameworks/Electron Framework.framework` },
        { pid: 20, ppid: 1, cpu: 0, command: '/Applications/Slack.app/Contents/MacOS/Slack' },
        { pid: 21, ppid: 20, cpu: 0, command: '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper --type=gpu-process --x=Electron Framework.framework' },
        { pid: 30, ppid: 1, cpu: 0, command: '/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao daemon' }
    ];
    const paths = new Map([
        [11, '/Applications/Antigravity.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'],
        [12, '/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'],
        [13, `${home}/.gemini/bin/agy`],
        [20, '/Applications/Slack.app/Contents/MacOS/Slack'],
        [21, '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper'],
        [30, '/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao']
    ]);
    const { applications, leftovers } = electronProcesses(table, new Set(), paths);
    assert.deepEqual(applications, ['Slack']);
    assert.deepEqual(leftovers, ['~/.gemini/bin/agy (pid 13)', '/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao (pid 30)']);
});
