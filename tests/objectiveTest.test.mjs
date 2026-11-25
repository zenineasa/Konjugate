/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { decodeObjectiveRunResult, encodeObjectiveRunRequest, frame, measuredAt, objectiveErrorLine, objectivePorts } from '../src/objectiveTest.mjs';

const root = join(import.meta.dirname, '..');

test('an objective\'s Ports are its keys, each with what the tuning card binds it to and how the program reads it', () => {
    const targets = [
        { value: 'state:11', label: 'Tank · Level', group: 'States' },
        { value: 'parameter:9', label: 'Valve · Gain', group: 'Tuned parameters' },
        { value: 'measured:Level (m)', label: 'Level (m)', group: 'Measured' }
    ];
    assert.deepEqual(objectivePorts([
        { key: 'level', kind: 'state', id: 11 },
        { key: 'gain', kind: 'parameter', id: 9 },
        { key: 'measured', kind: 'measured', column: 'Level (m)' },
        { key: 'loose', kind: 'state', id: null }
    ], targets), [
        { key: 'level', kind: 'state', kindWord: 'state', bound: 'Tank · Level', reads: 'run.series' },
        { key: 'gain', kind: 'parameter', kindWord: 'tuned parameter', bound: 'Valve · Gain', reads: 'run.value' },
        { key: 'measured', kind: 'measured', kindWord: 'measured column', bound: 'Level (m)', reads: 'run.series' },
        { key: 'loose', kind: 'state', kindWord: 'state', bound: null, reads: 'run.series' }
    ]);
});

test('the trial and the answer are the objective SDK\'s own messages, read and written by its own Python', async () => {
    const { loadPyodide } = await import(pathToFileURL(join(root, 'node_modules', 'pyodide', 'pyodide.mjs')).href);
    const pyodide = await loadPyodide({ indexURL: `${join(root, 'node_modules', 'pyodide')}/` });
    pyodide.FS.mkdirTree('/sdk/konjugate');
    for (const file of ['__init__.py', '__main__.py', 'objective.py']) {
        pyodide.FS.writeFile(`/sdk/konjugate/${file}`, await readFile(join(root, 'engine', 'sdk', 'python', 'konjugate', file), 'utf8'));
    }
    pyodide.runPython('import sys\nsys.path.insert(0, "/sdk")');
    const request = encodeObjectiveRunRequest({ times: [0, 0.5, 1], series: { level: [1, 2.5, 4], empty: [] }, values: { gain: 0.25 } });
    const framed = frame(request);
    assert.equal(new DataView(framed.buffer).getUint32(0, false), request.length, 'Framed by its length, big-endian.');
    const scope = pyodide.toPy({ data: request });
    const read = pyodide.runPython(`
from konjugate.objective import decode_run, encode_result
run = decode_run(bytes(data))
run.report("peak", max(run.series("level")))
answer = encode_result(sum(run.series("level")) * run.value("gain"), reports=run._reports)
failure = encode_result(message="ZeroDivisionError: division by zero")
{"times": run.times, "level": run.series("level"), "empty": run.series("empty"), "gain": run.value("gain"), "answer": answer, "failure": failure}
`, { globals: scope });
    const decoded = read.toJs({ dict_converter: Object.fromEntries });
    read.destroy();
    scope.destroy();
    assert.deepEqual([decoded.times, decoded.level, decoded.empty, decoded.gain], [[0, 0.5, 1], [1, 2.5, 4], [], 0.25]);
    assert.deepEqual(decodeObjectiveRunResult(Uint8Array.from(decoded.answer)), { ok: true, message: '', value: 1.875, reports: [{ key: 'peak', value: 4 }] });
    assert.deepEqual(decodeObjectiveRunResult(Uint8Array.from(decoded.failure)), { ok: false, message: 'ZeroDivisionError: division by zero', value: null, reports: [] });
});

test('a measured column at the run\'s times, and the line an error names', () => {
    assert.deepEqual(measuredAt([0, 0.5, 1, 2, 3], [0, 1, 2], [10, 20, 40]), [10, 15, 20, 40, 40]);
    assert.deepEqual(measuredAt([-1], [0, 1], [5, 6]), [5]);
    const traceback = 'Traceback (most recent call last):\n  File "/x/konjugate/objective.py", line 120, in main\n  File "/tmp/a/objective.py", line 7, in objective\n    return 1 / 0\nZeroDivisionError: division by zero';
    assert.equal(objectiveErrorLine(traceback, 'objective.py'), 7, 'The program\'s own last frame, not the SDK\'s.');
    assert.equal(objectiveErrorLine('Error at line 12 of the objective', 'objective.cpp'), 12);
    assert.equal(objectiveErrorLine('no number', 'objective.py'), null);
});
