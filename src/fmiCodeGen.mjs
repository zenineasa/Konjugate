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

import { integrationMethod, methodOf } from './integrationMethods.mjs';
import {
    buildModel, collectProviders, cppScheduleLines, cppSdkNamespace, cppStiffFmuPieces, doubleLiteral,
    cppAlgebraicLines, cppNodeSubstepLines, emitCppAlgebraicTask, emitCppProviderContribution, emitCppRegularContribution, stripLeadingCppInclude,
    cppProgramAdvanceLines, cppProgramInstantLines, cppProgramStartLines, emitCppNodeProgram, programEntries, programRuntimeCpp,
    shareProgramInstances, updateStateIndexes
} from './codeExport.mjs';
import { programSdkCpp } from './programSdkSources.mjs';

// The symbols of every term, and of a node's own program in the current format, that a parameter can reach.
const symbolOwners = (plan) => [...plan.algebraic, ...plan.contributions, ...(plan.nodeProvider?.program ? [plan.nodeProvider] : [])];

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
//
// FMI requires every variable's name to be unique. A parameter is named by its symbol, and two relationships can each have
// their own parameter with the same symbol (a spring's "mass" and a damper's "mass"): those, and only those, are named by
// their relationship or node as well ("Spring force.mass"), as a state is ("Node.State"). Any name still used twice (two nodes
// of the same name, say) gets its value reference after it. The generated source never names a variable, so this changes
// modelDescription.xml alone.
function uniqueVariableNames(document, stateVariables, parameterVariables, parameterIds) {
    const ownerNames = new Map();
    for (const owner of [...(document.edges ?? []), ...(document.nodes ?? [])]) {
        const terms = [owner, ...(owner.sourceTerms ?? [])];
        for (const term of terms) for (const parameter of term.parameters ?? []) ownerNames.set(parameter.id, owner.name);
    }
    const count = (variables) => variables.reduce((counts, variable) => counts.set(variable.name, (counts.get(variable.name) ?? 0) + 1), new Map());
    const symbols = count(parameterVariables);
    parameterVariables.forEach((variable, index) => {
        const owner = ownerNames.get(parameterIds[index]);
        if (symbols.get(variable.name) > 1 && owner) variable.name = `${owner}.${variable.name}`;
    });
    const all = [...stateVariables, ...parameterVariables];
    const names = count(all);
    for (const variable of all) if (names.get(variable.name) > 1) variable.name = `${variable.name} [${variable.valueReference}]`;
}

function assignValueReferences(model, document) {
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
            // A parameter that follows a stored schedule is computed inside the FMU from its samples,
            // as the engine computes it, so it is not an FMI variable a host sets.
            if (!parameter || value.schedule !== undefined || parameterValueReferences.has(parameter.id)) continue;
            parameterValueReferences.set(parameter.id, nextValueReference);
            const live = parameter.mode === 'live';
            parameterVariables.push({
                valueReference: nextValueReference, causality: live ? 'input' : 'parameter', variability: live ? 'continuous' : 'tunable',
                name: parameter.symbol, unit: parameter.unit ?? '', start: parameter.value ?? 0
            });
            nextValueReference += 1;
        }
    };
    for (const plan of model.nodePlans) for (const contribution of symbolOwners(plan)) visitSymbols(contribution.symbols);
    uniqueVariableNames(document, stateVariables, parameterVariables, [...parameterValueReferences.keys()]);

    return { stateVariables, parameterVariables, parameterValueReferences };
}

// Every parameter symbol entry carries its baked literal text (codeExport.mjs's own export
// target -- a standalone program has no runtime control stream at all) -- overwritten here to
// reference a per-instance mutable member instead, the one place FMU export's codegen genuinely
// diverges from the plain export's.
function rewriteParameterSymbols(model, parameterValueReferences) {
    for (const plan of model.nodePlans) {
        for (const contribution of symbolOwners(plan)) {
            for (const value of contribution.symbols.values()) {
                const parameter = value.parameter;
                if (!parameter || value.schedule !== undefined) continue;
                value.text = `parameterValue_${parameterValueReferences.get(parameter.id)}`;
            }
        }
    }
}

