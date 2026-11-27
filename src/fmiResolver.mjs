/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Resolves a node's `kind: "fmi"` implementation (see docs/projectSchema.md) into an ordinary
// `kind: "cpp"` computational-node-provider implementation, exactly like src/pluginResolver.mjs
// turns `kind: "plugin"` into `kind: "cpp"`/`"python"` before the engine ever sees the document --
// the engine itself has zero FMI-specific knowledge. The generated C++ source is the FMU's variable
// table handed to konjugate/fmiImportedNode.hpp's driver, a konjugate::sdk::v1::NodeProvider that
// dlopen()s the FMU's binary for this machine (src/fmiBinary.mjs chooses it) at runtime and runs
// it in Co-Simulation through the real FMI 2.0 or 3.0 C API (konjugate/fmiDynamicLoad.hpp), then runs
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
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseModelDescription } from './fmiModelDescription.mjs';
import { chooseInstalledFmuBinary, describeChosenBinary } from './fmiBinary.mjs';
import { fmuAttachmentsRequirement, fmuStartValuesRequirement } from './nodeProgram.mjs';
import { contentForEngine } from './components.mjs';
import { installedFmuArchive } from './fmuPackage.mjs';
import { currentBuildFor, installedBuildInformation } from './fmuBuilds.mjs';

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

// Each FMI type as the driver's konjugate::fmi::ValueType (engine/include/konjugate/fmiImportedNode.hpp).
const cppValueTypes = {
    Real: 'float64', Integer: 'int32', Boolean: 'boolean', Enumeration: 'enumeration',
    Float64: 'float64', Float32: 'float32', Int8: 'int8', UInt8: 'uint8', Int16: 'int16', UInt16: 'uint16',
    Int32: 'int32', UInt32: 'uint32', Int64: 'int64', UInt64: 'uint64'
};

// How the driver treats a variable: an input is set before every step; a fixed parameter only in initialization mode;
// a tunable one there and whenever its value changes between steps. A parameter that does not say it is tunable is
// fixed, as the standard has it.
function variableRole(variable) {
    if (variable.causality === 'output') return 'output';
    if (variable.causality === 'input') return 'input';
    return variable.variability === 'tunable' ? 'tunableParameter' : 'fixedParameter';
}

// The FMU's resources directory as its FMI version asks for it at instantiation: FMI 2.0 a file: URI, FMI 3.0 an
// absolute path ending in a separator (the Reference FMUs refuse one without), or none (null) when the FMU has no
// resources directory. FMI 2.0's URI is given either way, as FMPy gives it.
async function resourceLocation(fmuRoot, fmiVersion) {
    const directory = resolve(fmuRoot, 'resources');
    if (!fmiVersion.startsWith('3.')) return pathToFileURL(directory).href;
    const exists = await stat(directory).then((entry) => entry.isDirectory(), () => false);
    return exists ? `${directory}${sep}` : '';
}

