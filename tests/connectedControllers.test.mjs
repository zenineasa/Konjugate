/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { bluetoothSettingsUrl, controllersFromHid, controllersNotSeen, gamepadHidFilters, isSameController } from '../src/connectedControllers.mjs';

// What Chromium listed on a Mac with two PlayStation 4 controllers paired: each controller, and macOS's own virtual pad for each.
const ds4 = { name: 'DUALSHOCK 4 Wireless Controller', vendorId: 0x054c, productId: 0x09cc };
const listed = [
    { deviceId: '04cc8b71-e9ba-413e-85e6-15b80584f9ce', name: 'GamePad-1', vendorId: 0x045e, productId: 0x028e },
    { deviceId: '1922067537', ...ds4 },
    { deviceId: 'a5904c4c-ab98-4e0b-bd3c-b94662b8a664', name: 'GamePad-1', vendorId: 0x045e, productId: 0x028e },
    { deviceId: '1922722524', ...ds4 }
];

test('the HID list gives each connected controller, two of a model as two, without the system\'s own virtual pads', () => {
    assert.deepEqual(controllersFromHid(listed), [ds4, ds4]);
    assert.deepEqual(controllersFromHid([ds4, ds4]), [ds4], 'Entries with no device id count once by their model.');
    assert.deepEqual(controllersFromHid([{ name: '', vendorId: 0x046d, productId: 0xc215 }]), [{ name: 'Controller 046d:c215', vendorId: 0x046d, productId: 0xc215 }]);
    assert.deepEqual(controllersFromHid(), []);
});

test('a connected controller is matched to the gamepad a page sees by its name or by its vendor and product', () => {
    assert.equal(isSameController(ds4, 'DUALSHOCK 4 Wireless Controller (STANDARD GAMEPAD)'), true);
    assert.equal(isSameController(ds4, 'DUALSHOCK 4 Wireless Controller (STANDARD GAMEPAD) #2'), true);
    assert.equal(isSameController(ds4, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), true);
    assert.equal(isSameController(ds4, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), false);
});

test('the controllers not seen yet are those connected with no gamepad on the page, one gamepad for each', () => {
    const twins = [{ name: 'Joystick', vendorId: 1, productId: 2 }, { name: 'Joystick', vendorId: 1, productId: 2 }];
    assert.equal(controllersNotSeen(twins, []).length, 2);
    assert.equal(controllersNotSeen(twins, ['Joystick (Vendor: 0001 Product: 0002)']).length, 1);
    assert.equal(controllersNotSeen(twins, ['Joystick', 'Joystick #2']).length, 0);
});

test('the filters ask for joysticks, gamepads and multi-axis controllers, and Bluetooth settings open where there is one place', () => {
    assert.deepEqual(gamepadHidFilters.map((filter) => filter.usage), [4, 5, 8]);
    assert.match(bluetoothSettingsUrl('darwin'), /^x-apple\.systempreferences:/);
    assert.equal(bluetoothSettingsUrl('win32'), 'ms-settings:bluetooth');
    assert.equal(bluetoothSettingsUrl('linux'), null);
});
