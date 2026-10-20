/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { meshFromArrays, partProblems, triangleCount } from '../src/meshParts.mjs';

test('a mesh file becomes a part\'s mesh in metres, with an index and normals when the file has none', () => {
    // One triangle in millimetres, as an STL gives it: no index, no normals.
    const mesh = meshFromArrays([0, 0, 0, 1000, 0, 0, 0, 1000, 0], null, null, 0.001);
    assert.deepEqual(mesh, { position: [0, 0, 0, 1, 0, 0, 0, 1, 0], normal: [0, 0, 1, 0, 0, 1, 0, 0, 1], index: [0, 1, 2] });
    assert.equal(triangleCount(mesh), 1);
    assert.throws(() => meshFromArrays([], null, null), /no usable geometry/);
    assert.throws(() => meshFromArrays([0, 0, 0, 1, 0, 0, 0, 1, 0], null, [0, 1, 5]), /malformed/);
});

test('a part\'s prefix names the states that place it, and every problem is said', () => {
    const mesh = { position: [0, 0, 0], normal: [0, 0, 1], index: [] };
    const problems = partProblems([
        { prefix: '', mesh }, { prefix: 'arm', mesh }, { prefix: 'arm', mesh }, { prefix: 'Bad', mesh }, { prefix: 'leg', mesh: null }
    ], ['x', 'y', 'z', 'armX', 'armY']);
    assert.deepEqual(problems[0], { errors: [], notes: [] });
    assert.match(problems[1].notes[0], /no state armZ/);
    assert.match(problems[2].errors[0], /Two parts have the prefix "arm"/);
    assert.match(problems[3].errors[0], /not a valid prefix/);
    assert.match(problems[4].errors[0], /Choose a mesh file/);
});