// The generated source: the FMU's variable table handed to the shared driver, makeImportedFmu2 or makeImportedFmu3
// (engine/include/konjugate/fmiImportedNode.hpp), which runs it as the FMI standard orders.
// boundInputs: the inputs and parameters the node binds to a state or a shared parameter, which the driver sets from the
// node's inputs; givenValues: [{ variable, value }] for those given a value in the file, set once when the run starts. Every
// other input and parameter is left out, so the FMU keeps its own start value for it. A node that binds every input writes
// the same source as before start values were supported (docs/proposals/fmuImportWorkflow.md, stage 2).
function generateGlue({ description, binaryPath, binaryRelativePath, resources, guid, version, contentHash, inputKeys, outputKeys, boundInputs, givenValues }) {
    const outputVariables = description.variables.filter((variable) => variable.causality === 'output');
    const fmi3 = description.fmiVersion.startsWith('3.');
    const variable = (entry, key) => `{${cppStringLiteral(key)}, ${cppStringLiteral(entry.name)}, ${entry.valueReference}u, ValueType::${cppValueTypes[entry.type] ?? 'float64'}, Role::${variableRole(entry)}}`;
    const row = (entry, key) => `        ${variable(entry, key)}`;
    const rows = [
        ...boundInputs.map((entry) => row(entry, inputKeys.get(entry.name))),
        ...outputVariables.map((entry) => row(entry, outputKeys.get(entry.name)))
    ];
    // A number as C++ reads it back exactly: JavaScript's shortest round-trip text is a valid C++ double literal.
    const valueRows = givenValues.map(({ variable: entry, value }) => `        {${variable(entry, inputKeys.get(entry.name))}, ${/[.eE]/.test(String(value)) ? String(value) : `${value}.0`}}`);
    return `// Generated by src/fmiResolver.mjs for the imported FMU ${cppStringLiteral(description.modelName)}
// (guid ${cppStringLiteral(guid)}, version ${cppStringLiteral(version)}, FMI ${description.fmiVersion}, Co-Simulation),
// running ${cppStringLiteral(binaryRelativePath)}.
// Content hash ${cppStringLiteral(contentHash)} -- embedded only so replacing the installed FMU's
// binary in place invalidates Konjugate's build cache instead of silently reusing a stale
// compiled artifact (see buildCppProvider's caching in engine/src/providerRuntime.cpp).
// Every declared output is marked setsValue in the resolved implementation's outputs[] (see
// resolveFmiSource below), so the value the driver reports is read by the engine as the state's
// algebraic value, not a derivative -- see this file's header comment.
#include <konjugate/fmiImportedNode.hpp>

std::unique_ptr<konjugate::sdk::v1::NodeProvider> createNodeProvider() {
    using konjugate::fmi::Role;
    using konjugate::fmi::ValueType;
    return konjugate::fmi::${fmi3 ? 'makeImportedFmu3' : 'makeImportedFmu2'}({
        ${cppStringLiteral(`fmi.${guid}`)}, ${cppStringLiteral(description.modelName)}, ${cppStringLiteral(guid)},
        ${cppStringLiteral(binaryPath)},
        ${cppStringLiteral(resources)},
        {
${rows.join(',\n')}
        }${valueRows.length ? `,
        {
${valueRows.join(',\n')}
        }` : ''}
    });
}
`;
}

