/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A stand-in for the web engine's Emscripten module (out/engineWeb/konjugateEngine.js), for unit tests of what drives it
// (src/webEngineAdapter.mjs, src/webEngineLiveRunWorker.mjs, src/webEngineWorker.mjs) without building the WebAssembly engine. Like
// the real one it is an ES module whose default export starts a module from its options (print, printErr, wasmBinary), with a
// virtual filesystem (Module.FS) and Module.callMain(argv), which returns an exit code. What callMain does is the test's: it is
// handed to `globalThis.fakeWebEngine.callMain(Module, argv)`, which may read the files written, write the ones the engine would,
// print, and call back into what was installed on Module (emitEngineEvent, drainControlStreamBytes).
//
//   globalThis.fakeWebEngine = { callMain: (Module, argv) => 0, failStarts: 0 }
//   import(pathToFileURL('tests/fixtures/fakeWebEngine.mjs').href)   (what the code under test does with its engineModuleUrl)
//
// `failStarts` makes that many starts fail as an incomplete download does; `starts` counts them, and `modules` keeps each started.

class MemoryFileSystem {
    files = new Map();
    directories = new Set(['/']);

    mkdir(path) {
        if (this.directories.has(path)) throw new Error(`EEXIST: ${path}`);
        this.directories.add(path);
    }

    writeFile(path, data) {
        this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    }

    readFile(path, options = {}) {
        if (!this.files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        const bytes = this.files.get(path);
        return options.encoding === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
    }

    readdir(path) {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const names = [...this.files.keys(), ...this.directories].filter((entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/') && entry !== prefix);
        return ['.', '..', ...names.map((entry) => entry.slice(prefix.length))];
    }

    unlink(path) {
        if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
    }

    rmdir(path) {
        if (this.readdir(path).length > 2) throw new Error(`ENOTEMPTY: ${path}`);
        this.directories.delete(path);
    }
}

export default async function createKonjugateEngine(options = {}) {
    const control = globalThis.fakeWebEngine;
    control.starts = (control.starts ?? 0) + 1;
    if (control.failStarts > 0) {
        control.failStarts -= 1;
        throw new Error('Aborted(CompileError: WebAssembly.Module(): section was shorter than expected size)');
    }
    const Module = { FS: new MemoryFileSystem(), options, callMain: (argv) => control.callMain(Module, argv) };
    (control.modules ??= []).push(Module);
    return Module;
}
