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
import { combineSessions, selectSessions } from '../benchmarks/combine.mjs';
import { resultsDirectory } from '../benchmarks/lib/results.mjs';
import { checkTimedSources, harnessImports, parsePorcelain, uncommittedTimedSources } from '../benchmarks/lib/sourceGuard.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { largestSupersededPage, relativeLinks, writeSite } from '../benchmarks/pages.mjs';

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

test('a session refuses to time uncommitted changes to the engine or the harness, naming them, unless allowed', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'konjugateSourceGuard-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path, content) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), content);
    };
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'ignore' });
    write('engine/src/main.cpp', 'int main() {}\n');
    write('protocol/engine.proto', 'syntax = "proto3";\n');
    write('benchmarks/run.mjs', "import { decode } from '../src/decoder.mjs';\n");
    write('benchmarks/lib/plot.mjs', "export const plot = await import('./axes.mjs');\n");
    write('benchmarks/lib/axes.mjs', 'export {};\n');
    write('benchmarks/results/machine/combined.json', '{}\n');
    write('src/decoder.mjs', "export { units } from './units.mjs';\nexport function decode() {}\n");
    write('src/units.mjs', 'export const units = {};\n');
    write('src/renderer.mjs', "import './decoder.mjs';\n");
    write('docs/notes.md', 'Notes.\n');
    write('package.json', '{ "version": "2.0.0" }\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'start');

    // The harness's imports outside benchmarks/ are followed from module to module; a module that only imports the harness's is not one.
    assert.deepEqual(harnessImports(root), ['src/decoder.mjs', 'src/units.mjs']);
    assert.deepEqual(checkTimedSources({ root }), { ok: true, files: [], message: null });

    // Changes the timed engine and harness are not built from: documentation, another module, results.
    write('docs/notes.md', 'More notes.\n');
    write('src/renderer.mjs', '// changed\n');
    write('benchmarks/results/machine/sessions/new/summary.json', '{}\n');
    assert.deepEqual(uncommittedTimedSources(root), []);

    // Changes they are: a changed engine source, a changed module the harness imports, a new protocol file, a deleted harness module and
    // a renamed one.
    write('engine/src/main.cpp', 'int main() { return 0; }\n');
    write('src/units.mjs', 'export const units = { metre: 1 };\n');
    write('protocol/new.proto', 'syntax = "proto3";\n');
    rmSync(join(root, 'benchmarks/lib/axes.mjs'));
    git('mv', 'benchmarks/run.mjs', 'benchmarks/runner.mjs');
    const files = ['benchmarks/lib/axes.mjs', 'benchmarks/runner.mjs', 'engine/src/main.cpp', 'protocol/new.proto', 'src/units.mjs'];
    const refused = checkTimedSources({ root, action: 'start problems' });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.files, files);
    assert.match(refused.message, /^Not going to start problems: 5 files that the timed engine or the benchmark harness are built from have uncommitted changes:/);
    for (const file of files) assert.ok(refused.message.includes(`\n  ${file}`), file);
    assert.match(refused.message, /Commit them first.*--allow-uncommitted/s);
    const allowed = checkTimedSources({ root, allowUncommitted: true });
    assert.equal(allowed.ok, true);
    assert.deepEqual(allowed.files, files);
    assert.match(allowed.message, /^Going on with uncommitted changes \(--allow-uncommitted\).*marked as timed with uncommitted changes/s);

    // Outside a git checkout it cannot be told, so it refuses too.
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const unknown = checkTimedSources({ root });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.files, null);
    assert.match(unknown.message, /not a git checkout/);
});

test('git status output is read path by path, a rename by its new path', () => {
    assert.deepEqual(parsePorcelain('R  benchmarks/new.mjs\0benchmarks/old.mjs\0 M engine/a b.cpp\0?? protocol/x.proto\0D  src/y.mjs\0'),
        ['benchmarks/new.mjs', 'engine/a b.cpp', 'protocol/x.proto', 'src/y.mjs']);
    assert.deepEqual(parsePorcelain(''), []);
});

