/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Generates the C++ model source for an FMU export: a class implementing
// konjugate/simulationModel.hpp's SimulationModel contract (engine/include/konjugate/
// simulationModel.hpp), compiled and linked against engine/src/fmiGlue.cpp (the FMI 2.0
// Co-Simulation C API implementation) by the engine's `buildSharedLibrary` command. See
// docs/codeExport.md for the FMU export's scope and src/fmiExport.mjs for the orchestration
// (modelDescription.xml generation, invoking the engine build, zipping the result).
//
// Reuses src/codeExport.mjs's graph-building and expression-transpiling machinery wholesale --
// the same buildModel()/emitExpression()/collectProviders() already fidelity-tested for the plain
// C++/Python export -- rather than re-deriving it. The one real difference from the plain export:
// a live parameter (mode: "live") is exposed here as a genuine FMI input (fmi2SetReal between
// doStep calls is a real runtime control stream, unlike a standalone program with no host
// attached), instead of being baked to a constant.

import {
    buildModel, collectProviders, cppSdkNamespace, doubleLiteral,
    emitCppProviderContribution, emitCppRegularContribution, stripLeadingCppInclude
} from './codeExport.mjs';

// Assigns a stable FMI valueReference to every state (as an "output") and every parameter --
// live (mode: "live") as causality="input"/variability="continuous", constant otherwise as
// causality="parameter"/variability="tunable" -- deduped by parameter id since the same parameter
// can appear in more than one contribution's bindings. States come first, matching
// codeExport.mjs's own global state index order, so downstream tooling that already understands
// that ordering needs no new mapping. Unlike the plain export (which always bakes every
// parameter to a constant, since a standalone program has no runtime control stream), *every*
// parameter here becomes a real, settable FMI variable: fmi2SetReal between fmi2DoStep calls is
// exactly the runtime control stream a live parameter needs, and there's no reason a constant
// parameter can't also be exposed for a host to tune -- it just defaults to never being touched,
// reproducing the same constant behavior as today unless a host deliberately changes it.
function assignValueReferences(model) {
    const stateVariables = [];
    let nextValueReference = 0;
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) {
            stateVariables.push({
                valueReference: nextValueReference, causality: 'output', variability: 'continuous',
                name: `${plan.node.name}.${state.name}`, unit: state.unit ?? '', start: state.initialValue ?? 0
            });
            nextValueReference += 1;
        }
    }

    const parameterVariables = [];
    const parameterValueReferences = new Map(); // parameter.id -> valueReference
    const visitSymbols = (symbols) => {
        for (const value of symbols.values()) {
            const parameter = value.parameter;
            if (!parameter || parameterValueReferences.has(parameter.id)) continue;
            parameterValueReferences.set(parameter.id, nextValueReference);
            const live = parameter.mode === 'live';
            parameterVariables.push({
                valueReference: nextValueReference, causality: live ? 'input' : 'parameter', variability: live ? 'continuous' : 'tunable',
                name: parameter.symbol, unit: parameter.unit ?? '', start: parameter.value ?? 0
            });
            nextValueReference += 1;
        }
    };
    for (const plan of model.nodePlans) for (const contribution of plan.contributions) visitSymbols(contribution.symbols);

    return { stateVariables, parameterVariables, parameterValueReferences };
}

// Every parameter symbol entry carries its baked literal text (codeExport.mjs's own export
// target -- a standalone program has no runtime control stream at all) -- overwritten here to
// reference a per-instance mutable member instead, the one place FMU export's codegen genuinely
// diverges from the plain export's.
function rewriteParameterSymbols(model, parameterValueReferences) {
    for (const plan of model.nodePlans) {
        for (const contribution of plan.contributions) {
            for (const value of contribution.symbols.values()) {
                const parameter = value.parameter;
                if (!parameter) continue;
                value.text = `parameterValue_${parameterValueReferences.get(parameter.id)}`;
            }
        }
    }
}

