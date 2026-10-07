/* Copyright © 2026 Zenin Easa Panthakkalakath */

// These tests cover what a JS unit test can meaningfully check: structural shape and
// embedded-data correctness of the generated source. Actual numerical fidelity against the real
// engine (Explicit Euler, snapshot semantics, provider embedding) was verified by compiling and
// running the generated C++/Python output against hand-computed expected trajectories -- not
// reproduced here, since that would mean re-implementing a C++ compiler and a Python interpreter
// in JS. See docs/codeExport.md.

import assert from 'node:assert/strict';
import test from 'node:test';
import { generateStandaloneProgram } from '../src/codeExport.mjs';

let nextId;
function id() { return nextId++; }

function baseDocument() {
    nextId = 1;
    return {
        format: 'konjugate', version: 1, metadata: { projectName: 'Test project' },
        runConfigurations: [{ id: 900, globalTimeStep: 0.1, outputInterval: 0.1 }],
        activeRunConfigurationId: 900,
        exportDefaultTargetTime: 5,
        nodes: [], edges: []
    };
}

function balanced(source, openers, closers) {
    const opens = (source.match(openers) ?? []).length;
    const closes = (source.match(closers) ?? []).length;
    assert.equal(opens, closes, 'generated source has unbalanced delimiters.');
}

function singleNodeSourceTermModel() {
    const document = baseDocument();
    const nodeId = id();
    const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Tank',
        states: [{ id: stateId, name: 'Pressure', symbol: 'pressure', initialValue: 100, unit: 'Pa' }],
        sourceTerms: [{
            id: id(), state: 'pressure', expression: '',
            expressionModel: {
                latex: '-0.1 p', bindings: [{ kind: 'state', nodeId, stateId, symbol: 'p' }],
                output: { stateId }, mathJson: ['Multiply', '-0.1', 'p']
            }
        }]
    });
    return document;
}

test('single-node equation model emits the expression, the Euler update and the CSV header', () => {
    for (const kind of ['cpp', 'python']) {
        const source = generateStandaloneProgram(singleNodeSourceTermModel(), kind);
        assert.match(source, /-0\.1/);
        assert.match(source, /derivative\[0\] \+= contribution/);
        assert.match(source, kind === 'python' ? /time \(s\),Tank \\u2014 Pressure \(Pa\)/ : /time \(s\),Tank — Pressure \(Pa\)/);
    }
});

test('C++ output compiles-shaped constructs: constexpr timestep, isfinite guard, snapshot seeding', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp');
    assert.match(source, /constexpr double globalTimeStep = 0\.1;/);
    assert.match(source, /std::isfinite\(contributionValue\)/);
    assert.match(source, /double state\[1\] = \{ snapshot\[0\] \};/);
    balanced(source, /[{[]/g, /[}\]]/g);
    balanced(source, /\(/g, /\)/g);
});

test('Python output uses math.isfinite and seeds each node from the frozen snapshot', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'python');
    assert.match(source, /math\.isfinite\(contribution_value\)/);
    assert.match(source, /state = \[snapshot\[0\]\]/);
    balanced(source, /[{[(]/g, /[}\])]/g);
});

