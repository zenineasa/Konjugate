/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Compiles a C++ relationship provider's inline source (paired with a WASI-exports build of
// engine/src/providerWorker.cpp -- see that file's own __wasi__-gated section) via @wasmer/sdk's
// in-browser clang, then instantiates the result directly with WebAssembly.instantiate() and
// bridges the engine's C++-provider evaluation calls to it -- see docs/proposals/webEdition.md,
// phase 5, and engine/src/providerRuntime.cpp's WasmCppProviderBackend for the C++ side of this
// exact contract.
//
// Unlike webPythonProviderBridge.mjs (which calls directly into an already-loaded, synchronously-
// executing Pyodide interpreter), this does NOT spawn the compiled provider as a live process via
// @wasmer/sdk's sandbox.command()/spawn(): that path needs a WEBC-packaged command, and there is
// no supported way (as of the @wasmer/sdk version this was built against) to wrap freshly
// -compiled, client-side raw WASM bytes into one -- confirmed empirically (a compiled module fed
// to wasmer.packages.load() is rejected with an "InvalidMagic" WEBC-parsing error) and against
// the SDK's own issue tracker (wasmerio/wasmer-sdk#494 asks this exact question, unanswered).
// Instead, the compiled module is instantiated directly in this JS context via a minimal
// hand-rolled WASI polyfill (see wasiImports() below) and its exported functions
// (konjugateProviderCreate/konjugateProviderDispatch) are called synchronously -- there is no
// process and no Stream, so (unlike the abandoned spawn-based design) there is no async boundary
// left to cross at evaluation time either: compiling (the one genuinely async step, since it
// needs a real clang fetched from Wasmer's registry) happens once per distinct source, entirely
// ahead of the engine's callMain(), in ensureCppProvidersReady() below.
//
// The polyfill only needs to satisfy wasi-libc's static linking/startup requirements (this
// module's compiled providers never do real file/network I/O, and never spawn threads despite
// needing wasix_32v1 imports to link at all -- see its own comment): every function here is a
// stub that either is never called in practice, or -- for fd_write -- forwards to the console,
// since the only realistic caller is libc++'s own std::cerr/assert-failure path, useful to see
// during development rather than something the protocol depends on.

// The worker glue file is fixed (identical for every provider) and known ahead of time, so it is
// mounted into the sandbox once, at creation -- SandboxOptions.files, not a per-spawn option (a
// spawned command's own SpawnOptions has no `files` field; only the sandbox itself does). Files
// there are keyed by a plain relative path (confirmed against a real, current @wasmer/sdk: an
// earlier attempt using an explicit '/workspace/...' key produced "no such file or directory" --
// the sandbox's own working directory already IS that root) and are directly readable there by a
// command spawned in that sandbox -- unlike sandbox.fs, which is a genuinely separate,
// non-overlapping filesystem view.
// [fetch path under ./cppProviderSdk/, sandbox mount path] -- mirrors engine/include/konjugate/'s
// own layout so providerWorker.cpp's #include "konjugate/relationshipProvider.hpp" resolves
// unchanged (see the -Iinclude compile flag below).
const sdkFiles = [
    ['providerWorker.cpp', 'providerWorker.cpp'],
    ['konjugate/relationshipProvider.hpp', 'include/konjugate/relationshipProvider.hpp'],
    ['konjugate/providerSharedMemoryChannel.hpp', 'include/konjugate/providerSharedMemoryChannel.hpp']
];

let sandboxPromise = null;
async function ensureSandbox() {
    if (!sandboxPromise) {
        sandboxPromise = (async () => {
            const [{ Wasmer }, ...responses] = await Promise.all([
                import(new URL('./node_modules/@wasmer/sdk/dist/index.js', import.meta.url).href),
                ...sdkFiles.map(([relativePath]) => fetch(new URL(`./cppProviderSdk/${relativePath}`, import.meta.url)))
            ]);
            const files = {};
            for (const [index, [, mountPath]] of sdkFiles.entries()) {
                if (!responses[index].ok) throw new Error(`Could not fetch the C++ provider SDK file '${sdkFiles[index][0]}'.`);
                files[mountPath] = await responses[index].text();
            }
            const wasmer = await Wasmer.create();
            return wasmer.sandboxes.create({ packages: ['clang/clang'], files });
        })();
    }
    return sandboxPromise;
}

