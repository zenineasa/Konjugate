/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generates a standalone, single-file C++ or Python program that reproduces one full simulation
// run of the given (already flattened, subsystem/edgeGroup-stripped) project document -- with no
// runtime dependency on the Konjugate engine binary or GUI. See docs/codeExport.md for the
// supported subset and docs/projectSchema.md for the document shape this reads.
//
// Fidelity contract, confirmed against engine/src/executionPlan.cpp and
// engine/src/simulationRunner.cpp (the only integrator that exists is fixed-step, multi-rate
// Explicit Euler -- there is no RK4/implicit solver to consider):
//   - each global step takes one frozen copy of the whole state vector ("snapshot"); a node's own
//     states evolve through a local, substep-updated working copy SEEDED FROM that snapshot, while
//     a binding into another node's state always reads the frozen snapshot value, for every
//     substep of every node, the whole step through. A node's freshly computed states are only
//     committed back into the global vector after every node has finished the step.
//   - contributions targeting the same state are summed in a fixed order: a node's own source
//     terms in their JSON order, then edges that touch this node in document order (a
//     bidirectional edge's negated "other side" contribution is generated independently from the
//     same expression/bindings, re-evaluated for that side, not reused as a cached number).
//   - a contribution's finalized value (post negation) must be finite or the run aborts, exactly
//     like the engine's per-task check -- sub-expression NaN/Infinity is not itself an error.

const numericLiteralPattern = /^-?\d+(\.\d+)?([eE]-?\d+)?$/;

const minimumArgumentCounts = { Negate: 1, Divide: 2, Power: 2, Sqrt: 1, Abs: 1, Exp: 1, Ln: 1, Log: 1, Sin: 1, Cos: 1, Tan: 1, Min: 2, Max: 2 };

const cppOperators = {
    Add: (args) => (args.length ? `(${args.join(' + ')})` : '0.0'),
    Multiply: (args) => (args.length ? `(${args.join(' * ')})` : '1.0'),
    Negate: (args) => `(-${args[0]})`,
    Divide: (args) => `(${args[0]} / ${args[1]})`,
    Power: (args) => `std::pow(${args[0]}, ${args[1]})`,
    Sqrt: (args) => `std::sqrt(${args[0]})`,
    Abs: (args) => `std::abs(${args[0]})`,
    Exp: (args) => `std::exp(${args[0]})`,
    Ln: (args) => `std::log(${args[0]})`,
    Log: (args) => `std::log(${args[0]})`,
    Sin: (args) => `std::sin(${args[0]})`,
    Cos: (args) => `std::cos(${args[0]})`,
    Tan: (args) => `std::tan(${args[0]})`,
    Min: (args) => `std::min(${args[0]}, ${args[1]})`,
    Max: (args) => `std::max(${args[0]}, ${args[1]})`
};

// math.pow/math.sqrt/math.log raise ValueError on inputs where std::pow/std::sqrt/std::log would
// return NaN (e.g. sqrt of a negative number) instead of propagating a non-finite value the same
// way -- an acceptable, documented divergence (docs/codeExport.md) rather than a wrong-physics
// bug, since both forms fail loudly rather than silently continuing with bad data.
const pythonOperators = {
    Add: (args) => (args.length ? `(${args.join(' + ')})` : '0.0'),
    Multiply: (args) => (args.length ? `(${args.join(' * ')})` : '1.0'),
    Negate: (args) => `(-${args[0]})`,
    Divide: (args) => `(${args[0]} / ${args[1]})`,
    Power: (args) => `math.pow(${args[0]}, ${args[1]})`,
    Sqrt: (args) => `math.sqrt(${args[0]})`,
    Abs: (args) => `abs(${args[0]})`,
    Exp: (args) => `math.exp(${args[0]})`,
    Ln: (args) => `math.log(${args[0]})`,
    Log: (args) => `math.log(${args[0]})`,
    Sin: (args) => `math.sin(${args[0]})`,
    Cos: (args) => `math.cos(${args[0]})`,
    Tan: (args) => `math.tan(${args[0]})`,
    Min: (args) => `min(${args[0]}, ${args[1]})`,
    Max: (args) => `max(${args[0]}, ${args[1]})`
};

function doubleLiteral(value) {
    if (!Number.isFinite(value)) throw new Error(`Cannot embed a non-finite constant (${value}) in generated code.`);
    return Object.is(value, -0) ? '-0.0' : String(value);
}