function cppNodeStepBlocks(model, providerInfo) {
    return model.nodePlans.map((plan) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const contributionLines = plan.contributions.map((contribution) => (
            contribution.implementation
                ? emitCppProviderContribution(contribution, providerInfo.get(contribution))
                : emitCppRegularContribution(contribution)
        )).join('\n');
        const commitLines = plan.node.states.map((state, index) => (
            `        state_[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`
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
}

// Generates the model's C++ source and the variable list modelDescription.xml needs (same
// valueReferences on both sides, by construction). document must already be flattened
// (stripEdgeGroups(executionProjectDocument(...))), matching every other codeExport.mjs entry
// point. globalTimeStep is read from the model's active run configuration, exactly the way
// generateStandaloneProgram does.
export function generateFmiModel(document) {
    const runConfiguration = (document.runConfigurations ?? []).find((item) => item.id === document.activeRunConfigurationId) ?? document.runConfigurations?.[0];
    const globalTimeStep = runConfiguration?.globalTimeStep ?? 0.01;
    const model = buildModel(document);
    const providers = collectProviders(model, 'cpp'); // an FMU is a compiled binary -- C++ only.
    const { stateVariables, parameterVariables, parameterValueReferences } = assignValueReferences(model);
    rewriteParameterSymbols(model, parameterValueReferences);
    // A model with any embedded C++ provider can carry arbitrary internal state across evaluate()
    // calls with no generic way to serialize it -- only a provider-free model supports rollback
    // (fmi2Get/SetFMUstate). See konjugate/simulationModel.hpp's supportsStateCapture().
    const supportsStateCapture = providers.length === 0;

    let providerIndex = 0;
    const providerInfo = new Map();
    const providerBlocks = providers.map((provider) => {
        const namespaceName = `provider${providerIndex}`;
        providerIndex += 1;
        providerInfo.set(provider, { namespaceName, instanceVariable: `${namespaceName}Instance` });
        return `namespace ${namespaceName} {\n${stripLeadingCppInclude(provider.implementation.source)}\n}\n`;
    });

    const stepBlocks = cppNodeStepBlocks(model, providerInfo);

    const providerMembers = providers.map((provider) => {
        const info = providerInfo.get(provider);
        return `    decltype(${info.namespaceName}::createRelationshipProvider()) ${info.instanceVariable};`;
    }).join('\n');
    const providerInitializers = providers.map((provider) => {
        const info = providerInfo.get(provider);
        return `        ${info.instanceVariable} = ${info.namespaceName}::createRelationshipProvider();\n        ${info.instanceVariable}->initialize({});`;
    }).join('\n');

    const parameterSwitchCases = parameterVariables.map((variable) => (
        `            case ${variable.valueReference}: parameterValue_${variable.valueReference} = value; break;`
    )).join('\n');
    // getOutput answers fmi2GetReal for ANY value reference, not just state outputs -- a host
    // reading back what it just set via fmi2SetReal, or a parameter's current value, needs a real
    // answer here too, not the default 0.0.
    const outputSwitchCases = [
        ...stateVariables.map((variable, index) => `            case ${variable.valueReference}: return state_[${index}];`),
        ...parameterVariables.map((variable) => `            case ${variable.valueReference}: return parameterValue_${variable.valueReference};`)
    ].join('\n');
    const parameterMembers = parameterVariables.map((variable) => `    double parameterValue_${variable.valueReference} = ${doubleLiteral(variable.start)};`).join('\n');

    const stateCaptureMethods = supportsStateCapture ? [
        '',
        '    bool supportsStateCapture() const override { return true; }',
        '',
        '    std::vector<double> captureState() const override {',
        '        std::vector<double> snapshot = state_;',
        parameterVariables.map((variable) => `        snapshot.push_back(parameterValue_${variable.valueReference});`).join('\n'),
        '        return snapshot;',
        '    }',
        '',
        '    void restoreState(const std::vector<double>& snapshot) override {',
        '        for (std::size_t index = 0; index < state_.size(); ++index) state_[index] = snapshot[index];',
        parameterVariables.map((variable, index) => `        parameterValue_${variable.valueReference} = snapshot[state_.size() + ${index}];`).join('\n'),
        '    }'
    ].join('\n') : '';

    const includes = [
        '#include "konjugate/simulationModel.hpp"',
        '#include <algorithm>',
        '#include <cmath>',
        '#include <cstddef>',
        '#include <memory>',
        '#include <stdexcept>',
        providers.length ? '#include <span>' : '',
        providers.length ? '#include <string_view>' : '',
        '#include <vector>'
    ].filter(Boolean).join('\n');

    const source = [
        `// Generated by Konjugate's "Export simulation code" feature (FMU) from "${document.metadata?.projectName ?? 'this project'}".`,
        '// See docs/codeExport.md for exactly what an FMU export does and does not reproduce.',
        '',
        includes,
        '',
        providers.length ? `${cppSdkNamespace}\n` : '',
        providerBlocks.join('\n'),
        'namespace {',
        '',
        'class GeneratedModel final : public konjugate::sdk::v1::SimulationModel {',
        'public:',
        '    GeneratedModel() {',
        providerInitializers,
        '    }',
        '',
        '    void setInput(int valueReference, double value) override {',
        '        switch (valueReference) {',
        parameterSwitchCases,
        '            default: break;',
        '        }',
        '    }',
        '',
        '    double getOutput(int valueReference) const override {',
        '        switch (valueReference) {',
        outputSwitchCases,
        '            default: return 0.0;',
        '        }',
        '    }',
        '',
        '    void doStep(double currentTime, double globalTimeStep) override {',
        '        const std::vector<double> snapshot = state_;',
        stepBlocks,
        '    }',
        '',
        `    double globalTimeStep() const override { return ${doubleLiteral(globalTimeStep)}; }`,
        stateCaptureMethods,
        '',
        'private:',
        `    std::vector<double> state_ = { ${stateVariables.map((variable) => doubleLiteral(variable.start)).join(', ')} };`,
        parameterMembers,
        providerMembers,
        '};',
        '',
        '} // namespace',
        '',
        'std::unique_ptr<konjugate::sdk::v1::SimulationModel> konjugate::sdk::v1::createSimulationModel() {',
        '    return std::make_unique<GeneratedModel>();',
        '}',
        ''
    ].join('\n');

    return { source, stateVariables, parameterVariables, supportsStateCapture };
}
