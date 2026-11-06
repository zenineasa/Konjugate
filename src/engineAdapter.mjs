/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectFile } from './projectFile.mjs';
import { decodeResultFile, encodeEngineCommand, FramedEngineEventDecoder } from './engineProtocol.mjs';
import { scheduleModeNumbers, waveformProblem } from './parameterSchedule.mjs';
import { fitArguments } from './fitArguments.mjs';
import { decodeFittingProgressEvent, decodeFittingReport, decodeInferenceReport, decodeValidationReport, FramedMessageReader } from './reportProtocol.mjs';
import { resolveInstalledPlugins } from './pluginResolver.mjs';
import { resolveInstalledFmus } from './fmiResolver.mjs';
// A deliberate circular import: postRunStabilityDiagnostics.mjs's own checkSubstepConvergence()
// calls back into this module's runEngine() to drive its substep-doubling search. Safe here
// because both sides only ever use the other's export from inside a function body, never at
// module-top-level evaluation time, which is exactly the shape Node's ESM live-binding
// resolution handles correctly.
import { checkSubstepConvergence } from './postRunStabilityDiagnostics.mjs';
import { liveControlParameterIds } from './sharedParameters.mjs';

function engineFileName() {
    return process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine';
}

export async function resolveEnginePath({ applicationPath, resourcesPath, packaged }) {
    const candidates = [
        process.env.KONJUGATE_ENGINE_PATH,
        packaged ? join(resourcesPath, 'engine', engineFileName()) : join(applicationPath, 'out', 'engine', engineFileName()),
        packaged ? join(resourcesPath, 'engine', 'Release', engineFileName()) : null
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the next supported location.
        }
    }
    return null;
}

export function runEngine(executable, args, environment = {}, signal = null) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            env: { ...process.env, ...environment },
            stdio: ['ignore', 'ignore', 'pipe'],
            ...(signal ? { signal } : {})
        });
        let diagnostics = '';
        let processError = null;
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', (error) => { processError = error; });
        child.once('close', (code) => {
            if (processError) reject(processError);
            else resolve({ code, diagnostics: diagnostics.trim() });
        });
    });
}

// What this specific engine binary actually supports -- e.g. optimizerBackendIds, the set of
// parameter-fitting backends this build was compiled with (see engine/src/main.cpp's
// "capabilities" command). Deliberately not routed through runEngine(): that helper discards
// stdout (its callers all read a --report file instead), but "capabilities" writes its one JSON
// object straight to stdout with no report file involved.
export async function getEngineCapabilities(options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ['capabilities'], { stdio: ['ignore', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}) });
        let stdout = '';
        let diagnostics = '';
        let processError = null;
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', (error) => { processError = error; });
        child.once('close', (code) => {
            if (processError) { reject(processError); return; }
            if (code !== 0) { reject(new Error(diagnostics.trim() || `The engine exited with code ${code}.`)); return; }
            try {
                resolve({ available: true, capabilities: JSON.parse(stdout) });
            } catch (error) {
                reject(new Error(`Could not parse the engine's capabilities output: ${error.message}`));
            }
        });
    });
}

