/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerFocus } from '../src/inputFocus.mjs';

const project = { name: 'project' };
const twin = { name: 'twin' };
const poseView = { name: 'Pose Visualizer' };
const steering = [project, twin];

test('the steering window last used keeps its controllers while another of Konjugate\'s windows has focus, and none does in another app', () => {
    // In the project window: it has them itself, by its own focus.
    let state = controllerFocus({ focused: project, steering, owner: null });
    assert.deepEqual(state, { owner: project, handedTo: null });
    // The Pose Visualizer in front: the project window keeps them.
    state = controllerFocus({ focused: poseView, steering, owner: state.owner });
    assert.deepEqual(state, { owner: project, handedTo: project });
    // Another application in front: no window reads them, but the project window is still the one to go back to.
    state = controllerFocus({ focused: null, steering, owner: state.owner });
    assert.deepEqual(state, { owner: project, handedTo: null });
    // The twin's window used, then an add-on's: the twin's keeps them.
    state = controllerFocus({ focused: twin, steering, owner: state.owner });
    state = controllerFocus({ focused: poseView, steering, owner: state.owner });
    assert.deepEqual(state, { owner: twin, handedTo: twin });
    // The window that had them closed: nothing is handed on.
    assert.deepEqual(controllerFocus({ focused: poseView, steering: [project], owner: twin }), { owner: null, handedTo: null });
});