function csvField(value) {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function compileExpressionNode(node) {
    if (Array.isArray(node)) {
        const [operator, ...args] = node;
        return { op: operator, args: args.map(compileExpressionNode) };
    }
    const text = String(node);
    return numericLiteralPattern.test(text) ? { literal: Number(text) } : { symbol: text };
}

function emitExpression(node, symbols, operators) {
    if ('literal' in node) return doubleLiteral(node.literal);
    if ('symbol' in node) {
        const resolved = symbols.get(node.symbol);
        if (!resolved) throw new Error(`Unknown executable symbol: ${node.symbol}.`);
        return resolved;
    }
    const emitter = operators[node.op];
    if (!emitter) throw new Error(`Unsupported executable operation: ${node.op}.`);
    const minimum = minimumArgumentCounts[node.op] ?? 0;
    if (node.args.length < minimum) throw new Error(`An expression is missing an argument for ${node.op}.`);
    return emitter(node.args.map((argument) => emitExpression(argument, symbols, operators)));
}

// ---- graph build: mirrors engine/src/executionPlan.cpp's compileExecutionPlan exactly enough to
// reproduce its numerics, without needing any of its parallel-execution/checkpoint machinery. ----

function buildModel(document) {
    const enabledNodes = (document.nodes ?? []).filter((node) => node.enabled !== false);
    const disabledNodeIds = new Set((document.nodes ?? []).filter((node) => node.enabled === false).map((node) => node.id));
    const stateOwnerNodeId = new Map();
    const stateRecord = new Map();
    let globalIndex = 0;
    for (const node of enabledNodes) {
        node.states.forEach((state, localIndex) => {
            stateOwnerNodeId.set(state.id, node.id);
            stateRecord.set(state.id, { node, state, globalIndex, localIndex });
            globalIndex += 1;
        });
    }
    const nodeById = new Map(enabledNodes.map((node) => [node.id, node]));
    const nodePlans = enabledNodes.map((node) => ({
        node,
        localIndexByStateId: new Map(node.states.map((state, index) => [state.id, index])),
        substeps: node.numerics?.substepsPerGlobalStep ?? 1,
        contributions: [],
        nodeProvider: null
    }));
    const nodePlanById = new Map(nodePlans.map((plan) => [plan.node.id, plan]));

    for (const plan of nodePlans) {
        for (const term of plan.node.sourceTerms ?? []) {
            const programmable = term.implementation != null;
            plan.contributions.push(buildContribution({
                entityLabel: `source term on node "${plan.node.name}"`, ownerPlan: plan, alwaysLocal: true,
                bindings: programmable ? term.implementation.bindings : term.expressionModel.bindings,
                outputStateId: programmable ? term.implementation.output.stateId : term.expressionModel.output.stateId,
                mathJson: programmable ? null : term.expressionModel.mathJson,
                implementation: term.implementation ?? null,
                negate: false,
                parameters: term.parameters ?? [],
                identifierField: programmable ? 'key' : 'symbol'
            }, stateRecord));
        }
        if (plan.node.implementation) plan.nodeProvider = buildNodeProvider(plan, stateRecord);
    }

    for (const edge of document.edges ?? []) {
        if (edge.enabled === false) continue;
        if (disabledNodeIds.has(edge.source.nodeId) || disabledNodeIds.has(edge.target.nodeId)) continue;
        const programmable = edge.implementation != null;
        const outputRole = programmable ? edge.implementation.output.role : edge.equationModel.output.role;
        const outputStateId = programmable ? edge.implementation.output.stateId : edge.equationModel.output.stateId;
        const outputPlan = nodePlanById.get(stateOwnerNodeId.get(outputStateId));
        const bindings = programmable ? edge.implementation.bindings : edge.equationModel.bindings;
        const mathJson = programmable ? null : edge.equationModel.mathJson;
        const identifierField = programmable ? 'key' : 'symbol';
        if (outputPlan) {
            outputPlan.contributions.push(buildContribution({
                entityLabel: `relationship "${edge.name}"`, ownerPlan: outputPlan, alwaysLocal: false,
                bindings, outputStateId, mathJson, implementation: edge.implementation ?? null, negate: false,
                parameters: edge.parameters ?? [], identifierField
            }, stateRecord));
        }
        if (edge.directionality === 'bidirectional') {
            const otherNodeId = outputRole === 'target' ? edge.source.nodeId : edge.target.nodeId;
            const otherNode = nodeById.get(otherNodeId);
            const otherPlan = nodePlanById.get(otherNodeId);
            if (otherNode && otherPlan) {
                const otherEndpoint = outputRole === 'target' ? edge.source : edge.target;
                let otherStateId = otherEndpoint?.stateId;
                if (otherStateId == null || !otherNode.states.some((state) => state.id === otherStateId)) {
                    otherStateId = otherNode.states[0]?.id;
                }
                if (otherStateId == null) throw new Error(`Bidirectional relationship "${edge.name}" has an endpoint with no states.`);
                otherPlan.contributions.push(buildContribution({
                    entityLabel: `relationship "${edge.name}"`, ownerPlan: otherPlan, alwaysLocal: false,
                    bindings, outputStateId: otherStateId, mathJson, implementation: edge.implementation ?? null, negate: true,
                    parameters: edge.parameters ?? [], identifierField
                }, stateRecord));
            }
        }
    }

    return { nodePlans, globalStateCount: globalIndex, stateRecord };
}

function buildContribution(spec, stateRecord) {
    const { entityLabel, ownerPlan, alwaysLocal, bindings, outputStateId, mathJson, implementation, negate, parameters, identifierField } = spec;
    const outputLocalIndex = ownerPlan.localIndexByStateId.get(outputStateId);
    if (outputLocalIndex === undefined) throw new Error(`The ${entityLabel} targets a state that is not on its own node.`);
    const symbols = new Map();
    for (const binding of bindings ?? []) {
        const key = binding[identifierField];
        if (binding.kind === 'parameter') {
            const parameter = (parameters ?? []).find((item) => item.id === binding.parameterId);
            if (!parameter) throw new Error(`The ${entityLabel} has an unresolved parameter binding.`);
            symbols.set(key, { text: doubleLiteral(parameter.value), comment: parameter.symbol });
        } else {
            const record = stateRecord.get(binding.stateId);
            if (!record) throw new Error(`The ${entityLabel} references a disabled or missing state.`);
            const isLocal = alwaysLocal || binding.nodeId === ownerPlan.node.id;
            symbols.set(key, isLocal
                ? { text: `state[${ownerPlan.localIndexByStateId.get(binding.stateId)}]`, comment: `${ownerPlan.node.name}.${record.state.name}` }
                : { text: `snapshot[${record.globalIndex}]`, comment: `${record.node.name}.${record.state.name}` });
        }
    }
    return { entityLabel, outputLocalIndex, negate, symbols, mathJson, implementation };
}

function buildNodeProvider(plan, stateRecord) {
    const implementation = plan.node.implementation;
    const symbols = new Map();
    for (const binding of implementation.bindings ?? []) {
        if (binding.kind === 'parameter') throw new Error(`The computational-node provider on node "${plan.node.name}" cannot bind a parameter.`);
        const record = stateRecord.get(binding.stateId);
        if (!record) throw new Error(`The computational-node provider on node "${plan.node.name}" references a disabled or missing state.`);
        symbols.set(binding.key, { text: `state[${plan.localIndexByStateId.get(binding.stateId)}]`, comment: `${plan.node.name}.${record.state.name}` });
    }
    const outputs = (implementation.outputs ?? []).map((output) => {
        const localIndex = plan.localIndexByStateId.get(output.stateId);
        if (localIndex === undefined) throw new Error(`A computational-node provider output on node "${plan.node.name}" targets a state not on this node.`);
        return { key: output.key, localIndex };
    });
    return { entityLabel: `computational-node provider on node "${plan.node.name}"`, implementation, symbols, outputs };
}

// ---- provider blocking + registry: validates every provider-bearing entity up front (no partial
// output is ever emitted) and assigns each a stable, collision-free instance name. ----

function collectProviders(model, kind) {
    const providers = [];
    const visit = (owner) => {
        if (!owner.implementation) return;
        const providerKind = owner.implementation.kind;
        if (providerKind === 'plugin') {
            throw new Error(`The ${owner.entityLabel} references an installed plugin provider, which has no embeddable source -- export cannot include it.`);
        }
        if (providerKind !== 'cpp' && providerKind !== 'python') {
            throw new Error(`The ${owner.entityLabel} has an unrecognized provider kind "${providerKind}".`);
        }
        if (providerKind !== kind) {
            throw new Error(`The ${owner.entityLabel} is implemented in ${providerKind === 'cpp' ? 'C++' : 'Python'}, but export to ${kind === 'cpp' ? 'C++' : 'Python'} was requested -- export blocked. Provider source is never auto-translated between languages.`);
        }
        providers.push(owner);
    };
    for (const plan of model.nodePlans) {
        for (const contribution of plan.contributions) visit(contribution);
        if (plan.nodeProvider) {
            if (kind === 'cpp') throw new Error(`The computational-node provider on node "${plan.node.name}" has no C++ equivalent in the engine -- export to C++ is blocked for this model.`);
            visit(plan.nodeProvider);
        }
    }
    return providers;
}

function stripLeadingCppInclude(source) {
    return source.replace(/^#include\s*<konjugate\/relationshipProvider\.hpp>\s*\n/, '');
}

function pythonProviderClassName(source, entityLabel) {
    const match = source.match(/^class\s+(\w+)\s*\(\s*(RelationshipProvider|NodeProvider)\s*\)\s*:/m);
    if (!match) throw new Error(`Could not find a class implementing RelationshipProvider or NodeProvider in the provider source for the ${entityLabel}.`);
    return { className: match[1], baseClassName: match[2], pattern: new RegExp(`\\bclass\\s+${match[1]}\\s*\\(`) };
}

export function generateStandaloneProgram(document, kind) {
    if (kind !== 'cpp' && kind !== 'python') throw new Error(`Unknown export kind "${kind}" -- expected "cpp" or "python".`);
    const model = buildModel(document);
    const providers = collectProviders(model, kind);
    const runConfiguration = (document.runConfigurations ?? []).find((item) => item.id === document.activeRunConfigurationId) ?? document.runConfigurations?.[0];
    const globalTimeStep = runConfiguration?.globalTimeStep ?? 0.01;
    const outputInterval = runConfiguration?.outputInterval ?? globalTimeStep;
    const meta = { globalTimeStep, outputInterval, defaultTargetTime: document.exportDefaultTargetTime ?? 1 };
    return kind === 'cpp' ? generateCpp(model, providers, meta, document) : generatePython(model, providers, meta, document);
}

function csvHeader(model) {
    const columns = ['time (s)'];
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) columns.push(`${plan.node.name} — ${state.name}${state.unit ? ` (${state.unit})` : ''}`);
    }
    return columns.map(csvField).join(',');
}

