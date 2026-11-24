/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The benchmark suite's own machinery (benchmarks/README.md), checked without the engine: the analytic references against closed forms,
// the error and order measures, the committed models against the problems that build them, and the report's handling of text.

import assert from 'node:assert/strict';
import test from 'node:test';
import { affineSolution, expm } from '../benchmarks/lib/linearAlgebra.mjs';
import { jacobiElliptic, pendulumMotion, pendulumPeriod } from '../benchmarks/lib/elliptic.mjs';
import { conservationDrift, errorMetrics, observedOrder, spread } from '../benchmarks/lib/metrics.mjs';
import { loadModel } from '../benchmarks/lib/engine.mjs';
import { busyPatterns, machineSlug } from '../benchmarks/lib/machine.mjs';
import { renderReport } from '../benchmarks/lib/report.mjs';
import { modelDocuments } from '../benchmarks/generateModels.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { selectSessions } from '../benchmarks/combine.mjs';
import { resultsDirectory } from '../benchmarks/lib/results.mjs';

test('the matrix exponential matches closed forms', () => {
    const t = 37.3;
    const rotation = expm([[0, t], [-t, 0]]);
    assert.ok(Math.abs(rotation[0][0] - Math.cos(t)) < 1e-13);
    assert.ok(Math.abs(rotation[0][1] - Math.sin(t)) < 1e-13);
    const decay = expm([[-2, 0], [0, -1e-3]]);
    assert.ok(Math.abs(decay[0][0] - Math.exp(-2)) < 1e-15);
    assert.ok(Math.abs(decay[1][1] - Math.exp(-1e-3)) < 1e-15);
});

test('an affine solution is the same with or without an offset', () => {
    const matrix = [[-0.5, 0.2], [0.1, -0.3]];
    const forcing = [150, 90];
    const times = [0, 1, 10, 100];
    const plain = affineSolution(matrix, forcing, [290, 300], times);
    const shifted = affineSolution(matrix, forcing, [290, 300], times, [293, 293]);
    plain.forEach((sample, i) => sample.forEach((value, j) => assert.ok(Math.abs(value - shifted[i][j]) < 1e-10)));
    // At long times both reach the equilibrium A x = -b.
    const [x, y] = affineSolution(matrix, forcing, [0, 0], [1e4], [293, 293])[0];
    assert.ok(Math.abs(-0.5 * x + 0.2 * y + 150) < 1e-9 && Math.abs(0.1 * x - 0.3 * y + 90) < 1e-9);
});

test('the pendulum reference is the exact motion', () => {
    assert.ok(Math.abs(jacobiElliptic(0.7, 0).sn - Math.sin(0.7)) < 1e-15);
    const pendulum = { gravity: 9.81, length: 1, initialAngle: 2 };
    const period = pendulumPeriod(pendulum);
    const [start, , end] = pendulumMotion(pendulum, [0, period / 2, period]);
    assert.ok(Math.abs(start[0] - 2) < 1e-14 && Math.abs(end[0] - 2) < 1e-12 && Math.abs(end[1]) < 1e-12);
    // Energy is constant along it, and its derivative is the angular velocity it reports.
    const energy = ([angle, velocity]) => 0.5 * velocity ** 2 - 9.81 * Math.cos(angle);
    for (const sample of pendulumMotion(pendulum, [0.3, 1.1, 2.9, 7.7])) assert.ok(Math.abs(energy(sample) - energy([2, 0])) < 1e-12);
    const h = 1e-6;
    const [before, middle, after] = pendulumMotion(pendulum, [1 - h, 1, 1 + h]);
    assert.ok(Math.abs((after[0] - before[0]) / (2 * h) - middle[1]) < 1e-6);
    // A small swing has the small-angle period.
    assert.ok(Math.abs(pendulumPeriod({ gravity: 9.81, length: 1, initialAngle: 1e-6 }) - 2 * Math.PI / Math.sqrt(9.81)) < 1e-9);
});

