/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Code export of programs in the current format (version 2 of the program SDK), each in C++ and in Python, exported, compiled or run,
// and compared with the engine's run of the same model at every digit each export writes: conduction written as a program, with a room
// in °C (its input converted at the port, as the engine converts it); the digital PID example (a node's program with a clock, a random
// sensor and an Update); a thermostat that latches (memory advanced after every substep, two a step); and a two-way relationship whose
// program remembers and sets itself up in initialize() (one instance for both ends); the last three also under Runge–Kutta 4 (two
// internal steps a global step), Adaptive, Stiff and BDF, where a program is evaluated at every stage and advanced after every step the
// method accepts; and a decay whose program refuses a negative amount, under Adaptive, which rejects the steps it refuses.
//
//   node tests/engine/programExportFidelity.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateStandaloneProgram } from '../../src/codeExport.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', 'konjugateEngine');
const execute = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', (chunk) => { diagnostics += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, diagnostics }));
});
const example = (name) => readFile(join(root, 'examples', 'providers', name), 'utf8');
const document = (kind, source, roomUnit, roomInitial) => ({
    format: 'konjugate', version: 1, metadata: { projectName: 'Conduction' },
    nodes: [
        { id: 1, name: 'Wall', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 310, unit: 'K' }], sourceTerms: [] },
        { id: 2, name: 'Room', states: [{ id: 21, name: 'Temperature', symbol: 'temperature', initialValue: roomInitial, unit: roomUnit }], sourceTerms: [] }
    ],
    edges: [{
        id: 31, name: 'Conduction', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', equation: '',
        parameters: [{ id: 41, name: 'Conductance', symbol: 'conductance', value: 4, unit: 'W/K', mode: 'constant' }, { id: 42, name: 'Capacity', symbol: 'capacity', value: 2, unit: 'J/K', mode: 'constant' }],
        implementation: {
            kind, providerApiVersion: 2, source,
            bindings: [
                { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 }, { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 },
                { key: 'conductance', kind: 'parameter', parameterId: 41 }, { key: 'capacity', kind: 'parameter', parameterId: 42 }
            ],
            output: { role: 'target', key: 'warming', stateId: 21 }
        }
    }],
    exportDefaultTargetTime: 4,
    runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }],
    activeRunConfigurationId: 900
});

const providers = { cpp: { sdkPath: join(root, 'engine') }, python: { sdkPath: join(root, 'engine', 'sdk', 'python') } };
const runConfiguration = (model) => model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);

// The engine's run of `model` and its export's, every state at every sample, compared at the digits the export writes.
async function compare(model, kind, label) {
    const { globalTimeStep, outputInterval, method, tolerance, stepsPerGlobalStep } = runConfiguration(model);
    const time = model.exportDefaultTargetTime;
    const modelPath = join(directory, 'model.kjt');
    const configurationPath = join(directory, 'run.json');
    const resultPath = join(directory, 'run.kjr');
    await writeFile(modelPath, await encodeProjectFile(JSON.stringify(model)));
    await writeFile(configurationPath, JSON.stringify({ name: 'run', targetTime: time, globalTimeStep, outputInterval, execution: { backend: 'serial' }, providers,
        ...(method ? { method } : {}), ...(tolerance ? { tolerance } : {}), ...(stepsPerGlobalStep ? { stepsPerGlobalStep } : {}) }));
    const engineRun = await execute(executable, ['run', modelPath, '--configuration', configurationPath, '--output', resultPath]);
    assert.equal(engineRun.code, 0, `${label}: the engine must run: ${engineRun.diagnostics}`);
    const engine = decodeResultFile(await readFile(resultPath)).samples.map((sample) => sample.states.map((state) => state.value));
    const csvPath = join(directory, `${kind}.csv`);
    if (kind === 'cpp') {
        const sourcePath = join(directory, 'exported.cpp');
        const binaryPath = join(directory, 'exported');
        await writeFile(sourcePath, generateStandaloneProgram(model, 'cpp'));
        const compiled = await execute(process.env.CXX || 'c++', ['-std=c++20', '-O2', sourcePath, '-o', binaryPath]);
        assert.equal(compiled.code, 0, `${label}: the export must compile: ${compiled.diagnostics}`);
        const ran = await execute(binaryPath, ['--target-time', String(time), '--output', csvPath]);
        assert.equal(ran.code, 0, `${label}: the export must run: ${ran.diagnostics}`);
    } else {
        const sourcePath = join(directory, 'exported.py');
        await writeFile(sourcePath, generateStandaloneProgram(model, 'python'));
        const ran = await execute(process.env.PYTHON || 'python3', [sourcePath, '--target-time', String(time), '--output', csvPath]);
        assert.equal(ran.code, 0, `${label}: the export must run: ${ran.diagnostics}`);
    }
    const rows = (await readFile(csvPath, 'utf8')).trim().split('\n').slice(1).map((line) => line.split(',').map(Number).slice(1));
    assert.equal(rows.length, engine.length, `${label}: as many samples as the engine.`);
    // The C++ export writes 15 significant digits, the Python export 10: each is compared at the digits it writes. Under Stiff and BDF
    // the Jacobian is a finite difference, which turns the last-bit difference between an exported equation and the engine's into a
    // difference in its entries and so in the steps the error control takes: there the two agree within the tolerance's reach, as in
    // tests/engine/codeExportFidelity.mjs.
    const digits = method === 'rodas4' || method === 'rodas5p' || method === 'bdf' ? 1e-6 : kind === 'cpp' ? 1e-14 : 1e-9;
    rows.forEach((row, index) => row.forEach((value, state) => assert.ok(Math.abs(value - engine[index][state]) <= digits * Math.abs(engine[index][state]),
        `${label}: sample ${index}, state ${state} is ${value}, the engine ${engine[index][state]}.`)));
    return engine;
}

