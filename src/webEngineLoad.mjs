/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Starts the web engine's WebAssembly module, and recovers when its file came down incomplete. On a phone's connection a ~50 MB .wasm can
// arrive short (a dropped connection a proxy or an old cache reported as finished), and the browser then says only that a section "was
// shorter than expected size". The build records the file's real size in konjugateEngine.json beside it (scripts/buildWebShell.mjs); when
// the first start fails, the file is fetched again past the HTTP cache, checked against that size, and handed to the module as bytes.
// A file that is still short is reported as that, with both sizes, which points at the host and not at the model.

const attempts = 3;

async function expectedBytes(engineModuleUrl, fetchFunction) {
    try {
        const response = await fetchFunction(new URL('konjugateEngine.json', engineModuleUrl).href);
        const { wasmBytes } = response.ok ? await response.json() : {};
        return Number.isSafeInteger(wasmBytes) && wasmBytes > 0 ? wasmBytes : null;
    } catch {
        return null;
    }
}

export async function completeEngineBinary(engineModuleUrl, fetchFunction = fetch) {
    const expected = await expectedBytes(engineModuleUrl, fetchFunction);
    if (expected === null) return null;
    const wasmUrl = new URL('konjugateEngine.wasm', engineModuleUrl).href;
    let received = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetchFunction(wasmUrl, { cache: 'reload' });
            if (!response.ok) throw new Error(`answered ${response.status}`);
            const bytes = await response.arrayBuffer();
            received = bytes.byteLength;
            if (received === expected) return bytes;
        } catch (error) {
            received = 0;
            if (attempt === attempts) throw new Error(`The engine file could not be downloaded (${error.message}).`);
        }
    }
    throw new Error(`The engine file keeps arriving incomplete (${received} of ${expected} bytes). Reload the page; if it persists, the host is cutting the download short.`);
}

// `options` are the module's own (print, printErr). `importModule` and `fetchFunction` are the page's, replaceable for a test.
export async function startEngineModule(engineModuleUrl, options, { importModule = (url) => import(url), fetchFunction = fetch } = {}) {
    const start = async (extra) => (await importModule(engineModuleUrl)).default({ ...options, ...extra });
    try {
        return await start({});
    } catch (error) {
        const wasmBinary = await completeEngineBinary(engineModuleUrl, fetchFunction);
        if (!wasmBinary) throw error;
        return start({ wasmBinary });
    }
}
