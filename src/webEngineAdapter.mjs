/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Browser-side counterpart to src/engineAdapter.mjs's one-shot engine operations (capabilities,
// validate, run, infer, fit, checkSubstepConvergence) -- see docs/proposals/webEdition.md, phase
// 2. Talks directly to the WASM engine module (out/engineWeb/konjugateEngine.js) instead of
// spawning a real OS subprocess and exchanging real temp files: writes inputs into the module's
// own virtual filesystem, invokes main() with an argv array via callMain(), and reads outputs
// back out the same way -- the exact pattern phase 1 verified byte-for-byte identical to the
// desktop CLI, in both Node and a real Chromium renderer.
//
// Deliberately NOT implemented here: startEngineRun()'s live/streaming run (onUpdate/pacing/
// cancel/live-parameter-control). callMain() blocks the calling thread until main() returns, so a
// live-updating run needs a Worker-based design (to keep the page responsive while a run
// executes) -- a separate, harder problem from this module's one-shot operations, not attempted
// here.
//
// Deliberately NOT implemented here: plugin/FMU resolution (resolveInstalledPlugins/
// resolveInstalledFmus in engineAdapter.mjs). Both read from a local userData directory that has
// no browser equivalent, and both exist specifically to support the same programmable-provider/
// FMI features this web build already excludes (see webEdition.md's "Two genuinely different
// classes of missing native code"). A caller here passes already-resolved project content.
//
// Deliberately NOT reusing src/projectFile.mjs's encodeProjectFile(): that module imports
// node:crypto/node:zlib directly and cannot be loaded in a browser at all.
// src/browserProjectCodec.mjs is the browser-native (CompressionStream-based) replacement,
// shared with the phase-3 shell's project load/save -- unencrypted only; see its own header
// comment and webEdition.md's encrypted-project open question.
//
// reportProtocol.mjs is imported dynamically (inside validate/infer/fit below), not at module top
// level, and deliberately so: it pulls in protobufjs/minimal.js, which is a CommonJS module
// (module.exports/require) -- loadable via Node's own CJS/ESM interop, but not by a real browser
// at all without either an import map pointing the bare "protobufjs/minimal.js" specifier at a
// browser-compatible build, or a bundler. That is real, separate infrastructure work (matching
// webEdition.md's own "Minimal shell" phase, not this one), not something this module should
// force on every caller -- a page that only ever calls run()/capabilities() (this module's
// protobufjs-free path) should not fail to load over a problem that is not theirs. Confirmed by
// testing this exact failure mode in a real Chromium renderer: a static top-level import here
// broke the whole module, including run()/capabilities(), even when validate() was never called.
import { decodeResultFile } from './engineProtocol.mjs';
import { encodeProjectContent } from './browserProjectCodec.mjs';

// Python providers (docs/proposals/webEdition.md, phase 4) need a Pyodide interpreter loaded and
// wired up as Module.evaluatePythonProviderBridge before callMain(['run'/'fit', ...]) runs -- see
// engine/src/providerRuntime.cpp's WasmPyodideProviderBackend for the C++ side of this contract.
// validate() never executes providers, and infer() has no model document at all (it derives a
// model FROM a CSV, taking no `content` argument), so neither can reach a provider -- both are
// excluded here on purpose. Pyodide (~15MB) is real, avoidable cost for the (likely common) case
// of a model with no Python providers at all -- webPythonProviderBridge.mjs is only imported, and
// Pyodide only loaded, when a python-kind implementation actually appears in the document.
function hasPythonProviderImplementation(content) {
    let document;
    try {
        document = JSON.parse(content);
    } catch {
        return false; // an invalid document surfaces its own parse error from the engine itself
    }
    const implementations = [
        ...(document.nodes ?? []).map((node) => node.implementation),
        ...(document.nodes ?? []).flatMap((node) => (node.sourceTerms ?? []).map((term) => term.implementation)),
        ...(document.edges ?? []).map((edge) => edge.implementation)
    ];
    return implementations.some((implementation) => implementation?.kind === 'python');
}

async function ensurePythonProvidersReady(Module, content) {
    if (!hasPythonProviderImplementation(content)) return;
    const { installPythonProviderBridge } = await import('./webPythonProviderBridge.mjs');
    await installPythonProviderBridge(Module);
}