function stateIndexComment(model, commentPrefix) {
    const lines = [];
    let index = 0;
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) {
            lines.push(`${commentPrefix} snapshot[${index}] / globalState[${index}] = ${plan.node.name}.${state.name}${state.unit ? ` (${state.unit})` : ''}`);
            index += 1;
        }
    }
    return lines.join('\n');
}

function runInstructions(kind, meta, marker) {
    const lines = kind === 'cpp' ? [
        `${marker}How to run this program:`,
        `${marker}  1. Compile it:`,
        `${marker}       macOS/Linux (clang or gcc): c++ -std=c++20 -O2 <this file> -o simulation`,
        `${marker}       Windows (Developer Command Prompt for VS): cl /std:c++20 /O2 <this file>`,
        `${marker}  2. Run it:`,
        `${marker}       macOS/Linux: ./simulation`,
        `${marker}       Windows:     simulation.exe`
    ] : [
        `${marker}How to run this program:`,
        `${marker}  macOS/Linux: python3 <this file>`,
        `${marker}  Windows:     python <this file>`
    ];
    lines.push(
        `${marker}Optional flags on either platform: --target-time <seconds> (default ${doubleLiteral(meta.defaultTargetTime)}), --output <path> (default results.csv)`
    );
    return lines.join('\n');
}

