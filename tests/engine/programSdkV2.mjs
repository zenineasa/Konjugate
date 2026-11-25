/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for version 2 of the program SDK (docs/proposals/programSdkV2.md), through the real engine:
//   - conduction written as a version 2 program, in C++ and in Python, gives the bits of the equation it replaces, under Euler node by
//     node;
//   - a port bound to a state in a compatible unit is converted at the port (°C to K), and an incompatible one is refused by name;
//   - an input left unbound without a default, and a binding to an input the program does not have, are refused by name;
//   - the digital PID example (memory, a clock, a Random stream, an output into an Update state) gives the same bits in C++ and Python,
//     and a run to T equals, to the bit, a run to T / 2 continued from its checkpoint, the memory restored by the engine;
//   - a value that is not a finite number, an impure evaluate() and a misspelt port are named, with the program, what it belongs to, the
//     port and the time;
//   - the file's providerApiVersion must agree with the source, and an unknown version is refused by name.
//
// Run manually (after `npm run build:engine`):
//   node tests/engine/programSdkV2.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { EngineSession } from '../../src/engineSession.mjs';
import { convertProgramToVersion2 } from '../../src/programConversion.mjs';
import { defaultNodeProviderSource, defaultProviderSource, olderProviderSource } from '../../src/providerTemplate.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeValidationReport } from '../../src/reportProtocol.mjs';

const root = join(import.meta.dirname, '..', '..');
const executable = process.argv[2] ?? join(root, 'out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine');
const providers = {
    executionMode: 'inProcess',
    cpp: { sdkPath: join(root, 'engine') },
    python: { sdkPath: join(root, 'engine', 'sdk', 'python') }
};
const example = (name) => readFile(join(root, 'examples', 'providers', name), 'utf8');

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramSdkV2-'));
let runs = 0;

async function attempt(document, configuration) {
    const index = runs++;
    const modelPath = join(directory, `model${index}.kjt`);
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(modelPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, providers, execution: { backend: 'serial' }, ...configuration }));
    const outcome = await execute(['run', modelPath, '--configuration', configurationPath, '--output', outputPath]);
    return { ...outcome, result: outcome.code === 0 ? decodeResultFile(await readFile(outputPath)) : null };
}

async function run(document, configuration) {
    const { code, diagnostics, result } = await attempt(document, configuration);
    const issues = code !== 0 && diagnostics.includes('MODEL_INVALID')
        ? (await validate(document)).filter((issue) => issue.severity === 'error').map((issue) => issue.message).join(' ') : '';
    assert.equal(code, 0, `The run must succeed: ${diagnostics}${issues}`);
    return result;
}

async function refused(document, configuration, pattern, what) {
    const { code, diagnostics } = await attempt(document, configuration);
    assert.notEqual(code, 0, `${what}: the run must stop.`);
    assert.match(diagnostics, pattern, `${what}: ${diagnostics}`);
}

async function validate(document) {
    const index = runs++;
    const modelPath = join(directory, `validate${index}.kjt`);
    const reportPath = join(directory, `validate${index}.bin`);
    await writeFile(modelPath, await encodeProjectFile(JSON.stringify(document)));
    await execute(['validate', modelPath, '--report', reportPath]);
    return decodeValidationReport(await readFile(reportPath)).issues ?? [];
}

const valuesOf = (result) => result.samples.flatMap((sample) => sample.states.map((state) => state.value));
const sameBits = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
const stateValues = (result, stateId) => result.samples.map((sample) => sample.states.find((state) => state.stateId === stateId).value);

// Two bodies, Wall (hot) and Room (cold), and a relationship conducting heat from one to the other: an equation, or a program.
function conduction({ implementation = null, roomUnit = 'K', roomInitial = 295, bindings = null, capacity = 2 } = {}) {
    const edge = {
        id: 31, name: 'Conduction', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', equation: '',
        parameters: [
            { id: 41, name: 'Conductance', symbol: 'conductance', value: 4, unit: 'W/K', mode: 'constant' },
            { id: 42, name: 'Capacity', symbol: 'capacity', value: capacity, unit: 'J/K', mode: 'constant' }
        ]
    };
    if (implementation) {
        edge.implementation = {
            ...implementation,
            bindings: bindings ?? [
                { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 },
                { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 },
                { key: 'conductance', kind: 'parameter', parameterId: 41 },
                { key: 'capacity', kind: 'parameter', parameterId: 42 }
            ],
            output: { role: 'target', key: 'warming', stateId: 21 }
        };
    } else {
        edge.equation = '\\frac{conductance (hot - cold)}{capacity}';
        edge.equationModel = {
            latex: edge.equation, output: { role: 'target', stateId: 21 },
            mathJson: ['Divide', ['Multiply', 'conductance', ['Add', 'hot', ['Negate', 'cold']]], 'capacity'],
            bindings: [
                { kind: 'state', role: 'source', nodeId: 1, stateId: 11, symbol: 'hot' },
                { kind: 'state', role: 'target', nodeId: 2, stateId: 21, symbol: 'cold' },
                { kind: 'parameter', parameterId: 41, symbol: 'conductance' },
                { kind: 'parameter', parameterId: 42, symbol: 'capacity' }
            ]
        };
    }
    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        nodes: [
            { id: 1, name: 'Wall', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 310, unit: 'K' }], sourceTerms: [] },
            { id: 2, name: 'Room', states: [{ id: 21, name: 'Temperature', symbol: 'temperature', initialValue: roomInitial, unit: roomUnit }], sourceTerms: [] }
        ],
        edges: [edge]
    };
}

