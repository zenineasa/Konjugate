/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Resolves a node's `kind: "fmi"` implementation (see docs/projectSchema.md) into an ordinary
// `kind: "cpp"` computational-node-provider implementation, exactly like src/pluginResolver.mjs
// turns `kind: "plugin"` into `kind: "cpp"`/`"python"` before the engine ever sees the document --
// the engine itself has zero FMI-specific knowledge. The generated C++ source implements
// konjugate::sdk::v1::NodeProvider by dlopen()ing the installed FMU's own platform binary at
// runtime and driving it through the real FMI2 C API (konjugate/fmiDynamicLoad.hpp), then runs
// through the exact same in-process computational-node-provider path added for this feature
// (engine/src/providerInProcessNodeShim.cpp) -- see docs/interactionProviders.md.
//
// Output-value semantics: an FMU's causality="output" variable is an algebraic VALUE (e.g. a
// reported temperature), not a rate -- so every generated output is marked `setsValue: true`
// (see docs/projectSchema.md), the engine's real DAE-style algebraic-state mechanism, rather than
// folded into its target state as a derivative and Euler-integrated. The engine writes the FMU's
// reported value directly into the target state every substep, with zero approximation error and
// no dependency on any particular solver's arithmetic -- see NodeProviderOutputBinding::setsValue
// in engine/include/executionPlan.hpp. An earlier version of this resolver used a synthetic
// feedback input port and contributed `(fmuValue - stateAtStartOfSubstep) / stepSize` instead --
// exact only because Explicit Euler's specific single-stage arithmetic happens to cancel that back
// to `fmuValue`, the same Euler-specific trick `setsValue` itself replaced elsewhere (see
// docs/interactionProviders.md's `addGradient` section and docs/proposals/causalInferenceInputReplay.md)
// -- before being replaced with this one.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { parseModelDescription } from './fmiModelDescription.mjs';
import { platformDirectory, libraryExtension } from './fmiExport.mjs';
import { packageKey } from './packageArchive.mjs';

export class FmiResolutionError extends Error {
    constructor(message, code = 'FMI_RESOLUTION_FAILED') {
        super(message);
        this.name = 'FmiResolutionError';
        this.code = code;
    }
}

const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

// Konjugate's own binding/output keys must be lower camel case (engine/src/modelValidator.cpp's
// symbolPattern, `^[a-z][A-Za-z0-9]*$`) -- but a real vendor FMU's variable names are under no
// such constraint (dots for hierarchical structure, e.g. "Decay.Level", leading digits,
// underscores, ...). Rather than exposing raw FMU names as binding keys (which would simply fail
// validation for most real FMUs), this resolver deterministically sanitizes each FMU variable
// name into a valid key and uses THAT consistently everywhere a key is needed -- the project's own
// `bindings[]`/`outputs[]` JSON is written against these sanitized keys, not the FMU's raw names
// (a human hand-editing JSON derives one from the other with this same rule).
function sanitizeToLowerCamelCase(name) {
    const parts = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
    let result = parts.length
        ? parts[0].charAt(0).toLowerCase() + parts[0].slice(1)
            + parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
        : '';
    if (!/^[a-z]/.test(result)) result = `v${result}`;
    result = result.replace(/[^A-Za-z0-9]/g, '');
    return result || 'v';
}

// Detects a sanitized-key collision between two differently-named FMU variables (e.g.
// "Motor.Speed" and "motorSpeed" would both sanitize to "motorSpeed") -- rare in practice, but a
// silent collision would mean one binding/output secretly aliases two different FMU variables, so
// this is checked explicitly and rejected with a clear error rather than risked.
function keyByVariableName(variables, describeWhat) {
    const keys = new Map();
    for (const variable of variables) {
        const key = sanitizeToLowerCamelCase(variable.name);
        const collidingName = [...keys.entries()].find(([, existingKey]) => existingKey === key)?.[0];
        if (collidingName) {
            throw new FmiResolutionError(
                `FMU ${describeWhat} '${variable.name}' and '${collidingName}' both sanitize to the binding key '${key}' -- Konjugate cannot tell them apart.`,
                'FMU_KEY_COLLISION'
            );
        }
        keys.set(variable.name, key);
    }
    return keys;
}