function initialStateLiterals(model) {
    return Array.from(model.stateRecord.values()).map((record) => doubleLiteral(record.state.initialValue ?? 0)).join(', ');
}

function commentLines(symbols, prefix, marker) {
    return Array.from(symbols, ([key, value]) => `${prefix}${marker} ${key} <- ${value.comment}`);
}

// ---- C++ ----

function emitCppRegularContribution(contribution) {
    const symbols = new Map(Array.from(contribution.symbols, ([key, value]) => [key, value.text]));
    const expression = emitExpression(compileExpressionNode(contribution.mathJson), symbols, cppOperators);
    return [
        '        {',
        ...commentLines(contribution.symbols, '            ', '//'),
        `            double contributionValue = ${expression};`,
        contribution.negate ? '            contributionValue = -contributionValue;' : '',
        '            if (!std::isfinite(contributionValue)) throw std::runtime_error("A contribution produced a non-finite derivative.");',
        `            derivative[${contribution.outputLocalIndex}] += contributionValue;`,
        '        }'
    ].filter(Boolean).join('\n');
}

function emitCppProviderContribution(contribution, info) {
    const keys = Array.from(contribution.symbols.keys());
    const values = keys.map((key) => contribution.symbols.get(key).text).join(', ') || '0.0';
    const keyLiterals = keys.map((key) => `std::string_view("${key}")`).join(', ') || 'std::string_view("")';
    return [
        '        {',
        ...commentLines(contribution.symbols, '            ', '//'),
        `            const double inputValues[] = { ${values} };`,
        `            const std::string_view inputKeys[] = { ${keyLiterals} };`,
        '            konjugate::sdk::v1::OutputCollector outputCollector;',
        `            ${info.instanceVariable}->evaluate({stepTime, nodeTimeStep, konjugate::sdk::v1::InputView(inputValues, inputKeys)}, outputCollector);`,
        '            double contributionValue = outputCollector.gradient();',
        contribution.negate ? '            contributionValue = -contributionValue;' : '',
        '            if (!std::isfinite(contributionValue)) throw std::runtime_error("A contribution produced a non-finite derivative.");',
        `            derivative[${contribution.outputLocalIndex}] += contributionValue;`,
        '        }'
    ].filter(Boolean).join('\n');
}

