/* Copyright © 2026 Zenin Easa Panthakkalakath */

const identifierPattern = /^[a-z][A-Za-z0-9]*$/;

function sanitizedKeys(bindings) {
    return bindings
        .map((binding) => binding.key?.trim())
        .filter((key) => key && identifierPattern.test(key));
}

function providerIdentity(title) {
    const words = (title ?? '').trim().split(/[^A-Za-z0-9]+|(?=[A-Z])/).filter(Boolean);
    if (!words.length) return { id: 'relationship', name: 'Relationship', className: 'Relationship' };
    const id = words.map((word, index) => {
        const lower = word.toLowerCase();
        return index ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    }).join('');
    const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
    // A C++/Python class name must start with a letter, so a title beginning with a digit
    // (e.g. "3-way valve") falls back to a prefixed, still-distinct identifier.
    const candidateClassName = name.replace(/\s+/g, '');
    const className = /^[A-Za-z]/.test(candidateClassName) ? candidateClassName : `Relationship${candidateClassName}`;
    return { id, name, className };
}

function cppTemplate(inputKeys, outputKey, title) {
    const { id, name, className } = providerIdentity(title);
    const inputPorts = inputKeys.length
        ? inputKeys.map((key) => `                konjugate::sdk::v1::ScalarPort{"${key}", "${key}", ""}`).join(',\n')
        : '                // No bindings declared yet — add one below, then insert this template again.';
    const readLines = (inputKeys.length ? inputKeys : ['key']).map((key) => `        //   const double ${key} = context.inputs.at("${key}");`).join('\n');
    return `#include <konjugate/relationshipProvider.hpp>

#include <memory>

namespace {

class ${className} final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {
            "${id}",
            "${name}",
            {
${inputPorts}
            },
            konjugate::sdk::v1::ScalarPort{"${outputKey || 'output'}", "${outputKey || 'output'}", ""}
        };
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::OutputCollector& output) override {
        // Read each bound input by its declared key:
${readLines}
        // Add your computed contribution to the declared output:
        //   output.addGradient(value);
        output.addGradient(0);
    }
};

}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<${className}>();
}
`;
}

function pythonTemplate(inputKeys, outputKey, title) {
    const { id, name, className } = providerIdentity(title);
    const inputPorts = inputKeys.length
        ? inputKeys.map((key) => `                ScalarPort("${key}", "${key}", ""),`).join('\n')
        : '                # No bindings declared yet — add one below, then insert this template again.';
    const readLines = (inputKeys.length ? inputKeys : ['key']).map((key) => `        #   ${key} = inputs["${key}"]`).join('\n');
    return `from konjugate import (
    EvaluationContext,
    InputView,
    OutputCollector,
    RelationshipDescription,
    RelationshipProvider,
    ScalarPort,
)


class ${className}(RelationshipProvider):
    def describe(self):
        return RelationshipDescription(
            "${id}",
            "${name}",
            [
${inputPorts}
            ],
            ScalarPort("${outputKey || 'output'}", "${outputKey || 'output'}", ""),
        )

    def evaluate(self, context, inputs, outputs):
        # Read each bound input by its declared key:
${readLines}
        # Add your computed contribution to the declared output:
        #   outputs.add_gradient(value)
        outputs.add_gradient(0)
`;
}

/**
 * The older program format's starter relationship (version 1 of the SDK, konjugate/relationshipProvider.hpp and konjugate): kept for
 * what still needs one (tests of held version 1 programs); new programs start from defaultProviderSource, version 2.
 */
export function olderProviderSource(kind, bindings = [], outputKey = '', title = '') {
    const inputKeys = sanitizedKeys(bindings);
    const trimmedOutputKey = outputKey?.trim() ?? '';
    return kind === 'python'
        ? pythonTemplate(inputKeys, trimmedOutputKey, title)
        : cppTemplate(inputKeys, trimmedOutputKey, title);
}

// A C++ literal for a finite double -- pairs' time/value entries are already validated finite by
// the engine's own parseInferenceCsv() (this function's caller only ever feeds it data that
// already passed causal inference), but toString() on a bare double can still produce forms
// (e.g. "1e-7") that read fine here since C++ accepts the same scientific-notation syntax as JS.
function cppDoubleLiteral(value) {
    return Object.is(value, -0) ? '-0.0' : String(value);
}