test('a cross-node edge reads the snapshot array, not the owning node\'s local array', () => {
    const document = baseDocument();
    const nodeAId = id(); const stateAId = id();
    const nodeBId = id(); const stateBId = id();
    document.nodes.push(
        { id: nodeAId, name: 'A', states: [{ id: stateAId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: nodeBId, name: 'B', states: [{ id: stateBId, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'A to B', source: { nodeId: nodeAId, stateId: stateAId }, target: { nodeId: nodeBId, stateId: stateBId },
        directionality: 'directed',
        equationModel: {
            latex: 'x', bindings: [{ kind: 'state', role: 'source', nodeId: nodeAId, stateId: stateAId, symbol: 'x' }],
            output: { role: 'target', stateId: stateBId }, mathJson: 'x'
        },
        parameters: []
    });
    const source = generateStandaloneProgram(document, 'cpp');
    assert.match(source, /double contributionValue = snapshot\[0\];/);
});

test('a bidirectional edge negates the contribution on its other endpoint', () => {
    const document = baseDocument();
    const nodeAId = id(); const stateAId = id();
    const nodeBId = id(); const stateBId = id();
    document.nodes.push(
        { id: nodeAId, name: 'A', states: [{ id: stateAId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: nodeBId, name: 'B', states: [{ id: stateBId, name: 'Y', symbol: 'y', initialValue: 0, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'Coupling', source: { nodeId: nodeAId, stateId: stateAId }, target: { nodeId: nodeBId, stateId: stateBId },
        directionality: 'bidirectional',
        equationModel: {
            latex: 'x', bindings: [{ kind: 'state', role: 'source', nodeId: nodeAId, stateId: stateAId, symbol: 'x' }],
            output: { role: 'target', stateId: stateBId }, mathJson: 'x'
        },
        parameters: []
    });
    const source = generateStandaloneProgram(document, 'python');
    const negations = (source.match(/contribution_value = -contribution_value/g) ?? []).length;
    assert.equal(negations, 1, 'exactly one endpoint of a bidirectional edge should negate its contribution.');
});

test('a disabled node contributes no states and an edge touching it is excluded', () => {
    const document = baseDocument();
    const enabledId = id(); const enabledStateId = id();
    const disabledId = id(); const disabledStateId = id();
    document.nodes.push(
        { id: enabledId, name: 'Kept', states: [{ id: enabledStateId, name: 'X', symbol: 'x', initialValue: 1, unit: '' }], sourceTerms: [] },
        { id: disabledId, name: 'Dropped', enabled: false, states: [{ id: disabledStateId, name: 'Y', symbol: 'y', initialValue: 1, unit: '' }], sourceTerms: [] }
    );
    document.edges.push({
        id: id(), name: 'Into disabled', source: { nodeId: enabledId, stateId: enabledStateId }, target: { nodeId: disabledId, stateId: disabledStateId },
        directionality: 'directed',
        equationModel: {
            latex: 'x', bindings: [{ kind: 'state', role: 'source', nodeId: enabledId, stateId: enabledStateId, symbol: 'x' }],
            output: { role: 'target', stateId: disabledStateId }, mathJson: 'x'
        },
        parameters: []
    });
    const source = generateStandaloneProgram(document, 'cpp');
    assert.doesNotMatch(source, /Dropped/);
    assert.match(source, /globalState = \{ 1\.0 \};/);
});

test('a live parameter is emitted as a plain constant, not a runtime override', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id(); const parameterId = id();
    document.nodes.push({
        id: nodeId, name: 'Node', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            expressionModel: {
                latex: 'k', bindings: [{ kind: 'parameter', parameterId, symbol: 'k' }],
                output: { stateId }, mathJson: 'k'
            },
            parameters: [{ id: parameterId, name: 'Gain', symbol: 'k', value: 7.5, mode: 'live', control: { minimum: 0, maximum: 10, step: 0.1 } }]
        }]
    });
    const source = generateStandaloneProgram(document, 'cpp');
    assert.match(source, /double contributionValue = 7\.5;/);
});

test('a same-language relationship provider is embedded and callable', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Node', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: {
                kind: 'python', providerApiVersion: 1,
                source: 'from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort\n\n\nclass DoubleIt(RelationshipProvider):\n    def describe(self):\n        return RelationshipDescription("d", "D", [ScalarPort("input", "Input", "")], ScalarPort("output", "Output", ""))\n\n    def evaluate(self, context, inputs, outputs):\n        outputs.add_gradient(2.0 * inputs["input"])\n',
                bindings: [{ key: 'input', kind: 'state', nodeId, stateId }],
                output: { key: 'output', stateId }
            }
        }]
    });
    const source = generateStandaloneProgram(document, 'python');
    assert.match(source, /class DoubleItProvider0\(RelationshipProvider\):/);
    assert.doesNotMatch(source, /from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort\n\n\nclass DoubleItProvider0/);
    assert.match(source, /doubleItProvider0\.evaluate\(/);
    assert.match(source, /outputs\.add_gradient\(2\.0 \* inputs\["input"\]\)/);
});