// Whether a tuning objective (the same { expression, variables, constraints } `fitWithEngine` takes as `config.objective`) can be used, and
// if not, why, in the engine's own words: { available, valid, message }. The rules are the engine's alone, so the card can say what is wrong
// as a person writes, with exactly the answer a run would give.
export async function checkObjectiveWithEngine(objective, options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateObjective-'));
    try {
        const objectivePath = join(directory, 'objective.json');
        await writeFile(objectivePath, JSON.stringify(objective), 'utf8');
        const stdout = await new Promise((resolve, reject) => {
            const child = spawn(executable, ['check-objective', objectivePath], { stdio: ['ignore', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}) });
            let output = '';
            let diagnostics = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.stderr.on('data', (chunk) => { diagnostics += chunk; });
            child.once('error', reject);
            child.once('close', (code) => (code === 0 ? resolve(output) : reject(new Error(diagnostics.trim() || `The engine exited with code ${code}.`))));
        });
        return { available: true, ...JSON.parse(stdout) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function validateWithEngine(content, options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateValidation-'));
    const inputPath = join(directory, 'input.kjt');
    const reportPath = join(directory, 'validation.bin');
    try {
        const resolvedContent = await resolveInstalledFmus(await resolveInstalledPlugins(content, options), options);
        await writeFile(inputPath, await encodeProjectFile(resolvedContent));
        const execution = await runEngine(executable, ['validate', inputPath, '--report', reportPath], {}, options.signal);
        if (execution.code !== 0 && execution.code !== 2) {
            throw new Error(execution.diagnostics || `The validation engine exited with code ${execution.code}.`);
        }
        return { available: true, report: decodeValidationReport(await readFile(reportPath)) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Post-run phase of docs/proposals/numericalStabilityDiagnostics.md's "Check convergence" action
// -- deliberately NOT automatic (see that doc's post-run section): a real substep-doubling search
// against the compiled engine, one to several extra runs per requested node, so this only ever
// happens when a user explicitly asks for it from the stability findings panel, not on every
// result. Thin IPC-boundary wrapper around checkSubstepConvergence() (postRunStabilityDiagnostics.mjs),
// which cannot run in the renderer itself (it needs node:fs/node:child_process, unavailable under
// contextIsolation) -- mirrors validateWithEngine's own resolve-plugins-then-temp-directory shape
// immediately above.
export async function checkSubstepConvergenceWithEngine(content, runConfiguration, nodeIds, options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateConvergence-'));
    try {
        const resolvedContent = await resolveInstalledFmus(await resolveInstalledPlugins(content, options), options);
        const resolvedDocument = JSON.parse(resolvedContent);
        const findings = await checkSubstepConvergence({
            executable, document: resolvedDocument,
            // Without this, the configured Provider Toolchains interpreter/compiler (and the
            // Python SDK's own PYTHONPATH injection) never reached the engine here -- see
            // buildProvidersConfiguration's own comment for the real handshake failure this caused.
            runConfiguration: { ...runConfiguration, providers: buildProvidersConfiguration(runConfiguration, options, resolvedDocument) },
            nodeIds, directory
        });
        return { available: true, findings };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function inferWithEngine(csvContent, config, options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateInference-'));
    const inputPath = join(directory, 'series.csv');
    const reportPath = join(directory, 'inference.bin');
    try {
        await writeFile(inputPath, csvContent, 'utf8');
        const args = ['infer', inputPath, '--report', reportPath];
        // Only the flags the caller actually set are passed through -- the engine's own
        // InferenceConfig defaults apply to anything omitted, so a partial config here never
        // silently zeroes out a value the engine would otherwise pick sensibly.
        if (config?.skeletonThreshold !== undefined) args.push('--skeleton-threshold', String(config.skeletonThreshold));
        if (config?.coefficientThreshold !== undefined) args.push('--coefficient-threshold', String(config.coefficientThreshold));
        if (config?.validationFraction !== undefined) args.push('--validation-fraction', String(config.validationFraction));
        if (config?.candidateLags !== undefined) args.push('--lags', config.candidateLags.join(','));
        if (config?.ridgePenalties !== undefined) args.push('--ridge-penalties', config.ridgePenalties.join(','));
        if (config?.candidateDegrees !== undefined) args.push('--degrees', config.candidateDegrees.join(','));
        if (config?.includeInteractionTerms !== undefined) args.push('--include-interaction-terms', String(config.includeInteractionTerms));
        const execution = await runEngine(executable, args, {}, options.signal);
        if (execution.code !== 0) {
            throw new Error(execution.diagnostics || `The inference engine exited with code ${execution.code}.`);
        }
        return { available: true, report: decodeInferenceReport(await readFile(reportPath)) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Digital-twin parameter fitting. The whole optimization loop runs inside the engine binary itself (see
// engine/src/parameterFitting.cpp), so there is one process per fit, not one per trial. While it runs the engine writes a framed
// FittingProgressEvent to stdout after every simulation, which `onProgress` receives, and a person's "stop" reaches it through a
// file it checks between simulations (`requestStop`, handed to `onStart`): it then ends the search and reports the best values it
// found, as if it had finished, unlike aborting the signal, which kills the process and keeps nothing.
//
// `config.objective` ({ expression, direction: 'minimise' | 'maximise', targetTime, timeStep, variables, constraints: [{ expression, relation: '<=' | '>=', limit }] }) replaces the squared error
// against the CSV with an expression of the run (engine/include/fittingObjective.hpp); `csvContent` may then be empty, and only supplies
// columns the expression names. The values in events and in the report are the objective as written, rising when it is maximised.
export async function fitWithEngine(content, csvContent, config, options) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFitting-'));
    const inputPath = join(directory, 'input.kjt');
    const csvPath = join(directory, 'measured.csv');
    const reportPath = join(directory, 'fitting.bin');
    const stopPath = join(directory, 'stop');
    try {
        const resolvedContent = await resolveInstalledFmus(await resolveInstalledPlugins(content, options), options);
        await writeFile(inputPath, await encodeProjectFile(resolvedContent));
        await writeFile(csvPath, csvContent ?? '', 'utf8');
        const objectivePath = join(directory, 'objective.json');
        if (config?.objective) await writeFile(objectivePath, JSON.stringify(withProgramToolchains(config.objective, options)), 'utf8');
        const args = fitArguments({ inputPath, csvPath, reportPath, objectivePath, stopPath, progress: true }, config);
        options.onStart?.({ requestStop: () => writeFile(stopPath, '') });
        const execution = await runEngineWithFramedOutput(executable, args, options.signal, (message) => options.onProgress?.(decodeFittingProgressEvent(message)));
        if (execution.code !== 0 && execution.code !== 1) {
            // Exit code 1 is a completed-but-not-converged fit (see main.cpp's fit branch) --
            // still a real report worth reading back, unlike every other nonzero code here.
            throw new Error(execution.diagnostics || `The fitting engine exited with code ${execution.code}.`);
        }
        return { available: true, report: decodeFittingReport(await readFile(reportPath)) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// An objective written as a program is built and run with the same toolchains as a provider: the Python interpreter and SDK, and
// the C++ compiler and the engine's SDK (include/ and the glue main in src/), from the Provider Toolchains choices or found as usual.
export function withProgramToolchains(objective, options) {
    if (!objective?.program) return objective;
    return {
        ...objective,
        program: {
            ...objective.program,
            python: { sdkPath: pythonProviderSdkPath(options), ...(options.providerToolchains?.python?.interpreterPath ? { interpreter: options.providerToolchains.python.interpreterPath } : {}), ...objective.program.python },
            cpp: { sdkPath: cppProviderSdkPath(options), ...(options.providerToolchains?.cpp?.compilerPath ? { compiler: options.providerToolchains.cpp.compilerPath } : {}), ...objective.program.cpp }
        }
    };
}

// Like runEngine, but reads stdout as framed messages, handing each to `onMessage` as it arrives.
function runEngineWithFramedOutput(executable, args, signal, onMessage) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
        const reader = new FramedMessageReader();
        let diagnostics = '';
        let processError = null;
        child.stdout.on('data', (chunk) => {
            for (const message of reader.append(chunk)) {
                try { onMessage(message); } catch (error) { console.warn('A fitting progress message could not be read.', error); }
            }
        });
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', (error) => { processError = error; });
        child.once('close', (code) => {
            if (processError) reject(processError);
            else resolve({ code, diagnostics: diagnostics.trim() });
        });
    });
}

export async function runWithEngine(content, configuration, options) {
    const execution = await startEngineRun(content, configuration, options);
    if (!execution.available) return execution;
    return { available: true, result: await execution.completion };
}

export function normalizePacing(pacing = {}) {
    const mode = pacing.mode ?? 'fastest';
    const ratio = mode === 'realTime' ? 1 : Number(pacing.simulationSecondsPerWallSecond ?? 1);
    if (!['fastest', 'realTime', 'limitedRatio'].includes(mode)) throw new Error('Unsupported simulation pacing mode.');
    if (mode === 'limitedRatio' && (!(ratio > 0) || !Number.isFinite(ratio))) {
        throw new Error('Limited simulation pacing requires a finite positive ratio.');
    }
    return { mode, simulationSecondsPerWallSecond: ratio };
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function cppProviderSdkPath({ applicationPath, resourcesPath, packaged }) {
    // buildCppProvider() expects this to be the engine/ root: it compiles against
    // <sdkPath>/include and links <sdkPath>/src/providerWorker.cpp.
    return join(packaged ? resourcesPath : applicationPath, 'engine');
}

function pythonProviderSdkPath({ applicationPath, resourcesPath, packaged }) {
    // Put on the provider process's PYTHONPATH; must be the directory containing the
    // konjugate/ package, not the package directory itself.
    return join(packaged ? resourcesPath : applicationPath, 'engine', 'sdk', 'python');
}

// Shared by startEngineRun and checkSubstepConvergenceWithEngine below -- both write a
// runConfiguration.json the engine reads providers.{cpp,python}.{sdkPath,compiler,interpreter}
// and providers.executionMode from (engine/src/simulationRunner.cpp), and both need the exact same
// precedence to actually honor a configured Provider Toolchains path rather than silently falling
// back to a bare "python3"/"cc" the OS resolves on its own (on macOS, Apple's CommandLineTools
// stub python3, which has no third-party packages installed; on Windows, the Microsoft Store App
// Execution Alias stub) -- confirmed as the exact cause of a real "No module named konjugate" /
// "Python was not found" handshake failure when checkSubstepConvergenceWithEngine used to build
// its own runConfiguration without this block at all.
export function buildProvidersConfiguration(configuration, options, resolvedDocument) {
    // A cpp computational-node provider (an FMI import is always one; a hand-authored one could
    // be too) only ever runs in-process -- engine/src/providerRuntime.cpp deliberately gives it
    // no worker-process fallback, since providerWorker.cpp has no node-provider protocol for C++
    // at all. Falling back to the ordinary sharedMemoryWorker default for such a document would
    // fail the run outright, so its presence overrides the default tier (but never an executionMode
    // the caller/env/toolchain preference actually asked for -- see the precedence comment below).
    const requiresInProcessNodeProvider = resolvedDocument.nodes?.some((node) => node.implementation?.kind === 'cpp') ?? false;
    return {
        ...configuration.providers,
        // See ProviderExecutionMode in the engine. Precedence: an explicit per-run override
        // (not currently set by anything in this app, but available to callers/tests) wins
        // over a developer's session-scoped env var override, which wins over the user's
        // own choice in the Provider Toolchains dialog's advanced section (empty string
        // there means "Automatic" — deliberately falsy, so it falls through here), which
        // falls back to sharedMemoryWorker as the default -- unless the resolved document
        // requires the in-process transport outright (see above), in which case that default
        // becomes inProcess instead. ProviderRuntime already falls back to the pipe transport
        // per-process on any higher-tier setup failure, so defaulting sharedMemoryWorker on
        // is safe even for users who never touch this.
        executionMode: configuration.providers?.executionMode
            || process.env.KONJUGATE_PROVIDER_EXECUTION_MODE
            || options.providerToolchains?.executionMode
            || (requiresInProcessNodeProvider ? 'inProcess' : 'sharedMemoryWorker'),
        cpp: {
            sdkPath: cppProviderSdkPath(options),
            ...(options.providerToolchains?.cpp?.compilerPath ? { compiler: options.providerToolchains.cpp.compilerPath } : {}),
            ...configuration.providers?.cpp
        },
        python: {
            sdkPath: pythonProviderSdkPath(options),
            ...(options.providerToolchains?.python?.interpreterPath ? { interpreter: options.providerToolchains.python.interpreterPath } : {}),
            ...configuration.providers?.python
        }
    };
}

export async function startEngineRun(content, configuration, options, { onUpdate, retainResult = false } = {}) {
    const executable = await resolveEnginePath(options);
    if (!executable) return { available: false };
    const directory = await mkdtemp(join(tmpdir(), 'konjugateRun-'));
    const inputPath = join(directory, 'input.kjt');
    const configurationPath = join(directory, 'runConfiguration.json');
    const outputPath = join(directory, 'simulationResult.bin');
    const jobId = randomUUID();
    const initialPacing = normalizePacing(configuration.pacing);
    const resolvedContent = await resolveInstalledFmus(await resolveInstalledPlugins(content, options), options);
    await writeFile(inputPath, await encodeProjectFile(resolvedContent));
    const resolvedDocument = JSON.parse(resolvedContent);
    await writeFile(configurationPath, JSON.stringify({
        ...configuration,
        pacing: initialPacing,
        // During-run phase of docs/proposals/numericalStabilityDiagnostics.md: every interactive
        // run through this app monitors every node by default (Tier 1 is cheap by design
        // specifically so this is affordable -- see that doc's cost-bounding discussion), unless
        // the caller already set its own stabilityMonitoring (e.g. a test wanting a narrower or
        // empty scope). This only applies to this JS-level entry point, not the engine's `run`
        // CLI used directly (tests, scripted/batch use) -- those still default to unmonitored,
        // exactly as engine/src/simulationRunner.cpp itself already does.
        stabilityMonitoring: configuration.stabilityMonitoring ?? { nodeIds: (resolvedDocument.nodes ?? []).map((node) => node.id) },
        providers: buildProvidersConfiguration(configuration, options, resolvedDocument)
    }));
    const parsedDocument = JSON.parse(content);
    const liveParameterIds = liveControlParameterIds(parsedDocument);
    const child = spawn(executable, [
        'run', inputPath,
        '--configuration', configurationPath,
        '--output', outputPath,
        '--control-stream', 'protobuf',
        ...(onUpdate ? ['--event-stream', 'protobuf'] : [])
    ], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '';
    let lastSnapshotError = null;
    let lastSnapshotKey = '';
    let polling = false;
    let latestSamples = [];
    let protocolStateIds = [];
    let childExited = false;
    let shutdownPromise = null;
    let commandSequence = 0;
    let commandWrite = Promise.resolve();
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
    };
    child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        diagnostics += text;
        console.error('[Engine stderr]', text.trim());
    });
    const eventDecoder = new FramedEngineEventDecoder();
    child.stdout.on('data', (chunk) => {
        try {
            for (const event of eventDecoder.append(chunk)) {
                if (event.stateTable) protocolStateIds = event.stateTable;
                if (event.sampleBatch) {
                    const { times, stateCount, values } = event.sampleBatch;
                    if (stateCount !== protocolStateIds.length || values.length !== times.length * stateCount) {
                        throw new Error('The engine returned an inconsistent Protobuf sample batch.');
                    }
                    latestSamples = times.map((time, sampleIndex) => ({
                        time,
                        states: protocolStateIds.map((stateId, stateIndex) => ({
                            stateId,
                            value: values[sampleIndex * stateCount + stateIndex]
                        }))
                    }));
                }
            }
        } catch (error) {
            diagnostics += `\nENGINE_PROTOCOL_FAILURE: ${error.message}`;
            child.kill('SIGTERM');
        }
    });

    const readSnapshot = async () => {
        if (polling) return null;
        polling = true;
        try {
            const bytes = await readFile(outputPath);
            let snapshot = decodeResultFile(bytes, onUpdate ? { maximumSamples: 4000 } : undefined);
            lastSnapshotError = null;
            if (snapshot.snapshotMode === 'live') {
                snapshot = { ...snapshot, samples: latestSamples };
            }
            const key = `${snapshot.lifecycle}:${snapshot.samples?.at(-1)?.time ?? snapshot.availableResultTime}:${snapshot.interventions?.length ?? 0}:${snapshot.pacing?.mode}:${snapshot.pacing?.simulationSecondsPerWallSecond}`;
            if (key !== lastSnapshotKey) {
                lastSnapshotKey = key;
                onUpdate?.(structuredClone(snapshot));
            }
            return snapshot;
        } catch (error) {
            lastSnapshotError = error;
            return null;
        } finally {
            polling = false;
        }
    };
    // Without a consumer, nobody needs an in-progress snapshot -- skip the recurring read+decode of
    // the (growing) result file and just decode it once at the end, in finalize below.
    const pollTimer = onUpdate ? setInterval(readSnapshot, 100) : null;

    const completion = new Promise((resolve, reject) => {
        let finalized = false;
        const finalize = async (code, processError = null) => {
            if (finalized) return;
            finalized = true;
            childExited = true;
            child.stdin.destroy();
            clearInterval(pollTimer);
            while (polling) await new Promise((resolvePolling) => setTimeout(resolvePolling, 5));
            const result = await readSnapshot();
            let failure = processError;
            try {
                if (failure) throw failure;
                if (code !== 0) throw new Error(diagnostics.trim() || `The simulation engine exited with code ${code}.`);
                if (!result) throw new Error(lastSnapshotError
                    ? `The simulation engine result could not be read: ${lastSnapshotError.message}`
                    : 'The simulation engine did not produce a result.');
            } catch (error) {
                failure = error;
            }
            if (failure || !retainResult) {
                try {
                    await cleanup();
                } catch (error) {
                    failure ??= error;
                }
            }
            if (failure) reject(failure);
            else resolve(result);
        };
        child.once('error', (error) => { void finalize(null, error); });
        child.once('exit', (code) => { void finalize(code); });
    });

    const sendCommand = (command) => {
        const frame = encodeEngineCommand(++commandSequence, command);
        commandWrite = commandWrite.then(() => new Promise((resolve, reject) => {
            if (childExited || child.stdin.destroyed) {
                reject(new Error('The simulation engine is no longer accepting commands.'));
                return;
            }
            child.stdin.write(frame, (error) => error ? reject(error) : resolve());
        }));
        commandWrite.catch(() => {});
        return commandWrite;
    };

    const closeCommandStream = async () => {
        await commandWrite.catch(() => {});
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
            await new Promise((resolve) => child.stdin.end(resolve));
        }
    };

    const awaitExit = async (timeoutMilliseconds) => {
        if (childExited) {
            await completion.catch(() => {});
            return true;
        }
        return Promise.race([
            completion.then(() => true, () => true),
            delay(timeoutMilliseconds).then(() => false)
        ]);
    };

    const shutdown = ({ gracefulTimeoutMilliseconds = 1500, terminationTimeoutMilliseconds = 1000 } = {}) => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            if (!childExited) {
                await sendCommand({ type: 'setRunState', state: 'stopped' }).catch(() => {});
                await closeCommandStream().catch(() => {});
            }
            if (await awaitExit(gracefulTimeoutMilliseconds)) return;
            child.kill('SIGTERM');
            if (await awaitExit(terminationTimeoutMilliseconds)) return;
            if (!child.kill('SIGKILL') && !childExited) throw new Error('The simulation engine could not be terminated.');
            await completion.catch(() => {});
        })();
        return shutdownPromise;
    };

    const cancel = () => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            if (!childExited) {
                child.stdin.destroy();
                child.kill('SIGTERM');
            }
            if (await awaitExit(1000)) return;
            if (!child.kill('SIGKILL') && !childExited) throw new Error('The simulation engine could not be cancelled.');
            await completion.catch(() => {});
        })();
        return shutdownPromise;
    };

    return {
        available: true,
        jobId,
        completion,
        resultPath: outputPath,
        cleanup,
        setPacing: async (pacing) => {
            const normalized = normalizePacing(pacing);
            await sendCommand({ type: 'setPacing', pacing: normalized });
            return normalized;
        },
        setExecutionState: async (executionState) => {
            if (!['running', 'paused', 'stopped'].includes(executionState)) throw new Error('Unsupported execution state.');
            await sendCommand({ type: 'setRunState', state: executionState });
            if (executionState === 'stopped') await closeCommandStream();
            return executionState;
        },
        setParameterValue: async (parameterId, parameterValue) => {
            const value = Number(parameterValue);
            if (!liveParameterIds.has(parameterId)) throw new Error('That parameter is not available for live control.');
            if (!Number.isFinite(value)) throw new Error('A live parameter value must be finite.');
            await sendCommand({ type: 'setParameterValue', parameterId, value });
            return { parameterId, value };
        },
        // A recorded, timestamped intervention (see docs/resultExploration.md's "Parameter
        // interventions") rather than an instantaneous override -- appended to the run's active
        // schedule list, not replacing the previous value outright. samples is only meaningful
        // (and required, at least two) for mode "piecewise".
        scheduleParameterValue: async (parameterId, schedule) => {
            if (!liveParameterIds.has(parameterId)) throw new Error('That parameter is not available for live control.');
            if (!(schedule?.mode in scheduleModeNumbers)) throw new Error('Unsupported parameter schedule mode.');
            const startTime = Number(schedule.startTime ?? 0);
            const duration = Number(schedule.duration ?? 0);
            const targetValue = Number(schedule.targetValue ?? 0);
            const baseValue = Number(schedule.baseValue ?? 0);
            if (![startTime, duration, targetValue, baseValue].every(Number.isFinite)) {
                throw new Error('A parameter schedule requires finite numeric fields.');
            }
            const samples = schedule.mode === 'piecewise' ? (schedule.samples ?? []).map((sample) => ({
                time: Number(sample.time), value: Number(sample.value)
            })) : undefined;
            if (schedule.mode === 'piecewise') {
                if (samples.length < 2) throw new Error('A piecewise parameter schedule requires at least two samples.');
                if (!samples.every((sample) => Number.isFinite(sample.time) && Number.isFinite(sample.value))) {
                    throw new Error('A piecewise parameter schedule requires finite numeric samples.');
                }
            }
            const waveform = schedule.mode === 'waveform' ? schedule.waveform : undefined;
            if (schedule.mode === 'waveform') {
                const problem = waveformProblem({ ...waveform, duration });
                if (problem) throw new Error(problem);
            }
            await sendCommand({ type: 'scheduleParameterValue', parameterId, mode: schedule.mode, startTime, duration, targetValue, baseValue, samples, waveform });
            return { parameterId, ...schedule };
        },
        shutdown,
        cancel
    };
}
