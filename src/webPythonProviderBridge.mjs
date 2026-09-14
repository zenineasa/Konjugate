/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Loads Pyodide (bundled locally -- see scripts/buildWebShell.mjs's vendoredPackages list, no
// CDN fetch) and bridges the WASM engine's Python-provider evaluation calls to it, replacing the
// native desktop's fork+pipe+protobuf transport with a direct, synchronous call (see
// docs/proposals/webEdition.md, phase 4, and engine/src/providerRuntime.cpp's
// WasmPyodideProviderBackend for the C++ side of this exact contract).
//
// installPythonProviderBridge(Module) is async (Pyodide itself takes real time to fetch/
// instantiate), but MUST be awaited to completion before Module.callMain([...]) runs: once
// installed, Module.evaluatePythonProviderBridge itself is fully synchronous -- Pyodide function
// calls and FS operations are synchronous from JS's point of view once Pyodide is loaded, which
// is exactly what the C++ side's EM_JS call requires (it blocks for a return value, not a
// Promise). Reused unchanged by both the WASM engine's run/fit/infer paths (via
// webEngineWorker.mjs) and the provider editor's "Validate" button
// (webShims/providerEditor.mjs), so Pyodide itself only ever loads once per Worker/page.

const sdkFiles = ['__init__.py', '__main__.py', '_webBridge.py'];

let pyodidePromise = null;
function ensurePyodideLoaded() {
    if (!pyodidePromise) {
        pyodidePromise = (async () => {
            const { loadPyodide } = await import(new URL('./node_modules/pyodide/pyodide.mjs', import.meta.url).href);
            const pyodide = await loadPyodide({ indexURL: new URL('./node_modules/pyodide/', import.meta.url).href });
            pyodide.FS.mkdirTree('/konjugateSdk/konjugate');
            pyodide.FS.mkdirTree('/konjugateProviders');
            for (const fileName of sdkFiles) {
                const response = await fetch(new URL(`./pythonProviderSdk/konjugate/${fileName}`, import.meta.url));
                if (!response.ok) throw new Error(`Could not fetch the Python provider SDK file '${fileName}'.`);
                pyodide.FS.writeFile(`/konjugateSdk/konjugate/${fileName}`, await response.text());
            }
            pyodide.runPython('import sys\nif "/konjugateSdk" not in sys.path: sys.path.insert(0, "/konjugateSdk")');
            return pyodide;
        })();
    }
    return pyodidePromise;
}

// Exposed so the provider editor's "Validate" button can run a syntax check without needing a
// WASM engine instance at all -- see webShims/providerEditor.mjs.
export async function runPythonSyntaxCheck(source) {
    const pyodide = await ensurePyodideLoaded();
    // Keeps the user's source out of any shared/global Pyodide namespace -- passed as a local via
    // globals rather than interpolated into the code string (avoids any quoting/escaping hazard).
    const scope = pyodide.toPy({ source });
    try {
        pyodide.runPython('import ast\nast.parse(source)', { globals: scope });
        return { valid: true };
    } catch (error) {
        // Pyodide's PythonError.message is the whole Python traceback (useful in a devtools
        // console, not in a one-line status message) -- the actual "SyntaxError: ..." is always
        // its last non-empty line, so surface just that rather than the full traceback text.
        const lines = String(error.message ?? error).trim().split('\n');
        return { valid: false, message: lines.at(-1) };
    } finally {
        scope.destroy();
    }
}

export async function installPythonProviderBridge(Module) {
    const pyodide = await ensurePyodideLoaded();
    const createBridge = pyodide.pyimport('konjugate._webBridge').create_bridge;
    const bridgesByProcessKey = new Map();
    let scratchCounter = 0;

    Module.evaluatePythonProviderBridge = (requestJson) => {
        let request;
        try {
            request = JSON.parse(requestJson);
            if (request.kind === 'create') {
                const scratchPath = `/konjugateProviders/provider${scratchCounter++}.py`;
                pyodide.FS.writeFile(scratchPath, request.source);
                const bridge = createBridge(scratchPath);
                bridgesByProcessKey.set(request.processKey, bridge);
                return JSON.stringify({ ok: true });
            }
            const bridge = bridgesByProcessKey.get(request.processKey);
            if (!bridge) throw new Error(`No Python provider bridge for '${request.processKey}'.`);
            const responseJson = bridge.dispatch_json(requestJson);
            if (request.kind === 'shutdown') {
                bridgesByProcessKey.delete(request.processKey);
                bridge.destroy();
            }
            return responseJson;
        } catch (error) {
            return JSON.stringify({ ok: false, code: 'bridgeFailure', message: String(error.message ?? error), fatal: true });
        }
    };
}
