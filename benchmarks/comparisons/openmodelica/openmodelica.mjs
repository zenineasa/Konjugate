/* Copyright © 2026 Zenin Easa Panthakkalakath */

// OpenModelica on the comparison problems (problems.mjs), as compare.mjs drives it, a round at a time beside the other tools.
//
// OpenModelica has no macOS installer or Homebrew formula; it runs here in its own arm64 Linux image (openmodelica/openmodelica, pinned
// by tag and digest in ../tools.mjs) under Docker, so on a Mac its timings include Docker's Linux virtual machine on the
// same processor. Each problem is written as a Modelica model whose states carry the problem's absolute-tolerance scale as their `nominal`,
// since OpenModelica's solvers take each state's absolute tolerance as the tolerance times its nominal value (DASSL's log confirms it; CVODE's does not print them, and is taken to
// follow the same rule), and is translated and compiled
// once (simulate(), with a symbolic Jacobian), its frontend, backend, code generation and C compilation timed by OpenModelica itself. The
// executable is then run for each solver (DASSL, CVODE) and tolerance: its solve time is OpenModelica's own timer for the simulation (LOG_STATS), and
// its wall time is measured inside the container around the executable alone. Output is at
// the problem's samples (numberOfIntervals); at an event OpenModelica writes extra rows, and the row at each sample time is used.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMetrics } from '../../lib/metrics.mjs';

import { openModelicaImage } from '../tools.mjs';

export const image = openModelicaImage;
// The image's native platform on this computer: no emulation.
export const dockerPlatform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
export const solvers = ['dassl', 'cvode'];

function execute(command, args, { capture = true } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] });
        let output = '';
        let diagnostics = '';
        child.stdout?.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, output, diagnostics }));
    });
}

const real = (value) => (Number.isInteger(value) ? `${value}.0` : String(value));

// The problem as a Modelica model, the states in the tools' order, named as stateNames() says.
function modelica(problem, name) {
    const p = problem.parameters;
    const nominal = problem.absoluteScale;
    const start = problem.initial;
    const scalar = (names) => names.map((stateName, index) => `  Real ${stateName}(start = ${real(start[index])}, fixed = true, nominal = ${real(nominal[index])});`).join('\n');
    if (problem.kind === 'robertson') {
        return `model ${name}\n  parameter Real k1 = ${real(p.k1)}, k2 = ${real(p.k2)}, k3 = ${real(p.k3)};\n${scalar(['a', 'b', 'c'])}\nequation\n  der(a) = -k1*a + k3*b*c;\n  der(b) = k1*a - k3*b*c - k2*b^2;\n  der(c) = k2*b^2;\nend ${name};\n`;
    }
    if (problem.kind === 'vanDerPol') return `model ${name}\n  parameter Real mu = ${real(p.mu)};\n${scalar(['x', 'y'])}\nequation\n  der(x) = y;\n  der(y) = mu*(1 - x^2)*y - x;\nend ${name};\n`;
    if (problem.kind === 'lorenz') {
        return `model ${name}\n  parameter Real sigma = ${real(p.sigma)}, rho = ${real(p.rho)}, beta = ${real(p.beta)};\n${scalar(['x', 'y', 'z'])}\nequation\n  der(x) = sigma*(y - x);\n  der(y) = x*(rho - z) - y;\n  der(z) = x*y - beta*z;\nend ${name};\n`;
    }
    if (problem.kind === 'linear') {
        const n = p.rows.length;
        const array = (values) => `{${values.map(real).join(', ')}}`;
        const equations = p.rows.map((row, index) => `  der(x[${index + 1}]) = ${row.map(([column, value]) => `(${real(value)})*x[${column + 1}]`).join(' + ')}${p.forcing[index] ? ` + (${real(p.forcing[index])})` : ''};`).join('\n');
        return `model ${name}\n  Real x[${n}](start = ${array(start)}, each fixed = true, nominal = ${array(nominal)});\nequation\n${equations}\nend ${name};\n`;
    }
    if (problem.kind === 'buck') {
        return `model ${name}\n  parameter Real Vin = ${real(p.inputVoltage)}, L = ${real(p.inductance)}, C = ${real(p.capacitance)}, R = ${real(p.load)}, r = ${real(p.windingResistance + p.switchResistance)};\n`
            + `  parameter Real omega = ${real(2 * Math.PI * p.frequency)}, phase = ${real(Math.PI * p.duty)};\n${scalar(['i', 'v', 'Ein', 'Eloss', 'Eload'])}\n  Real s;\nequation\n`
            + `  s = if cos(omega*time - phase) >= cos(phase) then 1 else 0;\n  der(i) = (s*Vin - r*i - v)/L;\n  der(v) = (i - v/R)/C;\n  der(Ein) = s*Vin*i;\n  der(Eloss) = r*i^2;\n  der(Eload) = v^2/R;\nend ${name};\n`;
    }
    throw new Error(`unknown kind ${problem.kind}`);
}