function cppNodeStepBlocks(model, providerInfo) {
    return model.nodePlans.map((plan) => {
        const stateCount = plan.node.states.length;
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const emitContribution = (contribution) => (contribution.implementation
            ? emitCppProviderContribution(contribution, providerInfo.get(contribution))
            : emitCppRegularContribution(contribution));
        const commitLines = plan.node.states.map((state, index) => (
            `        state_[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`
        )).join('\n');
        // A node's own program in the current format adds its rates at each substep; programs that remember advance after each.
        const nodeLines = plan.nodeProvider?.program ? [emitCppNodeProgram(plan.nodeProvider, providerInfo.get(plan.nodeProvider))] : [];
        return [
            `    // Node: ${plan.node.name}`,
            '    {',
            `        double state[${stateCount}] = { ${seed} };`,
            // Euler or Verlet, as codeExport.mjs writes a node's substeps.
            cppNodeSubstepLines(plan, emitContribution, { nodeLines, afterSubstep: cppProgramAdvanceLines(plan, providerInfo, model) }),
            cppAlgebraicLines(plan, providerInfo),
            commitLines,
            '    }'
        ].join('\n');
    }).join('\n');
}

// The engine computes every algebraic state once from the initial states (and the parameter values
// the run starts with) before the first step. An FMU host sets parameters after instantiation, so
// settle() runs at construction and again on every setInput until the first doStep.
function cppSettleBlocks(model, providerInfo) {
    return model.nodePlans.filter((plan) => plan.algebraic.length).map((plan) => {
        const seed = plan.node.states.map((state) => `snapshot[${model.stateRecord.get(state.id).globalIndex}]`).join(', ');
        const commitLines = plan.node.states.map((state, index) => (
            `        state_[${model.stateRecord.get(state.id).globalIndex}] = state[${index}];`
        )).join('\n');
        return [
            `    // Node: ${plan.node.name}`,
            '    {',
            `        double state[${plan.node.states.length}] = { ${seed} };`,
            `        const double nodeTimeStep = globalTimeStep / ${plan.substeps}.0;`,
            '        const double algebraicTime = 0.0;',
            plan.algebraic.map((task) => emitCppAlgebraicTask(task, providerInfo.get(task))).join('\n'),
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
    // An FMU steps with Euler node by node, or under Stiff with Rodas4 or BDF inside fmi2DoStep, each global step as the engine takes
    // it (docs/proposals/integrators.md, Code export); Runge–Kutta 4 and Adaptive inside fmi2DoStep come later, so an FMU is never made
    // with numbers other than the run's.
    const method = methodOf(runConfiguration);
    const stiff = method === 'rodas4' || method === 'rodas5p' || method === 'bdf';
    if (method !== 'nodeByNode' && !stiff) {
        throw new Error(`The run configuration's method is ${integrationMethod(method)?.name ?? `“${method}”`}, which FMU export cannot write yet; choose Euler, node by node or Stiff in the Run settings to export an FMU.`);
    }
    const model = buildModel(document, { wholeModel: stiff });
    if (stiff) {
        const nodeProvider = model.nodePlans.find((plan) => plan.nodeProvider);
        if (nodeProvider) throw new Error(`Node "${nodeProvider.node.name}" is a program of its own, which FMU export cannot write under ${integrationMethod(method).name} yet.`);
    }
    const providers = collectProviders(model, 'cpp'); // an FMU is a compiled binary -- C++ only.
    const { stateVariables, parameterVariables, parameterValueReferences } = assignValueReferences(model, document);
    rewriteParameterSymbols(model, parameterValueReferences);
    // A program in the older format can carry arbitrary internal state across evaluate() calls with no generic way to serialize it, so
    // a model with one does not support rollback (fmi2Get/SetFMUstate; konjugate/simulationModel.hpp's supportsStateCapture()). A program
    // in the current format keeps its state in declared memory, which the FMU state carries (docs/proposals/programSdkV2.md, Export parity).
    // Under Stiff the solver's memory (Rodas4's controller, BDF's table) is not in the captured state either, so rollback is not offered.
    const supportsStateCapture = providers.every((provider) => provider.program) && !stiff;
    const programs = programEntries(model);
    // A program in the current format is written into an FMU stepped with Euler, node by node; under Stiff, not yet.
    if (stiff && programs.length) {
        throw new Error(`The program of the ${programs[0].task.entityLabel} is in the current program format, which FMU export cannot write under ${integrationMethod(method).name} yet; choose Euler, node by node in the Run settings to export an FMU.`);
    }

    let providerIndex = 0;
    const providerInfo = new Map();
    const providerBlocks = providers.map((provider) => {
        const namespaceName = `provider${providerIndex}`;
        providerIndex += 1;
        providerInfo.set(provider, { namespaceName, instanceVariable: `${namespaceName}Instance` });
        const source = provider.program
            ? provider.implementation.source.replace(/^#include\s*<konjugate\/sdk\/v2\/program\.hpp>\s*\n/m, '') : stripLeadingCppInclude(provider.implementation.source);
        return `namespace ${namespaceName} {\n${source}\n}\n`;
    });
    shareProgramInstances(model, providerInfo);

    const stiffPieces = stiff ? cppStiffFmuPieces(model, providers, providerInfo, runConfiguration) : null;
    const stepBlocks = stiff ? stiffPieces.body.join('\n') : cppNodeStepBlocks(model, providerInfo);
    const settleBlocks = cppSettleBlocks(model, providerInfo);

    const providerMembers = providers.map((provider) => {
        const info = providerInfo.get(provider);
        if (provider.program) return `    ProgramInstance ${info.instanceVariable};`;
        return `    decltype(${info.namespaceName}::createRelationshipProvider()) ${info.instanceVariable};`;
    }).join('\n');
    const providerInitializers = providers.filter((provider) => !provider.program).map((provider) => {
        const info = providerInfo.get(provider);
        return `        ${info.instanceVariable} = ${info.namespaceName}::createRelationshipProvider();\n        ${info.instanceVariable}->initialize({});`;
    }).join('\n');
    // The programs started from the initial states, then their clocks' first tick and their Update values, before the run's Updates are
    // settled, as the engine starts a run; again, afresh, when a host sets a parameter before the first step (initialize() reads it).
    const instantAtStart = cppProgramInstantLines(model, providerInfo, '0.0', false, 'state_').filter(Boolean);
    const programStartMethod = programs.length ? [
        '    void startPrograms() {',
        '        state_ = initialState_;',
        ...providers.filter((provider) => provider.program).map((provider) => {
            const info = providerInfo.get(provider);
            return `        ${info.instanceVariable}.program = ${info.namespaceName}::createProgram();\n        ${info.instanceVariable}.advanced = false;`;
        }),
        cppProgramStartLines(model, providerInfo, 'state_').split('\n').map((line) => `    ${line}`).join('\n'),
        ...(instantAtStart.length ? ['        {', '            const std::vector<double> read = state_;', ...instantAtStart, '        }'] : []),
        '    }',
        ''
    ].join('\n') : '';
    // At the step's end: the clocks that tick, then the programs' values into Update states, reading the states as the engine's update
    // phase reads them (Rate states at the step's end, Update states at its start).
    const instantAtEnd = cppProgramInstantLines(model, providerInfo, 'currentTime + globalTimeStep', false, 'state_').filter(Boolean);
    const programStepEnd = instantAtEnd.length ? [
        '        {',
        '            std::vector<double> read = state_;',
        ...updateStateIndexes(model).map((index) => `            read[${index}] = snapshot[${index}];`),
        ...instantAtEnd,
        '        }'
    ].join('\n') : '';
    // The FMU state: the states, the parameters, and each program's memory, word by word, with whether it has been advanced yet.
    const programMemoryCapture = providers.filter((provider) => provider.program).map((provider) => {
        const info = providerInfo.get(provider);
        return [
            `        snapshot.push_back(${info.instanceVariable}.advanced ? 1.0 : 0.0);`,
            `        for (std::size_t at = 0; at < ${info.instanceVariable}.memory.size(); at += 8) {`,
            '            double word = 0;',
            `            std::memcpy(&word, ${info.instanceVariable}.memory.data() + at, 8);`,
            '            snapshot.push_back(word);',
            '        }'
        ].join('\n');
    }).join('\n');
    const programMemoryRestore = providers.filter((provider) => provider.program).map((provider) => {
        const info = providerInfo.get(provider);
        return [
            `        ${info.instanceVariable}.advanced = snapshot[cursor++] != 0.0;`,
            `        for (std::size_t at = 0; at < ${info.instanceVariable}.memory.size(); at += 8) std::memcpy(${info.instanceVariable}.memory.data() + at, &snapshot[cursor++], 8);`
        ].join('\n');
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
        programMemoryCapture,
        '        return snapshot;',
        '    }',
        '',
        '    void restoreState(const std::vector<double>& snapshot) override {',
        '        for (std::size_t index = 0; index < state_.size(); ++index) state_[index] = snapshot[index];',
        parameterVariables.map((variable, index) => `        parameterValue_${variable.valueReference} = snapshot[state_.size() + ${index}];`).join('\n'),
        programMemoryRestore ? `        std::size_t cursor = state_.size() + ${parameterVariables.length};\n${programMemoryRestore}` : '',
        '    }'
    ].filter(Boolean).join('\n') : '';

    const includes = [
        '#include "konjugate/simulationModel.hpp"',
        '#include <algorithm>',
        '#include <cmath>',
        '#include <cstddef>',
        stiff ? '#include <functional>' : '',
        programs.length ? '#include <cstring>' : '',
        stiff || programs.length ? '#include <limits>' : '',
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
        providers.some((provider) => !provider.program) ? `${cppSdkNamespace}\n` : '',
        // The program SDK (version 2) as it is, and the instance the engine keeps, for the programs in the current format.
        programs.length ? `${programSdkCpp.replace(/^#pragma once\n/m, '')}\n\n${programRuntimeCpp}` : '',
        providerBlocks.join('\n'),
        stiff ? stiffPieces.headers : '',
        'namespace {',
        '',
        cppScheduleLines(model),
        'class GeneratedModel final : public konjugate::sdk::v1::SimulationModel {',
        'public:',
        '    GeneratedModel() {',
        providerInitializers,
        programs.length ? '        startPrograms();' : '',
        '        settle();',
        '    }',
        '',
        '    void setInput(int valueReference, double value) override {',
        '        switch (valueReference) {',
        parameterSwitchCases,
        '            default: break;',
        '        }',
        programs.length ? '        if (!started_) {\n            startPrograms();\n            settle();\n        }' : '        if (!started_) settle();',
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
        '        started_ = true;',
        stiff ? '' : '        const std::vector<double> snapshot = state_;',
        stepBlocks,
        programStepEnd,
        '    }',
        '',
        `    double globalTimeStep() const override { return ${doubleLiteral(globalTimeStep)}; }`,
        stateCaptureMethods,
        '',
        'private:',
        programStartMethod,
        '    void settle() {',
        `        const double globalTimeStep = ${doubleLiteral(globalTimeStep)};`,
        '        const std::vector<double> snapshot = state_;',
        '        (void)globalTimeStep; (void)snapshot;',
        settleBlocks,
        '    }',
        '',
        ...(stiff ? [
            ...stiffPieces.members,
            '    // Every input a host may set, for BDF to tell whether one changed between steps.',
            `    std::vector<double> currentInputs() const { return { ${parameterVariables.map((variable) => `parameterValue_${variable.valueReference}`).join(', ')} }; }`
        ] : []),
        '    bool started_ = false;',
        `    std::vector<double> state_ = { ${stateVariables.map((variable) => doubleLiteral(variable.start)).join(', ')} };`,
        programs.length ? `    const std::vector<double> initialState_ = { ${stateVariables.map((variable) => doubleLiteral(variable.start)).join(', ')} };` : '',
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
