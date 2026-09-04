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

// Assigns a stable FMI valueReference to every state (as an "output") and every live parameter
// (as an "input"), deduped by parameter id since the same live parameter can appear in more than
// one contribution's bindings. States come first, matching codeExport.mjs's own global state
// index order, so downstream tooling that already understands that ordering needs no new mapping.
function assignValueReferences(model) {
    const stateVariables = [];
    let nextValueReference = 0;
    for (const plan of model.nodePlans) {
        for (const state of plan.node.states) {
            stateVariables.push({
                valueReference: nextValueReference, causality: 'output',
                name: `${plan.node.name}.${state.name}`, unit: state.unit ?? '', start: state.initialValue ?? 0
            });
            nextValueReference += 1;
        }
    }

    const inputVariables = [];
    const parameterValueReferences = new Map(); // parameter.id -> valueReference
    const visitSymbols = (symbols) => {
        for (const value of symbols.values()) {
            const parameter = value.parameter;
            if (!parameter || parameter.mode !== 'live' || parameterValueReferences.has(parameter.id)) continue;
            parameterValueReferences.set(parameter.id, nextValueReference);
            inputVariables.push({
                valueReference: nextValueReference, causality: 'input',
                name: parameter.symbol, unit: parameter.unit ?? '', start: parameter.value ?? 0
            });
            nextValueReference += 1;
        }
    };
    for (const plan of model.nodePlans) for (const contribution of plan.contributions) visitSymbols(contribution.symbols);

    return { stateVariables, inputVariables, parameterValueReferences };
}

// Live-parameter symbol entries carry their baked literal text (codeExport.mjs's own export
// target -- a standalone program has no runtime control stream to read a live value from) --
// overwritten here to reference a per-instance input member instead, the one place FMU export's
// codegen genuinely diverges from the plain export's.
function rewriteLiveParameterSymbols(model, parameterValueReferences) {
    for (const plan of model.nodePlans) {
        for (const contribution of plan.contributions) {
            for (const value of contribution.symbols.values()) {
                const parameter = value.parameter;
                if (!parameter || parameter.mode !== 'live') continue;
                value.text = `liveInput_${parameterValueReferences.get(parameter.id)}`;
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
    const { stateVariables, inputVariables, parameterValueReferences } = assignValueReferences(model);
    rewriteLiveParameterSymbols(model, parameterValueReferences);

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

    const inputSwitchCases = inputVariables.map((variable) => (
        `            case ${variable.valueReference}: liveInput_${variable.valueReference} = value; break;`
    )).join('\n');
    const outputSwitchCases = stateVariables.map((variable, index) => (
        `            case ${variable.valueReference}: return state_[${index}];`
    )).join('\n');
    const inputMembers = inputVariables.map((variable) => `    double liveInput_${variable.valueReference} = ${doubleLiteral(variable.start)};`).join('\n');

    const includes = [
        '#include "konjugate/simulationModel.hpp"',
        '#include <algorithm>',
        '#include <cmath>',
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
        inputSwitchCases,
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
        '',
        'private:',
        `    std::vector<double> state_ = { ${stateVariables.map((variable) => doubleLiteral(variable.start)).join(', ')} };`,
        inputMembers,
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

    return { source, stateVariables, inputVariables };
}