function stateNames(problem) {
    if (problem.kind === 'robertson') return ['a', 'b', 'c'];
    if (problem.kind === 'vanDerPol') return ['x', 'y'];
    if (problem.kind === 'lorenz') return ['x', 'y', 'z'];
    if (problem.kind === 'buck') return ['i', 'v', 'Ein', 'Eloss', 'Eload'];
    return problem.parameters.rows.map((_row, index) => `x[${index + 1}]`);
}

function parseCsv(text) {
    const [header, ...lines] = text.trim().split('\n');
    return { columns: header.split(',').map((column) => column.replace(/^"|"$/g, '')), rows: lines.map((line) => line.split(',').map(Number)) };
}

// The row at each sample: the last row written at that time (after an event's, if one falls on it).
function atSamples({ columns, rows }, times, names, compared) {
    const timeColumn = columns.indexOf('time');
    const indexes = compared.map((index) => columns.indexOf(names[index]));
    if (indexes.some((index) => index < 0)) throw new Error(`OpenModelica's result lacks ${compared.map((index) => names[index]).filter((_name, k) => indexes[k] < 0).join(', ')}`);
    let cursor = 0;
    return times.map((time) => {
        const tolerance = 1e-9 * Math.max(Math.abs(time), times.at(-1) * 1e-6);
        while (cursor < rows.length && rows[cursor][timeColumn] < time - tolerance) cursor += 1;
        let found = cursor;
        while (found + 1 < rows.length && Math.abs(rows[found + 1][timeColumn] - time) <= tolerance) found += 1;
        if (found >= rows.length || Math.abs(rows[found][timeColumn] - time) > tolerance) throw new Error(`no output row at t = ${time}`);
        return indexes.map((index) => rows[found][index]);
    });
}

function statistics(log) {
    const number = (pattern) => Number(pattern.exec(log)?.[1] ?? NaN);
    const value = (pattern) => (Number.isFinite(number(pattern)) ? number(pattern) : null);
    return { steps: value(/(\d+)\s+steps taken/), nfev: value(/(\d+)\s+calls of functionODE/), njev: value(/(\d+)\s+evaluations of jacobian/), rejected: value(/(\d+)\s+error test failures/), events: value(/(\d+)\s+state events/) };
}

