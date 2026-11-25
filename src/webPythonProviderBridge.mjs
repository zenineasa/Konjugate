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

import { pythonProgramLintFunction } from './pythonProgramLint.mjs';

// The SDK as Pyodide needs it: version 1's package, and version 2's (konjugate.v2) beside it.
const sdkFiles = ['__init__.py', '__main__.py', '_webBridge.py', 'v2/__init__.py', 'v2/_host.py', 'v2/testing.py', 'v2/check.py'];

// Where Pyodide and the provider SDK come from: beside this module in the web shell, which scripts/buildWebShell.mjs assembles with
// both. Replaceable before Pyodide is first loaded (setPythonProviderSources), so a test can run the same bridge on the Pyodide in
// node_modules and the SDK in engine/sdk/python.
let sources = {
    importPyodide: () => import(new URL('./node_modules/pyodide/pyodide.mjs', import.meta.url).href),
    indexURL: new URL('./node_modules/pyodide/', import.meta.url).href,
    async readSdkFile(fileName) {
        const response = await fetch(new URL(`./pythonProviderSdk/konjugate/${fileName}`, import.meta.url));
        if (!response.ok) throw new Error(`Could not fetch the Python provider SDK file '${fileName}'.`);
        return response.text();
    }
};

export function setPythonProviderSources(replacement) {
    if (pyodidePromise) throw new Error('Pyodide is already loaded: its sources can only be set before it is first used.');
    sources = { ...sources, ...replacement };
}

let pyodidePromise = null;
function ensurePyodideLoaded() {
    if (!pyodidePromise) {
        pyodidePromise = (async () => {
            const { loadPyodide } = await sources.importPyodide();
            const pyodide = await loadPyodide({ indexURL: sources.indexURL });
            pyodide.FS.mkdirTree('/konjugateSdk/konjugate/v2');
            pyodide.FS.mkdirTree('/konjugateProviders');
            for (const fileName of sdkFiles) pyodide.FS.writeFile(`/konjugateSdk/konjugate/${fileName}`, await sources.readSdkFile(fileName));
            pyodide.runPython('import sys\nif "/konjugateSdk" not in sys.path: sys.path.insert(0, "/konjugateSdk")');
            return pyodide;
        })();
        // A failed load (an SDK file that did not come down) must not be kept, or every later provider would fail with it.
        pyodidePromise.catch(() => { pyodidePromise = null; });
    }
    return pyodidePromise;
}

// Exposed so the provider editor's "Validate" button can run a syntax check without needing a
// WASM engine instance at all -- see webShims/providerEditor.mjs. Returns the same
// { valid, diagnostics: [{ line, column, severity, message }] } shape src/main.mjs's own
// validatePythonSource (the desktop provider editor's syntax check, run via a real python3
// subprocess) returns -- not the same underlying mechanism (there is no subprocess/stdin here,
// just a direct Pyodide call), but the same shape, so neither this editor nor a future richer
// one needs its own diagnostic format.
export async function runPythonSyntaxCheck(source) {
    const pyodide = await ensurePyodideLoaded();
    // The checker is defined in its own namespace, and the user's source is handed to it as a local rather than interpolated into the
    // code string (no quoting or escaping hazard). Its checks are src/pythonProgramLint.mjs's, the desktop's own.
    const scope = pyodide.toPy({ source });
    try {
        const result = pyodide.runPython(`${pythonProgramLintFunction}\n_konjugate_lint(source)`, { globals: scope });
        const answer = result?.toJs ? result.toJs({ dict_converter: Object.fromEntries }) : result;
        result?.destroy?.();
        return { valid: Boolean(answer.valid), diagnostics: [...answer.diagnostics] };
    } catch (error) {
        // A genuinely unexpected failure, not the user's own SyntaxError (which is reported as a diagnostic): still a diagnostic,
        // rather than thrown out of the check.
        const lines = String(error.message ?? error).trim().split('\n');
        return { valid: false, diagnostics: [{ line: 1, column: 1, severity: 'error', message: lines.at(-1) }] };
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
                // A version 2 program answers with its description (konjugate/_webBridge.py's created_json).
                return bridge.created_json();
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
