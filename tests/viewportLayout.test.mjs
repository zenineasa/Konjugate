/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { canvasFog, eligibleEndpointIds, farPlaneFor, fogDensityFor, labelElementOf, virtualKeyboardInset } from '../src/renderer/viewportLayout.mjs';

test('virtualKeyboardInset reserves only visible keyboard space', () => {
    assert.equal(virtualKeyboardInset(900, { top: 620 }, true), 280);
    assert.equal(virtualKeyboardInset(900, { top: 620 }, false), 0);
    assert.equal(virtualKeyboardInset(900, null, true), 0);
});

test('eligibleEndpointIds excludes the opposite endpoint and hidden nodes', () => {
    const nodes = [{ id: 'source' }, { id: 'target' }, { id: 'hidden' }];
    assert.deepEqual(
        eligibleEndpointIds(nodes, 'source', (node) => node.id !== 'hidden'),
        ['target']
    );
});

// What is left of a shape's own colour at `distance` under exponential-squared fog of `density`, as three.js draws it.
const colourLeft = (density, distance) => Math.exp(-((density * distance) ** 2));

test('the fog is as it was up to the distance the canvas opens at, and thins beyond it so a wide model keeps its shapes', () => {
    const opensAt = canvasFog.referenceDistance;
    assert.equal(fogDensityFor(8), 0.022);
    assert.equal(fogDensityFor(opensAt), 0.022);
    // A model 80 units across is fitted from about 100 units back: with one density it faded away whole.
    assert.ok(colourLeft(0.022, 100) < 0.01, 'the fog that hid it');
    for (const distance of [40, 100, 1000, 5000]) {
        const left = colourLeft(fogDensityFor(distance), distance);
        assert.ok(Math.abs(left - colourLeft(0.022, opensAt)) < 1e-12, `what the camera looks at from ${distance} units keeps the colour it has when the canvas opens (${left})`);
        // And depth still reads: what lies twice as far fades more.
        assert.ok(colourLeft(fogDensityFor(distance), 2 * distance) < 0.6 * left);
    }
    assert.ok(fogDensityFor(100) < fogDensityFor(40) && fogDensityFor(40) < 0.022);
    assert.equal(fogDensityFor(NaN), 0.022);
    assert.equal(fogDensityFor(Infinity), 0.022);
});

test('the far plane keeps three times the viewing distance, and never less than it has had', () => {
    assert.equal(farPlaneFor(20), 300);
    assert.equal(farPlaneFor(100), 300);
    assert.equal(farPlaneFor(400), 1200);
    assert.equal(farPlaneFor(5000), 15000);
    assert.equal(farPlaneFor(NaN), 300);
});

test('a canvas object\'s label is found on the object, drawn into the page yet or not, and is null where there is none', () => {
    const element = (...names) => ({ classList: { contains: (name) => names.includes(name) } });
    const label = element('node-label-container');
    const object = { children: [{ isMesh: true }, { element: element('edge-label') }, { element: label }] };
    assert.equal(labelElementOf(object, 'node-label-container'), label);
    assert.equal(labelElementOf({ children: [{ isMesh: true }] }, 'node-label-container'), null);
    // A node not on the canvas (a result naming a state whose node is not drawn) is no error.
    assert.equal(labelElementOf(undefined, 'node-label-container'), null);
    assert.equal(labelElementOf({}, 'node-label-container'), null);
});
