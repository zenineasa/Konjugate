/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract for the older program format's two warnings that change no number (docs/proposals/programSdkV2.md, decision 8):
//   - a declared input with no binding is named in the result's programWarnings (it reads 0), for a Python relationship over the pipe
//     and a C++ one in the engine's own process, and the numbers are those of the same model with the input bound to a state at 0;
//   - two nodes running one Python node program, which serves both from one object, are named once when its checkpoint() returns
//     data; not when it returns none, nor when only one node runs it;
//   - a model with neither writes no programWarnings at all, so its result says what it always said.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const root = join(import.meta.dirname, '..', '..');
const providers = { cpp: { sdkPath: join(root, 'engine') }, python: { sdkPath: join(root, 'engine', 'sdk', 'python') } };

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let diagnostics = '';
        child.stderr.on('data', (chunk) => { diagnostics += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, diagnostics }));
    });
}

const directory = await mkdtemp(join(tmpdir(), 'konjugateProgramWarnings-'));
let runs = 0;
async function run(document, configuration = {}) {
    const index = runs++;
    const modelPath = join(directory, `model${index}.kjt`);
    const configurationPath = join(directory, `run${index}.json`);
    const outputPath = join(directory, `run${index}.kjr`);
    await writeFile(modelPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name: `run${index}`, providers, targetTime: 1, globalTimeStep: 0.125, outputInterval: 0.125, ...configuration }));
    const { code, diagnostics } = await execute(['run', modelPath, '--configuration', configurationPath, '--output', outputPath]);
    assert.equal(code, 0, `The run must succeed: ${diagnostics}`);
    return decodeResultFile(await readFile(outputPath));
}
const valuesOf = (result) => result.samples.flatMap((sample) => sample.states.map((state) => state.value));
const sameBits = (left, right) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

const appearance = { type: 'primitive', shape: 'box', color: '#2f6970' };
const source = { id: 1, name: 'Source', position: [0, 0, 0], states: [{ id: 11, name: 'Y', symbol: 'y', initialValue: 1, unit: '' }, { id: 12, name: 'Zero', symbol: 'zero', initialValue: 0, unit: '' }], sourceTerms: [], appearance };
const sink = { id: 2, name: 'Sink', position: [2, 0, 0], states: [{ id: 21, name: 'Z', symbol: 'z', initialValue: 0, unit: '' }], sourceTerms: [], appearance };

const pythonFeed = `from konjugate import RelationshipDescription, RelationshipProvider, ScalarPort


class Feed(RelationshipProvider):
    def describe(self):
        return RelationshipDescription("test.feed", "Feed", [ScalarPort("y", "Y", ""), ScalarPort("offset", "Offset", "")], ScalarPort("rate", "Rate", ""))

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient(inputs["y"] + inputs["offset"])
`;
const cppFeed = `#include <konjugate/relationshipProvider.hpp>

#include <memory>

namespace {
class Feed final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {"test.feed", "Feed", {konjugate::sdk::v1::ScalarPort{"y", "Y", ""}, konjugate::sdk::v1::ScalarPort{"offset", "Offset", ""}},
            konjugate::sdk::v1::ScalarPort{"rate", "Rate", ""}};
    }
    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::OutputCollector& output) override {
        output.addGradient(context.inputs.at("y") + context.inputs.at("offset"));
    }
};
}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() { return std::make_unique<Feed>(); }
`;

const feedModel = (kind, programSource, bindOffset) => ({
    format: 'konjugate', version: 1, metadata: { units: 'SI' },
    nodes: [source, sink],
    edges: [{
        id: 31, name: 'Feed', source: { nodeId: 1, stateId: 11 }, target: { nodeId: 2, stateId: 21 }, directionality: 'directed', parameters: [], equation: '',
        implementation: {
            kind, providerApiVersion: 1, source: programSource, output: { role: 'target', key: 'rate', stateId: 21 },
            bindings: [{ key: 'y', kind: 'state', nodeId: 1, stateId: 11 }, ...(bindOffset ? [{ key: 'offset', kind: 'state', nodeId: 1, stateId: 12 }] : [])]
        }
    }]
});

const counter = (memory) => `from konjugate import NodeProvider, NodeProviderDescription, ScalarPort


class Counter(NodeProvider):
    def describe(self):
        return NodeProviderDescription("test.counter", "Counter", [ScalarPort("level", "Level", "")], [ScalarPort("levelRate", "Level rate", "")])

    def initialize(self, context):
        self.count = 0

    def evaluate(self, context, inputs, outputs):
        outputs.add_gradient("levelRate", -inputs["level"])

    def checkpoint(self):
        return ${memory ? 'bytes([self.count])' : 'b""'}

    def restore(self, payload):
        pass
`;
const counterNode = (id, programSource) => ({
    id, name: `Counter ${id}`, position: [id, 0, 0], states: [{ id: id * 10 + 1, name: 'Level', symbol: 'level', initialValue: 1, unit: '' }], sourceTerms: [], appearance,
    implementation: { kind: 'python', providerApiVersion: 1, source: programSource, bindings: [{ key: 'level', kind: 'state', stateId: id * 10 + 1 }], outputs: [{ key: 'levelRate', stateId: id * 10 + 1 }] }
});
const countersModel = (programSources) => ({ format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: programSources.map((programSource, index) => counterNode(index + 3, programSource)), edges: [] });

try {
    for (const [kind, programSource, configuration] of [['python', pythonFeed, {}], ['cpp', cppFeed, { providers: { ...providers, executionMode: 'inProcess' } }]]) {
        const unbound = await run(feedModel(kind, programSource, false), configuration);
        assert.deepEqual(unbound.programWarnings, [{ code: 'inputUnbound', language: kind, entityIds: [31], port: 'offset' }],
            `A ${kind} program's unbound input must be named.`);
        const bound = await run(feedModel(kind, programSource, true), configuration);
        assert.equal(bound.programWarnings, undefined, `A ${kind} program with every input bound must write no programWarnings.`);
        assert.ok(sameBits(valuesOf(unbound), valuesOf(bound)), `The warning must change no number: an unbound ${kind} input reads 0, as before.`);
    }

    const shared = await run(countersModel([counter(true), counter(true)]));
    assert.deepEqual(shared.programWarnings, [{ code: 'sharedCheckpoint', language: 'python', entityIds: [3, 4] }],
        'Two nodes sharing one Python program that checkpoints memory must be named, once.');
    const withoutWarning = await run(countersModel([counter(false), counter(false)]));
    assert.equal(withoutWarning.programWarnings, undefined, 'An empty checkpoint() keeps no memory to share.');
    assert.ok(sameBits(valuesOf(shared), valuesOf(withoutWarning)), 'The warning must change no number.');
    assert.equal((await run(countersModel([counter(true)]))).programWarnings, undefined, 'One node shares its program with no one.');
    console.log('Program warnings: unbound inputs and shared Python checkpoints are named, and change no number.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
