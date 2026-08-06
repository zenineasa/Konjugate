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
    const inputReads = inputKeys.length
        ? `context.inputs.at("${inputKeys.join('"), context.inputs.at("')}")`
        : 'the declared inputs above';
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
        // TODO: read ${inputReads} and add the computed contribution through output.addGradient(...).
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
    const inputReads = inputKeys.length
        ? inputKeys.map((key) => `inputs["${key}"]`).join(', ')
        : 'the declared inputs above';
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
        # TODO: read ${inputReads} and add the computed contribution through outputs.add_gradient(...).
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