// Keyed by the provider's own source text (not a process key -- see this file's header comment;
// JS has no reason to replicate the engine's own process-key derivation, since the source text
// itself is already a perfectly good, naturally-deduplicating cache key, exactly like the native
// build's own on-disk build cache in engine/src/providerRuntime.cpp's buildCppProvider()).
const compiledModulesBySource = new Map(); // source -> Promise<WebAssembly.Module>
const resolvedModulesBySource = new Map(); // source -> WebAssembly.Module, populated once compileProvider()'s promise settles -- see
                                            // installCppProviderBridge()'s own comment on why a synchronous read of this map (not the
                                            // Promise above) is what a later synchronous registerCppProviderBridge() call needs.

async function compileProvider(source) {
    let modulePromise = compiledModulesBySource.get(source);
    if (modulePromise) return modulePromise;
    modulePromise = (async () => {
        const sandbox = await ensureSandbox();
        const compile = sandbox.command('clang', [
            '-x', 'c++', '-', 'providerWorker.cpp', '-o', '-', '-std=c++20', '-target', 'wasm32-wasi',
            '-Iinclude', '-lc++abi', '-lc++',
            '-Wl,--export=konjugateProviderCreate', '-Wl,--export=konjugateProviderDispatch',
            '-Wl,--export=malloc', '-Wl,--export=free'
        ]);
        const proc = await compile.spawn({ stdin: 'pipe', stdout: 'capture', stderr: 'capture' });
        await proc.stdin.write(new TextEncoder().encode(source));
        await proc.stdin.close();
        const output = await proc.wait({ check: false });
        if (output.exitCode !== 0) {
            throw new Error(`Failed to compile the C++ relationship provider:\n${output.stderr.text()}`);
        }
        return WebAssembly.compile(output.stdout.bytes);
    })();
    modulePromise.then((resolved) => resolvedModulesBySource.set(source, resolved), () => {});
    compiledModulesBySource.set(source, modulePromise);
    return modulePromise;
}

