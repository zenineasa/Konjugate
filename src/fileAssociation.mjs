/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Finds a .kjt path in an argv array (an OS double-click, a relaunch's second-instance argv,
// or the initial launch's process.argv) -- skips anything that looks like a flag so CLI
// switches like --interaction-test are never mistaken for a file path.
export function parseKjtPathFromArgv(argv) {
    return argv.find((arg) => !arg.startsWith('-') && arg.toLowerCase().endsWith('.kjt')) ?? null;
}