// implementation is the node's raw `{kind:"fmi", fmuId, fmuVersion, bindings, outputs}` object.
// fmuDirectory is the packages root (parallel to pluginResolver.mjs's pluginDirectory) -- installed
// FMUs live under `${fmuDirectory}/fmus/<fmuId>/<fmuVersion>/`. Returns a resolved
// `{...implementation, kind:"cpp", providerApiVersion:1, source, bindings}` object; `outputs` is
// returned unchanged, since FMI import requires it to already name every FMU output exactly.
// An FMU is not switched off on its own (its node is): a list of disabled FMUs an older caller passes is not read.
export async function resolveFmiSource(implementation, fmuDirectory) {
    if (!fmuDirectory) throw new FmiResolutionError('FMI import requires an installed FMU directory.', 'FMU_DIRECTORY_MISSING');
    const guid = implementation.fmuId;
    const version = implementation.fmuVersion;
    if (typeof guid !== 'string' || !guid || typeof version !== 'string' || !versionPattern.test(version)) {
        throw new FmiResolutionError('An fmi implementation requires fmuId and fmuVersion.', 'FMU_REFERENCE_INVALID');
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
    if (description.coSimulation?.needsExecutionTool) {
        throw new FmiResolutionError(
            `FMU ${description.modelName} needs the tool it was exported from installed and running beside it (needsExecutionTool), which Konjugate cannot start; export it from that tool as a standalone FMU.`,
            'FMU_NEEDS_TOOL'
        );
    }

    let chosen = await chooseInstalledFmuBinary(fmuRoot, description);
    let platformBinaryPath = chosen.error ? null : resolve(fmuRoot, ...chosen.relativePath.split('/'));
    // Built from its sources on request, it runs in place of its own binary until Use its own binary (stage 5).
    const preferred = chosen.error ? null : await currentBuildFor(fmuDirectory, await installedArchiveSha256(fmuRoot), undefined, { preferredOnly: true });
    if (preferred) {
        chosen = { relativePath: `fmuBuilds/${preferred.record.key}/${preferred.record.library}`, bytes: preferred.library };
        platformBinaryPath = preferred.libraryPath;
    } else if (chosen.error) {
        // Built here from its sources (docs/proposals/sourceFmuImport.md, stage 3): the build kept on this computer for its archive,
        // checked against its SHA-256. The project and the installed FMU stay as they came.
        const built = await currentBuildFor(fmuDirectory, await installedArchiveSha256(fmuRoot));
        if (built) {
            chosen = { relativePath: `fmuBuilds/${built.record.key}/${built.record.library}`, bytes: built.library };
            platformBinaryPath = built.libraryPath;
        } else if (await installedBuildInformation(fmuRoot, description)) {
            throw new FmiResolutionError(
                `FMU ${description.modelName} needs to be built from its sources on this computer: ${chosen.error}. Run the model to be asked, or press Build from its sources on its card.`,
                'FMU_NEEDS_BUILD'
            );
        } else {
            throw new FmiResolutionError(
                `FMU ${description.modelName} (${guid}) cannot run here: ${chosen.error}. Export or merge a build for this platform before using it here -- see "Merge platform FMUs" in the code export dialog.`,
                'FMU_PLATFORM_MISSING'
            );
        }
    }
    const contentHash = createHash('sha256').update(chosen.bytes).digest('hex');

    const inputVariables = description.variables.filter((variable) => variable.causality === 'input' || variable.causality === 'parameter');
    const outputVariables = description.variables.filter((variable) => variable.causality === 'output');
    const inputKeys = keyByVariableName(inputVariables, 'input/parameter');
    const outputKeys = keyByVariableName(outputVariables, 'output');

    // Each input or parameter is bound to a state or a shared parameter (the driver sets it from them), given a value of its
    // own (`kind: "value"`, set once when the run starts), or left out, when the FMU keeps its own start value for it.
    const bindings = Array.isArray(implementation.bindings) ? implementation.bindings : [];
    const validInputKeys = new Set(inputKeys.values());
    const bindingByKey = new Map();
    for (const binding of bindings) {
        if (!validInputKeys.has(binding.key)) {
            throw new FmiResolutionError(`Binding key '${binding.key}' does not name an input or parameter of FMU ${guid}.`, 'FMU_BINDING_UNKNOWN');
        }
        if (bindingByKey.has(binding.key)) throw new FmiResolutionError(`FMU ${guid}'s binding key '${binding.key}' is bound twice.`, 'FMU_BINDING_DUPLICATE');
        bindingByKey.set(binding.key, binding);
    }
    const boundInputs = [];
    const givenValues = [];
    for (const variable of inputVariables) {
        const binding = bindingByKey.get(inputKeys.get(variable.name));
        if (binding?.kind === 'value') {
            if (typeof binding.value !== 'number' || !Number.isFinite(binding.value)) {
                throw new FmiResolutionError(`FMU ${description.modelName}'s ${variable.causality} '${variable.name}' is given ${JSON.stringify(binding.value)}, which is not a number.`, 'FMU_VALUE_INVALID');
            }
            givenValues.push({ variable, value: binding.value });
        } else if (binding) {
            boundInputs.push(variable);
        } else if (variable.start === undefined || !Number.isFinite(variable.start)) {
            throw new FmiResolutionError(`FMU ${description.modelName}'s ${variable.causality} '${variable.name}' has no start value of its own, so it must be given one or bound.`, 'FMU_BINDING_MISSING');
        }
    }
    const engineBindings = bindings.filter((binding) => binding.kind !== 'value');

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

    const source = generateGlue({
        description, binaryPath: platformBinaryPath, binaryRelativePath: chosen.relativePath,
        resources: await resourceLocation(fmuRoot, description.fmiVersion), guid, version, contentHash, inputKeys, outputKeys, boundInputs, givenValues
    });

    // Every FMU output is algebraic (see the file header comment), so this resolver marks each one
    // setsValue itself rather than requiring the user to author that -- an FMU import couldn't
    // mean anything else.
    const setsValueOutputs = outputs.map((output) => ({ ...output, setsValue: true }));

    return {
        ...implementation,
        kind: 'cpp',
        providerApiVersion: 1,
        source,
        bindings: engineBindings,
        outputs: setsValueOutputs
    };
}

// What a variable says of itself, for the node's card: its start value, unit, description and bounds, where it says them.
function variableExtras(variable) {
    return Object.fromEntries(['start', 'unit', 'description', 'min', 'max'].filter((name) => variable[name] !== undefined).map((name) => [name, variable[name]]));
}

// The binaries an installed FMU carries, by its binaries/ directory names.
async function installedPlatforms(fmuRoot) {
    const entries = await readdir(resolve(fmuRoot, 'binaries'), { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

// The installed FMU's archive, as a project keeps it (stage 8): its SHA-256 and size.
async function archiveFacts(fmuDirectory, guid, version) {
    const archive = await installedFmuArchive(fmuDirectory, guid, version).catch(() => null);
    return archive ? { archiveSha256: archive.sha256, archiveBytes: archive.buffer.length } : {};
}

// The SHA-256 of the archive an FMU was installed from (its fmuMeta.json, or its archive.fmu for an older install).
async function installedArchiveSha256(fmuRoot) {
    const meta = JSON.parse(await readFile(resolve(fmuRoot, 'fmuMeta.json'), 'utf8').catch(() => '{}'));
    if (meta.archiveSha256) return meta.archiveSha256;
    const archive = await readFile(resolve(fmuRoot, 'archive.fmu')).catch(() => null);
    return archive ? createHash('sha256').update(archive).digest('hex') : null;
}

// What an installed FMU says about building it from its sources, for About this FMU: without the configuration's file lists. Null when
// it says nothing.
async function installedBuildSummary(fmuRoot, description) {
    const build = await installedBuildInformation(fmuRoot, description);
    if (!build) return null;
    const { configuration, ...summary } = build;
    return summary;
}

// The card's "About this FMU" (docs/proposals/fmuImportWorkflow.md, stage 3): what the FMU says of itself and how it runs here.
function fmuAbout(description, platforms, chosen, build = null, built = null) {
    return Object.fromEntries(Object.entries({
        modelName: description.modelName,
        fmiVersion: description.fmiVersion,
        description: description.description,
        author: description.author,
        version: description.version,
        copyright: description.copyright,
        license: description.license,
        generationTool: description.generationTool,
        generationDateAndTime: description.generationDateAndTime,
        defaultExperiment: description.defaultExperiment,
        coSimulation: description.coSimulation,
        canGetAndSetFMUState: description.canGetAndSetFMUState,
        platforms,
        runsHere: !chosen.error || Boolean(built),
        build: build ?? undefined,
        // Built here from its sources (stage 3): with which compiler and when, for About this FMU.
        built: built ? { banner: built.record.banner, builtAt: built.record.builtAt, recipe: built.record.recipe?.name ?? null } : undefined,
        hasOwnBinary: !chosen.error
    }).filter(([, value]) => value !== undefined));
}

// An installed FMU's ports as a node's implementation names them: each input or parameter, which the node must bind
// to a state or a shared parameter, and each output, which sets a state of the node. For the canvas, so a user can wire
// an FMU into a node without writing the keys by hand, and to say how it runs here. Returns { name, fmiVersion,
// inputs: [{ key, name, causality, type, variability }], outputs: [{ key, name, type }], notExposed: [{ name, causality,
// type }], binary } -- binary the sentence describeChosenBinary gives (which file runs, or why none can).
export async function describeInstalledFmuPorts(fmuDirectory, guid, version) {
    if (!fmuDirectory) throw new FmiResolutionError('FMI import requires an installed FMU directory.', 'FMU_DIRECTORY_MISSING');
    if (typeof guid !== 'string' || !guid || typeof version !== 'string' || !versionPattern.test(version)) {
        throw new FmiResolutionError('An FMU is named by its fmuId and fmuVersion.', 'FMU_REFERENCE_INVALID');
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
    const inputVariables = description.variables.filter((variable) => variable.causality === 'input' || variable.causality === 'parameter');
    const outputVariables = description.variables.filter((variable) => variable.causality === 'output');
    const inputKeys = keyByVariableName(inputVariables, 'input/parameter');
    const outputKeys = keyByVariableName(outputVariables, 'output');
    const chosen = await chooseInstalledFmuBinary(fmuRoot, description);
    const archiveSha256 = await installedArchiveSha256(fmuRoot);
    const kept = await currentBuildFor(fmuDirectory, archiveSha256);
    // The build that runs: the only way it runs with no binary of its own, else the one the person chose (stage 5).
    const built = kept && (chosen.error || kept.preferred) ? kept : null;
    return {
        name: description.modelName, fmiVersion: description.fmiVersion,
        inputs: inputVariables.map((variable) => ({
            key: inputKeys.get(variable.name), name: variable.name, causality: variable.causality, type: variable.type, variability: variable.variability,
            ...variableExtras(variable)
        })),
        outputs: outputVariables.map((variable) => ({ key: outputKeys.get(variable.name), name: variable.name, type: variable.type, ...variableExtras(variable) })),
        notExposed: description.notExposed,
        binary: built ? `Runs the build of its sources made on this computer (${built.record.library})${chosen.error ? '' : ', in place of its own binary'}.` : describeChosenBinary(chosen, description.fmiVersion),
        about: {
            ...fmuAbout(description, await installedPlatforms(fmuRoot), chosen, await installedBuildSummary(fmuRoot, description), built),
            ...(kept ? { buildKept: true } : {}),
            ...await archiveFacts(fmuDirectory, guid, version)
        }
    };
}

// The document-walk counterpart to pluginResolver.mjs's resolveInstalledPlugins, scoped to node
// implementations only -- `kind: "fmi"` is only ever valid there (see docs/projectSchema.md), not
// on an edge or source term. Kept as its own pass rather than folded into resolveInstalledPlugins
// (a different storage layout, a different resolver, the same "resolve before validate" shape);
// src/engineAdapter.mjs runs both passes before every validate/run.
export async function resolveInstalledFmus(content, { fmuDirectory } = {}) {
    // An in port's test signal is the host's too, applied before anything else (docs/proposals/rootPorts.md, stage 6).
    content = contentForEngine(content);
    const document = typeof content === 'string' ? JSON.parse(content) : structuredClone(content);
    let changed = false;
    // An FMU that may be loaded only once in a process (canBeInstantiatedOnlyOncePerProcess) cannot be two nodes: refused, naming them.
    const byFmu = new Map();
    // A switched-off node is not run (FMI review #5): its FMU is not looked for, so one missing from this library does not stop the model,
    // and it is not a second instance. It reaches the engine without its FMU, as a node whose states nothing sets, switched off.
    for (const node of document.nodes ?? []) {
        if (node.enabled !== false || node.implementation?.kind !== 'fmi') continue;
        delete node.implementation;
        changed = true;
    }
    for (const node of document.nodes ?? []) {
        if (node.implementation?.kind !== 'fmi' || typeof node.implementation.fmuId !== 'string') continue;
        const key = `${node.implementation.fmuId}@${node.implementation.fmuVersion}`;
        byFmu.set(key, [...(byFmu.get(key) ?? []), node]);
    }
    for (const nodes of byFmu.values()) {
        if (nodes.length < 2 || !fmuDirectory) continue;
        const { fmuId, fmuVersion } = nodes[0].implementation;
        const fmusRoot = resolve(fmuDirectory, 'fmus');
        const fmuRoot = resolve(fmusRoot, fmuId, fmuVersion);
        if (!fmuRoot.startsWith(`${fmusRoot}${sep}`)) continue;
        const xmlText = await readFile(resolve(fmuRoot, 'modelDescription.xml'), 'utf8').catch(() => null);
        const description = xmlText ? parseModelDescription(xmlText) : null;
        if (description?.coSimulation?.canBeInstantiatedOnlyOncePerProcess) {
            throw new FmiResolutionError(
                `FMU ${description.modelName} can run only once at a time (canBeInstantiatedOnlyOncePerProcess), but ${nodes.length} nodes use it: ${nodes.map((node) => `'${node.name ?? node.id}'`).join(', ')}. Keep one of them.`,
                'FMU_ONCE_PER_PROCESS'
            );
        }
    }
    for (const node of document.nodes ?? []) {
        if (node.implementation?.kind !== 'fmi') continue;
        changed = true;
        node.implementation = await resolveFmiSource(node.implementation, fmuDirectory);
    }
    // Start values are the host's to apply, here: the engine never sees the requirement (src/nodeProgram.mjs).
    // So are the FMUs a project keeps (stage 8): installed in the library when the project was opened.
    const handled = new Set([fmuStartValuesRequirement, fmuAttachmentsRequirement]);
    if (Array.isArray(document.requires) && document.requires.some((entry) => handled.has(entry))) {
        changed = true;
        document.requires = document.requires.filter((entry) => !handled.has(entry));
        if (!document.requires.length) delete document.requires;
    }
    return changed ? JSON.stringify(document) : (typeof content === 'string' ? content : JSON.stringify(document));
}