function generateCpp(model, providers, meta, document) {
    // collectProviders already rejects any node-level computational provider before this function
    // is ever reached (there is no C++ equivalent in the engine), so every entry here is an
    // ordinary single-output relationship/source-term provider.
    let providerIndex = 0;
    const providerInfo = new Map();
    const providerBlocks = providers.map((provider) => {
        const namespaceName = `provider${providerIndex}`;
        providerIndex += 1;
        providerInfo.set(provider, { namespaceName, instanceVariable: `${namespaceName}Instance` });
        return `namespace ${namespaceName} {\n${stripLeadingCppInclude(provider.implementation.source)}\n}\n`;
    });

    const nodeBlocks = model.nodePlans.map((plan) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const contributionLines = plan.contributions.map((contribution) => (
            contribution.implementation
                ? emitCppProviderContribution(contribution, providerInfo.get(contribution))
                : emitCppRegularContribution(contribution)
        )).join('\n');
        const commitLines = plan.node.states.map((state, index) => (
            `        globalState[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`
        )).join('\n');
        return [
            `    // Node: ${plan.node.name}`,
            '    {',
            `        double state[${stateCount}] = { ${seed} };`,
            `        const double nodeTimeStep = globalTimeStep / ${plan.substeps}.0;`,
            `        for (int substep = 0; substep < ${plan.substeps}; ++substep) {`,
            '            const double stepTime = currentTime + substep * nodeTimeStep;',
            `            double derivative[${stateCount}] = {};`,
            contributionLines,
            `            for (int index = 0; index < ${stateCount}; ++index) state[index] += nodeTimeStep * derivative[index];`,
            '        }',
            commitLines,
            '    }'
        ].join('\n');
    }).join('\n');

    const providerDeclarations = providers.map((provider) => {
        const info = providerInfo.get(provider);
        return `    auto ${info.instanceVariable} = ${info.namespaceName}::createRelationshipProvider();\n    ${info.instanceVariable}->initialize({});`;
    }).join('\n');

    const includes = [
        '#include <cmath>',
        '#include <cstddef>',
        '#include <fstream>',
        '#include <iomanip>',
        '#include <iostream>',
        '#include <memory>',
        providers.length ? '#include <span>' : '',
        '#include <stdexcept>',
        '#include <string>',
        '#include <string_view>',
        '#include <vector>'
    ].filter(Boolean).join('\n');

    const header = `// Generated by Konjugate's "Export simulation code" feature from "${document.metadata?.projectName ?? 'this project'}".\n`
        + `// Reproduces one Explicit Euler run of the model as it was when exported. See docs/codeExport.md\n`
        + `// for exactly what is (and is not) reproduced.\n//\n`
        + `${runInstructions('cpp', meta, '// ')}\n//\n${stateIndexComment(model, '// ')}\n`;

    const escapedHeader = csvHeader(model).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    return [
        header,
        includes,
        '',
        providers.length ? `${cppSdkNamespace}\n` : '',
        providerBlocks.join('\n'),
        'int main(int argc, char** argv) {',
        `    double targetTime = ${doubleLiteral(meta.defaultTargetTime)};`,
        '    std::string outputPath = "results.csv";',
        '    for (int index = 1; index < argc; ++index) {',
        '        const std::string argument = argv[index];',
        '        if (argument == "--target-time" && index + 1 < argc) targetTime = std::stod(argv[++index]);',
        '        else if (argument == "--output" && index + 1 < argc) outputPath = argv[++index];',
        '    }',
        `    constexpr double globalTimeStep = ${doubleLiteral(meta.globalTimeStep)};`,
        `    constexpr double outputInterval = ${doubleLiteral(meta.outputInterval)};`,
        '    const std::size_t outputEveryStep = static_cast<std::size_t>(outputInterval / globalTimeStep + 0.5);',
        providerDeclarations,
        `    std::vector<double> globalState = { ${initialStateLiterals(model)} };`,
        '    std::ofstream output(outputPath);',
        '    output << std::setprecision(15);',
        `    output << "${escapedHeader}\\n";`,
        '    const auto writeRow = [&](double time) {',
        '        output << time;',
        '        for (double value : globalState) output << \',\' << value;',
        '        output << \'\\n\';',
        '    };',
        '    writeRow(0);',
        '    const auto steps = static_cast<std::size_t>(std::ceil(targetTime / globalTimeStep - 1e-9));',
        '    for (std::size_t step = 0; step < steps; ++step) {',
        '        const std::vector<double> snapshot = globalState;',
        '        const double currentTime = step * globalTimeStep;',
        nodeBlocks.split('\n').map((line) => `    ${line}`).join('\n'),
        '        if ((step + 1) % outputEveryStep == 0) writeRow((step + 1) * globalTimeStep);',
        '    }',
        '    std::cerr << "Wrote " << outputPath << "\\n";',
        '    return 0;',
        '}',
        ''
    ].join('\n');
}

