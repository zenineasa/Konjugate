/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The web edition's C++ providers (src/webCppProviderBridge.mjs). Wasmer's in-browser clang, fetched from its registry, is replaced
// by a sandbox of the test's own: it records what it is asked to compile, and answers with a real WebAssembly provider built from
// tests/fixtures/cppProvider/stubProvider.c (with providerWorker.cpp's exports and some of its WASI imports), or with clang's errors.
// So the bridge's own work is real: compiling each source once, instantiating the module with its WASI stand-ins, passing bytes in
// and out of its memory, and replaying a provider's failure to start. That the real providerWorker.cpp compiles and answers the
// protocol is checked in a real browser by the web interaction suite.
//
// The stand-in providers are built here, with the web edition's own compiler: the clang in the Emscripten SDK that
// `npm run setup:web` installs (.tools/emsdk), into out/testFixtures, again only when the C source is newer. Without that toolchain
// the tests that need them are skipped, saying so; with KONJUGATE_REQUIRE_WEB_TOOLCHAIN=1 (the web edition's CI job), they fail.
//
// The bridge keeps one toolchain and one cache for the page, so these tests run in order: the first checks a failed start is not kept.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ensureCppProvidersReady, installCppProviderBridge, runCppSyntaxCheck, setCppProviderSources } from '../src/webCppProviderBridge.mjs';

