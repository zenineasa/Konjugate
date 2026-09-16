/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Worker entry point for the web-threads build's real live/streaming run (docs/proposals/
// webEdition.md, phase 6 live runs) -- the counterpart to webEngineWorker.mjs's batch fallback,
// but this one actually streams incremental progress instead of playing back one completed
// result. Only ever loaded by a web-threads build (real live runs need SharedArrayBuffer/Atomics,
// same as C++ providers and parallel execution); see webEngineLiveShim.mjs for how the two
// variants are selected.
//
// Mirrors src/engineAdapter.mjs's startEngineRun() (the desktop live-run implementation) as
// closely as this environment allows, since it is the authoritative real contract src/main.mjs's
// engineStart IPC handler already builds on:
//   - The event stream (stdout, --event-stream protobuf) is NOT itself the source of truth for
//     onUpdate -- it only supplies latestSamples, a lightweight recent-sample cache patched into
//     a polled decode of the OUTPUT FILE when that file's own snapshotMode is 'live' (the engine
//     periodically rewrites --output atomically as it runs; simulationRunner.cpp's own existing,
//     unmodified behavior -- this file does not change how or when that happens, only how the
//     "poll and decode" step is triggered for a WASM module instead of a real OS process).
//   - Desktop polls with a 100ms setInterval; that cannot work in this Worker, since its own JS
//     thread is synchronously blocked inside Module.callMain() for the whole run (a timer queued
//     on a blocked thread never fires until the block ends). Instead, Module.FS.readFile(outputPath)
//     is read and decoded event-DRIVEN, synchronously inside Module.emitEngineEvent() below (the
//     JS side of engine/src/main.cpp's EM_JS event sink), which -- like
//     WasmPyodideProviderBackend's already-proven EM_JS-mid-blocking-execution call
//     (engine/src/providerRuntime.cpp) -- runs as a normal synchronous JS call nested inside the
//     still-blocked callMain(), with full access to Module.FS the same way any other JS code in
//     this Worker would. This is at least as responsive as desktop's polling, typically more so
//     (driven by the engine's own event cadence rather than a fixed 100ms tick).
//   - The control stream (setPacing/setRunState/setParameterValue) is fed via a SharedArrayBuffer
//     ring buffer (webEngineStdinBuffer.mjs) the job's creator (webEngineLiveShim.mjs) writes into
//     directly, and drained synchronously here via Module.drainControlStreamBytes -- called from
//     engine/src/simulationRunner.cpp's own EM_JS poll (see that file's
//     pollEmscriptenControlBytes()), nested inside the still-blocked callMain() the same way
//     Module.emitEngineEvent is. An EARLIER revision of this file instead fed commands through
//     Module.stdin (one byte at a time, matching the native pipe transport's own std::cin-based
//     control stream unchanged) -- confirmed broken by direct testing: commands were silently
//     dropped, because a std::thread spawned from inside callMain() becomes a genuinely separate
//     Worker whose reads get proxied back to THIS thread, which can never service them while
//     busy running the simulation itself. See webEngineStdinBuffer.mjs's own header comment for
//     the full account.

import { decodeResultFile, FramedEngineEventDecoder } from './engineProtocol.mjs';
import { encodeProjectContent } from './browserProjectCodec.mjs';
import { ensureCppProvidersReady, ensurePythonProvidersReady } from './webEngineAdapter.mjs';
import { drainStdinBytes } from './webEngineStdinBuffer.mjs';