const cppSdkNamespace = `namespace konjugate::sdk::v1 {

struct ScalarPort { std::string key; std::string name; std::string unit; };
struct RelationshipDescription { std::string providerId; std::string name; std::vector<ScalarPort> inputs; ScalarPort output; };
struct InitializationContext { std::uint64_t instanceId = 0; };

class InputView {
public:
    InputView(std::span<const double> values, std::span<const std::string_view> keys) noexcept : values_(values), keys_(keys) {}
    [[nodiscard]] std::size_t size() const noexcept { return values_.size(); }
    [[nodiscard]] double at(std::size_t index) const {
        if (index >= values_.size()) throw std::out_of_range("Relationship-provider input index is out of range.");
        return values_[index];
    }
    [[nodiscard]] double at(std::string_view key) const {
        for (std::size_t index = 0; index < keys_.size(); ++index) if (keys_[index] == key) return values_[index];
        throw std::out_of_range("Unknown relationship-provider input key.");
    }
private:
    std::span<const double> values_;
    std::span<const std::string_view> keys_;
};

struct EvaluationContext { double simulationTime = 0; double stepSize = 0; InputView inputs; };

class OutputCollector {
public:
    void addGradient(double value) noexcept { gradient_ += value; }
    [[nodiscard]] double gradient() const noexcept { return gradient_; }
private:
    double gradient_ = 0;
};

class RelationshipProvider {
public:
    virtual ~RelationshipProvider() = default;
    [[nodiscard]] virtual RelationshipDescription describe() const = 0;
    virtual void initialize(const InitializationContext&) {}
    virtual void evaluate(const EvaluationContext&, OutputCollector&) = 0;
    virtual void shutdown() noexcept {}
};

} // namespace konjugate::sdk::v1

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider();
`;

// ---- Python ----

function pythonSymbolsDict(symbols) {
    return `{${Array.from(symbols, ([key, value]) => `"${key}": ${value.text}`).join(', ')}}`;
}