test('a cross-language provider blocks export with a descriptive, node-naming error', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Controller', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: {
                kind: 'cpp', providerApiVersion: 1,
                source: '#include <konjugate/relationshipProvider.hpp>\n',
                bindings: [], output: { key: 'output', stateId }
            }
        }]
    });
    assert.throws(() => generateStandaloneProgram(document, 'python'), /"Controller"[\s\S]*C\+\+[\s\S]*Python/);
});

test('a plugin-referenced provider always blocks export', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Plugged', states: [{ id: stateId, name: 'X', symbol: 'x', initialValue: 0, unit: '' }],
        sourceTerms: [{
            id: id(), state: 'x', expression: '',
            implementation: { kind: 'plugin', pluginId: 'example', pluginVersion: 1, providerId: 'p', bindings: [], output: { key: 'output', stateId } }
        }]
    });
    assert.throws(() => generateStandaloneProgram(document, 'cpp'), /"Plugged"[\s\S]*plugin/);
    assert.throws(() => generateStandaloneProgram(document, 'python'), /"Plugged"[\s\S]*plugin/);
});

test('serial (default) dispatches node integrators with a plain sequential loop', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp');
    assert.match(source, /for \(const auto& integrate : nodeIntegrators\) integrate\(\);/);
    assert.doesNotMatch(source, /#pragma omp/);
    assert.doesNotMatch(source, /std::thread/);
    assert.doesNotMatch(source, /MPI_/);
});

test('openmp mode wraps node dispatch in a parallel-for pragma and needs no extra includes', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp', { parallelism: 'openmp' });
    assert.match(source, /#pragma omp parallel for/);
    assert.match(source, /for \(int nodeIndex = 0; nodeIndex < nodeCount; \+\+nodeIndex\) nodeIntegrators\[static_cast<std::size_t>\(nodeIndex\)\]\(\);/);
    assert.match(source, /OMP_NUM_THREADS/);
    balanced(source, /[{[]/g, /[}\]]/g);
});

test('stdThread mode spawns and joins a std::thread per node', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp', { parallelism: 'stdThread' });
    assert.match(source, /#include <thread>/);
    assert.match(source, /workers\.emplace_back\(integrate\);/);
    assert.match(source, /worker\.join\(\);/);
    balanced(source, /[{[]/g, /[}\]]/g);
});

test('mpi mode partitions nodes into contiguous blocks and only rank 0 writes output', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp', { parallelism: 'mpi' });
    assert.match(source, /#include <mpi\.h>/);
    assert.match(source, /MPI_Init\(&argc, &argv\);/);
    assert.match(source, /MPI_Comm_rank\(MPI_COMM_WORLD, &worldRank\);/);
    assert.match(source, /MPI_Allgatherv\(MPI_IN_PLACE, 0, MPI_DATATYPE_NULL, globalState\.data\(\), recvCounts\.data\(\), displacements\.data\(\), MPI_DOUBLE, MPI_COMM_WORLD\);/);
    assert.match(source, /if \(worldRank == 0\) \{\s*\n\s*output\.open/);
    assert.match(source, /if \(worldRank != 0\) return;/);
    assert.match(source, /MPI_Finalize\(\);/);
    balanced(source, /[{[]/g, /[}\]]/g);
});

test('an unknown parallelism option is rejected', () => {
    assert.throws(() => generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp', { parallelism: 'bogus' }), /Unknown parallelism option "bogus"/);
});

test('Python export rejects thread-based parallelism (GIL-bound, would not actually parallelize)', () => {
    for (const parallelism of ['openmp', 'stdThread']) {
        assert.throws(() => generateStandaloneProgram(singleNodeSourceTermModel(), 'python', { parallelism }), /GIL-bound/);
    }
});

test('Python mpi mode imports mpi4py, partitions nodes into contiguous blocks and only rank 0 writes output', () => {
    const source = generateStandaloneProgram(singleNodeSourceTermModel(), 'python', { parallelism: 'mpi' });
    assert.match(source, /from mpi4py import MPI/);
    assert.match(source, /comm = MPI\.COMM_WORLD/);
    assert.match(source, /world_rank = comm\.Get_rank\(\)/);
    assert.match(source, /gathered_chunks = comm\.allgather\(global_state\[my_state_start:my_state_end\]\)/);
    assert.match(source, /global_state = \[value for chunk in gathered_chunks for value in chunk\]/);
    assert.match(source, /output = open\(output_path, 'w'\) if world_rank == 0 else None/);
    assert.match(source, /if my_node_start <= 0 < my_node_end:/);
    balanced(source, /[{[(]/g, /[}\])]/g);
});

test('a node-level computational provider always blocks C++ export', () => {
    const document = baseDocument();
    const nodeId = id(); const stateId = id();
    document.nodes.push({
        id: nodeId, name: 'Controlled', states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }],
        sourceTerms: [],
        implementation: {
            kind: 'python', providerApiVersion: 1,
            source: 'from konjugate import NodeOutputCollector, NodeProvider, NodeProviderDescription, ScalarPort\n\n\nclass Controller(NodeProvider):\n    def describe(self):\n        return NodeProviderDescription("c", "C", [ScalarPort("level", "Level", "")], [ScalarPort("rate", "Rate", "")])\n\n    def evaluate(self, context, inputs, outputs):\n        outputs.add_gradient("rate", 1.0)\n\n    def checkpoint(self):\n        return b""\n\n    def restore(self, payload):\n        pass\n',
            bindings: [{ key: 'level', kind: 'state', stateId }],
            outputs: [{ key: 'rate', stateId }]
        }
    });
    assert.throws(() => generateStandaloneProgram(document, 'cpp'), /"Controlled"[\s\S]*no C\+\+ equivalent/);
    const python = generateStandaloneProgram(document, 'python');
    assert.match(python, /class ControllerProvider0\(NodeProvider\):/);
    assert.match(python, /node_outputs\.gradients\.get\("rate", 0\.0\)/);
});