// A valid, safe C++ string literal for any JS string: JSON's escaping (\\, \", \n, ...) is a
// strict subset of C++'s for the ASCII text these values are (a modelName, a guid, a filesystem
// path), so this is exact, not an approximation.
function cppStringLiteral(text) {
    return JSON.stringify(String(text));
}

// Shared between generateFmi2Glue/generateFmi3Glue below: the describe()-returned port lists are
// entirely FMI-version-agnostic (a key, a name, no unit), so this is written once, not duplicated
// per version.
function buildPortDeclarations(inputVariables, outputVariables, inputKeys, outputKeys) {
    const scalarPort = (key) => `        {${cppStringLiteral(key)}, ${cppStringLiteral(key)}, ""}`;
    const inputPorts = inputVariables.map((variable) => scalarPort(inputKeys.get(variable.name))).join(',\n');
    const outputPorts = outputVariables.map((variable) => scalarPort(outputKeys.get(variable.name))).join(',\n');
    return { inputPorts, outputPorts };
}

function generateFmi2Glue({ description, binaryPath, guid, version, contentHash, inputKeys, outputKeys }) {
    const inputVariables = description.variables.filter((variable) => variable.causality === 'input' || variable.causality === 'parameter');
    const outputVariables = description.variables.filter((variable) => variable.causality === 'output');
    const { inputPorts, outputPorts } = buildPortDeclarations(inputVariables, outputVariables, inputKeys, outputKeys);

    const inputBlock = inputVariables.length ? `
        const fmi2ValueReference inputVr[] = {${inputVariables.map((variable) => variable.valueReference).join(', ')}};
        const fmi2Real inputValues[] = {
            ${inputVariables.map((variable) => `static_cast<fmi2Real>(context.inputs.at(${cppStringLiteral(inputKeys.get(variable.name))}))`).join(',\n            ')}
        };
        if (api_.setReal(component_, inputVr, ${inputVariables.length}, inputValues) != fmi2OK) {
            throw std::runtime_error("fmi2SetReal failed for the imported FMU.");
        }
` : '';

    const outputBlock = outputVariables.length ? `
        const fmi2ValueReference outputVr[] = {${outputVariables.map((variable) => variable.valueReference).join(', ')}};
        fmi2Real outputValues[${outputVariables.length}];
        if (api_.getReal(component_, outputVr, ${outputVariables.length}, outputValues) != fmi2OK) {
            throw std::runtime_error("fmi2GetReal failed for the imported FMU.");
        }
${outputVariables.map((variable, index) =>
        `        outputs.addGradient(${cppStringLiteral(outputKeys.get(variable.name))}, static_cast<double>(outputValues[${index}]));`
    ).join('\n')}
` : '';

    return `// Generated by src/fmiResolver.mjs for the imported FMU ${cppStringLiteral(description.modelName)}
// (guid ${cppStringLiteral(guid)}, version ${cppStringLiteral(version)}, FMI ${description.fmiVersion}).
// Content hash ${cppStringLiteral(contentHash)} -- embedded only so replacing the installed FMU's
// binary in place invalidates Konjugate's build cache instead of silently reusing a stale
// compiled artifact (see buildCppProvider's caching in engine/src/providerRuntime.cpp).
// Every declared output is marked setsValue in the resolved implementation's outputs[] (see
// resolveFmiSource below), so addGradient's value here is read by the engine as the state's
// algebraic value, not a derivative -- see this file's header comment.
#include <konjugate/relationshipProvider.hpp>
#include <konjugate/fmiDynamicLoad.hpp>

#include <memory>
#include <stdexcept>
#include <vector>

namespace {

using konjugate::fmi::Fmi2Api;
using konjugate::fmi::LoadedLibrary;

class ImportedFmu final : public konjugate::sdk::v1::NodeProvider {
public:
    ImportedFmu() : library_(${cppStringLiteral(binaryPath)}), api_(library_) {}

    ~ImportedFmu() override { teardown(); }

    konjugate::sdk::v1::NodeProviderDescription describe() const override {
        return {
            "fmi.${guid}", ${cppStringLiteral(description.modelName)},
            {
${inputPorts}
            },
            {
${outputPorts}
            }
        };
    }

    void initialize(const konjugate::sdk::v1::InitializationContext&) override {
        component_ = api_.instantiate("konjugateImportedFmu", fmi2CoSimulation, ${cppStringLiteral(guid)}, "", nullptr, fmi2False, fmi2False);
        if (!component_) throw std::runtime_error("fmi2Instantiate failed for the imported FMU.");
        if (api_.setupExperiment(component_, fmi2False, 0.0, 0.0, fmi2False, 0.0) != fmi2OK) {
            throw std::runtime_error("fmi2SetupExperiment failed for the imported FMU.");
        }
        if (api_.enterInitializationMode(component_) != fmi2OK) throw std::runtime_error("fmi2EnterInitializationMode failed for the imported FMU.");
        if (api_.exitInitializationMode(component_) != fmi2OK) throw std::runtime_error("fmi2ExitInitializationMode failed for the imported FMU.");
        initializedOk_ = true;
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::NodeOutputCollector& outputs) override {
        if (!component_) throw std::runtime_error("The imported FMU was evaluated before initialize().");
${inputBlock}
        if (api_.doStep(component_, context.simulationTime, context.stepSize, fmi2False) != fmi2OK) {
            throw std::runtime_error("fmi2DoStep failed for the imported FMU.");
        }
${outputBlock}    }

    std::vector<std::byte> checkpoint() const override {
        if (!component_) throw std::runtime_error("The imported FMU was checkpointed before initialize().");
        fmi2FMUstate state = nullptr;
        if (api_.getFMUstate(component_, &state) != fmi2OK) throw std::runtime_error("This imported FMU does not support checkpointing.");
        size_t size = 0;
        if (api_.serializedFMUstateSize(component_, state, &size) != fmi2OK) {
            api_.freeFMUstate(component_, &state);
            throw std::runtime_error("fmi2SerializedFMUstateSize failed for the imported FMU.");
        }
        std::vector<std::byte> bytes(size);
        const auto status = api_.serializeFMUstate(component_, state, reinterpret_cast<fmi2Byte*>(bytes.data()), size);
        api_.freeFMUstate(component_, &state);
        if (status != fmi2OK) throw std::runtime_error("fmi2SerializeFMUstate failed for the imported FMU.");
        return bytes;
    }

    void restore(std::span<const std::byte> payload) override {
        if (!component_) throw std::runtime_error("The imported FMU was restored before initialize().");
        fmi2FMUstate state = nullptr;
        if (api_.deSerializeFMUstate(component_, reinterpret_cast<const fmi2Byte*>(payload.data()), payload.size(), &state) != fmi2OK) {
            throw std::runtime_error("fmi2DeSerializeFMUstate failed for the imported FMU.");
        }
        const auto status = api_.setFMUstate(component_, state);
        api_.freeFMUstate(component_, &state);
        if (status != fmi2OK) throw std::runtime_error("fmi2SetFMUstate failed for the imported FMU.");
    }

    void shutdown() noexcept override { teardown(); }

private:
    void teardown() noexcept {
        if (component_) {
            if (initializedOk_) api_.terminate(component_);
            api_.freeInstance(component_);
            component_ = nullptr;
        }
    }

    LoadedLibrary library_;
    Fmi2Api api_;
    fmi2Component component_ = nullptr;
    bool initializedOk_ = false;
};

} // namespace

std::unique_ptr<konjugate::sdk::v1::NodeProvider> createNodeProvider() {
    return std::make_unique<ImportedFmu>();
}
`;
}