const root = join(import.meta.dirname, '..');
const providerSource = join(import.meta.dirname, 'fixtures', 'cppProvider', 'stubProvider.c');
const clang = join(root, '.tools', 'emsdk', 'upstream', 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');

// The two stand-ins, built from stubProvider.c (the second with -DFAIL_CREATE); null, with the reason, without the toolchain.
async function builtProviders() {
    if (!existsSync(clang)) {
        const reason = 'the web toolchain is not set up (npm run setup:web installs it)';
        if (process.env.KONJUGATE_REQUIRE_WEB_TOOLCHAIN === '1') throw new Error(`The C++ provider stand-ins cannot be built: ${reason}.`);
        return { skip: reason };
    }
    const directory = join(root, 'out', 'testFixtures', 'cppProvider');
    await mkdir(directory, { recursive: true });
    const build = async (name, defines) => {
        const output = join(directory, `${name}.wasm`);
        if (!existsSync(output) || statSync(output).mtimeMs < statSync(providerSource).mtimeMs) {
            await promisify(execFile)(clang, ['--target=wasm32', '-nostdlib', '-O2', '-Wl,--no-entry', ...defines, '-o', output, providerSource]);
        }
        return readFile(output);
    };
    return { stubProvider: await build('stubProvider', []), failingProvider: await build('failingProvider', ['-DFAIL_CREATE']) };
}
const { stubProvider, failingProvider, skip: needsProviders = false } = await builtProviders();

// What clang is asked to do, and the answers it gives: by the source, a provider that starts, one that does not, or errors.
const compiles = [];
const kills = [];
let sandboxFailures = 0;
let syntaxAnswer = { exitCode: 0, stderr: '' };
setCppProviderSources({
    async createSandbox() {
        if (sandboxFailures > 0) {
            sandboxFailures -= 1;
            throw new Error('Could not fetch the C++ provider SDK file \'providerWorker.cpp\'.');
        }
        return {
            command(program, args) {
                return {
                    async spawn(options) {
                        let source = '';
                        let killed = null;
                        const gone = new Promise((resolve) => { killed = resolve; });
                        return {
                            stdin: { write: async (bytes) => { source += new TextDecoder().decode(bytes); }, close: async () => {} },
                            // A check that never ends on its own (a compiler stuck on a large program) ends only when killed.
                            async kill() { kills.push(source); killed({ exitCode: 137, stdout: { bytes: new Uint8Array(0) }, stderr: { text: () => 'killed' } }); },
                            async wait() {
                                compiles.push({ program, args, options, source });
                                if (source === 'never ends') return gone;
                                if (args.includes('-fsyntax-only')) return { exitCode: syntaxAnswer.exitCode, stdout: { bytes: new Uint8Array(0) }, stderr: { text: () => syntaxAnswer.stderr } };
                                if (source.includes('does not compile')) return { exitCode: 1, stdout: { bytes: new Uint8Array(0) }, stderr: { text: () => '<stdin>:1:1: error: unknown type name \'does\'' } };
                                return { exitCode: 0, stdout: { bytes: source.includes('fails to start') ? failingProvider : stubProvider }, stderr: { text: () => '' } };
                            }
                        };
                    }
                };
            }
        };
    }
});

const documentWith = (...sources) => JSON.stringify({
    nodes: sources.map((source) => ({ implementation: { kind: 'cpp', source } })),
    edges: [{ implementation: { kind: 'cpp', source: sources[0] } }, { implementation: { kind: 'python', source: 'x = 1' } }]
});
const text = (bytes) => new TextDecoder().decode(bytes);
const ask = (Module, processKey, request) => Module.dispatchCppProviderBridge(processKey, new TextEncoder().encode(request));

test('a toolchain that could not be loaded is not kept, and its sources cannot be changed once it is', { skip: needsProviders }, async () => {
    sandboxFailures = 1;
    await assert.rejects(ensureCppProvidersReady({}, documentWith('// first\n')), /Could not fetch the C\+\+ provider SDK file/);
    await ensureCppProvidersReady({}, documentWith('// first\n'));
    assert.equal(compiles.length, 1, 'The next use loads it again, and compiles.');
    assert.throws(() => setCppProviderSources({}), /already loaded/);
});

test('each distinct provider source in a model is compiled once, for wasm32-wasi with the provider worker, before the engine runs', { skip: needsProviders }, async () => {
    compiles.length = 0;
    const Module = {};
    await ensureCppProvidersReady(Module, documentWith('// pump\n', '// valve\n', '// pump\n'));
    assert.deepEqual(compiles.map((compile) => compile.source).sort(), ['// pump\n', '// valve\n'], 'Three uses, two sources.');
    const [{ program, args, options }] = compiles;
    assert.equal(program, 'clang');
    for (const flag of ['providerWorker.cpp', '-target', 'wasm32-wasi', '-Iinclude', '-Wl,--export=konjugateProviderCreate', '-Wl,--export=konjugateProviderDispatch', '-Wl,--export=malloc', '-Wl,--export=free']) {
        assert.ok(args.includes(flag), `clang is given ${flag}`);
    }
    assert.deepEqual(options, { stdin: 'pipe', stdout: 'capture', stderr: 'capture' });
    assert.equal(typeof Module.registerCppProviderBridge, 'function');
    assert.equal(typeof Module.dispatchCppProviderBridge, 'function');
    await ensureCppProvidersReady({}, documentWith('// pump\n'));
    assert.equal(compiles.length, 2, 'A source already compiled is not compiled again.');
    const untouched = {};
    await ensureCppProvidersReady(untouched, JSON.stringify({ nodes: [{ implementation: { kind: 'python' } }, { implementation: { kind: 'cpp' } }], edges: [] }));
    await ensureCppProvidersReady(untouched, 'not json');
    assert.deepEqual(untouched, {}, 'A model with no C++ source loads nothing and installs nothing.');
    assert.equal(compiles.length, 2);
});

test('a registered provider is called synchronously, its answer read out of its memory, and nothing it was given is leaked', { skip: needsProviders }, async () => {
    const Module = {};
    await ensureCppProvidersReady(Module, documentWith('// echo\n'));
    Module.registerCppProviderBridge('echo-1', '// echo\n');
    Module.registerCppProviderBridge('echo-1', '// echo\n');
    assert.equal(text(ask(Module, 'echo-1', 'hello')), 'echo:hello');
    assert.deepEqual([1, 2, 3].map(() => text(ask(Module, 'echo-1', 'live'))), ['2', '2', '2'], 'Only the request and its length are held while it answers, call after call.');
    const large = 'x'.repeat(200000);
    assert.equal(text(ask(Module, 'echo-1', large)).length, large.length + 5, 'A request larger than its first memory.');
    Module.registerCppProviderBridge('echo-2', '// echo\n');
    assert.equal(text(ask(Module, 'echo-2', 'live')), '2', 'A second instance of the same module has its own memory.');
    assert.throws(() => Module.registerCppProviderBridge('echo-3', '// never compiled\n'), /has not finished compiling/);
    assert.throws(() => ask(Module, 'nobody', 'hello'), /No web C\+\+ provider instance for 'nobody'/);
});

test('the WASI stand-ins give a provider a console, a clock and random bytes, and do not let it exit', { skip: needsProviders }, async (t) => {
    const Module = {};
    await ensureCppProvidersReady(Module, documentWith('// wasi\n'));
    Module.registerCppProviderBridge('wasi', '// wasi\n');
    const logged = t.mock.method(console, 'log', () => {});
    const errored = t.mock.method(console, 'error', () => {});
    assert.equal(text(ask(Module, 'wasi', 'log:to standard output')), 'logged');
    assert.equal(text(ask(Module, 'wasi', 'err:to standard error')), 'logged');
    assert.equal(text(ask(Module, 'wasi', 'grow:after its memory grew')), 'logged', 'Read from the memory as it is now, not the buffer before it grew.');
    assert.deepEqual(logged.mock.calls.map((call) => call.arguments), [['to standard output'], ['after its memory grew']]);
    assert.deepEqual(errored.mock.calls.map((call) => call.arguments), [['to standard error']]);
    const nanoseconds = Buffer.from(ask(Module, 'wasi', 'time')).readBigUInt64LE(0);
    assert.ok(Math.abs(Number(nanoseconds / 1000000n) - Date.now()) < 5000, 'The clock is the wall clock, in nanoseconds.');
    const [first, second] = [ask(Module, 'wasi', 'random'), ask(Module, 'wasi', 'random')];
    assert.equal(first.length, 16);
    assert.notDeepEqual(first, second);
    assert.throws(() => ask(Module, 'wasi', 'exit'), /unexpectedly called exit\(3\)/);
});

test('a provider that fails to start answers its failure to the first request, as the engine expects of any reply', { skip: needsProviders }, async () => {
    const Module = {};
    await ensureCppProvidersReady(Module, documentWith('// fails to start\n'));
    Module.registerCppProviderBridge('failing', '// fails to start\n');
    assert.equal(text(ask(Module, 'failing', 'handshake')), 'create failed');
    assert.equal(text(ask(Module, 'failing', 'again')), 'echo:again', 'Once.');
});

test('a source that does not compile says why, and is compiled again when next asked for', async () => {
    compiles.length = 0;
    const source = 'does not compile\n';
    await assert.rejects(ensureCppProvidersReady({}, documentWith(source)), /Failed to compile the C\+\+ relationship provider:\n<stdin>:1:1: error: unknown type name 'does'/);
    await assert.rejects(ensureCppProvidersReady({}, documentWith(source)));
    assert.equal(compiles.length, 2, 'A failure is not kept as an answer.');
});

test('the provider editor\'s syntax check reports clang\'s diagnostics, each where it is', async () => {
    syntaxAnswer = { exitCode: 0, stderr: '' };
    assert.deepEqual(await runCppSyntaxCheck('int x;'), { valid: true, diagnostics: [] });
    assert.ok(compiles.at(-1).args.includes('-fsyntax-only'));
    assert.equal(compiles.at(-1).source, 'int x;');
    syntaxAnswer = { exitCode: 1, stderr: '<stdin>:3:5: error: expected \';\' after expression\n  3 |     x = 1\n<stdin>:1:10: warning: unused variable \'y\'\n<stdin>:1:1: note: declared here\n' };
    assert.deepEqual(await runCppSyntaxCheck('broken'), { valid: false, diagnostics: [
        { line: 3, column: 5, severity: 'error', message: 'expected \';\' after expression' },
        { line: 1, column: 10, severity: 'warning', message: 'unused variable \'y\'' },
        { line: 1, column: 1, severity: 'note', message: 'declared here' }
    ] });
    syntaxAnswer = { exitCode: 1, stderr: 'clang: error: unable to execute command\n' };
    assert.deepEqual(await runCppSyntaxCheck('broken'), { valid: false, diagnostics: [{ line: 1, column: 1, severity: 'error', message: 'clang: error: unable to execute command' }] });
    syntaxAnswer = { exitCode: 1, stderr: '' };
    assert.deepEqual((await runCppSyntaxCheck('broken')).diagnostics, [{ line: 1, column: 1, severity: 'error', message: 'Compilation failed.' }]);
});

test('the editor\'s check kills its compiler when it is superseded or past its time limit', async () => {
    kills.length = 0;
    const controller = new AbortController();
    const checking = runCppSyntaxCheck('never ends', { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(checking, { name: 'AbortError' });
    assert.deepEqual(kills, ['never ends']);
    await assert.rejects(runCppSyntaxCheck('int x;', { signal: AbortSignal.abort() }), { name: 'AbortError' }, 'An aborted check starts no compiler.');
});