self.onmessage = async (startEvent) => {
    const { engineModuleUrl, content, configuration, stdinRing } = startEvent.data;
    const post = (message) => self.postMessage(message);

    let protocolStateIds = [];
    let latestSamples = [];
    let lastSnapshotKey = '';
    const eventDecoder = new FramedEngineEventDecoder();
    const outputPath = '/live/result.bin';

    let Module;
    try {
        const stdoutBuffer = [];
        Module = await import(engineModuleUrl).then((moduleExports) => moduleExports.default({
            print: (text) => stdoutBuffer.push(text),
            printErr: (text) => console.error('[Engine stderr]', text)
        }));
        Module.FS.mkdir('/live');
        await ensurePythonProvidersReady(Module, content);
        await ensureCppProvidersReady(Module, content);
        const inputPath = '/live/input.kjt';
        const configurationPath = '/live/runConfiguration.json';
        Module.FS.writeFile(inputPath, await encodeProjectContent(content));
        Module.FS.writeFile(configurationPath, JSON.stringify(configuration));

        const readAndPostSnapshot = () => {
            let bytes;
            try {
                bytes = Module.FS.readFile(outputPath);
            } catch {
                return; // No result written yet (very early in the run) -- nothing to report.
            }
            let snapshot;
            try {
                snapshot = decodeResultFile(bytes, { maximumSamples: 4000 });
            } catch {
                return; // Mid-write partial content decoded before the engine's next atomic rewrite -- try again on the next event.
            }
            if (snapshot.snapshotMode === 'live') snapshot = { ...snapshot, samples: latestSamples };
            const key = `${snapshot.lifecycle}:${snapshot.samples?.at(-1)?.time ?? snapshot.availableResultTime}:${snapshot.pacing?.mode}:${snapshot.pacing?.simulationSecondsPerWallSecond}`;
            if (key === lastSnapshotKey) return;
            lastSnapshotKey = key;
            post({ type: 'update', result: snapshot });
        };

        // engine/src/simulationRunner.cpp polls the control stream (setPacing/setRunState/
        // setParameterValue) on a steady ~10-40ms cadence regardless of simulation progress --
        // including while paused, when the run loop is otherwise idle and never emits a sample
        // event at all. Piggybacking readAndPostSnapshot() on every control-stream poll (rather
        // than only on emitEngineEvent, below) is what lets a pause/resume/stop transition -- none
        // of which touch the sample-event stream -- actually reach onUpdate promptly instead of
        // going unnoticed until the next real sample event (or never, if the run is paused for a
        // long time, or the engine has already returned from a stop and there is no "next" event
        // at all).
        Module.drainControlStreamBytes = () => {
            const bytes = drainStdinBytes(stdinRing);
            readAndPostSnapshot();
            return bytes;
        };

        // Installed onto Module for engine/src/main.cpp's EM_JS wasmEmitEngineEvent() to call --
        // see that file's own header comment. Runs synchronously, nested inside the still-blocked
        // Module.callMain() call below, exactly once per framed event the engine writes.
        Module.emitEngineEvent = (bytes) => {
            try {
                for (const event of eventDecoder.append(bytes)) {
                    if (event.stateTable) protocolStateIds = event.stateTable;
                    if (event.sampleBatch) {
                        const { times, stateCount, values } = event.sampleBatch;
                        if (stateCount === protocolStateIds.length && values.length === times.length * stateCount) {
                            latestSamples = times.map((time, sampleIndex) => ({
                                time,
                                states: protocolStateIds.map((stateId, stateIndex) => ({
                                    stateId, value: values[sampleIndex * stateCount + stateIndex]
                                }))
                            }));
                        }
                    }
                }
            } catch (error) {
                console.error('[Engine event decode failure]', error.message);
                return;
            }
            readAndPostSnapshot();
        };

        const exitCode = Module.callMain([
            'run', inputPath, '--configuration', configurationPath, '--output', outputPath,
            '--control-stream', 'protobuf', '--event-stream', 'protobuf'
        ]);
        if (exitCode !== 0) {
            throw new Error(stdoutBuffer.join('').trim() || `The engine exited with code ${exitCode}.`);
        }
        const finalBytes = Module.FS.readFile(outputPath);
        const finalSnapshot = decodeResultFile(finalBytes);
        post({ type: 'complete', result: finalSnapshot });
    } catch (error) {
        post({ type: 'error', message: error.message });
    }
};