test('a cases expression exports as a conditional in both languages', async () => {
    const { compileExpressionNode, emitExpression, cppOperators } = await import('../src/codeExport.mjs');
    const expression = ['Which', ['Less', 0, 'x', 1], 'a', ['Not', ['Equal', 'x', 2]], 2, 'True', 3];
    const symbols = new Map([['x', 'x'], ['a', 'a']]);
    assert.equal(emitExpression(compileExpressionNode(expression), symbols, cppOperators),
        '(((0.0 < x) && (x < 1.0)) ? a : ((!((x == 2.0))) ? 2.0 : 3.0))');
});

test('every number is written as a floating-point literal, so C++ neither divides integers nor mixes them with doubles', async () => {
    const { compileExpressionNode, doubleLiteral, emitExpression, cppOperators } = await import('../src/codeExport.mjs');
    assert.deepEqual([75, 0.5, -3, 1e21, 1e-7, -0].map(doubleLiteral), ['75.0', '0.5', '-3.0', '1e+21', '1e-7', '-0.0']);
    const symbols = new Map([['x', 'x']]);
    // 1 / 2 is 0 in C++ with integer literals; and std::min(75, x) does not compile with x a double.
    assert.equal(emitExpression(compileExpressionNode(['Divide', '1', '2']), symbols, cppOperators), '(1.0 / 2.0)');
    assert.equal(emitExpression(compileExpressionNode(['Min', '75', 'x']), symbols, cppOperators), 'std::min(75.0, x)');
});

test('a setsValue source term is assigned before the derivatives, not integrated', async () => {
    const { generateFmiModel } = await import('../src/fmiCodeGen.mjs');
    const document = baseDocument();
    const nodeId = id();
    const [driver, doubled] = [id(), id()];
    const binding = (stateId, symbol) => ({ kind: 'state', nodeId, stateId, symbol });
    document.nodes.push({
        id: nodeId, name: 'Node',
        states: [
            { id: driver, name: 'Driver', symbol: 'driver', initialValue: 1, unit: '' },
            { id: doubled, name: 'Doubled', symbol: 'doubled', initialValue: 0, unit: '' }
        ],
        sourceTerms: [
            { id: id(), state: 'doubled', expression: '2 x', setsValue: true,
                expressionModel: { latex: '2 x', bindings: [binding(driver, 'x')], output: { stateId: doubled }, mathJson: ['Multiply', '2', 'x'] } },
            { id: id(), state: 'driver', expression: '0.5', expressionModel: { latex: '0.5', bindings: [], output: { stateId: driver }, mathJson: '0.5' } }
        ]
    });
    const sources = {
        cpp: generateStandaloneProgram(document, 'cpp'),
        python: generateStandaloneProgram(document, 'python'),
        fmu: generateFmiModel(document).source
    };
    for (const [kind, source] of Object.entries(sources)) {
        const assignment = kind === 'python' ? source.indexOf('state[1] = algebraic_value') : source.indexOf('state[1] = algebraicValue;');
        const derivatives = source.indexOf(kind === 'python' ? 'derivative = [0.0]' : 'double derivative[');
        assert.ok(assignment > 0, `${kind}: the algebraic state must be assigned.`);
        assert.ok(assignment < derivatives, `${kind}: the algebraic state must be assigned before derivatives are evaluated.`);
        assert.doesNotMatch(source, /derivative\[1\] \+=/, `${kind}: the algebraic state must not be integrated.`);
    }
});