let modulePromise = null;
let stdoutBuffer = [];

// engineModuleUrl is caller-supplied (e.g. "./engine/konjugateEngine.js", relative to the page)
// rather than hardcoded, since where the built .js/.wasm pair is actually served from is a
// hosting decision this module has no business making. The module is instantiated once and
// reused for every subsequent call -- re-instantiating per call would re-parse/re-compile the
// ~49MB .wasm every time, which is real, avoidable cost.
async function loadModule(engineModuleUrl) {
    if (!modulePromise) {
        modulePromise = import(engineModuleUrl).then((moduleExports) => moduleExports.default({
            print: (text) => stdoutBuffer.push(text),
            printErr: () => {}
        }));
    }
    return modulePromise;
}

let scratchCounter = 0;
// Mirrors mkdtemp(tmpdir(), ...)'s role in engineAdapter.mjs -- a fresh, uniquely-named directory
// per call in the module's own virtual filesystem, so sequential calls (the only shape this
// module supports; there is no concurrency story here) never see another call's stale files.
function scratchDirectory(Module) {
    const path = `/scratch-${Date.now()}-${scratchCounter++}`;
    Module.FS.mkdir(path);
    return path;
}

function removeScratchDirectory(Module, path) {
    for (const name of Module.FS.readdir(path)) {
        if (name === '.' || name === '..') continue;
        Module.FS.unlink(`${path}/${name}`);
    }
    Module.FS.rmdir(path);
}

// Every operation below follows the same shape: instantiate/reuse the module, make a scratch
// directory, write input file(s), callMain with the exact argv the desktop CLI documents (see
// docs/engineCli.md), read output file(s) back (via readOutput, called BEFORE cleanup -- the
// scratch directory and everything in it is gone once this function returns), clean up.
// acceptedExitCodes mirrors each operation's own exit-code tolerance in engineAdapter.mjs (e.g.
// validate's 0 or 2, fit's 0 or 1) -- a nonzero code outside that set throws, matching
// runEngine()'s own diagnostics-in-the-error convention as closely as this environment allows
// (there is no captured stderr text here, since printErr is discarded above; the exit code is
// what's available).
async function runOneShot(engineModuleUrl, { setup, argv, readOutput, acceptedExitCodes = [0] }) {
    const Module = await loadModule(engineModuleUrl);
    const directory = scratchDirectory(Module);
    try {
        const paths = await setup(Module, directory);
        const exitCode = Module.callMain(argv(paths));
        if (!acceptedExitCodes.includes(exitCode)) {
            throw new Error(`The engine exited with code ${exitCode}.`);
        }
        // Explicitly awaited, not just returned: readOutput is async (validate/infer/fit's own
        // readOutput lazily imports reportProtocol.mjs first -- see this module's own header
        // comment). A bare `return readOutput(...)` would let finally's cleanup below run
        // immediately, before that import (and the FS.readFile() after it) ever completes,
        // deleting the scratch directory out from under it -- caught directly by testing this: a
        // real ENOENT reading the report file back.
        return await readOutput(Module, paths);
    } finally {
        removeScratchDirectory(Module, directory);
    }
}

export async function getWebEngineCapabilities(engineModuleUrl) {
    const Module = await loadModule(engineModuleUrl);
    stdoutBuffer = [];
    const exitCode = Module.callMain(['capabilities']);
    if (exitCode !== 0) throw new Error(`The engine exited with code ${exitCode}.`);
    return { available: true, capabilities: JSON.parse(stdoutBuffer.join('')) };
}

export async function validateWithWebEngine(engineModuleUrl, content) {
    const report = await runOneShot(engineModuleUrl, {
        setup: async (Module, directory) => {
            const inputPath = `${directory}/input.kjt`;
            const reportPath = `${directory}/validation.bin`;
            Module.FS.writeFile(inputPath, await encodeProjectContent(content));
            return { inputPath, reportPath };
        },
        argv: ({ inputPath, reportPath }) => ['validate', inputPath, '--report', reportPath],
        readOutput: async (Module, { reportPath }) => {
            const { decodeValidationReport } = await import('./reportProtocol.mjs');
            return decodeValidationReport(Module.FS.readFile(reportPath));
        },
        acceptedExitCodes: [0, 2]
    });
    return { available: true, report };
}