test('error, order and drift measures', () => {
    const metrics = errorMetrics([[1, 10], [2, 30]], [[1, 10], [1.5, 20]]);
    assert.equal(metrics.maxAbsError, 10);
    assert.ok(Math.abs(metrics.rmse - Math.sqrt((0.25 + 100) / 4)) < 1e-15);
    assert.equal(metrics.relativeError, 1);
    assert.equal(errorMetrics([[NaN]], [[1]]).maxAbsError, Infinity);
    const steps = [0.4, 0.2, 0.1, 0.05];
    const order = observedOrder(steps, steps.map((h) => 3 * h + 2 * h * h));
    assert.ok(order.fitted > 1 && order.fitted < 1.2 && Math.abs(order.finest - 1) < 0.05);
    assert.ok(Math.abs(observedOrder(steps, steps.map((h) => h ** 2)).fitted - 2) < 1e-12);
    assert.deepEqual(conservationDrift([2, 2.5, 1.5, 2.2]), { maxRelativeDrift: 0.25, finalRelativeDrift: (2.2 - 2) / 2 });
    assert.deepEqual(spread([5, 3, 9, 4, 4]), { median: 4, minimum: 3, maximum: 9, medianAbsoluteDeviation: 1, count: 5 });
});

test('the committed benchmark models are what their problems build', async () => {
    const models = modelDocuments();
    assert.ok(models.length >= 9);
    for (const { path, document } of models) assert.deepEqual(await loadModel(path), JSON.parse(JSON.stringify(document)), path);
});

test('the busy-process warning names Konjugate\'s test processes, not every Electron application', () => {
    const kind = (command) => busyPatterns.find(({ pattern }) => pattern.test(command))?.name ?? null;
    assert.equal(kind('node scripts/runInteractionTests.mjs'), 'interaction test runner');
    assert.equal(kind('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --interaction-test'), 'Konjugate Electron');
    assert.equal(kind('/Applications/Konjugate.app/Contents/MacOS/Konjugate'), 'Konjugate Electron');
    assert.equal(kind('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless'), 'test-driven Chrome');
    assert.equal(kind('/Applications/Visual Studio Code.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'), null);
    assert.equal(kind('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), null);
    assert.equal(machineSlug({ modelIdentifier: 'MacBookAir10,1', chip: 'Apple M1', platform: 'darwin' }), 'macbookair10-1-apple-m1-darwin');
});

test('the report is self-contained and inserts names as text', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const html = renderReport({
        summary: { run: { mode: 'accuracy', startedAt: '2026-01-01T00:00:00Z', konjugateVersion: '1.0.0', engineVersion: '0.2.0', gitCommit: 'abc1234', workingTreeChanges: false }, totals: { engineRuns: 1, substeps: 10 } },
        problems: [{
            id: 'test/problem', title: hostile, summary: 'A test.', models: ['model.kjt'], notes: [], referenceProvenance: null,
            rows: [{ case: hostile, method: 'explicit Euler', maxAbsError: 0.5, note: '' }],
            checks: [{ name: 'check', description: hostile, value: 1, limit: { max: 2 }, pass: true }],
            plots: [{ id: 'plot', title: hostile, subtitle: '', xLabel: 'x', yLabel: 'y', logX: false, logY: true, series: [{ name: `${hostile}</script>`, role: 'reference', points: [[0, 1], [1, 2]] }, { name: 'b', role: 'explicit', points: [[0, 2], [1, 3]] }] }]
        }],
        timings: null
    });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes(`${hostile}</script>`));
    assert.ok(!/<(script|link)[^>]+(src|href)=/.test(html), 'no external scripts or stylesheets');
    assert.match(html, /1 \/ 1/);
});

test('a --full report shows the timings, their spread and the machine', () => {
    const wall = { median: 12.5, minimum: 12, maximum: 14, medianAbsoluteDeviation: 0.4, count: 7 };
    const html = renderReport({
        summary: {
            run: { mode: 'full', startedAt: '2026-01-01T00:00:00Z', konjugateVersion: '1.0.0', engineVersion: '0.2.0', gitCommit: 'abc1234', workingTreeChanges: true },
            totals: { engineRuns: 1, substeps: 10 },
            machine: { model: 'MacBook Air', modelIdentifier: 'MacBookAir10,1', chip: 'Apple M1', cpu: 'Apple M1', performanceCores: 4, efficiencyCores: 4, logicalProcessors: 8, memoryBytes: 8 * 2 ** 30, operatingSystem: 'macOS 26', architecture: 'arm64', power: { source: 'AC Power', batteryPercent: 80, lowPowerMode: false }, loadAverage: [1, 1, 1], node: 'v24' },
            timing: { repeats: 7, warmupRuns: 1, caffeinated: true, busyProcesses: ['interaction test runner'] }
        },
        problems: [],
        timings: [{ problem: 'test/problem', label: 'A case', wall, engineCompute: { ...wall, median: 9 }, substepsPerSecond: 1.5e7, peakResidentBytes: 20 * 2 ** 20 }]
    });
    for (const text of ['Timing and memory', 'A case', '12.5', '12 – 14', '1.50e7', 'MacBookAir10,1', 'AC Power · 80 % battery · Low Power Mode off', 'interaction test runner', 'under caffeinate', 'with uncommitted changes']) {
        assert.ok(html.includes(text), text);
    }
});