function emitPythonRegularContribution(contribution) {
    const symbols = new Map(Array.from(contribution.symbols, ([key, value]) => [key, value.text]));
    const expression = emitExpression(compileExpressionNode(contribution.mathJson), symbols, pythonOperators);
    return [
        ...commentLines(contribution.symbols, '        ', '#'),
        `        contribution_value = ${expression}`,
        contribution.negate ? '        contribution_value = -contribution_value' : '',
        '        if not math.isfinite(contribution_value): raise RuntimeError("A contribution produced a non-finite derivative.")',
        `        derivative[${contribution.outputLocalIndex}] += contribution_value`
    ].filter(Boolean).join('\n');
}

function emitPythonProviderContribution(contribution, info) {
    return [
        ...commentLines(contribution.symbols, '        ', '#'),
        '        outputs = OutputCollector()',
        `        ${info.instanceVariable}.evaluate(EvaluationContext(step_time, node_time_step), InputView(${pythonSymbolsDict(contribution.symbols)}), outputs)`,
        '        contribution_value = outputs.gradient',
        contribution.negate ? '        contribution_value = -contribution_value' : '',
        '        if not math.isfinite(contribution_value): raise RuntimeError("A contribution produced a non-finite derivative.")',
        `        derivative[${contribution.outputLocalIndex}] += contribution_value`
    ].filter(Boolean).join('\n');
}

function emitPythonNodeProvider(nodeProvider, info) {
    const outputLines = nodeProvider.outputs.map((output) => (
        `        derivative[${output.localIndex}] += node_outputs.gradients.get("${output.key}", 0.0)`
    ));
    return [
        ...commentLines(nodeProvider.symbols, '        ', '#'),
        '        node_outputs = NodeOutputCollector()',
        `        ${info.instanceVariable}.evaluate(EvaluationContext(step_time, node_time_step), InputView(${pythonSymbolsDict(nodeProvider.symbols)}), node_outputs)`,
        ...outputLines
    ].join('\n');
}

function generatePython(model, providers, meta, document) {
    let providerIndex = 0;
    const providerInfo = new Map();
    const providerBlocks = providers.map((provider) => {
        const { className, pattern } = pythonProviderClassName(provider.implementation.source, provider.entityLabel);
        const uniqueName = `${className}Provider${providerIndex}`;
        providerIndex += 1;
        providerInfo.set(provider, { className: uniqueName, instanceVariable: `${uniqueName.charAt(0).toLowerCase()}${uniqueName.slice(1)}` });
        const withoutImport = provider.implementation.source.replace(/^from konjugate import\s*(\([^)]*\)|[^\n]*)\n?/m, '');
        return withoutImport.replace(pattern, `class ${uniqueName}(`);
    });

    const nodeBlocks = model.nodePlans.map((plan) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const contributionLines = plan.contributions.map((contribution) => (
            contribution.implementation
                ? emitPythonProviderContribution(contribution, providerInfo.get(contribution))
                : emitPythonRegularContribution(contribution)
        )).join('\n');
        const nodeProviderLines = plan.nodeProvider ? emitPythonNodeProvider(plan.nodeProvider, providerInfo.get(plan.nodeProvider)) : '';
        const commitLines = plan.node.states.map((state, index) => (
            `    global_state[${model.stateRecord.get(state.id).globalIndex}] = state[${index}]`
        )).join('\n');
        return [
            `    # Node: ${plan.node.name}`,
            `    state = [${seed}]`,
            `    node_time_step = global_time_step / ${plan.substeps}`,
            `    for substep in range(${plan.substeps}):`,
            '        step_time = current_time + substep * node_time_step',
            `        derivative = [0.0] * ${stateCount}`,
            contributionLines,
            nodeProviderLines,
            `        for index in range(${stateCount}):`,
            '            state[index] += node_time_step * derivative[index]',
            commitLines
        ].filter(Boolean).join('\n');
    }).join('\n');

    const providerInstances = providers.map((provider) => {
        const info = providerInfo.get(provider);
        return [
            `    ${info.instanceVariable} = ${info.className}()`,
            `    ${info.instanceVariable}.initialize(InitializationContext(0))`
        ].join('\n');
    }).join('\n');

    const header = `# Generated by Konjugate's "Export simulation code" feature from "${document.metadata?.projectName ?? 'this project'}".\n`
        + `# Reproduces one Explicit Euler run of the model as it was when exported. See docs/codeExport.md\n`
        + `# for exactly what is (and is not) reproduced.\n#\n`
        + `${runInstructions('python', meta, '# ')}\n#\n${stateIndexComment(model, '# ')}\n`;

    const escapedHeader = csvHeader(model).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    return [
        header,
        'import argparse',
        'import math',
        '',
        providers.length ? `${pythonSdkModule}\n` : '',
        providerBlocks.join('\n\n\n'),
        '',
        'def run(target_time, output_path):',
        `    global_time_step = ${doubleLiteral(meta.globalTimeStep)}`,
        `    output_interval = ${doubleLiteral(meta.outputInterval)}`,
        '    output_every_step = round(output_interval / global_time_step)',
        providerInstances,
        `    global_state = [${initialStateLiterals(model)}]`,
        '    with open(output_path, \'w\') as output:',
        `        output.write("${escapedHeader}\\n")`,
        '        def write_row(time):',
        '            output.write(",".join(f"{value:.10g}" for value in [time, *global_state]) + "\\n")',
        '        write_row(0)',
        '        steps = math.ceil(target_time / global_time_step - 1e-9)',
        '        for step in range(steps):',
        '            snapshot = list(global_state)',
        '            current_time = step * global_time_step',
        nodeBlocks.split('\n').map((line) => `        ${line}`).join('\n'),
        '            if (step + 1) % output_every_step == 0:',
        '                write_row((step + 1) * global_time_step)',
        '    print(f"Wrote {output_path}")',
        '',
        '',
        'if __name__ == "__main__":',
        '    parser = argparse.ArgumentParser()',
        `    parser.add_argument("--target-time", type=float, default=${doubleLiteral(meta.defaultTargetTime)})`,
        '    parser.add_argument("--output", type=str, default="results.csv")',
        '    arguments = parser.parse_args()',
        '    run(arguments.target_time, arguments.output)',
        ''
    ].join('\n');
}