/**
 * Generates a no-bindings, `setsValue` C++ source term that replays one CSV column's own recorded
 * (time, value) samples exactly, rather than fitting a model to it -- for a column causal
 * inference found nothing predicting (see docs/proposals/causalInferenceInputReplay.md). Each
 * evaluate() call emits the linearly-interpolated value between the two recorded samples
 * straddling the current simulation time; the caller marks the owning source term `setsValue:
 * true` (docs/projectSchema.md), so the engine writes that value directly into the state every
 * substep instead of integrating it as a derivative. This is exact at any substep count and,
 * unlike an earlier version of this generator that emitted the interval's local slope for the
 * engine to Euler-integrate, has no dependency on the state's starting value ever being exactly
 * right -- there is nothing to integrate from, so a wrong initial value can never leave a
 * permanent offset the way it could under the derivative-based approach. Past the last recorded
 * sample (and before the first), the value holds at its last/first known point rather than
 * extrapolating.
 *
 * pairs: [{ time, value }, ...] in chronological row order, already regularly spaced (the same
 * guarantee parseInferenceCsv enforces on its input). Requires at least 2 samples -- interpolation
 * needs two points, and a `double[]` embedded with zero entries is a compiler extension, not
 * standard C++ (confirmed: clang accepts it but flags it under -Wpedantic, which this project's
 * engine build enables) -- rejected outright rather than silently emitting that.
 */
export function replayProviderSource(columnName, pairs, title) {
    if (!Array.isArray(pairs) || pairs.length < 2) {
        throw new Error(`replayProviderSource needs at least 2 recorded samples for "${columnName}", got ${pairs?.length ?? 0}.`);
    }
    const { name, className } = providerIdentity(title || columnName);
    const times = pairs.map((pair) => cppDoubleLiteral(pair.time)).join(', ');
    const values = pairs.map((pair) => cppDoubleLiteral(pair.value)).join(', ');
    return `#include <konjugate/sdk/v2/program.hpp>

#include <cstddef>
#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// Recorded "${columnName}" samples from the imported CSV, chronological and regularly spaced.
constexpr double kTimes[] = { ${times} };
constexpr double kValues[] = { ${values} };
constexpr std::size_t kSampleCount = sizeof(kTimes) / sizeof(kTimes[0]);

// ${name}: the recorded values, linearly interpolated, held past either end. A function of time alone, so it takes every stage of every
// method.
class ${className} final : public k::Relationship {
public:
    k::Output output{this, "output"};

    double evaluate(double t, const k::Inputs&) const override {
        if (kSampleCount < 2) return kValues[0];
        const double rowTimeStep = kTimes[1] - kTimes[0];
        // position is dimensionless (row-index units), so a fixed small nudge here is safe
        // regardless of the CSV's own absolute time scale or sampling interval. Needed because
        // the caller's own accumulated simulation time can drift a hair off an exact recorded
        // sample time (e.g. summing 0.2 five times does not land on exactly 1.0 in double
        // precision) -- both range boundaries below and the interior interval lookup all derive
        // from this one nudged value, so "just before the end" and "just past an interior
        // boundary" get the same tolerant treatment rather than two independently-tuned checks
        // drifting out of sync with each other. See docs/proposals/causalInferenceInputReplay.md.
        const double position = (t - kTimes[0]) / rowTimeStep + 1e-6;
        // Before the first recorded sample, or past the last one (any run longer than the CSV's
        // own recorded span will reach this): hold at the nearest known point rather than
        // extrapolating.
        if (position < 0) return kValues[0];
        if (position >= kSampleCount - 1) return kValues[kSampleCount - 1];
        std::size_t index = static_cast<std::size_t>(position);
        if (index >= kSampleCount - 1) index = kSampleCount - 2;
        const double fraction = position - static_cast<double>(index);
        return kValues[index] + fraction * (kValues[index + 1] - kValues[index]);
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<${className}>(); }
`;
}