export async function checkSubstepConvergenceWithWebEngine() {
    // No equivalent of postRunStabilityDiagnostics.mjs's checkSubstepConvergence() here yet -- that
    // function drives a multi-run substep-doubling search itself (see its own doc comment), which
    // this module's single-shot runOneShot() helper isn't shaped for. Left as a real gap rather
    // than a silent stub: callers should treat this as unavailable until it's built.
    return { available: false };
}

export async function inferWithWebEngine(engineModuleUrl, csvContent, config) {
    const report = await runOneShot(engineModuleUrl, {
        setup: (Module, directory) => {
            const inputPath = `${directory}/series.csv`;
            const reportPath = `${directory}/inference.bin`;
            Module.FS.writeFile(inputPath, csvContent);
            return { inputPath, reportPath };
        },
        argv: ({ inputPath, reportPath }) => {
            const args = ['infer', inputPath, '--report', reportPath];
            // Only the flags the caller actually set are passed through -- the engine's own
            // InferenceConfig defaults apply to anything omitted, matching inferWithEngine().
            if (config?.skeletonThreshold !== undefined) args.push('--skeleton-threshold', String(config.skeletonThreshold));
            if (config?.coefficientThreshold !== undefined) args.push('--coefficient-threshold', String(config.coefficientThreshold));
            if (config?.validationFraction !== undefined) args.push('--validation-fraction', String(config.validationFraction));
            if (config?.candidateLags !== undefined) args.push('--lags', config.candidateLags.join(','));
            if (config?.ridgePenalties !== undefined) args.push('--ridge-penalties', config.ridgePenalties.join(','));
            if (config?.candidateDegrees !== undefined) args.push('--degrees', config.candidateDegrees.join(','));
            if (config?.includeInteractionTerms !== undefined) args.push('--include-interaction-terms', String(config.includeInteractionTerms));
            return args;
        },
        readOutput: async (Module, { reportPath }) => {
            const { decodeInferenceReport } = await import('./reportProtocol.mjs');
            return decodeInferenceReport(Module.FS.readFile(reportPath));
        }
    });
    return { available: true, report };
}

export async function fitWithWebEngine(engineModuleUrl, content, csvContent, config) {
    const report = await runOneShot(engineModuleUrl, {
        setup: async (Module, directory) => {
            await ensurePythonProvidersReady(Module, content);
            const inputPath = `${directory}/input.kjt`;
            const csvPath = `${directory}/measured.csv`;
            const reportPath = `${directory}/fitting.bin`;
            Module.FS.writeFile(inputPath, await encodeProjectContent(content));
            Module.FS.writeFile(csvPath, csvContent);
            return { inputPath, csvPath, reportPath };
        },
        argv: ({ inputPath, csvPath, reportPath }) => {
            const args = ['fit', inputPath, csvPath, '--report', reportPath];
            if (config?.backend !== undefined) args.push('--backend', config.backend);
            if (config?.maxIterations !== undefined) args.push('--max-iterations', String(config.maxIterations));
            return args;
        },
        readOutput: async (Module, { reportPath }) => {
            const { decodeFittingReport } = await import('./reportProtocol.mjs');
            return decodeFittingReport(Module.FS.readFile(reportPath));
        },
        // Exit code 1 is a completed-but-not-converged fit (see main.cpp's fit branch) -- still a
        // real report worth reading back, matching fitWithEngine()'s own tolerance exactly.
        acceptedExitCodes: [0, 1]
    });
    return { available: true, report };
}

export async function runWithWebEngine(engineModuleUrl, content, configuration) {
    const result = await runOneShot(engineModuleUrl, {
        setup: async (Module, directory) => {
            await ensurePythonProvidersReady(Module, content);
            const inputPath = `${directory}/input.kjt`;
            const configurationPath = `${directory}/runConfiguration.json`;
            const outputPath = `${directory}/result.bin`;
            Module.FS.writeFile(inputPath, await encodeProjectContent(content));
            Module.FS.writeFile(configurationPath, JSON.stringify(configuration));
            return { inputPath, configurationPath, outputPath };
        },
        argv: ({ inputPath, configurationPath, outputPath }) =>
            ['run', inputPath, '--configuration', configurationPath, '--output', outputPath],
        readOutput: (Module, { outputPath }) => decodeResultFile(Module.FS.readFile(outputPath))
    });
    return { available: true, result };
}