const pidCpp = await example('pidController.cpp');
const pid = (kind, source) => {
    const shared = [['setpoint', 293.15, 'K'], ['kp', 50, 'W/K'], ['ki', 5, 'W/(K*s)'], ['kd', 1, 'W*s/K'], ['maxPower', 2000, 'W'], ['sensorNoise', 0.1, 'K']]
        .map(([symbol, value, unit], index) => ({ id: 500 + index, name: symbol, symbol, value, unit, mode: 'constant' }));
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'Heated room' }, sharedParameters: shared,
        nodes: [{
            id: 1, name: 'Heater', updates: 'settle',
            states: [
                { id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 285, unit: 'K', kind: 'rate' },
                { id: 12, name: 'Power', symbol: 'power', initialValue: 0, unit: 'W', kind: 'update' }
            ],
            sourceTerms: [{
                id: 101, state: 'temperature', expression: '(power - 50 (temperature - 280)) / 1000',
                expressionModel: {
                    latex: '', output: { stateId: 11 },
                    mathJson: ['Divide', ['Add', 'power', ['Negate', ['Multiply', 50, ['Add', 'temperature', -280]]]], 1000],
                    bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'temperature' }, { kind: 'state', nodeId: 1, stateId: 12, symbol: 'power' }]
                }
            }],
            implementation: {
                kind, providerApiVersion: 2, source,
                bindings: [{ key: 'measurement', kind: 'state', nodeId: 1, stateId: 11 }, ...shared.map((parameter) => ({ key: parameter.symbol, kind: 'parameter', sharedParameterId: parameter.id }))],
                outputs: [{ key: 'power', stateId: 12 }]
            }
        }],
        edges: [],
        exportDefaultTargetTime: 3,
        runConfigurations: [{ id: 900, globalTimeStep: 0.005, outputInterval: 0.05 }],
        activeRunConfigurationId: 900
    };
};