/**
 * The older program format's starter node program (version 1): it reads every declared input by its key and adds to every declared
 * output, and keeps no state of its own, so checkpoint() is empty. New node programs start from defaultNodeProviderSource, version 2.
 */
export function olderNodeProviderSource(kind, inputs = [], outputs = [], title = '') {
    const inputKeys = sanitizedKeys(inputs);
    const outputKeys = sanitizedKeys(outputs);
    const { id, name, className } = providerIdentity(title || 'Node');
    if (kind === 'python') {
        const ports = (keys) => keys.map((key) => `                ScalarPort("${key}", "${key}", ""),`).join('\n') || '                # None declared yet.';
        return `from konjugate import NodeProvider, NodeProviderDescription, ScalarPort


class ${className}(NodeProvider):
    def describe(self):
        return NodeProviderDescription(
            "${id}",
            "${name}",
            [
${ports(inputKeys)}
            ],
            [
${ports(outputKeys)}
            ],
        )

    def evaluate(self, context, inputs, outputs):
        # Each input by its key (context.simulation_time and context.step_size are there too):
${(inputKeys.length ? inputKeys : ['key']).map((key) => `        #   ${key} = inputs["${key}"]`).join('\n')}
        # Each output: a rate added to its state, or the state's value when the output sets the value.
${outputKeys.length ? outputKeys.map((key) => `        outputs.add_gradient("${key}", 0.0)`).join('\n') : '        pass'}

    def checkpoint(self):
        return b""

    def restore(self, payload):
        pass
`;
    }
    const ports = (keys) => keys.map((key) => `                konjugate::sdk::v1::ScalarPort{"${key}", "${key}", ""}`).join(',\n') || '                // None declared yet.';
    return `#include <konjugate/relationshipProvider.hpp>

#include <memory>

namespace {

class ${className} final : public konjugate::sdk::v1::NodeProvider {
public:
    konjugate::sdk::v1::NodeProviderDescription describe() const override {
        return {
            "${id}",
            "${name}",
            {
${ports(inputKeys)}
            },
            {
${ports(outputKeys)}
            }
        };
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::NodeOutputCollector& outputs) override {
        // Each input by its key (context.simulationTime and context.stepSize are there too):
${(inputKeys.length ? inputKeys : ['key']).map((key) => `        //   const double ${key} = context.inputs.at("${key}");`).join('\n')}
        // Each output: a rate added to its state, or the state's value when the output sets the value.
${outputKeys.map((key) => `        outputs.addGradient("${key}", 0.0);`).join('\n') || '        (void)context;'}
        (void)outputs;
    }

    std::vector<std::byte> checkpoint() const override { return {}; }
    void restore(std::span<const std::byte>) override {}
};

}

std::unique_ptr<konjugate::sdk::v1::NodeProvider> createNodeProvider() {
    return std::make_unique<${className}>();
}
`;
}

// ---- Version 2 of the program SDK (konjugate/sdk/v2/program.hpp, konjugate.v2; docs/programs.md) -------------------------------------

// A program's SDK version as its source says: 2 when it includes konjugate/sdk/v2 or imports from konjugate.v2, 1 otherwise. The app
// writes this into the file's providerApiVersion when the program is saved (docs/proposals/programSdkV2.md, Versioning).
export function programSourceVersion(kind, source) {
    if (typeof source !== 'string') return 1;
    if (kind === 'cpp') return source.includes('konjugate/sdk/v2/') ? 2 : 1;
    if (kind === 'python') return /^\s*(from\s+konjugate\.v2(\.\w+)*\s+import|import\s+konjugate\.v2\b)/m.test(source) ? 2 : 1;
    return 1;
}

// An implementation with its providerApiVersion as its source says, for a program written in C++ or Python; anything else as it is. A
// version 1 program's file is left byte for byte as it was (an absent version stays absent).
export function withProgramVersion(implementation) {
    if (!implementation || (implementation.kind !== 'cpp' && implementation.kind !== 'python') || typeof implementation.source !== 'string') return implementation;
    const version = programSourceVersion(implementation.kind, implementation.source);
    if (implementation.providerApiVersion === version || (implementation.providerApiVersion === undefined && version === 1)) return implementation;
    return { ...implementation, providerApiVersion: version };
}

// A port key (camelCase, as the file binds it) as a Python attribute (snake_case): konjugate.v2 binds `source_temperature` as
// `sourceTemperature`, so the two always agree.
export function pythonAttribute(key) {
    return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

const cppReserved = new Set(['alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'constexpr', 'continue',
    'decltype', 'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline',
    'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'nullptr', 'operator', 'or', 'private', 'protected', 'public', 'register', 'return',
    'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union',
    'unsigned', 'using', 'virtual', 'void', 'volatile', 'while', 'evaluate', 'advance', 'initialize', 'shutdown', 'jacobian', 'registry']);
const pythonReserved = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
    'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
    'evaluate', 'advance', 'initialize', 'shutdown', 'jacobian', 'outputs']);

// A port's member name in C++ (its key, or the key with an underscore where the key is a word the language or the SDK keeps).
export function cppMember(key) {
    return cppReserved.has(key) ? `${key}_` : key;
}

// A port's attribute in Python, with name= when its snake_case would not give the key back.
function pythonPort(key, declaration) {
    const attribute = pythonAttribute(key);
    if (pythonReserved.has(attribute)) return { attribute: `${attribute}_`, declaration: declaration.replace(/\)$/, `${declaration.endsWith('()') ? '' : ', '}name="${key}")`) };
    return { attribute, declaration };
}

const commentLines = {
    cpp: [
        '        // evaluate() changes nothing: it may be called at any stage of a step, any number of times. What the program remembers',
        '        // between steps is declared memory (k::Memory), changed only in advance(); a quantity that changes continuously is better',
        '        // a node\'s state that an output drives, so the method integrates it to its own order.'
    ],
    python: [
        '        # evaluate() changes nothing: it may be called at any stage of a step, any number of times. What the program remembers',
        '        # between steps is declared memory (Memory), changed only in advance(); a quantity that changes continuously is better',
        '        # a node\'s state that an output drives, so the method integrates it to its own order.'
    ]
};

function relationshipTemplateV2(kind, inputKeys, outputKey, title) {
    const { className, name } = providerIdentity(title);
    const output = outputKey || 'output';
    if (kind === 'python') {
        const ports = inputKeys.map((key) => pythonPort(key, 'Input()'));
        const out = pythonPort(output, 'Output()');
        return `from konjugate.v2 import Input, Output, Relationship


class ${className}(Relationship):
    """${name}."""

    # Each input, bound to a state, a parameter or the time. Give a unit, Input("K"), to have it checked against what it is bound to
    # when the run starts, and converted where it can be.
${ports.length ? ports.map((port) => `    ${port.attribute} = ${port.declaration}`).join('\n') : '    # No inputs declared yet: declare one here, as name = Input("unit"), and bind it in the code editor\'s Ports.'}
    ${out.attribute} = ${out.declaration}

    def evaluate(self, t, x):
        # The output's value from the inputs${ports.length ? `: ${ports.map((port) => `x.${port.attribute}`).join(', ')}` : ''}.
${commentLines.python.join('\n')}
        return 0.0
`;
    }
    const members = inputKeys.map((key) => `    k::Input ${cppMember(key)}{this, "${key}"};`);
    return `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// ${name}.
class ${className} final : public k::Relationship {
public:
    // Each input, bound to a state, a parameter or the time; the quoted key is what the project file binds. Give a unit,
    // {this, "key", "K"}, to have it checked against what it is bound to when the run starts, and converted where it can be.
${members.length ? members.join('\n') : '    // No inputs declared yet: declare one here, as k::Input name{this, "name", "unit"};, and bind it in the code editor\'s Ports.'}
    k::Output ${cppMember(output)}{this, "${output}"};

    double evaluate(double t, const k::Inputs& x) const override {
        // The output's value from the inputs${inputKeys.length ? `: ${inputKeys.map((key) => `x[${cppMember(key)}]`).join(', ')}` : ''}.
${commentLines.cpp.join('\n')}
        static_cast<void>(t);
        static_cast<void>(x);
        return 0.0;
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<${className}>(); }
`;
}

function nodeTemplateV2(kind, inputKeys, boundOutputKeys, title) {
    const { className, name } = providerIdentity(title || 'Node');
    // A program declares at least one output, or it cannot run or pass Check program: with none bound yet, one named "output", to be
    // renamed to the key of the state it sets.
    const outputKeys = boundOutputKeys.length ? boundOutputKeys : ['output'];
    if (kind === 'python') {
        const ports = inputKeys.map((key) => pythonPort(key, 'Input()'));
        const outs = outputKeys.map((key) => pythonPort(key, 'Output()'));
        return `from konjugate.v2 import Input, Node, Output


class ${className}(Node):
    """${name}."""

    # Each input, bound to one of this node's states, another node's or a shared parameter. Give a unit, Input("K"), to have it checked
    # against what it is bound to when the run starts, and converted where it can be.
${ports.length ? ports.map((port) => `    ${port.attribute} = ${port.declaration}`).join('\n') : '    # No inputs declared yet: declare one here, as name = Input("unit"), and bind it in the code editor\'s Ports.'}
    # Each output: a rate into a Rate state, or the value of an Update state.
${outs.length ? outs.map((port) => `    ${port.attribute} = ${port.declaration}`).join('\n') : '    # None declared yet.'}

    def evaluate(self, t, x):
        # Every output's value from the inputs${ports.length ? `: ${ports.map((port) => `x.${port.attribute}`).join(', ')}` : ''}.
${commentLines.python.join('\n')}
        return ${outs.length ? `self.outputs(${outs.map((port) => `${port.attribute}=0.0`).join(', ')})` : '()'}
`;
    }
    return `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// ${name}.
class ${className} final : public k::Node {
public:
    // Each input, bound to one of this node's states, another node's or a shared parameter; the quoted key is what the project
    // file binds. Give a unit, {this, "key", "K"}, to have it checked when the run starts, and converted where it can be.
${inputKeys.length ? inputKeys.map((key) => `    k::Input ${cppMember(key)}{this, "${key}"};`).join('\n') : '    // No inputs declared yet: declare one here, as k::Input name{this, "name", "unit"};, and bind it in the code editor\'s Ports.'}
    // Each output: a rate into a Rate state, or the value of an Update state.
${outputKeys.length ? outputKeys.map((key) => `    k::Output ${cppMember(key)}{this, "${key}"};`).join('\n') : '    // None declared yet.'}

    void evaluate(double t, const k::Inputs& x, k::Outputs& y) const override {
        // Every output's value from the inputs${inputKeys.length ? `: ${inputKeys.map((key) => `x[${cppMember(key)}]`).join(', ')}` : ''}.
${commentLines.cpp.join('\n')}
        static_cast<void>(t);
        static_cast<void>(x);
${outputKeys.length ? outputKeys.map((key) => `        y[${cppMember(key)}] = 0.0;`).join('\n') : '        static_cast<void>(y);'}
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<${className}>(); }
`;
}

/**
 * A starter relationship program (version 2 of the program SDK) from the relationship's bindings and output key, so writing a C++ or
 * Python relationship begins from a compiling program that already declares every value it is bound to and its output.
 */
export function defaultProviderSource(kind, bindings = [], outputKey = '', title = '', outputs = null) {
    // A relationship's program with several outputs (implementation.outputs) computes them together, as a node program does.
    if (Array.isArray(outputs) && outputs.length > 1) return nodeTemplateV2(kind, sanitizedKeys(bindings), sanitizedKeys(outputs), title);
    return relationshipTemplateV2(kind, sanitizedKeys(bindings), outputKey?.trim() ?? '', title);
}

/**
 * A starter node program (version 2): every bound input and output declared, every output set to 0. It keeps no memory; one that
 * must (a digital controller's integral) declares it, and the engine saves and restores it.
 */
export function defaultNodeProviderSource(kind, inputs = [], outputs = [], title = '') {
    return nodeTemplateV2(kind, sanitizedKeys(inputs), sanitizedKeys(outputs), title);
}

/**
 * "Controller (sampled)": a node program sampled on a clock, with memory and a seeded random stream, as a digital controller is: its
 * output held between samples and set in advance() at every tick. The period is a whole number of the run's time steps.
 */
export function sampledControllerSource(kind, inputs = [], outputs = [], title = 'Controller', period = 0.01) {
    const inputKeys = sanitizedKeys(inputs);
    const outputKeys = sanitizedKeys(outputs);
    const { className, name } = providerIdentity(title || 'Controller');
    const first = inputKeys[0] ?? 'measurement';
    const declaredInputs = inputKeys.length ? inputKeys : [first];
    const declaredOutputs = outputKeys.length ? outputKeys : ['command'];
    if (kind === 'python') {
        const ports = declaredInputs.map((key) => pythonPort(key, 'Input()'));
        const outs = declaredOutputs.map((key) => pythonPort(key, 'Output()'));
        return `from konjugate.v2 import Clock, Input, Memory, Node, Output, Random


class ${className}(Node):
    """${name}: sampled every ${period} s, its outputs held between samples, as a digital controller's are."""

${ports.map((port) => `    ${port.attribute} = ${port.declaration}`).join('\n')}
${outs.map((port) => `    ${port.attribute} = ${port.declaration}`).join('\n')}

    clock = Clock(${period})                 # advance() at the start and every ${period} s: a whole number of the run's time steps

    # What the controller remembers between samples: changed only in advance(), saved and restored by the engine.
${outs.map((port) => `    held_${port.attribute} = Memory(0.0)`).join('\n')}
    noise = Random()                      # a seeded stream, for a noisy sensor: m.noise.normal() in advance()

    def evaluate(self, t, x):
        # Between samples each output holds what the last sample set.
        return self.outputs(${outs.map((port) => `${port.attribute}=x.held_${port.attribute}`).join(', ')})

    def advance(self, step, x, m):
        # At each sample: read the inputs (x.${ports[0].attribute}), work out the commands and hold them. step.first is the run's
        # first sample; step.size is the clock's period.
${outs.map((port) => `        m.held_${port.attribute} = 0.0`).join('\n')}
`;
    }
    return `#include <konjugate/sdk/v2/program.hpp>

#include <memory>

namespace k = konjugate::sdk::v2;

namespace {

// ${name}: sampled every ${period} s, its outputs held between samples, as a digital controller's are.
class ${className} final : public k::Node {
public:
${declaredInputs.map((key) => `    k::Input ${cppMember(key)}{this, "${key}"};`).join('\n')}
${declaredOutputs.map((key) => `    k::Output ${cppMember(key)}{this, "${key}"};`).join('\n')}

    k::Clock clock{this, ${period}};     // advance() at the start and every ${period} s: a whole number of the run's time steps

    // What the controller remembers between samples: changed only in advance(), saved and restored by the engine.
${declaredOutputs.map((key) => `    k::Memory<double> held${key.charAt(0).toUpperCase()}${key.slice(1)}{this, "held${key.charAt(0).toUpperCase()}${key.slice(1)}", 0.0};`).join('\n')}
    k::Memory<k::Random> noise{this, "noise"};   // a seeded stream, for a noisy sensor: m[noise].normal() in advance()

    void evaluate(double, const k::Inputs& x, k::Outputs& y) const override {
        // Between samples each output holds what the last sample set.
${declaredOutputs.map((key) => `        y[${cppMember(key)}] = x[held${key.charAt(0).toUpperCase()}${key.slice(1)}];`).join('\n')}
    }

    void advance(const k::Step& step, const k::Inputs& x, k::MemoryWriter& m) const override {
        // At each sample: read the inputs (x[${cppMember(declaredInputs[0])}]), work out the commands and hold them. step.first is the
        // run's first sample; step.size is the clock's period.
        static_cast<void>(step);
        static_cast<void>(x);
${declaredOutputs.map((key) => `        m[held${key.charAt(0).toUpperCase()}${key.slice(1)}] = 0.0;`).join('\n')}
    }
};

}

std::unique_ptr<k::Program> createProgram() { return std::make_unique<${className}>(); }
`;
}
