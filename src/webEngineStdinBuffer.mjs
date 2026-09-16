/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A SharedArrayBuffer-backed single-producer/single-consumer byte ring buffer, used to feed live
// EngineCommand frames (setPacing/setRunState/setParameterValue -- src/engineProtocol.mjs's
// encodeEngineCommand) into a running web-threads engine's control stream (docs/proposals/
// webEdition.md, phase 6 live runs).
//
// This is a synchronous, non-blocking drain, not the blocking-stdin-callback design an earlier
// revision of this file used (Module.stdin, one byte at a time, Atomics.wait-based blocking on an
// empty ring). That design was confirmed broken by direct testing in a real browser: pause/
// setPacing/setParameterValue commands were silently dropped, never reaching
// engine/src/simulationRunner.cpp's control-command handling at all. The root cause (also
// confirmed directly, by inspecting Emscripten's own generated glue): a pthread-enabled
// MODULARIZE'd module's FS/TTY state -- including Module.stdin's registration -- is only ever
// initialized on the thread that instantiates the module (Emscripten's own "main runtime thread"
// concept); a std::thread spawned from inside callMain() (engine/src/simulationRunner.cpp's
// startControlReader()) becomes a genuinely separate Worker whose own read() calls get proxied
// back to that instantiating thread -- but that thread is the SAME one permanently busy running
// the simulation loop for the whole run, so a proxied call to it can never actually be serviced.
// See engine/src/simulationRunner.cpp's pollEmscriptenControlBytes() for the replacement: a
// synchronous, non-blocking EM_JS poll made from the SAME thread already running the simulation
// loop, called from inside its own existing per-step control-refresh cadence -- exactly the
// pattern engine/src/main.cpp's emitEngineEvent already uses successfully for the output
// direction. Module.drainControlStreamBytes (installed by src/webEngineLiveRunWorker.mjs, wired
// to drainStdinBytes() below) is that poll's JS-side implementation.
//
// Layout: one Int32Array(2) control region [readPos, writePos], followed by `capacity` bytes of
// ring storage. No blocking primitive is needed on either side (the producer writes and returns;
// the consumer drains whatever is currently available and returns), so no "generation"/"closed"
// signaling is needed either -- unlike an earlier revision of this file.
const CONTROL_LENGTH_INTS = 2;

export function createStdinRingBuffer(capacityBytes = 4096) {
    const sharedBuffer = new SharedArrayBuffer(CONTROL_LENGTH_INTS * Int32Array.BYTES_PER_ELEMENT + capacityBytes);
    return { sharedBuffer, capacityBytes };
}

function views({ sharedBuffer, capacityBytes }) {
    return {
        control: new Int32Array(sharedBuffer, 0, CONTROL_LENGTH_INTS),
        data: new Uint8Array(sharedBuffer, CONTROL_LENGTH_INTS * Int32Array.BYTES_PER_ELEMENT, capacityBytes)
    };
}

// Producer side (webEngineLiveShim.mjs, on whichever thread creates the live-run Worker --
// typically the page's real main thread). Capacity is sized generously relative to real command
// frames (a handful to a few dozen bytes each -- see encodeEngineCommand); queuing more unconsumed
// bytes than fit throws rather than silently corrupting the ring, which should never happen in
// practice (nothing here queues commands faster than a person can interact with pacing/parameter
// controls, and the consumer drains at least every ~10ms while a run is active).
export function pushStdinBytes(ring, bytes) {
    const { control, data } = views(ring);
    for (const byte of bytes) {
        const writePos = Atomics.load(control, 1);
        const nextWritePos = (writePos + 1) % data.length;
        if (nextWritePos === Atomics.load(control, 0)) {
            throw new Error('The live-run control buffer is full.');
        }
        data[writePos] = byte;
        Atomics.store(control, 1, nextWritePos);
    }
}

// Consumer side: called synchronously from engine/src/simulationRunner.cpp's EM_JS
// wasmDrainControlBytes() (via Module.drainControlStreamBytes, installed by
// webEngineLiveRunWorker.mjs), on the same thread running the simulation loop. Returns whatever is
// currently queued (possibly empty) and advances the read position past it; never blocks.
export function drainStdinBytes(ring) {
    const { control, data } = views(ring);
    const readPos = Atomics.load(control, 0);
    const writePos = Atomics.load(control, 1);
    if (readPos === writePos) return new Uint8Array(0);
    let result;
    if (writePos > readPos) {
        result = data.slice(readPos, writePos);
    } else {
        result = new Uint8Array(data.length - readPos + writePos);
        result.set(data.subarray(readPos), 0);
        result.set(data.subarray(0, writePos), data.length - readPos);
    }
    Atomics.store(control, 0, writePos);
    return result;
}
