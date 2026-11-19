/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the computer has connected, as opposed to what a page has been shown (docs/proposals/humanInputBinding.md, "Settings ›
// Controllers"). A browser shows a page a gamepad only once one of its buttons has been pressed while the page is in front, so a page alone
// cannot tell "nothing is connected" from "something is connected but has not been used here yet". The desktop app can: its main process
// lists the gamepads and joysticks the system has (through Chromium's HID device list, answered without showing a chooser), and the
// Controllers page names the ones not seen yet, or says nothing is connected at all. Shared by the main process and the renderer.

// The HID usages of a game controller: generic desktop's joystick, gamepad and multi-axis controller.
export const gamepadHidFilters = Object.freeze([{ usagePage: 0x01, usage: 0x04 }, { usagePage: 0x01, usage: 0x05 }, { usagePage: 0x01, usage: 0x08 }]);

// Devices the system makes for itself, not controllers anyone connected: macOS adds a "GamePad-1" (an Xbox 360 controller's ids) on its
// internal bus for each controller connected, which never sends anything.
const virtual = (device) => /^GamePad-\d+$/.test(device.name ?? '');

const hex = (number) => Number(number ?? 0).toString(16).padStart(4, '0');

// The controllers in a HID device list: [{ name, vendorId, productId }], one per controller (two of the same model are two, told apart by
// Chromium's device id; an entry without one counts once by its model) and without the system's own.
export function controllersFromHid(deviceList = []) {
    const kept = new Map();
    for (const device of deviceList) {
        if (!device || virtual(device)) continue;
        const name = String(device.name ?? '').trim() || `Controller ${hex(device.vendorId)}:${hex(device.productId)}`;
        const key = device.deviceId ? `device|${device.deviceId}` : `${device.vendorId}|${device.productId}|${name}`;
        if (!kept.has(key)) kept.set(key, { name, vendorId: Number(device.vendorId) || 0, productId: Number(device.productId) || 0 });
    }
    return [...kept.values()];
}

// Whether a gamepad the page sees (by its Gamepad API id: "DUALSHOCK 4 Wireless Controller (STANDARD GAMEPAD)" on macOS, "Wireless
// Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)" in Chrome elsewhere) is this connected controller.
export function isSameController(controller, gamepadId) {
    const id = String(gamepadId ?? '').toLowerCase();
    if (controller.vendorId && id.includes(hex(controller.vendorId)) && id.includes(hex(controller.productId))) return true;
    return Boolean(controller.name) && id.includes(controller.name.toLowerCase());
}

// The connected controllers the page has not been shown yet: each needs one of its buttons pressed while the window is in front.
export function controllersNotSeen(controllers, gamepadIds) {
    const left = [...gamepadIds];
    return controllers.filter((controller) => {
        const index = left.findIndex((id) => isSameController(controller, id));
        if (index < 0) return true;
        left.splice(index, 1);
        return false;
    });
}

// Where the system's Bluetooth settings open, for the "Open Bluetooth settings" button; null where there is no one place to open.
export function bluetoothSettingsUrl(platform) {
    if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.BluetoothSettings';
    if (platform === 'win32') return 'ms-settings:bluetooth';
    return null;
}