// work: a host directory the container mounts as /work. Returns the session: start(), build(problem), run(problem, solver, relative,
// referenceSamples) and stop().
export function createOpenModelica(work) {
    const container = `konjugate-openmodelica-${process.pid}`;
    const inside = (script) => execute('docker', ['exec', container, 'bash', '-c', script]);
    const built = new Map();
    const session = {
        version: '',
        async start() {
            const docker = await execute('docker', ['info', '--format', '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}']);
            if (docker.code !== 0) throw new Error('Docker is not running: start Docker (Docker Desktop on a Mac) for OpenModelica.');
            const pulled = await execute('docker', ['pull', '--platform', dockerPlatform, image]);
            if (pulled.code !== 0) throw new Error(`docker pull ${image} failed: ${pulled.diagnostics}`);
            const digest = (await execute('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image])).output.trim();
            const label = process.env.AO_SESSION_ID ? ['--label', `ao.session=${process.env.AO_SESSION_ID}`] : [];
            const started = await execute('docker', ['run', '-d', '--rm', '--name', container, ...label, '--platform', dockerPlatform, '-v', `${work}:/work`, image, 'sleep', 'infinity']);
            if (started.code !== 0) throw new Error(`The OpenModelica container did not start: ${started.diagnostics}`);
            session.version = `${(await inside('omc --version')).output.trim()}, image ${digest || image} (${dockerPlatform} under Docker ${docker.output.trim()}); executables run with -jacobian=coloredSymbolical`;
        },
        async stop() {
            await execute('docker', ['rm', '-f', container]);
        },
        // Translates and compiles the problem's model; returns OpenModelica's own times for each phase, in seconds.
        async build(problem) {
            const name = `Konjugate_${problem.id}`;
            const directory = join(work, problem.id);
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, `${name}.mo`), modelica(problem, name));
            const intervals = Math.round(problem.run.targetTime / problem.run.outputInterval);
            await writeFile(join(directory, 'build.mos'), [
                'setCommandLineOptions("--generateDynamicJacobian=symbolic"); getErrorString();',
                `loadFile("${name}.mo"); getErrorString();`,
                `res := simulate(${name}, startTime = 0.0, stopTime = ${real(problem.run.targetTime)}, numberOfIntervals = ${intervals}, tolerance = 1e-6, method = "dassl", outputFormat = "csv", simflags = "-jacobian=coloredSymbolical");`,
                'getErrorString();'
            ].join('\n'));
            const result = await inside(`cd /work/${problem.id} && omc build.mos`);
            // OpenModelica prints simulate()'s record: its own time for each phase.
            const time = (field) => Number(new RegExp(`${field} = ([0-9.eE+-]+)`).exec(result.output)?.[1]);
            if (!existsSync(join(directory, name)) || !Number.isFinite(time('timeCompile'))) throw new Error(`translation failed: ${(result.output + result.diagnostics).slice(-300)}`);
            const [frontend, backend, simCode, templates, compile] = ['timeFrontend', 'timeBackend', 'timeSimCode', 'timeTemplates', 'timeCompile'].map(time);
            built.set(problem.id, { name, intervals, directory });
            return { frontend, backend, simCode, templates, compile, translation: frontend + backend + simCode + templates };
        },
        // One run of the built executable: its time inside the container (the executable alone), and when referenceSamples are given, the
        // error and the work OpenModelica reports.
        async run(problem, solver, relative, referenceSamples = null) {
            const { name, intervals, directory } = built.get(problem.id);
            const command = `cd /work/${problem.id} && s=$(date +%s%N) && ./${name} -s=${solver} -jacobian=coloredSymbolical -tolerance=${relative} -r=result.csv -lv=LOG_STATS > log.txt 2>&1; code=$?; e=$(date +%s%N); echo $((e - s)) $code`;
            const [nanoseconds, code] = (await inside(command)).output.trim().split(/\s+/).map(Number);
            if (code !== 0) {
                const log = await readFile(join(directory, 'log.txt'), 'utf8');
                throw new Error(log.split('\n').filter((line) => /error|fail/i.test(line)).slice(0, 3).join(' ').slice(0, 300) || `exit ${code}`);
            }
            // OpenModelica's own timer for the simulation (integration and output), apart from starting and reading its XML files.
            const log = await readFile(join(directory, 'log.txt'), 'utf8');
            const simulation = Number(/([0-9.eE+-]+)s\s+\[\s*[0-9.]+%\]\s+simulation/.exec(log)?.[1]);
            const timing = { seconds: Number.isFinite(simulation) ? simulation : nanoseconds / 1e9, wallSeconds: nanoseconds / 1e9 };
            if (!referenceSamples) return timing;
            const samples = atSamples(parseCsv(await readFile(join(directory, 'result.csv'), 'utf8')), problem.times, stateNames(problem), problem.compared);
            return { ...timing, relativeError: errorMetrics(samples, referenceSamples).relativeError, work: statistics(log) };
        }
    };
    return session;
}