test('a session timed with uncommitted changes is shown prominently, with its provenance note when it has one', async (t) => {
    const machineDirectory = mkdtempSync(join(tmpdir(), 'konjugateProvenance-'));
    t.after(() => rmSync(machineDirectory, { recursive: true, force: true }));
    const sessionDirectory = join(machineDirectory, 'sessions', '2026-01-01T00-00-00');
    const write = (path, content) => {
        mkdirSync(join(sessionDirectory, path, '..'), { recursive: true });
        writeFileSync(join(sessionDirectory, path), JSON.stringify(content));
    };
    const run = (extra) => ({ run: { konjugateVersion: '2.0.0', gitCommit: '1111111', workingTreeChanges: true, ...extra } });
    const report = async () => readFileSync(await combineSessions(machineDirectory), 'utf8');

    // Changes only to what the engine and harness are not built from: recorded, but not a warning.
    write('problems/summary.json', run({ uncommittedSources: [] }));
    assert.doesNotMatch(await report(), /class="notice"/);

    // Changes to them, without a note: the report says the numbers are not a commit.
    write('problems/summary.json', run({ uncommittedSources: ['engine/src/main.cpp'] }));
    const unexplained = await report();
    assert.match(unexplained, /<p class="notice"><strong>Timed with uncommitted changes\.<\/strong> session 2026-01-01T00-00-00 \(problems\) ran from a checkout with uncommitted changes to what the engine or the harness is built from/);
    assert.match(unexplained, /cannot be reproduced from the repository/);

    // With a note: both commits, linked, and the note; the recorded results are untouched.
    const builtFrom = '1111111'.padEnd(40, 'a');
    const committedAs = '2222222'.padEnd(40, 'b');
    const note = { recorded: { gitCommit: '1111111', workingTreeChanges: true }, builtFrom, uncommittedChangesCommittedAs: committedAs, summary: 'Committed afterwards, unchanged.' };
    write('provenance.json', note);
    const { source } = selectSessions(machineDirectory);
    assert.equal(source.gitCommit, '1111111');
    assert.deepEqual(source.provenance, {
        summary: 'Committed afterwards, unchanged.', file: 'sessions/2026-01-01T00-00-00/provenance.json',
        builtFrom: { gitCommit: '1111111', fullCommit: builtFrom, commitUrl: `https://github.com/zenineasa/Konjugate/commit/${builtFrom}` },
        committedAs: { gitCommit: '2222222', fullCommit: committedAs, commitUrl: `https://github.com/zenineasa/Konjugate/commit/${committedAs}` }
    });
    const explained = await report();
    assert.match(explained, /<strong>Timed with uncommitted changes, committed since\.<\/strong> session 2026-01-01T00-00-00 \(problems\): Committed afterwards, unchanged\./);
    assert.ok(explained.includes(`built from <a href="https://github.com/zenineasa/Konjugate/commit/${builtFrom}"><code>1111111</code></a> with uncommitted changes, committed as <a href="https://github.com/zenineasa/Konjugate/commit/${committedAs}"><code>2222222</code></a> (<a href="sessions/2026-01-01T00-00-00/provenance.json">provenance</a>)`));
    assert.doesNotMatch(explained, /dirty/);
    assert.deepEqual(JSON.parse(readFileSync(join(sessionDirectory, 'problems', 'summary.json'), 'utf8')), run({ uncommittedSources: ['engine/src/main.cpp'] }));

    // A note about another commit than the session recorded is refused.
    write('provenance.json', { ...note, recorded: { gitCommit: '3333333' }, builtFrom: '3333333'.padEnd(40, 'c') });
    assert.throws(() => selectSessions(machineDirectory), /is about commit 3333333, but the session recorded 1111111/);
});

test('a page\'s relative links are the files it names, not other sites or places on the page', () => {
    assert.deepEqual(relativeLinks('<a href="report.html#problems">x</a><a href="#top">y</a><img src="plots/a.svg"><a href="https://github.com/x">z</a><a href="mailto:a@b.c">m</a><a href="a.csv?x=1&amp;y=2">d</a>'),
        ['report.html', 'plots/a.svg', 'a.csv?x=1&y=2']);
});

test('the published reports are the index and only the committed files the reports link to, every link there', (t) => {
    const site = mkdtempSync(join(tmpdir(), 'konjugatePages-'));
    t.after(() => rmSync(site, { recursive: true, force: true }));
    const { files, bytes } = writeSite(site);
    const results = join(import.meta.dirname, '..', 'benchmarks', 'results');
    // Every page's relative links resolve within the site (writeSite refuses otherwise; checked here independently).
    for (const file of files.filter((name) => name.endsWith('.html'))) {
        for (const link of relativeLinks(readFileSync(join(site, file), 'utf8'))) assert.ok(existsSync(join(site, file, '..', link)), `${file} → ${link}`);
    }
    for (const machine of files.filter((name) => name.endsWith('/combined.json')).map((name) => name.split('/')[0])) {
        const combined = JSON.parse(readFileSync(join(results, machine, 'combined.json'), 'utf8'));
        assert.ok(files.includes(`${machine}/report.html`));
        // Every combined session's own report is published, whatever its size; a superseded one only when small.
        for (const entry of combined.sessionParts.filter((part) => part.part !== 'comparisons')) assert.ok(files.includes(`${machine}/sessions/${entry.session}/${entry.part}/report.html`), entry.session);
        for (const entry of combined.supersededSessions.filter((part) => part.part !== 'comparisons')) {
            const path = `${machine}/sessions/${entry.session}/${entry.part}/report.html`;
            if (existsSync(join(results, path))) assert.equal(files.includes(path), statSync(join(results, path)).size <= largestSupersededPage, path);
        }
    }
    // Not everything: the raw session files stay in the repository.
    assert.ok(!files.some((name) => /\/sessions\/[^/]+\/(problems|scaling)\/(results|checks)\.csv$/.test(name)));
    assert.equal(bytes, files.reduce((sum, name) => sum + statSync(join(site, name)).size, 0));
});
