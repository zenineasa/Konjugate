/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Electron side of scripts/exploreApp.mjs (docs/drivingTheApp.md): in place of the interaction suite, runs one script's
// `explore(driver, context)` against the app as the suite launches it, with every native dialog answered by the driver
// (tests/drivers/electronWindowDriver.mjs), then says which dialogs came and how each was answered. It runs in the app's main
// process, so the script has the driver's real mouse and keyboard input, window handles and screenshots.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeDialog } from './drivers/nativeDialogAnswers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls `expression` in `handle`'s window until it is truthy, and returns its value.
async function waitFor(handle, expression, message = `Timed out waiting for ${expression}`, timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const value = await handle.evaluate(expression).catch(() => undefined);
        if (value) return value;
        if (Date.now() > until) throw new Error(message);
        await sleep(100);
    }
}

export async function runExploration(driver, { scriptPath, outputDirectory, heartbeatFile }) {
    // The launcher stops a run whose main process stops answering (a busy loop, a synchronous wait), rather than letting it hang.
    const beat = () => writeFile(heartbeatFile, String(Date.now())).catch(() => {});
    let heartbeat = null;
    if (heartbeatFile) {
        await beat();
        heartbeat = setInterval(beat, 1000);
    }
    await mkdir(outputDirectory, { recursive: true });
    await driver.prepare?.();
    const window = driver.mainHandle;
    // Said as each comes, so the output reads in order with the script's own.
    const stopListening = driver.onNativeDialog((record) => console.log(`  [dialog] ${describeDialog(record)}`));
    let shots = 0;
    const context = {
        window,
        outputDirectory,
        sleep,
        waitFor,
        // A PNG of a window (the project window by default) in the output folder, numbered in the order taken.
        async screenshot(name = 'screenshot', handle = window) {
            shots += 1;
            const path = join(outputDirectory, `${String(shots).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '-')}.png`);
            await driver.screenshot(path, handle);
            console.log(`  [screenshot] ${path}`);
            return path;
        },
        log: (...parts) => console.log(...parts)
    };
    try {
        const module = await import(pathToFileURL(scriptPath).href);
        const explore = module.explore ?? module.default;
        if (typeof explore !== 'function') throw new Error(`${scriptPath} does not export an explore(driver, context) function.`);
        await explore(driver, context);
        driver.checkDialogs();
    } finally {
        stopListening();
        clearInterval(heartbeat);
        const left = driver.clearDialogAnswers();
        if (left.length) console.log(`  ${left.length} dialog answer${left.length === 1 ? ' was' : 's were'} queued and never used: ${left.map((answer) => JSON.stringify(answer)).join(', ')}`);
        const dialogs = driver.nativeDialogs();
        console.log(dialogs.length ? `${dialogs.length} native dialog${dialogs.length === 1 ? '' : 's'} came, none reached the screen${dialogs.some((record) => record.bypassed) ? ' except those marked "dismissed by the watchdog"' : ''}.` : 'No native dialog came.');
        await driver.finish?.();
    }
}