const thermostat = {
    python: `from konjugate.v2 import Input, Memory, Node, Output


class Thermostat(Node):
    temperature = Input("degC")
    heater = Output("W")
    on = Memory(False)

    def evaluate(self, t, x):
        return self.outputs(heater=2000.0 if x.on else 0.0)

    def advance(self, step, x, m):
        if x.temperature < 19.5:
            m.on = True
        elif x.temperature > 20.5:
            m.on = False
`,
    cpp: `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

class Thermostat final : public k::Node {
public:
    k::Input temperature{this, "temperature", "degC"};
    k::Output heater{this, "heater", "W"};
    k::Memory<bool> on{this, "on", false};

    void evaluate(double, const k::Inputs& x, k::Outputs& y) const override { y[heater] = x[on] ? 2000.0 : 0.0; }
    void advance(const k::Step&, const k::Inputs& x, k::MemoryWriter& m) const override {
        if (x[temperature] < 19.5) m[on] = true;
        else if (x[temperature] > 20.5) m[on] = false;
    }
};

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Thermostat>(); }
`
};
const latched = (kind) => ({
    format: 'konjugate', version: 1, metadata: { projectName: 'Thermostat' },
    nodes: [{
        id: 1, name: 'Room', updates: 'settle', numerics: { substepsPerGlobalStep: 2 },
        states: [
            { id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 15, unit: 'degC', kind: 'rate' },
            { id: 12, name: 'Heat', symbol: 'heat', initialValue: 0, unit: 'W', kind: 'update' }
        ],
        sourceTerms: [{
            id: 101, state: 'temperature', expression: '(heat - 100 (temperature - 10)) / 1000',
            expressionModel: {
                latex: '', output: { stateId: 11 },
                mathJson: ['Divide', ['Add', 'heat', ['Negate', ['Multiply', 100, ['Add', 'temperature', -10]]]], 1000],
                bindings: [{ kind: 'state', nodeId: 1, stateId: 11, symbol: 'temperature' }, { kind: 'state', nodeId: 1, stateId: 12, symbol: 'heat' }]
            }
        }],
        implementation: { kind, providerApiVersion: 2, source: thermostat[kind], bindings: [{ key: 'temperature', kind: 'state', nodeId: 1, stateId: 11 }], outputs: [{ key: 'heater', stateId: 12 }] }
    }],
    edges: [],
    exportDefaultTargetTime: 120,
    runConfigurations: [{ id: 900, globalTimeStep: 0.5, outputInterval: 0.5 }],
    activeRunConfigurationId: 900
});

// A conduction that fouls as heat passes: its conductance, set up in initialize() from a constant, falls with the heat it has passed,
// which it remembers; both ends of a two-way relationship, one program.
const fouling = {
    python: `from konjugate.v2 import Constant, Input, Memory, Output, Relationship


class Fouling(Relationship):
    hot = Input("K")
    cold = Input("K")
    clean = Constant("W/K")
    warming = Output("K/s")
    passed = Memory(0.0)

    def initialize(self, setup, m):
        self.conductance = setup.clean / 2.0
        m.passed = 1.0

    def evaluate(self, t, x):
        return self.conductance * (x.hot - x.cold) / (1.0 + 0.01 * x.passed)

    def advance(self, step, x, m):
        m.passed = x.passed + step.size * abs(x.hot - x.cold)
`,
    cpp: `#include <konjugate/sdk/v2/program.hpp>

#include <cmath>
#include <memory>

namespace k = konjugate::sdk::v2;

class Fouling final : public k::Relationship {
public:
    k::Input hot{this, "hot", "K"};
    k::Input cold{this, "cold", "K"};
    k::Constant clean{this, "clean", "W/K"};
    k::Output warming{this, "warming", "K/s"};
    k::Memory<double> passed{this, "passed", 0.0};

    void initialize(const k::Setup& setup, k::MemoryWriter& m) override {
        conductance = setup[clean] / 2.0;
        m[passed] = 1.0;
    }
    double evaluate(double, const k::Inputs& x) const override { return conductance * (x[hot] - x[cold]) / (1.0 + 0.01 * x[passed]); }
    void advance(const k::Step& step, const k::Inputs& x, k::MemoryWriter& m) const override {
        m[passed] = x[passed] + step.size * std::abs(x[hot] - x[cold]);
    }

private:
    double conductance = 0;
};

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Fouling>(); }
`
};
const fouled = (kind) => {
    const model = document(kind, fouling[kind], 'K', 295);
    const edge = model.edges[0];
    edge.directionality = 'bidirectional';
    edge.parameters = [{ id: 43, name: 'Clean', symbol: 'clean', value: 8, unit: 'W/K', mode: 'constant' }];
    edge.implementation.bindings = [
        { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 }, { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 }, { key: 'clean', kind: 'parameter', parameterId: 43 }
    ];
    model.nodes[1].numerics = { substepsPerGlobalStep: 3 };
    return model;
};