// A minimal WASI preview1 + WASIX polyfill: only wide enough for wasi-libc's own static
// startup and a real C++ program's std::cerr/assert-failure path -- see this file's header
// comment for why the wasix_32v1 thread/futex imports are present but never expected to fire.
//
// memoryHolder.memory (a live WebAssembly.Memory, set once the instance exists -- see
// registerCppProviderBridge below) is read fresh, as memoryHolder.memory.buffer, on every single
// call below rather than cached once: a malloc-driven memory.grow() detaches the previous
// ArrayBuffer and replaces .buffer with a new one, so caching it up front would silently start
// reading/writing a stale, detached buffer the first time this provider's heap grows.
function wasiImports(memoryHolder) {
    const decoder = new TextDecoder();
    return {
        wasi_snapshot_preview1: {
            fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
                const view = new DataView(memoryHolder.memory.buffer);
                let written = 0;
                let text = '';
                for (let i = 0; i < iovsLen; i++) {
                    const ptr = view.getUint32(iovsPtr + i * 8, true);
                    const len = view.getUint32(iovsPtr + i * 8 + 4, true);
                    text += decoder.decode(new Uint8Array(memoryHolder.memory.buffer, ptr, len));
                    written += len;
                }
                if (text) (fd === 1 ? console.log : console.error)(text);
                view.setUint32(nwrittenPtr, written, true);
                return 0;
            },
            fd_read: () => 8, // EBADF -- this build never reads stdin; see this file's header comment
            fd_close: () => 0,
            fd_seek: () => 0,
            fd_fdstat_get: () => 0,
            fd_fdstat_set_flags: () => 0,
            fd_prestat_get: () => 8,
            fd_prestat_dir_name: () => 8,
            environ_sizes_get: (countPtr, sizePtr) => {
                const view = new DataView(memoryHolder.memory.buffer);
                view.setUint32(countPtr, 0, true);
                view.setUint32(sizePtr, 0, true);
                return 0;
            },
            environ_get: () => 0,
            args_sizes_get: (countPtr, sizePtr) => {
                const view = new DataView(memoryHolder.memory.buffer);
                view.setUint32(countPtr, 0, true);
                view.setUint32(sizePtr, 0, true);
                return 0;
            },
            args_get: () => 0,
            clock_time_get: (id, precision, resultPtr) => {
                const view = new DataView(memoryHolder.memory.buffer);
                const nanoseconds = BigInt(Math.floor(Date.now())) * 1000000n;
                view.setBigUint64(resultPtr, nanoseconds, true);
                return 0;
            },
            clock_res_get: (id, resultPtr) => {
                new DataView(memoryHolder.memory.buffer).setBigUint64(resultPtr, 1000000n, true);
                return 0;
            },
            random_get: (ptr, len) => {
                crypto.getRandomValues(new Uint8Array(memoryHolder.memory.buffer, ptr, len));
                return 0;
            },
            proc_exit: (code) => { throw new Error(`A web C++ provider unexpectedly called exit(${code}).`); },
            sched_yield: () => 0
        },
        wasix_32v1: {
            // Baked into the clang package's own default -pthread/-matomics linker flags (see
            // this project's earlier toolchain spike notes) regardless of source content -- a
            // compiled module always imports these to satisfy static linking, but a program that
            // never calls pthread_create/std::thread (this one never does) should never actually
            // invoke them at runtime; each throws if it somehow is, rather than silently
            // pretending to synchronize.
            callback_signal: () => {},
            thread_signal: () => {},
            futex_wait: () => { throw new Error('Unexpected futex_wait in a single-threaded web C++ provider.'); },
            futex_wake: () => 0,
            futex_wake_all: () => 0
        }
    };
}

const instancesByProcessKey = new Map();

function callExportReturningBytesOrThrow(instance, exportName, args) {
    const outLenPointer = instance.exports.malloc(4);
    try {
        const resultPointer = instance.exports[exportName](...args, outLenPointer);
        const length = new DataView(instance.exports.memory.buffer).getUint32(outLenPointer, true);
        const bytes = new Uint8Array(instance.exports.memory.buffer, resultPointer, length).slice();
        if (resultPointer) instance.exports.free(resultPointer);
        return bytes;
    } finally {
        instance.exports.free(outLenPointer);
    }
}

// Installed onto Module by ensureCppProvidersReady() (webEngineAdapter.mjs), before callMain()
// runs -- see engine/src/providerRuntime.cpp's WasmCppProviderBackend, which calls these
// synchronously through a plain EM_JS binding (there is no async boundary left at this point;
// see this file's header comment).
export function installCppProviderBridge(Module) {
    Module.registerCppProviderBridge = (processKey, source) => {
        if (instancesByProcessKey.has(processKey)) return;
        // ensureCppProvidersReady() already awaited compileProvider(source) to completion before
        // callMain() ran, so resolvedModulesBySource is populated by the time this synchronous
        // call happens (a Promise's own .then() callback is never invoked synchronously, even
        // once settled, so that map -- not the Promise from compiledModulesBySource -- is what a
        // synchronous read here needs). What follows IS still synchronous: a plain
        // `new WebAssembly.Instance(module, imports)` against an already-compiled Module -- as
        // opposed to the async WebAssembly.instantiate() free function -- always is, per the
        // WebAssembly JS API.
        const compiledModule = resolvedModulesBySource.get(source);
        if (!compiledModule) {
            throw new Error(`Web C++ provider '${processKey}' has not finished compiling (ensureCppProvidersReady() must compile every provider source before callMain() runs).`);
        }
        const memoryHolder = {};
        const instance = new WebAssembly.Instance(compiledModule, wasiImports(memoryHolder));
        memoryHolder.memory = instance.exports.memory;
        const created = callExportReturningBytesOrThrow(instance, 'konjugateProviderCreate', []);
        if (created.length > 0) {
            // konjugateProviderCreate() returns an encoded Failure message on error (see
            // providerWorker.cpp) -- the engine-side dispatch() path already knows how to parse
            // and surface that shape, so route it through the SAME dispatch call the caller is
            // about to make anyway, by remembering it and replaying it as the first response.
            instancesByProcessKey.set(processKey, { instance, pendingFailure: created });
            return;
        }
        instancesByProcessKey.set(processKey, { instance, pendingFailure: null });
    };

    Module.dispatchCppProviderBridge = (processKey, requestBytes) => {
        const entry = instancesByProcessKey.get(processKey);
        if (!entry) throw new Error(`No web C++ provider instance for '${processKey}'.`);
        if (entry.pendingFailure) {
            const failure = entry.pendingFailure;
            entry.pendingFailure = null;
            return failure;
        }
        const requestPointer = entry.instance.exports.malloc(requestBytes.length);
        new Uint8Array(entry.instance.exports.memory.buffer, requestPointer, requestBytes.length).set(requestBytes);
        try {
            return callExportReturningBytesOrThrow(entry.instance, 'konjugateProviderDispatch', [requestPointer, requestBytes.length]);
        } finally {
            entry.instance.exports.free(requestPointer);
        }
    };
}