// The FMI 3.0 counterpart to generateFmi2Glue above -- same port-list/setsValue-output shape
// (see the file header comment), different C API calls: fmi3EnterInitializationMode folds what
// FMI2 splits into fmi2SetupExperiment+fmi2EnterInitializationMode into one call; fmi3DoStep gains
// event/terminate/early-return/last-successful-time out-params, which this synchronous,
// non-early-returning driver always supplies storage for but only acts on when the FMU actually
// requests termination or an early return it was never granted.
function generateFmi3Glue({ description, binaryPath, guid, version, contentHash, inputKeys, outputKeys }) {
    const inputVariables = description.variables.filter((variable) => variable.causality === 'input' || variable.causality === 'parameter');
    const outputVariables = description.variables.filter((variable) => variable.causality === 'output');
    const { inputPorts, outputPorts } = buildPortDeclarations(inputVariables, outputVariables, inputKeys, outputKeys);

    const inputBlock = inputVariables.length ? `
        const fmi3ValueReference inputVr[] = {${inputVariables.map((variable) => variable.valueReference).join(', ')}};
        const fmi3Float64 inputValues[] = {
            ${inputVariables.map((variable) => `static_cast<fmi3Float64>(context.inputs.at(${cppStringLiteral(inputKeys.get(variable.name))}))`).join(',\n            ')}
        };
        if (api_.setFloat64(instance_, inputVr, ${inputVariables.length}, inputValues, ${inputVariables.length}) != fmi3OK) {
            throw std::runtime_error("fmi3SetFloat64 failed for the imported FMU.");
        }
` : '';

    const outputBlock = outputVariables.length ? `
        const fmi3ValueReference outputVr[] = {${outputVariables.map((variable) => variable.valueReference).join(', ')}};
        fmi3Float64 outputValues[${outputVariables.length}];
        if (api_.getFloat64(instance_, outputVr, ${outputVariables.length}, outputValues, ${outputVariables.length}) != fmi3OK) {
            throw std::runtime_error("fmi3GetFloat64 failed for the imported FMU.");
        }
${outputVariables.map((variable, index) =>
        `        outputs.addGradient(${cppStringLiteral(outputKeys.get(variable.name))}, static_cast<double>(outputValues[${index}]));`
    ).join('\n')}
` : '';

    return `// Generated by src/fmiResolver.mjs for the imported FMU ${cppStringLiteral(description.modelName)}
// (guid ${cppStringLiteral(guid)}, version ${cppStringLiteral(version)}, FMI ${description.fmiVersion}).
// Content hash ${cppStringLiteral(contentHash)} -- embedded only so replacing the installed FMU's
// binary in place invalidates Konjugate's build cache instead of silently reusing a stale
// compiled artifact (see buildCppProvider's caching in engine/src/providerRuntime.cpp).
// Every declared output is marked setsValue in the resolved implementation's outputs[] (see
// resolveFmiSource below), so addGradient's value here is read by the engine as the state's
// algebraic value, not a derivative -- see this file's header comment.
#include <konjugate/relationshipProvider.hpp>
#include <konjugate/fmiDynamicLoad.hpp>

#include <memory>
#include <stdexcept>
#include <vector>

namespace {

using konjugate::fmi::Fmi3Api;
using konjugate::fmi::LoadedLibrary;

class ImportedFmu final : public konjugate::sdk::v1::NodeProvider {
public:
    ImportedFmu() : library_(${cppStringLiteral(binaryPath)}), api_(library_) {}

    ~ImportedFmu() override { teardown(); }

    konjugate::sdk::v1::NodeProviderDescription describe() const override {
        return {
            "fmi.${guid}", ${cppStringLiteral(description.modelName)},
            {
${inputPorts}
            },
            {
${outputPorts}
            }
        };
    }

    void initialize(const konjugate::sdk::v1::InitializationContext&) override {
        instance_ = api_.instantiateCoSimulation("konjugateImportedFmu", ${cppStringLiteral(guid)}, "",
            fmi3False, fmi3False, fmi3False, fmi3False, nullptr, 0, nullptr, nullptr, nullptr);
        if (!instance_) throw std::runtime_error("fmi3InstantiateCoSimulation failed for the imported FMU.");
        if (api_.enterInitializationMode(instance_, fmi3False, 0.0, 0.0, fmi3False, 0.0) != fmi3OK) {
            throw std::runtime_error("fmi3EnterInitializationMode failed for the imported FMU.");
        }
        if (api_.exitInitializationMode(instance_) != fmi3OK) throw std::runtime_error("fmi3ExitInitializationMode failed for the imported FMU.");
        initializedOk_ = true;
    }

    void evaluate(const konjugate::sdk::v1::EvaluationContext& context, konjugate::sdk::v1::NodeOutputCollector& outputs) override {
        if (!instance_) throw std::runtime_error("The imported FMU was evaluated before initialize().");
${inputBlock}
        fmi3Boolean eventEncountered = fmi3False;
        fmi3Boolean terminateSimulation = fmi3False;
        fmi3Boolean earlyReturn = fmi3False;
        fmi3Float64 lastSuccessfulTime = 0.0;
        // eventEncountered is not itself an error (a real dynamic FMU can legitimately signal a
        // discrete change) and Konjugate has no event-iteration mechanism to react with, so it is
        // deliberately not checked here. terminateSimulation and earlyReturn are: this driver
        // never grants early return (earlyReturnAllowed=false above), so either signals a real
        // problem worth surfacing rather than silently continuing on stale state.
        if (api_.doStep(instance_, context.simulationTime, context.stepSize, fmi3False,
                        &eventEncountered, &terminateSimulation, &earlyReturn, &lastSuccessfulTime) != fmi3OK) {
            throw std::runtime_error("fmi3DoStep failed for the imported FMU.");
        }
        if (terminateSimulation) throw std::runtime_error("The imported FMU requested termination during fmi3DoStep.");
        if (earlyReturn) throw std::runtime_error("The imported FMU returned early from fmi3DoStep, which this importer does not support.");
${outputBlock}    }

    std::vector<std::byte> checkpoint() const override {
        if (!instance_) throw std::runtime_error("The imported FMU was checkpointed before initialize().");
        fmi3FMUState state = nullptr;
        if (api_.getFMUState(instance_, &state) != fmi3OK) throw std::runtime_error("This imported FMU does not support checkpointing.");
        size_t size = 0;
        if (api_.serializedFMUStateSize(instance_, state, &size) != fmi3OK) {
            api_.freeFMUState(instance_, &state);
            throw std::runtime_error("fmi3SerializedFMUStateSize failed for the imported FMU.");
        }
        std::vector<std::byte> bytes(size);
        const auto status = api_.serializeFMUState(instance_, state, reinterpret_cast<fmi3Byte*>(bytes.data()), size);
        api_.freeFMUState(instance_, &state);
        if (status != fmi3OK) throw std::runtime_error("fmi3SerializeFMUState failed for the imported FMU.");
        return bytes;
    }

    void restore(std::span<const std::byte> payload) override {
        if (!instance_) throw std::runtime_error("The imported FMU was restored before initialize().");
        fmi3FMUState state = nullptr;
        if (api_.deserializeFMUState(instance_, reinterpret_cast<const fmi3Byte*>(payload.data()), payload.size(), &state) != fmi3OK) {
            throw std::runtime_error("fmi3DeserializeFMUState failed for the imported FMU.");
        }
        const auto status = api_.setFMUState(instance_, state);
        api_.freeFMUState(instance_, &state);
        if (status != fmi3OK) throw std::runtime_error("fmi3SetFMUState failed for the imported FMU.");
    }

    void shutdown() noexcept override { teardown(); }

private:
    void teardown() noexcept {
        if (instance_) {
            if (initializedOk_) api_.terminate(instance_);
            api_.freeInstance(instance_);
            instance_ = nullptr;
        }
    }

    LoadedLibrary library_;
    Fmi3Api api_;
    fmi3Instance instance_ = nullptr;
    bool initializedOk_ = false;
};

} // namespace

std::unique_ptr<konjugate::sdk::v1::NodeProvider> createNodeProvider() {
    return std::make_unique<ImportedFmu>();
}
`;
}

