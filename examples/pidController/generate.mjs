/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Makes PidController.fmu from PidController.mo (docs/proposals/rootPorts.md, stage 7), reproducibly, by hand: never in CI, never by the
// app. A PI controller drawn from the Modelica Standard Library's blocks, exported by OpenModelica as an FMI 2.0 Co-Simulation FMU with
// forward Euler inside, its binaries built from the FMU's own C sources for each platform this machine can reach:
//
//   1. OpenModelica in its Docker image pinned by digest (the one the benchmarks use, benchmarks/comparisons/tools.mjs), arm64: the
//      Modelica Standard Library installed at a pinned version, the model checked, buildModelFMU with --fmiFlags=s:euler (a source FMU
//      with an aarch64 Linux binary, which goes under binaries/aarch64-linux), and OpenModelica's own simulation of the model against
//      the input series below, for comparison;
//   2. the same image, amd64: the FMU's sources built with its gcc and CMake into an x86_64 Linux binary (binaries/linux64);
//   3. this Mac: the FMU's sources built with CMake and Apple clang into an arm64 macOS binary (binaries/darwin64);
//   4. the three merged into one FMU (fixed zip timestamps), validated by FMPy and simulated against the same input series, compared
//      with OpenModelica's own simulation; the input series and FMPy's result kept as the check's reference.
//
// It refuses to start Docker: start it first, and quit it afterwards if you started it for this. Its containers carry the label
// konjugate.example=pid-controller (and ao.session when run from an Orchestrator session) and are removed at the end; other containers
// and images are never touched. FMPy is read from the Python on PATH (PYTHON chooses another), without -I so a user-site install is found.
//
//   node examples/pidController/generate.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { openModelicaImage } from '../../benchmarks/comparisons/tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const modelicaVersion = '4.1.0+maint.om';
const python = process.env.PYTHON || 'python3';
const label = ['--label', 'konjugate.example=pid-controller', ...(process.env.AO_SESSION_ID ? ['--label', `ao.session=${process.env.AO_SESSION_ID}`] : [])];
const stopTime = 14400;
const step = 10;