function collectCppProviderSources(content) {
    let document;
    try {
        document = JSON.parse(content);
    } catch {
        return [];
    }
    const implementations = [
        ...(document.nodes ?? []).map((node) => node.implementation),
        ...(document.nodes ?? []).flatMap((node) => (node.sourceTerms ?? []).map((term) => term.implementation)),
        ...(document.edges ?? []).map((edge) => edge.implementation)
    ];
    return [...new Set(implementations
        .filter((implementation) => implementation?.kind === 'cpp' && typeof implementation.source === 'string')
        .map((implementation) => implementation.source))];
}

// Must be awaited to completion before Module.callMain([...]) runs: it precompiles every distinct
// C++ provider source the document references (the one genuinely async step -- see this file's
// header comment), so Module.registerCppProviderBridge above can instantiate synchronously later,
// from inside the engine's own blocking EM_JS call.
export async function ensureCppProvidersReady(Module, content) {
    const sources = collectCppProviderSources(content);
    if (sources.length === 0) return;
    installCppProviderBridge(Module);
    await Promise.all(sources.map((source) => compileProvider(source)));
}

// Exposed for the provider editor's "Validate" button (webShims/providerEditor.mjs) -- a
// compile-only check (clang -fsyntax-only), independent of the WASM engine/registration path
// above. Returns the same { valid, diagnostics: [{ line, column, severity, message }] } shape
// runPythonSyntaxCheck() (webPythonProviderBridge.mjs) and desktop's own parseCompilerDiagnostics
// return, parsed from clang's `file:line:col: severity: message` diagnostic format.
const diagnosticPattern = /^[^:]*:(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/gm;

export async function runCppSyntaxCheck(source) {
    const sandbox = await ensureSandbox();
    const check = sandbox.command('clang', ['-x', 'c++', '-', '-fsyntax-only', '-std=c++20', '-Iinclude']);
    const proc = await check.spawn({ stdin: 'pipe', stdout: 'capture', stderr: 'capture' });
    await proc.stdin.write(new TextEncoder().encode(source));
    await proc.stdin.close();
    const output = await proc.wait({ check: false });
    if (output.exitCode === 0) return { valid: true, diagnostics: [] };

    const diagnostics = [];
    for (const match of output.stderr.text().matchAll(diagnosticPattern)) {
        const [, line, column, severity, message] = match;
        diagnostics.push({ line: Number(line), column: Number(column), severity, message });
    }
    if (diagnostics.length === 0) {
        diagnostics.push({ line: 1, column: 1, severity: 'error', message: output.stderr.text().trim() || 'Compilation failed.' });
    }
    return { valid: false, diagnostics };
}
