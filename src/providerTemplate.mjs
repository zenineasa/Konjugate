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
 * Generates a starter provider implementation from the relationship's currently declared
 * bindings and output key, so authoring a C++/Python relationship begins from a compiling
 * skeleton that already names every value the provider can read from and write to.
 */
export function defaultProviderSource(kind, bindings = [], outputKey = '', title = '') {
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
 * Generates a no-bindings C++ source term that replays one CSV column's own recorded (time,
 * value) samples exactly, rather than fitting a model to it -- for a column causal inference
 * found nothing predicting (see docs/proposals/causalInferenceInputReplay.md). Each evaluate()
 * call emits the local slope between the two recorded samples straddling the current simulation
 * time, which integrates exactly under Euler at any substep count because a constant-rate
 * segment's true solution genuinely is linear -- not an approximation the way a fitted rate's
 * single-Euler-step calibration is. Past the last recorded sample (and before the first), the
 * gradient is zero: the value holds at its last/first known point rather than extrapolating.
 *
 * pairs: [{ time, value }, ...] in chronological row order, already regularly spaced (the same
 * guarantee parseInferenceCsv enforces on its input). Requires at least 2 samples -- a slope
 * needs two points, and a `double[]` embedded with zero entries is a compiler extension, not
 * standard C++ (confirmed: clang accepts it but flags it under -Wpedantic, which this project's
 * engine build enables) -- rejected outright rather than silently emitting that.
 */
export function replayProviderSource(columnName, pairs, title) {
    if (!Array.isArray(pairs) || pairs.length < 2) {
        throw new Error(`replayProviderSource needs at least 2 recorded samples for "${columnName}", got ${pairs?.length ?? 0}.`);
    }
    const { id, name, className } = providerIdentity(title || columnName);
    const times = pairs.map((pair) => cppDoubleLiteral(pair.time)).join(', ');
    const values = pairs.map((pair) => cppDoubleLiteral(pair.value)).join(', ');
    return `#include <konjugate/relationshipProvider.hpp>

#include <cstddef>
#include <memory>

namespace {

// Recorded "${columnName}" samples from the imported CSV, chronological and regularly spaced.
constexpr double kTimes[] = { ${times} };
constexpr double kValues[] = { ${values} };
constexpr std::size_t kSampleCount = sizeof(kTimes) / sizeof(kTimes[0]);

class ${className} final : public konjugate::sdk::v1::RelationshipProvider {
public:
    konjugate::sdk::v1::RelationshipDescription describe() const override {
        return {
            "${id}",
            "${name}",
            {},
            konjugate::sdk::v1::ScalarPort{"output", "output", ""}
        };
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context,
                  konjugate::sdk::v1::OutputCollector& output) override {
        if (kSampleCount < 2) { output.addGradient(0); return; }
        const double rowTimeStep = kTimes[1] - kTimes[0];
        // position is dimensionless (row-index units), so a fixed small nudge here is safe
        // regardless of the CSV's own absolute time scale or sampling interval. Needed because
        // the caller's own accumulated simulationTime can drift a hair off an exact recorded
        // sample time (e.g. summing 0.2 five times does not land on exactly 1.0 in double
        // precision) -- both range boundaries below and the interior interval lookup all derive
        // from this one nudged value, so "just before the end" and "just past an interior
        // boundary" get the same tolerant treatment rather than two independently-tuned checks
        // drifting out of sync with each other. Confirmed by a direct Euler-integration test
        // across several substep counts (including a case where the un-nudged version leaked
        // slightly past the recorded end at very fine substep counts) before this fix was added;
        // see docs/proposals/causalInferenceInputReplay.md.
        const double position = (context.simulationTime - kTimes[0]) / rowTimeStep + 1e-6;
        // Before the first recorded sample, or past the last one (any run longer than the CSV's
        // own recorded span will reach this): hold, emitting no further change.
        if (position < 0 || position >= kSampleCount - 1) { output.addGradient(0); return; }
        std::size_t index = static_cast<std::size_t>(position);
        if (index >= kSampleCount - 1) index = kSampleCount - 2;
        output.addGradient((kValues[index + 1] - kValues[index]) / rowTimeStep);
    }
};

}

std::unique_ptr<konjugate::sdk::v1::RelationshipProvider> createRelationshipProvider() {
    return std::make_unique<${className}>();
}
`;
}
