/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Worker entry point for the web shell's batch Run fallback (docs/proposals/webEdition.md,
// phase 3) -- runs webEngineAdapter.mjs's existing, already-verified one-shot runWithWebEngine()
// off the main thread, so the page stays responsive while the WASM module's blocking
// Module.callMain() runs the whole simulation. See src/webEngineLiveShim.mjs for why this is a
// batch fallback rather than a true live/streaming run.

import { runWithWebEngine } from './webEngineAdapter.mjs';

self.onmessage = async (event) => {
    const { requestId, engineModuleUrl, content, configuration } = event.data;
    try {
        const outcome = await runWithWebEngine(engineModuleUrl, content, configuration);
        self.postMessage({ requestId, ok: true, outcome });
    } catch (error) {
        self.postMessage({ requestId, ok: false, message: error.message });
    }
};