async function sha256OfFile(path) {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
}

// implementation is the node's raw `{kind:"fmi", fmuId, fmuVersion, bindings, outputs}` object.
// fmuDirectory is the packages root (parallel to pluginResolver.mjs's pluginDirectory) -- installed
// FMUs live under `${fmuDirectory}/fmus/<fmuId>/<fmuVersion>/`. Returns a resolved
// `{...implementation, kind:"cpp", providerApiVersion:1, source, bindings}` object; `outputs` is
// returned unchanged, since FMI import requires it to already name every FMU output exactly.
export async function resolveFmiSource(implementation, fmuDirectory, disabledFmuKeys = []) {
    if (!fmuDirectory) throw new FmiResolutionError('FMI import requires an installed FMU directory.', 'FMU_DIRECTORY_MISSING');
    const guid = implementation.fmuId;
    const version = implementation.fmuVersion;
    if (typeof guid !== 'string' || !guid || typeof version !== 'string' || !versionPattern.test(version)) {
        throw new FmiResolutionError('An fmi implementation requires fmuId and fmuVersion.', 'FMU_REFERENCE_INVALID');
    }
    if (disabledFmuKeys.includes(packageKey('fmu', guid, version))) {
        throw new FmiResolutionError(`FMU ${guid} is disabled. Enable it from Extensions before running this model.`, 'FMU_DISABLED');
    }

    const fmusRoot = resolve(fmuDirectory, 'fmus');
    const fmuRoot = resolve(fmusRoot, guid, version);
    if (!fmuRoot.startsWith(`${fmusRoot}${sep}`)) throw new FmiResolutionError('The FMU reference path is unsafe.', 'FMU_REFERENCE_INVALID');

    let xmlText;
    try {
        xmlText = await readFile(resolve(fmuRoot, 'modelDescription.xml'), 'utf8');
    } catch {
        throw new FmiResolutionError(`FMU ${guid} version ${version} is not installed.`, 'FMU_NOT_INSTALLED');
    }
    const description = parseModelDescription(xmlText);

    const platformBinaryPath = resolve(fmuRoot, 'binaries', platformDirectory(), `${description.modelIdentifier}${libraryExtension()}`);
    let contentHash;
    try {
        contentHash = await sha256OfFile(platformBinaryPath);
    } catch {
        throw new FmiResolutionError(
            `FMU ${guid} has no binary for this platform (${platformDirectory()}). Export or merge a build for this platform before using it here -- see "Merge platform FMUs" in the code export dialog.`,
            'FMU_PLATFORM_MISSING'
        );
    }

    const inputVariables = description.variables.filter((variable) => variable.causality === 'input' || variable.causality === 'parameter');
    const outputVariables = description.variables.filter((variable) => variable.causality === 'output');
    const inputKeys = keyByVariableName(inputVariables, 'input/parameter');
    const outputKeys = keyByVariableName(outputVariables, 'output');

    const bindings = Array.isArray(implementation.bindings) ? implementation.bindings : [];
    const boundKeys = new Set(bindings.map((binding) => binding.key));
    for (const variable of inputVariables) {
        const key = inputKeys.get(variable.name);
        if (!boundKeys.has(key)) {
            throw new FmiResolutionError(`FMU ${guid}'s input '${variable.name}' (binding key '${key}') has no binding.`, 'FMU_BINDING_MISSING');
        }
    }
    const validInputKeys = new Set(inputKeys.values());
    for (const binding of bindings) {
        if (!validInputKeys.has(binding.key)) {
            throw new FmiResolutionError(`Binding key '${binding.key}' does not name an input or parameter of FMU ${guid}.`, 'FMU_BINDING_UNKNOWN');
        }
    }

    const outputs = Array.isArray(implementation.outputs) ? implementation.outputs : [];
    const declaredOutputKeys = new Set(outputs.map((output) => output.key));
    for (const variable of outputVariables) {
        const key = outputKeys.get(variable.name);
        if (!declaredOutputKeys.has(key)) {
            throw new FmiResolutionError(`FMU ${guid}'s output '${variable.name}' (binding key '${key}') has no entry in outputs.`, 'FMU_OUTPUT_MISSING');
        }
    }
    const validOutputKeys = new Set(outputKeys.values());
    for (const output of outputs) {
        if (!validOutputKeys.has(output.key)) {
            throw new FmiResolutionError(`Output key '${output.key}' does not name an output of FMU ${guid}.`, 'FMU_OUTPUT_UNKNOWN');
        }
    }

    const generateGlue = description.fmiVersion.startsWith('3.') ? generateFmi3Glue : generateFmi2Glue;
    const source = generateGlue({ description, binaryPath: platformBinaryPath, guid, version, contentHash, inputKeys, outputKeys });

    // Every FMU output is algebraic (see the file header comment), so this resolver marks each one
    // setsValue itself rather than requiring the user to author that -- an FMU import couldn't
    // mean anything else.
    const setsValueOutputs = outputs.map((output) => ({ ...output, setsValue: true }));

    return {
        ...implementation,
        kind: 'cpp',
        providerApiVersion: 1,
        source,
        bindings,
        outputs: setsValueOutputs
    };
}

// The document-walk counterpart to pluginResolver.mjs's resolveInstalledPlugins, scoped to node
// implementations only -- `kind: "fmi"` is only ever valid there (see docs/projectSchema.md), not
// on an edge or source term. Kept as its own pass rather than folded into resolveInstalledPlugins
// (a different storage layout, a different resolver, the same "resolve before validate" shape);
// src/engineAdapter.mjs runs both passes before every validate/run.
export async function resolveInstalledFmus(content, { fmuDirectory, disabledFmuKeys = [] } = {}) {
    const document = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
    let changed = false;
    for (const node of document.nodes ?? []) {
        if (node.implementation?.kind !== 'fmi') continue;
        changed = true;
        node.implementation = await resolveFmiSource(node.implementation, fmuDirectory, disabledFmuKeys);
    }
    return changed ? JSON.stringify(document) : (typeof content === 'string' ? content : JSON.stringify(document));
}
