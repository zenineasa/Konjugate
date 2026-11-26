/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Registered on every session while the app is driven (interceptNativeDialogs in electronWindowDriver.mjs), so it runs before each
// window's own preload and page: a window's alert, confirm and prompt, which Electron shows as native dialogs, are answered by the
// driver instead (synchronously, as the page expects), in the page's world and in the preloads' own. Test tooling only: the app
// never loads this file.

const { contextBridge, ipcRenderer } = require('electron');

const channel = 'konjugate-test:native-dialog';
const ask = (kind, message, defaultText) => {
    const reply = ipcRenderer.sendSync(channel, { kind, message: message === undefined ? '' : String(message), ...(defaultText === undefined ? {} : { defaultText: String(defaultText) }) });
    return reply && typeof reply === 'object' ? reply.value : undefined;
};

// Written to run in either world: in the page's it is serialized (so it uses nothing from here) and given `ask` across the bridge.
function install(askDriver, target = globalThis) {
    target.alert = function alert(message) { askDriver('alert', message); };
    target.confirm = function confirm(message) { return askDriver('confirm', message) === true; };
    target.prompt = function prompt(message, defaultText) {
        const answer = askDriver('prompt', message, defaultText);
        return typeof answer === 'string' ? answer : null;
    };
}

install(ask);
if (process.contextIsolated) {
    try {
        contextBridge.executeInMainWorld({ func: install, args: [ask] });
    } catch (error) {
        // The watchdog still catches a dialog the page then shows, and says so.
        console.error(`Native dialog interception could not reach the page: ${error.message}`);
    }
}