test('results are kept per computer, not per version', () => {
    const directory = resultsDirectory({ modelIdentifier: 'MacBookAir10,1', chip: 'Apple M1', platform: 'darwin' });
    assert.ok(directory.endsWith(['benchmarks', 'results', 'macbookair10-1-apple-m1-darwin'].join(sep)), directory);
});

test('only the sessions timed from the newest source are combined; the others are listed as superseded', (t) => {
    const machineDirectory = mkdtempSync(join(tmpdir(), 'konjugateCombine-'));
    t.after(() => rmSync(machineDirectory, { recursive: true, force: true }));
    const write = (session, part, file, content) => {
        mkdirSync(join(machineDirectory, 'sessions', session, part), { recursive: true });
        writeFileSync(join(machineDirectory, 'sessions', session, part, file), JSON.stringify(content));
    };
    const run = (commit, workingTreeChanges = false) => ({ run: { konjugateVersion: '2.0.0', gitCommit: commit, workingTreeChanges } });
    const comparisons = (commit, tools) => ({ versions: { konjugate: { version: '2.0.0', commit } }, records: tools.map((tool) => ({ tool })) });
    write('2026-01-01T00-00-00', 'problems', 'summary.json', run('aaaaaaa'));
    write('2026-01-01T00-00-00', 'scaling', 'summary.json', run('aaaaaaa', true));
    write('2026-01-02T00-00-00', 'comparisons', 'comparisons.json', comparisons('bbbbbbb', ['Konjugate', 'SciPy']));
    write('2026-01-03T00-00-00', 'problems', 'summary.json', run('ccccccc'));
    write('2026-01-03T00-00-00', 'comparisons', 'comparisons.json', comparisons('ccccccc', ['Konjugate', 'Julia']));
    write('2026-01-04T00-00-00', 'scaling', 'summary.json', run('unknown'));
    // OpenModelica alone, from a later commit: it times no Konjugate, so it does not decide which source is newest.
    write('2026-01-05T00-00-00-openmodelica', 'openmodelica', 'comparisons.json', comparisons('ddddddd', ['OpenModelica']));
    mkdirSync(join(machineDirectory, 'sessions', '2026-01-06T00-00-00'), { recursive: true });

    const { sessions, source, superseded } = selectSessions(machineDirectory);
    assert.deepEqual(source, { konjugateVersion: '2.0.0', gitCommit: 'ccccccc', fullCommit: null, commitUrl: null });
    // A part that recorded no start time is dated by its session folder's name, in UTC.
    assert.equal(superseded.find((entry) => entry.session === '2026-01-04T00-00-00').startedAt, '2026-01-04T00:00:00.000Z');
    assert.deepEqual(sessions.map((session) => [session.name, [...session.parts]]), [['2026-01-03T00-00-00', ['problems', 'comparisons']]]);
    assert.deepEqual(superseded.map((entry) => `${entry.session} ${entry.part} ${entry.gitCommit}`), [
        '2026-01-01T00-00-00 problems aaaaaaa', '2026-01-01T00-00-00 scaling aaaaaaa', '2026-01-02T00-00-00 comparisons bbbbbbb',
        '2026-01-04T00-00-00 scaling unknown', '2026-01-05T00-00-00-openmodelica openmodelica ddddddd'
    ]);
    assert.deepEqual(selectSessions(machineDirectory, ['2026-01-01T00-00-00']).sessions.map((session) => [...session.parts]), [['problems', 'scaling']]);

    // A commit the repository has is linked to its page by its full hash.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    write('2026-01-07T00-00-00', 'problems', 'summary.json', run(head.slice(0, 7)));
    const linked = selectSessions(machineDirectory).source;
    assert.equal(linked.fullCommit, head);
    assert.equal(linked.commitUrl, `https://github.com/zenineasa/Konjugate/commit/${head}`);
});