test('algebraic terms that bind every state of their node are ordered by the states they use', () => {
    // The node editor binds all of a node's states to each source term, used or not. Only what an
    // expression reads orders algebraic terms, so z = y + 1 follows y = 2x and nothing is a cycle.
    const document = baseDocument();
    const nodeId = id();
    const [x, y, z] = [id(), id(), id()];
    const everyState = [[x, 'x'], [y, 'y'], [z, 'z']].map(([stateId, symbol]) => ({ kind: 'state', nodeId, stateId, symbol }));
    document.nodes.push({
        id: nodeId, name: 'Node',
        states: [
            { id: x, name: 'X', symbol: 'x', initialValue: 3, unit: '' },
            { id: y, name: 'Y', symbol: 'y', initialValue: 0, unit: '' },
            { id: z, name: 'Z', symbol: 'z', initialValue: 0, unit: '' }
        ],
        sourceTerms: [
            { id: id(), state: 'z', expression: 'y + 1', setsValue: true,
                expressionModel: { latex: 'y + 1', bindings: everyState, output: { stateId: z }, mathJson: ['Add', 'y', '1'] } },
            { id: id(), state: 'y', expression: '2 x', setsValue: true,
                expressionModel: { latex: '2 x', bindings: everyState, output: { stateId: y }, mathJson: ['Multiply', '2', 'x'] } }
        ]
    });
    for (const kind of ['cpp', 'python']) {
        const source = generateStandaloneProgram(document, kind);
        const assign = (index) => source.indexOf(kind === 'python' ? `state[${index}] = algebraic_value` : `state[${index}] = algebraicValue;`);
        assert.ok(assign(1) > 0 && assign(2) > 0, `${kind}: both algebraic states must be assigned.`);
        assert.ok(assign(1) < assign(2), `${kind}: y must be computed before z, which uses it.`);
    }
});

// A shared parameter with a stored schedule (sharedParameters[].schedule).
function scheduledModel(schedule) {
    const document = baseDocument();
    const nodeId = id();
    const stateId = id();
    const algebraicId = id();
    document.sharedParameters = [{ id: 500, name: 'Rate', symbol: 'rate', value: 9, mode: 'constant', schedule }];
    const linked = () => ({ id: id(), name: 'Rate', symbol: 'r', value: 0, mode: 'constant', sharedParameterId: 500 });
    const derivativeParameter = linked();
    const algebraicParameter = linked();
    document.nodes.push({
        id: nodeId, name: 'Tank',
        states: [{ id: stateId, name: 'Level', symbol: 'level', initialValue: 0, unit: '' }, { id: algebraicId, name: 'Shown', symbol: 'shown', initialValue: 0, unit: '' }],
        sourceTerms: [
            { id: id(), state: 'level', expression: '', parameters: [derivativeParameter],
                expressionModel: { latex: '', bindings: [{ kind: 'parameter', parameterId: derivativeParameter.id, symbol: 'r' }], output: { stateId }, mathJson: 'r' } },
            { id: id(), state: 'shown', expression: '', setsValue: true, parameters: [algebraicParameter],
                expressionModel: { latex: '', bindings: [{ kind: 'parameter', parameterId: algebraicParameter.id, symbol: 'r' }], output: { stateId: algebraicId }, mathJson: 'r' } }
        ]
    });
    return document;
}