function run(command, args, { cwd, quiet = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; if (!quiet) process.stdout.write(chunk); });
        child.stderr.on('data', (chunk) => { output += chunk; if (!quiet) process.stderr.write(chunk); });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} ${args.slice(0, 3).join(' ')} … failed (exit ${code}):\n${output.slice(-2000)}`))));
    });
}
const firstLine = async (command, args) => (await run(command, args, { quiet: true })).trim().split('\n')[0];

// The check's inputs: the setpoint steps from 18 °C to 21 °C at an hour; the measurement rises toward it, a new value every 10 minutes.
// Each changes 5 s into a 10 s step, so every tool reads the same value at every communication point, held for the step.
export function inputSeries() {
    const valueAt = (time) => {
        const segment = Math.floor(time / 600) * 600;
        const setpoint = time > 3600 ? 21 : 18;
        const measurement = segment < 3600 ? 18 : 21 - 3 * Math.exp(-(segment - 3600) / 1800);
        return [setpoint, Number(measurement.toFixed(6))];
    };
    const rows = [[0, ...valueAt(0)]];
    for (let time = step; time <= stopTime; time += step) {
        const before = valueAt(time - step);
        const now = valueAt(time);
        if (before[0] !== now[0] || before[1] !== now[1]) rows.push([time - step / 2, ...before], [time - step / 2, ...now]);
    }
    rows.push([stopTime, ...valueAt(stopTime)]);
    return rows;
}

async function main() {
    if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
        console.error('Docker is not running. Start Docker (Docker Desktop on a Mac), wait until it is ready, and run this again; quit Docker Desktop afterwards if you started it for this.');
        process.exit(1);
    }
    const work = await mkdtemp(join(tmpdir(), 'k64-pidcontroller-'));
    const containers = [];
    try {
        await cp(join(here, 'PidController.mo'), join(work, 'PidController.mo'));
        const series = inputSeries();
        await writeFile(join(work, 'inputs.csv'), `time,setpoint,measurement\n${series.map((row) => row.join(',')).join('\n')}\n`);
        for (const platform of ['linux/arm64', 'linux/amd64']) await run('docker', ['pull', '--platform', platform, openModelicaImage], { quiet: true });
        const digest = (await run('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', openModelicaImage], { quiet: true })).trim();

        // 1. OpenModelica, arm64: the source FMU, and its own simulation of the model.
        const arm = `konjugate-pidcontroller-arm64-${process.pid}`;
        await run('docker', ['run', '-d', '--rm', '--name', arm, ...label, '--platform', 'linux/arm64', '-v', `${work}:/work`, '-w', '/work', openModelicaImage, 'sleep', 'infinity'], { quiet: true });
        containers.push(arm);
        await writeFile(join(work, 'build.mos'), [
            `installPackage(Modelica, "${modelicaVersion}", exactMatch = true); getErrorString();`,
            `loadModel(Modelica, {"${modelicaVersion}"}); getErrorString();`,
            'getVersion(Modelica);',
            'loadFile("PidController.mo"); getErrorString();',
            'checkModel(PidController); getErrorString();',
            `simulate(PidController, startTime = 0, stopTime = ${stopTime}, numberOfIntervals = ${stopTime / step}, method = "euler", outputFormat = "csv", fileNamePrefix = "openmodelica", variableFilter = "command", simflags = "-csvInput=inputs.csv"); getErrorString();`,
            // Forward Euler inside, and the protected controller block's own variables left out of the FMU's interface.
            'setCommandLineOptions("--fmiFlags=s:euler --fmiFilter=protected"); getErrorString();',
            'buildModelFMU(PidController, version = "2.0", fmuType = "cs", fileNamePrefix = "PidController", platforms = {"static"}); getErrorString();',
            ''
        ].join('\n'));
        const omcOutput = await run('docker', ['exec', arm, 'omc', 'build.mos']);
        if (!/Check of PidController completed successfully/.test(omcOutput)) throw new Error('OpenModelica did not check the model.');
        const omcVersion = await firstLine('docker', ['exec', arm, 'omc', '--version']);
        const linuxGcc = await firstLine('docker', ['exec', arm, 'gcc', '--version']);
        const linuxCmake = await firstLine('docker', ['exec', arm, 'cmake', '--version']);
        // The library's revision, as OpenModelica's package manager says it installed it.
        const mslSha = /Modelica 4\.1\.0\+maint\.om\/package\.mo[^\n]*SHA ([0-9a-f]+)/.exec(omcOutput)?.[1] ?? null;
        const source = unzipSync(new Uint8Array(await readFile(join(work, 'PidController.fmu'))));
        // A header of libcsv (LGPL 2.1 upstream) that OpenModelica puts among the sources, though no source includes it and no binary
        // compiles it: left out, so the FMU carries no code under a licence it does not reproduce; the builds below show it is not needed.
        delete source['sources/util/libcsv.h'];
        const files = {};
        for (const [name, bytes] of Object.entries(source)) {
            if (name.endsWith('/')) continue;
            // OpenModelica, run on arm64, calls its aarch64 Linux binary linux64: it is kept under its FMI 3.0-style name instead,
            // and linux64 is the x86_64 binary, as FMI 2.0 tools read the name.
            files[name.replace(/^binaries\/linux64\//, 'binaries/aarch64-linux/')] = bytes;
        }

        // 2. The same image, amd64: the sources built into an x86_64 Linux binary.
        await mkdir(join(work, 'amd64'), { recursive: true });
        await unzipInto(source, join(work, 'amd64', 'fmu'));
        await rm(join(work, 'amd64', 'fmu', 'binaries'), { recursive: true, force: true });
        await run('docker', ['run', '--rm', '--name', `konjugate-pidcontroller-amd64-${process.pid}`, ...label, '--platform', 'linux/amd64', '-v', `${join(work, 'amd64')}:/work`, '-w', '/work', openModelicaImage,
            'bash', '-c', 'cmake -S fmu/sources -B build -D RUNTIME_DEPENDENCIES_LEVEL=modelica -D CMAKE_BUILD_TYPE=Release && cmake --build build --target install'], { quiet: true });
        files['binaries/linux64/PidController.so'] = new Uint8Array(await readFile(join(work, 'amd64', 'fmu', 'binaries', 'linux64', 'PidController.so')));

        // 3. This Mac: the sources built with CMake and Apple clang into an arm64 macOS binary.
        await unzipInto(source, join(work, 'darwin', 'fmu'));
        await rm(join(work, 'darwin', 'fmu', 'binaries'), { recursive: true, force: true });
        await run('cmake', ['-S', 'fmu/sources', '-B', 'build', '-D', 'RUNTIME_DEPENDENCIES_LEVEL=modelica', '-D', 'CMAKE_BUILD_TYPE=Release'], { cwd: join(work, 'darwin'), quiet: true });
        await run('cmake', ['--build', 'build', '--target', 'install'], { cwd: join(work, 'darwin'), quiet: true });
        files['binaries/darwin64/PidController.dylib'] = new Uint8Array(await readFile(join(work, 'darwin', 'fmu', 'binaries', 'darwin64', 'PidController.dylib')));

        // 4. One FMU, its entries in name order with a fixed time, so the same binaries give the same file.
        const ordered = Object.fromEntries(Object.keys(files).sort().map((name) => [name, [files[name], { mtime: new Date('1980-01-01T00:00:00Z') }]]));
        const fmu = zipSync(ordered, { level: 9 });
        const fmuPath = join(here, 'PidController.fmu');
        await writeFile(fmuPath, fmu);
        const fmuSha256 = createHash('sha256').update(fmu).digest('hex');

        // Validated and simulated by FMPy against the same inputs, and compared with OpenModelica's own simulation.
        const check = await run(python, ['-c', `
