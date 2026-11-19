/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHumanInput, gamepadName } from '../src/renderer/humanInput.mjs';

const ds4 = 'DUALSHOCK 4 Wireless Controller (STANDARD GAMEPAD)';
const pad = (index, id = ds4) => ({ index, id, mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ value: 0, pressed: false })) });

// A page with the gamepads given, read once per poll; frames run by hand.
function fakeHost(gamepads) {
    return {
        navigator: { getGamepads: () => gamepads },
        document: { visibilityState: 'visible', hasFocus: () => true },
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
        addEventListener: () => {}, removeEventListener: () => {}
    };
}

test('two controllers of the same model are two devices: the first keeps its id, the second is told apart', () => {
    const gamepads = [pad(0), null, pad(2)];
    const input = createHumanInput({ host: fakeHost(gamepads) });
    input.start();
    assert.deepEqual(input.readings().map((reading) => [reading.id, reading.name]), [
        [ds4, 'DUALSHOCK 4 Wireless Controller'],
        [`${ds4} #2`, 'DUALSHOCK 4 Wireless Controller 2']
    ]);
    // Each one's stick read as its own.
    const moved = [];
    input.onReading((reading) => moved.push([reading.device.id, reading.control.index, reading.value]));
    gamepads[2].axes[1] = 1;
    input.simulated.poll();
    assert.deepEqual(moved, [[`${ds4} #2`, 1, 1]]);
    // The second unplugged: the first stays as it was.
    gamepads[2] = null;
    input.simulated.poll();
    assert.deepEqual(input.readings().map((reading) => reading.id), [ds4]);
    input.stop();
});

test('a gamepad\'s name drops what the browser adds in brackets, and numbers a second of a kind', () => {
    assert.equal(gamepadName(ds4), 'DUALSHOCK 4 Wireless Controller');
    assert.equal(gamepadName(`${ds4} #3`), 'DUALSHOCK 4 Wireless Controller 3');
    assert.equal(gamepadName('Left joystick (simulated)'), 'Left joystick');
});