test('a scheduled parameter is read from one table at the instant the engine reads it, in either language', () => {
    const document = scheduledModel({ interpolation: 'hold', samples: [[0, 1], [10, 3]] });
    const cpp = generateStandaloneProgram(document, 'cpp');
    assert.match(cpp, /const double scheduleTimes0\[\] = \{ 0\.0, 10\.0 \};/);
    assert.match(cpp, /const double scheduleValues0\[\] = \{ 1\.0, 3\.0 \};/);
    assert.match(cpp, /\{ scheduleTimes0, scheduleValues0, 2, true \}/);
    assert.doesNotMatch(cpp, /scheduleTimes1/, 'two parameters linked to one shared parameter share one table');
    assert.match(cpp, /double contributionValue = scheduleValue\(0, stepTime\);/);
    assert.match(cpp, /const double algebraicValue = scheduleValue\(0, algebraicTime\);/);
    balanced(cpp, /\{/g, /\}/g);
    const python = generateStandaloneProgram(document, 'python');
    assert.match(python, /^import bisect$/m);
    assert.match(python, /\(True, \[0\.0, 10\.0\], \[1\.0, 3\.0\]\),  # r$/m);
    assert.match(python, /contribution_value = schedule_value\(0, step_time\)/);
    assert.match(python, /algebraic_value = schedule_value\(0, algebraic_time\)/);
    // No schedule, no table or import.
    assert.doesNotMatch(generateStandaloneProgram(singleNodeSourceTermModel(), 'cpp'), /scheduleValue/);
    assert.doesNotMatch(generateStandaloneProgram(singleNodeSourceTermModel(), 'python'), /import bisect/);
});

test('a malformed schedule blocks export with the parameter named', () => {
    for (const schedule of [{ interpolation: 'cubic', samples: [[0, 1]] }, { samples: [] }, { samples: [[0, 1], [0, 2]] }, { samples: [[0, Infinity]] }]) {
        assert.throws(() => generateStandaloneProgram(scheduledModel(schedule), 'cpp'), /"Rate"/);
    }
});

test('the Python header is ASCII however long, so Python 3.9 reads it, and still writes the names as they are', () => {
    // Python 3.9 refuses a source line of several thousand bytes with a non-ASCII character in it, and the header
    // names every state on one line, each with a dash between its node and its state.
    const document = baseDocument();
    for (let index = 0; index < 400; index += 1) {
        document.nodes.push({
            id: id(), name: index ? `Road A → B ${index}` : 'Tank "one" \\ 😀',
            states: [{ id: id(), name: 'Größe', symbol: 'x', initialValue: 1, unit: 'm³' }], sourceTerms: []
        });
    }
    const python = generateStandaloneProgram(document, 'python');
    const header = python.split('\n').find((line) => line.includes('output.write("time (s)'));
    assert.ok(header.length > 8000, 'the header is one long line');
    for (const line of python.split('\n')) {
        assert.ok(line.length < 1000 || /^[\x00-\x7f]*$/.test(line), `a long line has a non-ASCII character: ${line.slice(0, 80)}…`);
    }
    // Read as Python reads it, the literal is the header Konjugate's own CSV export writes.
    const literal = header.slice(header.indexOf('"'), header.lastIndexOf('"') + 1);
    const read = literal.slice(1, -1).replace(/\\(U[0-9a-f]{8}|u[0-9a-f]{4}|n|"|\\)/g, (_, escape) => (
        escape === 'n' ? '\n' : escape.length > 1 ? String.fromCodePoint(parseInt(escape.slice(1), 16)) : escape));
    assert.ok(read.startsWith('time (s),"Tank ""one"" \\ 😀 — Größe (m³)",Road A → B 1 — Größe (m³),'), read.slice(0, 80));
    assert.ok(read.endsWith('Road A → B 399 — Größe (m³)\n'));
    // The MPI program writes the same header.
    const mpi = generateStandaloneProgram(document, 'python', { parallelism: 'mpi' });
    assert.ok(mpi.includes(literal));
    // C++ reads UTF-8 in a string literal of any length: its header is left as it is.
    assert.ok(generateStandaloneProgram(document, 'cpp').includes('Road A → B 1 — Größe (m³)'));
});