const pythonSdkModule = `# --- vendored from engine/sdk/python/konjugate (author-facing provider SDK types) ---
from abc import ABC, abstractmethod
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping, Sequence


@dataclass(frozen=True)
class ScalarPort:
    key: str
    name: str
    unit: str = ""


@dataclass(frozen=True)
class RelationshipDescription:
    provider_id: str
    name: str
    inputs: Sequence[ScalarPort]
    output: ScalarPort


@dataclass(frozen=True)
class InitializationContext:
    instance_id: int


@dataclass(frozen=True)
class EvaluationContext:
    simulation_time: float
    step_size: float


class InputView:
    def __init__(self, values: Mapping[str, float]):
        self._values = MappingProxyType(dict(values))

    def __getitem__(self, key: str) -> float:
        return self._values[key]

    def __len__(self) -> int:
        return len(self._values)


class OutputCollector:
    def __init__(self):
        self._gradient = 0.0

    def add_gradient(self, value: float) -> None:
        self._gradient += float(value)

    @property
    def gradient(self) -> float:
        return self._gradient


class RelationshipProvider(ABC):
    @abstractmethod
    def describe(self) -> RelationshipDescription:
        raise NotImplementedError

    def initialize(self, context: InitializationContext) -> None:
        del context

    @abstractmethod
    def evaluate(self, context: EvaluationContext, inputs: InputView, outputs: OutputCollector) -> None:
        raise NotImplementedError

    def shutdown(self) -> None:
        pass


@dataclass(frozen=True)
class NodeProviderDescription:
    provider_id: str
    name: str
    inputs: Sequence[ScalarPort]
    outputs: Sequence[ScalarPort]


class NodeOutputCollector:
    def __init__(self):
        self._gradients = {}

    def add_gradient(self, key: str, value: float) -> None:
        self._gradients[key] = self._gradients.get(key, 0.0) + float(value)

    @property
    def gradients(self) -> Mapping[str, float]:
        return MappingProxyType(dict(self._gradients))


class NodeProvider(ABC):
    @abstractmethod
    def describe(self) -> NodeProviderDescription:
        raise NotImplementedError

    def initialize(self, context: InitializationContext) -> None:
        del context

    @abstractmethod
    def evaluate(self, context: EvaluationContext, inputs: InputView, outputs: NodeOutputCollector) -> None:
        raise NotImplementedError

    def shutdown(self) -> None:
        pass
# --- end vendored SDK types ---`;