// A heater whose power a digital PID program sets (an Update state), warming a room that loses heat to 280 K outside.
function heatedRoom(kind, source, { noise = 0.1 } = {}) {
    const shared = [
        ['setpoint', 293.15, 'K'], ['kp', 50, 'W/K'], ['ki', 5, 'W/(K*s)'], ['kd', 1, 'W*s/K'], ['maxPower', 2000, 'W'], ['sensorNoise', noise, 'K']
    ].map(([symbol, value, unit], index) => ({ id: 500 + index, name: symbol, symbol, value, unit, mode: 'constant' }));
    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        sharedParameters: shared,
        nodes: [{
            id: 1, name: 'Heater',
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
                bindings: [
                    { key: 'measurement', kind: 'state', nodeId: 1, stateId: 11 },
                    ...shared.map((parameter) => ({ key: parameter.symbol, kind: 'parameter', sharedParameterId: parameter.id }))
                ],
                outputs: [{ key: 'power', stateId: 12 }]
            }
        }],
        edges: []
    };
}

try {
    // Conduction: the program, in each language, gives the equation's bits.
    const timing = { targetTime: 4, globalTimeStep: 0.01, outputInterval: 0.1 };
    const equation = await run(conduction(), timing);
    for (const [kind, file] of [['cpp', 'conduction.cpp'], ['python', 'conduction.py']]) {
        const program = await run(conduction({ implementation: { kind, providerApiVersion: 2, source: await example(file) } }), timing);
        assert.ok(sameBits(valuesOf(program), valuesOf(equation)), `Conduction in ${kind} must give the equation's bits.`);
    }

    // Units: a room in °C is converted at the port (295 K is 21.85 °C), and the rate in K/s reaches it as °C/s.
    const python = { kind: 'python', providerApiVersion: 2, source: await example('conduction.py') };
    const celsius = await run(conduction({ implementation: python, roomUnit: 'degC', roomInitial: 21.85 }), timing);
    const kelvin = stateValues(equation, 21);
    stateValues(celsius, 21).forEach((value, index) => assert.ok(Math.abs(value + 273.15 - kelvin[index]) < 1e-9,
        `A room in °C must follow the room in K (${value} °C against ${kelvin[index]} K).`));
    await refused(conduction({ implementation: python, roomUnit: 'm' }), timing,
        /Input ‘cold’ of the program Conduction on relationship Wall → Room is in K but is bound to Room\.temperature, in m\./, 'An input in the wrong unit');

    // Bindings: one missing without a default, and one to an input the program does not have.
    const fewer = [
        { key: 'hot', kind: 'state', nodeId: 1, stateId: 11 }, { key: 'cold', kind: 'state', nodeId: 2, stateId: 21 },
        { key: 'conductance', kind: 'parameter', parameterId: 41 }
    ];
    await refused(conduction({ implementation: python, bindings: fewer }), timing,
        /Input ‘capacity’ of Conduction on relationship Wall → Room is not bound to anything and has no default\. Bind it on the Program tab/, 'An unbound input');
    await refused(conduction({ implementation: python, bindings: [...fewer, { key: 'capacty', kind: 'parameter', parameterId: 42 }] }), timing,
        /The program Conduction on relationship Wall → Room has no input ‘capacty’ \(its inputs: hot, cold, conductance, capacity\)/, 'A binding to no input');

    // An exception names the program, what it belongs to, the time, the line and the inputs.
    await refused(conduction({ implementation: python, capacity: 0 }), timing,
        /Conduction on relationship Wall → Room failed in evaluate\(\) at t = 0 s: ZeroDivisionError: (?:float )?division by zero \(line 18\)\. Inputs: hot = 310 K, cold = 295 K, conductance = 4 W\/K, capacity = 0 J\/K/,
        'An exception in a program');
    // A value that is not a finite number, from finite inputs, named; under Euler the run stops.
    await refused(conduction({ implementation: { kind: 'cpp', providerApiVersion: 2, source: await example('conduction.cpp') }, capacity: 0 }), timing,
        /Conduction on relationship Wall → Room gave inf for ‘warming’ at t = 0 s from finite inputs\. Inputs: hot = 310 K, cold = 295 K, conductance = 4 W\/K, capacity = 0 J\/K/,
        'A non-finite output');

    // An impure evaluate(): in Python the frozen object says where memory belongs; in C++ the engine's double first call catches it.
    const impurePython = `from konjugate.v2 import Input, Output, Relationship


class Counting(Relationship):
    hot = Input("K")
    cold = Input("K")
    conductance = Input("W/K")
    capacity = Input("J/K")
    warming = Output("K/s")

    def evaluate(self, t, x):
        self.calls = getattr(self, "calls", 0) + 1
        return float(self.calls)
`;
    await refused(conduction({ implementation: { kind: 'python', providerApiVersion: 2, source: impurePython } }), timing,
        /Counting on relationship Wall → Room failed in evaluate\(\) at t = 0 s: AttributeError: Counting cannot set 'calls' after initialize\(\).*\(line 12\)/,
        'A Python program changing itself');
    const impureCpp = `#include <konjugate/sdk/v2/program.hpp>
#include <memory>
namespace k = konjugate::sdk::v2;
namespace {
class Counting final : public k::Relationship {
public:
    k::Input hot{this, "hot", "K"};
    k::Input cold{this, "cold", "K"};
    k::Input conductance{this, "conductance", "W/K"};
    k::Input capacity{this, "capacity", "J/K"};
    k::Output warming{this, "warming", "K/s"};
    double evaluate(double, const k::Inputs&) const override { return static_cast<double>(++calls_); }
private:
    mutable int calls_ = 0;
};
}
std::unique_ptr<k::Program> createProgram() { return std::make_unique<Counting>(); }
`;
    await refused(conduction({ implementation: { kind: 'cpp', providerApiVersion: 2, source: impureCpp } }), timing,
        /Counting on relationship Wall → Room gave a different ‘warming’ when called twice with the same inputs at t = 0 s \(1, then 2\)\. evaluate\(\) must not change anything/,
        'A C++ program changing itself');

    // A misspelt port in Python is found when the program is loaded, before anything runs.
    const misspelt = (await example('conduction.py')).replace('x.capacity', 'x.capactiy');
    await refused(conduction({ implementation: { kind: 'python', providerApiVersion: 2, source: misspelt } }), timing,
        /The program Conduction reads 'capactiy', which is not one of its inputs or memory \(capacity, cold, conductance, hot\)\. Line 18\./, 'A misspelt port');

    // The digital PID: memory, a clock, a Random stream and an Update output, the same bits in C++ and Python.
    const pidTiming = { targetTime: 2, globalTimeStep: 0.01, outputInterval: 0.01 };
    const pidCpp = await run(heatedRoom('cpp', await example('pidController.cpp')), pidTiming);
    const pidPython = await run(heatedRoom('python', await example('pidController.py')), pidTiming);
    assert.ok(sameBits(valuesOf(pidCpp), valuesOf(pidPython)), 'The PID example must give the same bits in C++ and Python.');
    const power = stateValues(pidPython, 12);
    assert.ok(power[0] > 0 && power[0] <= 2000, `The controller's first sample must set the power at the start (${power[0]} W).`);
    assert.ok(stateValues(pidPython, 11).at(-1) > 285, 'The heater must warm the room.');
    const memory = pidPython.checkpoints.at(-1).programMemory;
    assert.equal(memory?.length, 1, 'A checkpoint must keep the program\'s memory.');
    assert.deepEqual(memory[0].fields.map((field) => field.name), ['integral', 'previousError', 'held', 'noise'], 'Memory is kept field by field, by name.');
    assert.equal(memory[0].fields[3].words[1], String(2 * 201), 'The noise stream must have drawn twice at each of 201 ticks.');

    // A run to T equals a run to T / 2 continued from its checkpoint, the memory restored by the engine, in each language.
    for (const [kind, file] of [['cpp', 'pidController.cpp'], ['python', 'pidController.py']]) {
        const document = heatedRoom(kind, await example(file));
        const whole = kind === 'cpp' ? pidCpp : pidPython;
        const half = await run(document, { ...pidTiming, targetTime: 1 });
        const checkpoint = half.checkpoints.at(-1);
        assert.equal(checkpoint.time, 1, 'The half run must end with a checkpoint at its end.');
        const rest = await run(document, { ...pidTiming, startCheckpoint: checkpoint });
        const tail = whole.samples.filter((sample) => sample.time > 1 + 1e-9);
        const continued = rest.samples.filter((sample) => sample.time > 1 + 1e-9);
        assert.ok(tail.length > 50 && sameBits(tail.flatMap((sample) => sample.states.map((state) => state.value)),
            continued.flatMap((sample) => sample.states.map((state) => state.value))), `A ${kind} PID continued from its checkpoint must give the bits of the whole run.`);
    }

    // A latch: memory with no clock, advanced after every substep under Euler node by node, and continued from a checkpoint to the bit.
    const thermostat = `from konjugate.v2 import Input, Memory, Node, Output


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
`;
    const latched = {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        nodes: [{
            id: 1, name: 'Room', numerics: { substepsPerGlobalStep: 2 },
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
            implementation: {
                kind: 'python', providerApiVersion: 2, source: thermostat,
                bindings: [{ key: 'temperature', kind: 'state', nodeId: 1, stateId: 11 }],
                outputs: [{ key: 'heater', stateId: 12 }]
            }
        }],
        edges: []
    };
    const latchTiming = { targetTime: 400, globalTimeStep: 0.5, outputInterval: 0.5 };
    const latch = await run(latched, latchTiming);
    const late = stateValues(latch, 11).slice(400);
    assert.ok(late.every((value) => value > 19 && value < 21) && Math.max(...late) > 20.4 && Math.min(...late) < 19.6,
        `The thermostat must hold the room between its two thresholds (${Math.min(...late)} to ${Math.max(...late)} °C).`);
    const latchHalf = await run(latched, { ...latchTiming, targetTime: 200 });
    const latchRest = await run(latched, { ...latchTiming, startCheckpoint: latchHalf.checkpoints.at(-1) });
    assert.ok(sameBits(latch.samples.filter((sample) => sample.time > 200).flatMap((sample) => sample.states.map((state) => state.value)),
        latchRest.samples.filter((sample) => sample.time > 200).flatMap((sample) => sample.states.map((state) => state.value))),
    'A latch continued from its checkpoint must give the bits of the whole run.');

    // The starter templates run as generated, in both languages: a relationship's and a node's.
    for (const kind of ['cpp', 'python']) {
        const templated = conduction({ implementation: { kind, providerApiVersion: 2, source: defaultProviderSource(kind, [{ key: 'hot' }, { key: 'cold' }, { key: 'conductance' }, { key: 'capacity' }], 'warming', 'Conduction') } });
        templated.nodes.push({
            id: 3, name: 'Programmed', states: [{ id: 61, name: 'Level', symbol: 'level', initialValue: 1, unit: '' }], sourceTerms: [],
            implementation: {
                kind, providerApiVersion: 2, source: defaultNodeProviderSource(kind, [{ key: 'level' }], [{ key: 'levelRate' }], 'Programmed'),
                bindings: [{ key: 'level', kind: 'state', nodeId: 3, stateId: 61 }], outputs: [{ key: 'levelRate', stateId: 61 }]
            }
        });
        const fromTemplates = await run(templated, timing);
        assert.ok(stateValues(fromTemplates, 21).every((value) => value === 295) && stateValues(fromTemplates, 61).every((value) => value === 1),
            `The ${kind} templates, as generated, must run and change nothing.`);
    }

    // Several outputs: one relationship's program reaching a state at each end (implementation.outputs), the room warmed and the wall
    // cooled by the same heat; it gives a two-way conduction equation's bits, and is refused on a two-way relationship or in the older format.
    const exchange = `from konjugate.v2 import Input, Node, Output, Parameter


class Exchange(Node):
    hot = Input("K")
    cold = Input("K")
    conductance = Parameter("W/K")
    capacity = Parameter("J/K")
    warming = Output("K/s")
    cooling = Output("K/s")

    def evaluate(self, t, x):
        flow = x.conductance * (x.hot - x.cold) / x.capacity
        return self.outputs(warming=flow, cooling=-flow)
`;
    const twoOutputs = conduction({ implementation: { kind: 'python', providerApiVersion: 2, source: exchange } });
    delete twoOutputs.edges[0].implementation.output;
    twoOutputs.edges[0].implementation.outputs = [{ key: 'warming', role: 'target', stateId: 21 }, { key: 'cooling', role: 'source', stateId: 11 }];
    const twoWay = conduction();
    twoWay.edges[0].directionality = 'bidirectional';
    const exchanged = await run(twoOutputs, timing);
    assert.ok(sameBits(valuesOf(exchanged), valuesOf(await run(twoWay, timing))), 'A program with two outputs must give a two-way equation\'s bits.');
    assert.ok(Math.abs(stateValues(exchanged, 11).at(-1) + stateValues(exchanged, 21).at(-1) - 605) < 1e-9, 'What leaves the wall reaches the room.');
    const outputsIssues = async (change) => {
        const document = structuredClone(twoOutputs);
        change(document.edges[0]);
        return (await validate(document)).filter((issue) => issue.code === 'programOutputsUnsupported').map((issue) => issue.message);
    };
    assert.deepEqual(await outputsIssues(() => {}), [], 'A one-way relationship\'s program may give several outputs.');
    assert.match((await outputsIssues((edge) => { edge.directionality = 'bidirectional'; }))[0] ?? '', /A two-way relationship gives one output/);
    assert.match((await outputsIssues((edge) => { edge.implementation.providerApiVersion = 1; }))[0] ?? '', /Only a program in the current program format/);

    // Stages: under Runge–Kutta 4 a version 2 program takes part in every stage, so conduction as a program gives the equation's bits
    // there too, and nothing is held; the same program in the older format is held, and differs.
    const rungeKutta4 = { ...timing, method: 'rungeKutta4' };
    const equationStages = await run(conduction(), rungeKutta4);
    for (const [kind, file] of [['cpp', 'conduction.cpp'], ['python', 'conduction.py']]) {
        const staged = await run(conduction({ implementation: { kind, providerApiVersion: 2, source: await example(file) } }), rungeKutta4);
        assert.ok(sameBits(valuesOf(staged), valuesOf(equationStages)), `Conduction in ${kind} must give the equation's bits under Runge–Kutta 4.`);
        assert.deepEqual(staged.integration?.heldTerms ?? [], [], `A version 2 ${kind} program is never held.`);
    }
    const olderConduction = `from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort


class Conduction(RelationshipProvider):
    def describe(self):
        return RelationshipDescription("conduction", "Conduction", [ScalarPort("hot", "hot", "K"), ScalarPort("cold", "cold", "K"),
            ScalarPort("conductance", "conductance", "W/K"), ScalarPort("capacity", "capacity", "J/K")], ScalarPort("warming", "warming", "K/s"))

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient(inputs["conductance"] * (inputs["hot"] - inputs["cold"]) / inputs["capacity"])
`;
    const held = await run(conduction({ implementation: { kind: 'python', providerApiVersion: 1, source: olderConduction } }), rungeKutta4);
    assert.deepEqual(held.integration.heldTerms, [{ sourceId: 31, stateId: 21 }], 'The same program in the older format is held, and named.');
    assert.ok(!sameBits(valuesOf(held), valuesOf(equationStages)), 'A held program is first order in its coupling.');

    // Converted: the older programs, converted, give the older programs' bits under Euler node by node (they were pure), in each language.
    const olderConductionCpp = olderProviderSource('cpp', [{ key: 'hot' }, { key: 'cold' }, { key: 'conductance' }, { key: 'capacity' }], 'warming', 'Conduction')
        .replace('        output.addGradient(0);', '        const double hot = context.inputs.at("hot");\n        output.addGradient(context.inputs.at("conductance") * (hot - context.inputs.at("cold")) / context.inputs.at("capacity"));');
    for (const [kind, older] of [['python', olderConduction], ['cpp', olderConductionCpp]]) {
        const converted = convertProgramToVersion2(kind, older);
        assert.ok(converted.complete, `The ${kind} conduction converts completely: ${converted.notes}`);
        const before = await run(conduction({ implementation: { kind, providerApiVersion: 1, source: older } }), timing);
        const after = await run(conduction({ implementation: { kind, providerApiVersion: 2, source: converted.source } }), timing);
        assert.ok(sameBits(valuesOf(before), valuesOf(after)) && sameBits(valuesOf(after), valuesOf(equation)),
            `The ${kind} conduction converted must give the older program's bits.`);
    }

    // Memory under Runge–Kutta 4 with two steps a global step: advance() after each, and a run continued from its checkpoint to the bit.
    const latchStages = { ...latchTiming, method: 'rungeKutta4', stepsPerGlobalStep: 2 };
    const latchRk = await run(latched, latchStages);
    const latchRkHalf = await run(latched, { ...latchStages, targetTime: 200 });
    const latchRkRest = await run(latched, { ...latchStages, startCheckpoint: latchRkHalf.checkpoints.at(-1) });
    assert.ok(sameBits(latchRk.samples.filter((sample) => sample.time > 200).flatMap((sample) => sample.states.map((state) => state.value)),
        latchRkRest.samples.filter((sample) => sample.time > 200).flatMap((sample) => sample.states.map((state) => state.value))),
    'A latch under Runge–Kutta 4 continued from its checkpoint must give the bits of the whole run.');
    const lateRk = stateValues(latchRk, 11).slice(400);
    assert.ok(Math.max(...lateRk) > 20.4 && Math.min(...lateRk) < 19.6, 'The latch must switch under Runge–Kutta 4.');

    // Under Adaptive and Stiff, memory advances after every step they accept (never a rejected one, or one taken again to land on an event),
    // and a run continued from its checkpoint, which keeps the controller and the memory, gives the bits of the whole run.
    for (const method of ['dormandPrince54', 'tsit5', 'rodas4', 'rodas5p', 'bdf']) {
        const adaptiveTiming = { ...latchTiming, method, tolerance: { relative: 1e-6, absolute: 1e-9 } };
        const whole = await run(latched, adaptiveTiming);
        const lateAdaptive = stateValues(whole, 11).slice(400);
        assert.ok(Math.max(...lateAdaptive) > 20.4 && Math.min(...lateAdaptive) < 19.6, `The latch must switch under ${method}.`);
        const firstHalf = await run(latched, { ...adaptiveTiming, targetTime: 200 });
        const rest = await run(latched, { ...adaptiveTiming, startCheckpoint: firstHalf.checkpoints.at(-1) });
        assert.ok(sameBits(whole.samples.filter((sample) => sample.time > 200).flatMap((sample) => sample.states.map((state) => state.value)),
            rest.samples.filter((sample) => sample.time > 200).flatMap((sample) => sample.states.map((state) => state.value))),
        `A latch under ${method} continued from its checkpoint must give the bits of the whole run.`);
    }

    // A program's own Jacobian under Stiff (Rodas4 and BDF): a stiff conduction, both ways, whose program says its derivatives. They are
    // supplied terms of the shared Jacobian assembly, beside the equations', taken through its ports and bindings, the other end's with the
    // sign flipped, so its columns are exact rather than differenced: the run follows the equation's, and a deliberately wrong Jacobian
    // changes the steps, which it would not if it were not used. Without one, the program is differenced, as an equation is under
    // finiteDifference.
    {
        const pythonJacobian = (factor) => `from konjugate.v2 import Input, Output, Parameter, Relationship


class Conduction(Relationship):
    hot = Input("K")
    cold = Input("K")
    conductance = Parameter("W/K")
    capacity = Parameter("J/K")
    warming = Output("K/s")

    def evaluate(self, t, x):
        return x.conductance * (x.hot - x.cold) / x.capacity

    def jacobian(self, t, x):
        g = ${factor} * x.conductance / x.capacity
        return {("warming", "hot"): g, ("warming", "cold"): -g}
`;
        const cppJacobian = `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

class Conduction final : public k::Relationship {
public:
    k::Input     hot        {this, "hot",         "K"};
    k::Input     cold       {this, "cold",        "K"};
    k::Parameter conductance{this, "conductance", "W/K"};
    k::Parameter capacity   {this, "capacity",    "J/K"};
    k::Output    warming    {this, "warming",     "K/s"};

    double evaluate(double, const k::Inputs& x) const override { return x[conductance] * (x[hot] - x[cold]) / x[capacity]; }
    void jacobian(double, const k::Inputs& x, k::Jacobian& J) const override {
        const double g = x[conductance] / x[capacity];
        J(warming, hot) = g;
        J(warming, cold) = -g;
    }
};

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Conduction>(); }
`;
        const bothWays = (implementation) => {
            const document = conduction({ implementation, capacity: 0.001 });
            document.edges[0].directionality = 'bidirectional';
            return document;
        };
        for (const method of ['rodas4', 'rodas5p', 'bdf']) {
            const stiffTiming = { targetTime: 2, globalTimeStep: 0.1, outputInterval: 0.1, method, tolerance: { relative: 1e-6, absolute: 1e-9 } };
            const equationRun = await run(bothWays(null), stiffTiming);
            const differenced = { ...stiffTiming, jacobian: 'finiteDifference' };
            const equationDifferenced = await run(bothWays(null), differenced);
            const plain = await run(bothWays({ kind: 'python', providerApiVersion: 2, source: await example('conduction.py') }), differenced);
            const given = await run(bothWays({ kind: 'python', providerApiVersion: 2, source: pythonJacobian(1) }), stiffTiming);
            const givenCpp = await run(bothWays({ kind: 'cpp', providerApiVersion: 2, source: cppJacobian }), stiffTiming);
            const wrong = await run(bothWays({ kind: 'python', providerApiVersion: 2, source: pythonJacobian(0.25) }), stiffTiming);
            assert.ok(sameBits(valuesOf(plain), valuesOf(equationDifferenced)), `Under ${method} a program without a Jacobian is differenced, as the equation is.`);
            assert.equal(given.integration.exactColumns, 2, `Under ${method} a program's own Jacobian makes its columns exact.`);
            const checked = await run(bothWays({ kind: 'python', providerApiVersion: 2, source: pythonJacobian(1) }), { ...stiffTiming, jacobian: 'check' });
            assert.ok(checked.integration.jacobianCheck.checks > 0 && checked.integration.jacobianCheck.largestDifference < 1e-6,
                `Under ${method} the check finds the program's Jacobian agreeing with differences (${JSON.stringify(checked.integration.jacobianCheck)}).`);
            const wrongChecked = await run(bothWays({ kind: 'python', providerApiVersion: 2, source: pythonJacobian(0.25) }), { ...stiffTiming, jacobian: 'check' });
            assert.ok(wrongChecked.integration.jacobianCheck.largestDifference > 0.1, `Under ${method} the check finds a wrong Jacobian out.`);
            const expected = valuesOf(equationRun);
            valuesOf(given).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-4,
                `Under ${method} a program's own Jacobian must follow the equation (${value} against ${expected[index]}).`));
            assert.ok(Math.abs(valuesOf(given).at(-1) - 302.5) < 1e-3 && Math.abs(valuesOf(given).at(-2) - 302.5) < 1e-3,
                `Under ${method} both ends must settle at the mean (${valuesOf(given).slice(-2)}).`);
            assert.ok(sameBits(valuesOf(given), valuesOf(givenCpp)), `Under ${method} the Python and C++ Jacobians must give the same bits.`);
            assert.ok(!sameBits(valuesOf(wrong), valuesOf(given)), `Under ${method} a wrong Jacobian must change the steps.`);
        }
    }

    // A relay: memory that switches a rate directly (a jump in the right-hand side at an accepted step). BDF carries its table on across
    // it rather than starting again after every step whose memory changed (which would hold an accumulator's run at order 1), and stays
    // honest: its error estimate sees the jump, rejects steps and shortens them, so the relay holds the room at least as tightly as
    // Rodas4 does at the same tolerance.
    {
        const relay = `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

class Relay final : public k::Relationship {
public:
    k::Input temperature{this, "temperature"};
    k::Output rate{this, "rate"};
    k::Memory<bool> on{this, "on", true};

    double evaluate(double, const k::Inputs& x) const override { return (x[on] ? 2.0 : 0.0) - 0.1 * (x[temperature] - 10.0); }
    void advance(const k::Step&, const k::Inputs& x, k::MemoryWriter& m) const override {
        if (x[temperature] > 20.5) m[on] = false;
        else if (x[temperature] < 19.5) m[on] = true;
    }
};

std::unique_ptr<k::Program> createProgram() { return std::make_unique<Relay>(); }
`;
        const relayed = {
            format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
            nodes: [{ id: 1, name: 'Room', states: [{ id: 11, name: 'Temperature', symbol: 'temperature', initialValue: 15, unit: '' }],
                sourceTerms: [{ id: 101, state: 'temperature', expression: '', implementation: {
                    kind: 'cpp', providerApiVersion: 2, source: relay, bindings: [{ key: 'temperature', kind: 'state', nodeId: 1, stateId: 11 }], output: { key: 'rate', stateId: 11 }
                } }] }],
            edges: []
        };
        const relayTiming = (method) => ({ targetTime: 100, globalTimeStep: 0.5, outputInterval: 0.5, method, tolerance: { relative: 1e-6, absolute: 1e-9 } });
        const swing = (result) => { const late = stateValues(result, 11).slice(100); return [Math.min(...late), Math.max(...late)]; };
        const underBdf = await run(relayed, relayTiming('bdf'));
        const underRodas = await run(relayed, relayTiming('rodas4'));
        const [bdfLow, bdfHigh] = swing(underBdf);
        const [rodasLow, rodasHigh] = swing(underRodas);
        assert.ok(underBdf.integration.rejectedSteps > 0 && underBdf.integration.restarts === 0, 'BDF sees the relay\'s jumps in its error estimate, without starting again.');
        assert.ok(bdfLow >= rodasLow && bdfHigh <= rodasHigh && bdfLow > 19 && bdfHigh < 21,
            `BDF holds the relay at least as tightly as Rodas4 (${bdfLow} to ${bdfHigh}, against ${rodasLow} to ${rodasHigh}).`);
    }

    // OutOfDomain: a fast decay whose program refuses a negative amount. Adaptive and Stiff reject the steps a stage refuses and finish;
    // Runge–Kutta 4 at a step that overshoots stops, naming the program, the time, the stage and the inputs.
    const refusing = `from konjugate.v2 import Input, OutOfDomain, Output, Relationship


class Decay(Relationship):
    amount = Input()
    rate = Output()

    def evaluate(self, t, x):
        if x.amount < 0:
            raise OutOfDomain(f"an amount of {x.amount:.3g} cannot decay")
        return -50.0 * x.amount
`;
    const decaying = {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        nodes: [{
            id: 1, name: 'Store', states: [{ id: 11, name: 'Amount', symbol: 'amount', initialValue: 1, unit: '' }],
            sourceTerms: [{ id: 101, state: 'amount', expression: '', implementation: {
                kind: 'python', providerApiVersion: 2, source: refusing, bindings: [{ key: 'amount', kind: 'state', nodeId: 1, stateId: 11 }], output: { key: 'rate', stateId: 11 }
            } }]
        }],
        edges: []
    };
    const decayTiming = { targetTime: 0.5, globalTimeStep: 0.1, outputInterval: 0.1 };
    for (const method of ['dormandPrince54', 'tsit5', 'rodas4', 'rodas5p', 'bdf']) {
        const decayed = await run(decaying, { ...decayTiming, method, tolerance: { relative: 1e-8, absolute: 1e-12 } });
        assert.ok(Math.abs(stateValues(decayed, 11).at(-1) - Math.exp(-25)) < 1e-9, `Under ${method} the refused steps are retried smaller and the decay finishes.`);
        // Adaptive overshoots below zero at a large stage and is refused; Stiff, L-stable, does not overshoot here.
        if (method === 'dormandPrince54' || method === 'tsit5') assert.ok(decayed.integration.rejectedSteps > 0, 'Under Adaptive the refusals count as rejected steps.');
    }
    await refused(decaying, { ...decayTiming, method: 'rungeKutta4' },
        /Decay on node Store's own part refused its inputs at t = 0\.05 s \(stage 2 of 4, Runge–Kutta 4\): an amount of -1\.5 cannot decay/, 'A refusal under Runge–Kutta 4');

    // A clock whose period is not a whole number of steps is refused, with the periods that would do.
    await refused(heatedRoom('python', await example('pidController.py')), { ...pidTiming, globalTimeStep: 0.004, outputInterval: 0.004 },
        /The clock of PidController on node Heater ticks every 0\.01 s, which is not a whole number of the run's time steps \(0\.004 s\)\. Use a period of 0\.008 s or 0\.012 s/,
        'A clock out of step');

    // The file's version must agree with the source; a version this Konjugate does not have is refused by name.
    const versionIssues = async (version, source) => (await validate(conduction({ implementation: { kind: 'python', providerApiVersion: version, source } })))
        .filter((issue) => issue.code === 'programVersionMismatch' || issue.code === 'providerApiVersionInvalid');
    assert.deepEqual(await versionIssues(2, await example('conduction.py')), [], 'A version 2 program saying version 2 is valid.');
    assert.match((await versionIssues(1, await example('conduction.py')))[0]?.message ?? '', /written in the newer program format, but the file says it is in the older one/);
    assert.match((await versionIssues(3, await example('conduction.py')))[0]?.message ?? '',
        /This program is written for version 3 of the program SDK, which this Konjugate does not have; update Konjugate\./);

    // A live session: a restore answers with the programs' memory, and a new session given that memory carries on as the first did.
    {
        const document = heatedRoom('python', await example('pidController.py'));
        const sessionConfiguration = { globalTimeStep: 0.01, outputInterval: 0.01, checkpointInterval: 0.5, execution: { backend: 'serial' }, providers };
        // The session runs the engine this test was given, not whichever out/engine the checkout has.
        process.env.KONJUGATE_ENGINE_PATH = executable;
        const engineOptions = { applicationPath: root, packaged: false };
        const first = await EngineSession.start(JSON.stringify(document), sessionConfiguration, engineOptions);
        const second = await EngineSession.start(JSON.stringify(document), sessionConfiguration, engineOptions);
        try {
            await first.advanceTo(1, { takeCheckpoints: true });
            const restored = await first.restoreCheckpoint(0.5);
            assert.equal(restored.programMemory?.length, 1, 'A restore answers with the program\'s memory.');
            const onwards = await first.advanceTo(1);
            await second.restoreState(restored.time, restored.values, restored.providerStates, restored.programMemory);
            const carried = await second.advanceTo(1);
            assert.ok(onwards.samples.length > 10 && sameBits(onwards.samples.flatMap((sample) => sample.values), carried.samples.flatMap((sample) => sample.values)),
                'A session restored with the memory must carry on as the first one did.');
        } finally {
            await first.close();
            await second.close();
        }
    }

    // Check program: the standard checks, through the transport a run uses, for each language.
    const checkProgram = async (kind, source, inputs) => {
        const index = runs++;
        const sourcePath = join(directory, `check${index}.${kind === 'cpp' ? 'cpp' : 'py'}`);
        const configurationPath = join(directory, `check${index}.json`);
        const reportPath = join(directory, `check${index}.report.json`);
        await writeFile(sourcePath, source);
        await writeFile(configurationPath, JSON.stringify({ kind, providers, inputs, time: 0 }));
        const { code, diagnostics } = await execute(['checkProgram', sourcePath, '--configuration', configurationPath, '--report', reportPath]);
        assert.equal(code, 0, `Check program must answer: ${diagnostics}`);
        return JSON.parse(await readFile(reportPath, 'utf8'));
    };
    const pidInputs = { kp: 50, ki: 5, kd: 1, maxPower: 2000, measurement: 290, setpoint: 293.15 };
    for (const [kind, file] of [['cpp', 'pidController.cpp'], ['python', 'pidController.py']]) {
        const answer = await checkProgram(kind, await example(file), pidInputs);
        assert.ok(answer.ok && answer.program === 'PidController' && answer.kind === 'node', `The ${kind} PID passes Check program: ${answer.problems}`);
        assert.deepEqual(Object.keys(answer.memory), ['integral', 'previousError', 'held', 'noise'], 'Check program shows the memory by name.');
    }
    const impureAnswer = await checkProgram('cpp', impureCpp, {});
    assert.ok(!impureAnswer.ok && /gave a different ‘warming’ when called twice/.test(impureAnswer.problems[0]), `An impure program fails Check program: ${impureAnswer.problems}`);
    const typoAnswer = await checkProgram('python', misspelt, {});
    assert.ok(!typoAnswer.ok && /reads 'capactiy'.*Line 18\./.test(typoAnswer.problems[0]), `A misspelt port fails Check program: ${typoAnswer.problems}`);

    console.log('Version 2 programs run, convert, remember and fail as the program SDK says.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
