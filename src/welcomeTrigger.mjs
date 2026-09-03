/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A window already exists whenever a user clicks "New" (ipcMain.on('newProjectWindow', ...) in
// main.mjs), so that call site never needs this guard -- only the two zero-window entry points
// (first launch, and macOS dock-reactivation with no windows open) call it. Both harness flags
// suppress it: --interaction-test and --generate-example-thumbnails both drive the first window
// directly via a did-finish-load listener, and an unrelated second (Welcome) window appearing
// underneath either would risk stealing focus from them.
//
// Extracted into its own Electron-free module specifically so it's unit-testable: main.mjs's
// top-level `import ... from 'electron'` throws under plain `node --test`, so this guard couldn't
// be tested at all if it stayed inline inside main.mjs's app.whenReady() closure.
export function shouldSkipWelcomeTrigger(argv = process.argv) {
    return argv.includes('--interaction-test') || argv.includes('--generate-example-thumbnails');
}