const methods = [
    { method: 'rungeKutta4', stepsPerGlobalStep: 2 },
    { method: 'dormandPrince54', tolerance: { relative: 1e-6, absolute: 1e-9 } },
    { method: 'tsit5', tolerance: { relative: 1e-6, absolute: 1e-9 } },
    { method: 'rodas4', tolerance: { relative: 1e-6, absolute: 1e-9 } },
    { method: 'rodas5p', tolerance: { relative: 1e-6, absolute: 1e-9 } },
    { method: 'bdf', tolerance: { relative: 1e-6, absolute: 1e-9 } }
];

// A fast decay whose program refuses a negative amount: Adaptive overshoots below zero at a large stage, is refused, and tries smaller.
const refusing = {
    python: `from konjugate.v2 import Input, OutOfDomain, Output, Relationship


class Decay(Relationship):
    amount = Input()
    rate = Output()

    def evaluate(self, t, x):
        if x.amount < 0:
            raise OutOfDomain(f"an amount of {x.amount:.3g} cannot decay")
        return -50.0 * x.amount
`,
    cpp: `#include <konjugate/sdk/v2/program.hpp>

#include <memory>
#include <string>

namespace k = konjugate::sdk::v2;

class Decay final : public k::Relationship {
public:
    k::Input amount{this, "amount"};
    k::Output rate{this, "rate"};

    double evaluate(double, const k::Inputs& x) const override {
        if (x[amount] < 0) throw k::OutOfDomain("an amount of " + std::to_string(x[amount]) + " cannot decay");
        return -50.0 * x[amount];
    }
};

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Decay>(); }
`
};
const decaying = (kind) => ({
    format: 'konjugate', version: 1, metadata: { projectName: 'Decay' },
    nodes: [{
        id: 1, name: 'Store', states: [{ id: 11, name: 'Amount', symbol: 'amount', initialValue: 1, unit: '' }],
        sourceTerms: [{ id: 101, state: 'amount', expression: '', implementation: {
            kind, providerApiVersion: 2, source: refusing[kind], bindings: [{ key: 'amount', kind: 'state', nodeId: 1, stateId: 11 }], output: { key: 'rate', stateId: 11 }
        } }]
    }],
    edges: [],
    exportDefaultTargetTime: 0.5,
    runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.1, method: 'dormandPrince54', tolerance: { relative: 1e-8, absolute: 1e-12 } }],
    activeRunConfigurationId: 900
});

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramExport-'));
try {
    for (const [roomUnit, roomInitial] of [['K', 295], ['degC', 21.85]]) {
        for (const [kind, file] of [['cpp', 'conduction.cpp'], ['python', 'conduction.py']]) {
            await compare(document(kind, await example(file), roomUnit, roomInitial), kind, `conduction, ${kind}, room in ${roomUnit}`);
        }
    }
    for (const kind of ['cpp', 'python']) {
        const heated = await compare(pid(kind, kind === 'cpp' ? pidCpp : await example('pidController.py')), kind, `PID, ${kind}`);
        assert.ok(heated.at(-1)[0] > heated[0][0] + 0.5 && heated.at(-1)[1] > 0, `PID, ${kind}: the heater must warm the room.`);
        const latch = await compare(latched(kind), kind, `thermostat, ${kind}`);
        assert.ok(latch.some((sample) => sample[1] === 2000) && latch.slice(-60).some((sample) => sample[1] === 0), `thermostat, ${kind}: the heater must switch.`);
        const fouledRun = await compare(fouled(kind), kind, `fouling, ${kind}`);
        assert.ok(Math.abs(fouledRun.at(-1)[0] - fouledRun.at(-1)[1]) < Math.abs(310 - 295), `fouling, ${kind}: the two ends must approach.`);
        for (const settings of methods) {
            const under = (model) => ({ ...model, runConfigurations: [{ ...runConfiguration(model), ...settings }] });
            await compare(under(pid(kind, kind === 'cpp' ? pidCpp : await example('pidController.py'))), kind, `PID, ${kind}, ${settings.method}`);
            await compare(under(latched(kind)), kind, `thermostat, ${kind}, ${settings.method}`);
            await compare(under(fouled(kind)), kind, `fouling, ${kind}, ${settings.method}`);
        }
        await compare(decaying(kind), kind, `refusing decay, ${kind}, dormandPrince54`);
    }
    console.log('Programs in the current format export to C++ and Python with the engine\'s numbers: memory, clocks, Updates and initialize() included.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