import csv, json, numpy as np
from fmpy import simulate_fmu, __version__
from fmpy.validation import validate_fmu
rows = [list(map(float, row)) for row in list(csv.reader(open(${JSON.stringify(join(work, 'inputs.csv'))})))[1:]]
signal = np.array([tuple(row) for row in rows], dtype=[('time', np.float64), ('setpoint', np.float64), ('measurement', np.float64)])
result = simulate_fmu(${JSON.stringify(fmuPath)}, start_time=0.0, stop_time=${stopTime}.0, output_interval=${step}.0, input=signal, output=['command'])
om = {}
for row in csv.DictReader(open(${JSON.stringify(join(work, 'openmodelica_res.csv'))})):
    om.setdefault(float(row['time']), float(row['command']))
def held(t):
    value = None
    for row in rows:
        if row[0] <= t: value = (row[1], row[2])
    return value
# A row after a step whose inputs changed during it: the FMU's output uses the inputs held from the step's start (read at the start of
# each step), OpenModelica's the new ones at its end; those rows are a step apart by design, and are left out of the comparison.
steady = [r for r in result if float(r['time']) in om and float(r['time']) >= ${step} and held(float(r['time']) - ${step}) == held(float(r['time']))]
diff = max(abs(float(r['command']) - om[float(r['time'])]) for r in steady)
print(json.dumps({ 'fmpy': __version__, 'problems': [str(p) for p in validate_fmu(${JSON.stringify(fmuPath)})], 'rows': [[float(r['time']), float(r['command'])] for r in result], 'openmodelicaDifference': diff, 'compared': len(steady) }))
`], { quiet: true });
        const { fmpy, problems, rows, openmodelicaDifference, compared } = JSON.parse(check.trim().split('\n').at(-1));
        if (problems.length) throw new Error(`FMPy found problems in the FMU: ${problems.join('; ')}`);
        await writeFile(join(here, 'PidController_inputs.csv'), `time,setpoint,measurement\n${series.map((row) => row.join(',')).join('\n')}\n`);
        await writeFile(join(here, 'PidController_ref.csv'), `time,command\n${rows.map(([time, value]) => `${time},${value}`).join('\n')}\n`);
        const record = {
            image: digest, openModelica: omcVersion, modelicaStandardLibrary: { version: modelicaVersion, sha: mslSha },
            fmiFlags: 's:euler', fmiFilter: 'protected', linux: { compiler: linuxGcc, cmake: linuxCmake },
            macos: { compiler: await firstLine('clang', ['--version']), cmake: await firstLine('cmake', ['--version']) },
            fmpy, fmuSha256, fmuBytes: fmu.length, platforms: Object.keys(files).filter((name) => name.startsWith('binaries/')).map((name) => name.split('/')[1]),
            openModelicaComparison: { largestDifference: openmodelicaDifference, rowsCompared: compared, rowsInAll: rows.length }
        };
        await writeFile(join(here, 'build.json'), `${JSON.stringify(record, null, 4)}\n`);
        console.log(JSON.stringify(record, null, 4));
    } finally {
        for (const container of containers) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
        await rm(work, { recursive: true, force: true });
    }
}

async function unzipInto(entries, directory) {
    for (const [name, bytes] of Object.entries(entries)) {
        if (name.endsWith('/')) continue;
        const path = join(directory, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
