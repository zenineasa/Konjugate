/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Orchestrates a Konjugate model's export as a real, compiled FMI 2.0 or FMI 3.0 Co-Simulation FMU:
// generates the model's C++ source and modelDescription.xml (src/fmiCodeGen.mjs plus the XML
// builders below), asks the engine binary to compile it into a shared library (its generic
// `buildSharedLibrary` command -- see engine/src/main.cpp -- linked against engine/src/fmiGlue.cpp
// or engine/src/fmi3Glue.cpp, the FMI C API implementations), and zips the result into one .fmu (fflate's zipSync, the same library already
// used for .kja/.kjp packages in src/packageArchive.mjs). See docs/codeExport.md.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { binaryDirectoryCandidates } from './fmiBinary.mjs';
import { generateFmiModel } from './fmiCodeGen.mjs';
import { fmiAttributes } from './ownership.mjs';
import { cppProviderSdkPath, resolveEnginePath, runEngine } from './engineAdapter.mjs';

function escapeXml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// An output, and a local (a state a model with ports offers to be observed, docs/proposals/rootPorts.md), starts exactly at its value.
const exactStart = (variable) => variable.causality === 'output' || variable.causality === 'local';
// The variables in value reference order: a model without ports has its states then its parameters, already in that order.
const inValueReferenceOrder = (variables) => [...variables].sort((a, b) => a.valueReference - b.valueReference);

function scalarVariablesXml(variables) {
    // causality="output" defaults to initial="calculated", which the standard forbids from
    // carrying a start value -- confirmed against a real validator (FMPy), not assumed.
    // causality="input"/"parameter" variables carry no initial attribute at all (the standard
    // forbids that combination too); their start is just their default before a host ever calls
    // fmi2SetReal. Units aren't emitted: Konjugate's own unit strings are free-form author text,
    // not the SI-exponent decomposition FMI's <UnitDefinitions> requires a referenced unit name to
    // resolve to -- declaring them properly is a real, separate scope item, not something to
    // fake with an undeclared unit= attribute (which a validator correctly rejects).
    return variables.map((variable) => (
        `        <ScalarVariable name="${escapeXml(variable.name)}" valueReference="${variable.valueReference}" causality="${variable.causality}" variability="${variable.variability}"${exactStart(variable) ? ' initial="exact"' : ''}>\n`
        + `            <Real start="${variable.start}"/>\n`
        + `        </ScalarVariable>`
    )).join('\n');
}

// The FMI versions an export can be made for; FMI 2.0 is the default, as the export dialog offers it first.
export const fmiVersions = ['2.0', '3.0'];

function checkedFmiVersion(fmiVersion) {
    if (!fmiVersions.includes(fmiVersion)) throw new Error(`Konjugate exports FMI 2.0 or FMI 3.0 FMUs, not FMI ${fmiVersion}.`);
    return fmiVersion;
}

// Platform directory naming follows each FMI standard's own convention. FMI 2.0's (win32/win64/
// linux32/linux64/darwin32/darwin64) predates Apple Silicon, so arm64 is folded into the 64-bit
// bucket like most real-world FMU exporters do, rather than inventing a nonstandard directory name.
// FMI 3.0 names a platform tuple, architecture then operating system (aarch64-darwin, x86_64-linux,
// x86_64-windows, ...; FMI 3.0 section 2.5.1.4), as src/fmiBinary.mjs reads it on import.
export function platformDirectory(fmiVersion = '2.0') {
    if (fmiVersion === '3.0') return binaryDirectoryCandidates('3.0')[0];
    const bitness = process.arch === 'x86' || process.arch === 'ia32' ? '32' : '64';
    if (process.platform === 'win32') return `win${bitness}`;
    if (process.platform === 'darwin') return `darwin${bitness}`;
    return `linux${bitness}`;
}

export function libraryExtension() {
    if (process.platform === 'win32') return '.dll';
    if (process.platform === 'darwin') return '.dylib';
    return '.so';
}

// Deterministic, not random: two exports of the identical document (generated C++ is
// platform-independent -- fmiCodeGen.mjs never branches on process.platform/arch) must land on the
// same GUID no matter which machine or platform runs the export, since that's exactly what lets
// mergeFmuPackages() below verify that a set of single-platform .fmu files are genuinely exports of
// the same model before combining their binaries into one multi-platform .fmu. Formatted to look
// like the RFC4122 GUIDs FMI tooling expects, but derived from a SHA-256 of the model's own
// identity rather than randomUUID().
// An FMI 3.0 export's instantiationToken is made the same way from its own source (which differs from
// the FMI 2.0 one by the constants appended below), so the two exports of a model never share an
// identity: Konjugate's own FMU installs are keyed by it.
function deterministicGuid(modelIdentifier, source) {
    const digest = createHash('sha256').update(modelIdentifier).update('\n').update(source).digest('hex');
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

// The run a host starts with (FMI 2.0 section 2.2.5, FMI 3.0.2 section 2.4.5): from 0, to the run's end when the export knows it,
// in communication steps of the model's output interval (a whole number of its global step, so every step is one the FMU takes
// as the engine does, and a host's samples are Konjugate's). docs/proposals/fmuImportWorkflow.md, stage 7.
function defaultExperimentXml(defaultExperiment) {
    if (!defaultExperiment) return '';
    const attributes = [['startTime', defaultExperiment.startTime], ['stopTime', defaultExperiment.stopTime], ['stepSize', defaultExperiment.stepSize]]
        .filter(([, value]) => Number.isFinite(value)).map(([name, value]) => ` ${name}="${value}"`).join('');
    return `    <DefaultExperiment${attributes}/>\n`;
}

export function modelDescriptionXml({ modelName, guid, modelIdentifier, stateVariables, parameterVariables, supportsStateCapture, ownership = null, defaultExperiment = null }) {
    const rollback = supportsStateCapture ? 'true' : 'false';
    // The project's author, copyright and license (docs/proposals/modelOwnership.md), as the attributes FMI has for exactly these.
    const rights = Object.entries(fmiAttributes(ownership)).map(([name, value]) => ` ${name}="${escapeXml(value.replace(/[\r\n]+/g, ' '))}"`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="2.0" modelName="${escapeXml(modelName)}" guid="${guid}"${rights} generationTool="Konjugate">
    <CoSimulation modelIdentifier="${escapeXml(modelIdentifier)}" canHandleVariableCommunicationStepSize="true"
        canGetAndSetFMUstate="${rollback}" canSerializeFMUstate="${rollback}" providesDirectionalDerivative="false"/>
${defaultExperimentXml(defaultExperiment)}    <ModelVariables>
${scalarVariablesXml(inValueReferenceOrder([...stateVariables, ...parameterVariables]))}
    </ModelVariables>
    <ModelStructure>
        <Outputs>
${inValueReferenceOrder([...stateVariables, ...parameterVariables]).map((variable, index) => (variable.causality === 'output' ? `            <Unknown index="${index + 1}"/>` : null)).filter(Boolean).join('\n')}
        </Outputs>
    </ModelStructure>
</fmiModelDescription>
`;
}

// FMI 3.0 (FMI 3.0 section 2.4): the variables are typed elements (<Float64>) rather than FMI 2.0's
// <ScalarVariable><Real/>, with the same causality, variability, initial and start as the FMI 2.0
// export writes, and the same value references. FMI 3.0 also asks for exactly one independent
// variable (section 2.4.7.4), "time", which takes the value reference after the model's last one so
// every other value reference stays the FMI 2.0 export's. Units are declared: FMI 3.0's <Unit> needs
// only a name (its <BaseUnit> SI decomposition is optional, section 2.4.3), so each of the model's
// unit strings is declared as written, and the variables refer to it.
function float64VariablesXml(variables) {
    return variables.map((variable) => (
        `        <Float64 name="${escapeXml(variable.name)}" valueReference="${variable.valueReference}" causality="${variable.causality}" variability="${variable.variability}"`
        + `${exactStart(variable) ? ' initial="exact"' : ''}${variable.unit ? ` unit="${escapeXml(variable.unit)}"` : ''} start="${variable.start}"/>`
    )).join('\n');
}

export function modelDescription3Xml({
    modelName, instantiationToken, modelIdentifier, stateVariables, parameterVariables, supportsStateCapture, globalTimeStep, timeValueReference, ownership = null,
    defaultExperiment = null
}) {
    const rollback = supportsStateCapture ? 'true' : 'false';
    const rights = Object.entries(fmiAttributes(ownership)).map(([name, value]) => ` ${name}="${escapeXml(value.replace(/[\r\n]+/g, ' '))}"`).join('');
    const variables = inValueReferenceOrder([...stateVariables, ...parameterVariables]);
    const units = [...new Set(['s', ...variables.map((variable) => variable.unit).filter(Boolean)])];
    // No Event Mode, no early return, no intermediate update: fmi3DoStep (engine/src/fmi3Glue.cpp)
    // always takes the whole communication step (FMI 3.0 section 4.2). fixedInternalStepSize is the
    // model's global step, of which a communication step must be a whole number. The outputs are the
    // states, each with initial="exact" as in the FMI 2.0 export, so none is an <InitialUnknown>
    // (FMI 3.0 section 2.4.8: those are the outputs with initial "approx" or "calculated").
    return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="3.0" modelName="${escapeXml(modelName)}" instantiationToken="${instantiationToken}"${rights} generationTool="Konjugate">
    <CoSimulation modelIdentifier="${escapeXml(modelIdentifier)}" canHandleVariableCommunicationStepSize="true" fixedInternalStepSize="${globalTimeStep}"
        canGetAndSetFMUState="${rollback}" canSerializeFMUState="${rollback}" providesDirectionalDerivatives="false" providesAdjointDerivatives="false"
        hasEventMode="false" mightReturnEarlyFromDoStep="false" canReturnEarlyAfterIntermediateUpdate="false" providesIntermediateUpdate="false"/>
    <UnitDefinitions>
${units.map((unit) => `        <Unit name="${escapeXml(unit)}"/>`).join('\n')}
    </UnitDefinitions>
    <LogCategories>
        <Category name="logStatusError" description="A call the FMU refuses, and why."/>
    </LogCategories>
${defaultExperimentXml(defaultExperiment)}    <ModelVariables>
        <Float64 name="time" valueReference="${timeValueReference}" causality="independent" variability="continuous" unit="s" description="Simulation time"/>
${float64VariablesXml(variables)}
    </ModelVariables>
    <ModelStructure>
${variables.filter((variable) => variable.causality === 'output').map((variable) => `        <Output valueReference="${variable.valueReference}"/>`).join('\n')}
    </ModelStructure>
</fmiModelDescription>
`;
}

// What an FMI 3.0 export adds to the model's source: the constants engine/src/fmi3Glue.cpp reads.
function fmi3IdentitySource({ instantiationToken, timeValueReference, outputCount }) {
    return [
        '',
        '// FMI 3.0 identity, read by engine/src/fmi3Glue.cpp.',
        'namespace konjugate::sdk::v1 {',
        `extern const char* const fmi3InstantiationToken = "${instantiationToken}";`,
        `extern const unsigned int fmi3TimeValueReference = ${timeValueReference};`,
        `extern const unsigned int fmi3OutputCount = ${outputCount};`,
        '}',
        ''
    ].join('\n');
}

// The FMI 2.0 identity, appended to the source as FMI 3.0's is: fmi2Instantiate refuses another GUID (FMI review M1). The GUID is the
// hash of the source without it, as before, so the modelDescription.xml an export writes is unchanged.
function fmi2IdentitySource(guid) {
    return ['', '// FMI 2.0 identity, read by engine/src/fmiGlue.cpp.', 'namespace konjugate::sdk::v1 {', `extern const char* const fmi2Guid = "${guid}";`, '}', ''].join('\n');
}

// The model's C++ source, its modelIdentifier and its modelDescription.xml, as an export writes them: pure JS, no compiler, so a
// test can check an FMU made earlier against what the exporter writes now (tests/fmiExamples.test.mjs).
// fmiVersion is '2.0' (the default) or '3.0'; the model and its value references are the same for both.
// `fmuInterface` (src/fmuInterface.mjs) is the interface a project with ports declares; without it, every state is an output, as before.
export function describeFmu(document, modelName, { fmiVersion = '2.0', stopTime = null, fmuInterface = null } = {}) {
    checkedFmiVersion(fmiVersion);
    const { source, stateVariables, parameterVariables, supportsStateCapture, globalTimeStep, outputCount } = generateFmiModel(document, { fmuInterface });
    // The output interval the model's active run configuration records at, else its global step; and the run's end when known.
    const runConfiguration = (document.runConfigurations ?? []).find((item) => item.id === document.activeRunConfigurationId) ?? document.runConfigurations?.[0];
    const stepSize = Number.isFinite(runConfiguration?.outputInterval) && runConfiguration.outputInterval > 0 ? runConfiguration.outputInterval : globalTimeStep;
    const defaultExperiment = { startTime: 0, stopTime: Number.isFinite(stopTime) && stopTime > 0 ? stopTime : undefined, stepSize };
    const modelIdentifier = (modelName || 'model').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_');
    if (fmiVersion === '3.0') {
        const timeValueReference = stateVariables.length + parameterVariables.length;
        const identity = { timeValueReference, outputCount };
        const instantiationToken = `{${deterministicGuid(modelIdentifier, `${source}${fmi3IdentitySource({ ...identity, instantiationToken: '' })}`)}}`;
        const fmi3Source = `${source}${fmi3IdentitySource({ ...identity, instantiationToken })}`;
        const xml = modelDescription3Xml({
            modelName: modelName || 'model', instantiationToken, modelIdentifier, stateVariables, parameterVariables, supportsStateCapture,
            globalTimeStep, timeValueReference, ownership: document.ownership, defaultExperiment
        });
        return { source: fmi3Source, modelSource: source, modelIdentifier, xml, fmiVersion };
    }
    const guid = deterministicGuid(modelIdentifier, source);
    const xml = modelDescriptionXml({
        modelName: modelName || 'model', guid, modelIdentifier, stateVariables, parameterVariables, supportsStateCapture, ownership: document.ownership,
        defaultExperiment
    });
    // `modelSource`: the model before either version's identity, the same for FMI 2.0 and 3.0.
    return { source: `${source}${fmi2IdentitySource(guid)}`, modelSource: source, modelIdentifier, xml, fmiVersion };
}

// document must already be flattened (stripEdgeGroups(executionProjectDocument(...))), matching
// every other codeExport.mjs/fmiCodeGen.mjs entry point. engineOptions is the same
// {applicationPath, resourcesPath, packaged} shape resolveEnginePath()/cppProviderSdkPath() take
// elsewhere. fmiVersion is '2.0' (the default) or '3.0'. Returns a Buffer -- the finished .fmu file's bytes.
export async function generateFmuPackage(document, { modelName, engineOptions, fmiVersion = '2.0', stopTime = null, fmuInterface = null }) {
    const executable = await resolveEnginePath(engineOptions);
    if (!executable) throw new Error('The Konjugate engine binary could not be found -- FMU export needs it to compile the generated model.');

    const { source, modelIdentifier, xml } = describeFmu(document, modelName, { fmiVersion, stopTime, fmuInterface });
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuExport-'));
    try {
        const sourcePath = join(directory, 'model.cpp');
        await writeFile(sourcePath, source, 'utf8');
        const gluePath = join(cppProviderSdkPath(engineOptions), 'src', fmiVersion === '3.0' ? 'fmi3Glue.cpp' : 'fmiGlue.cpp');
        const artifactPath = join(directory, `${modelIdentifier}${libraryExtension()}`);
        const execution = await runEngine(executable, [
            'buildSharedLibrary', sourcePath, gluePath,
            '--output', artifactPath,
            '--sdk-path', cppProviderSdkPath(engineOptions)
        ]);
        if (execution.code !== 0) throw new Error(execution.diagnostics || `The engine exited with code ${execution.code} while building the FMU.`);

        const libraryBytes = new Uint8Array(await readFile(artifactPath));
        const archive = zipSync({
            'modelDescription.xml': new TextEncoder().encode(xml),
            [`binaries/${platformDirectory(fmiVersion)}/${modelIdentifier}${libraryExtension()}`]: libraryBytes
        }, { level: 6 });
        return Buffer.from(archive);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// An FMU's identity: FMI 2.0's guid, or FMI 3.0's instantiationToken (prefixed, so an FMI 2.0 and an
// FMI 3.0 file never match each other).
function guidOf(name, xmlBytes) {
    const text = new TextDecoder().decode(xmlBytes);
    const token = /\binstantiationToken="([^"]*)"/.exec(text);
    if (token) return `3.0 ${token[1]}`;
    const match = /guid="([^"]*)"/.exec(text);
    if (!match) throw new Error(`'${name}' has no modelDescription.xml guid -- it doesn't look like a Konjugate-exported FMU.`);
    return match[1];
}

// Konjugate never cross-compiles: each machine's export only ever contains one platform's
// binaries/<dir>/ (see generateFmuPackage above). A "multi-platform FMU" is built by exporting the
// identical model separately on each target platform, then combining those single-platform .fmu
// files here -- pure zip surgery, no compiler involved. Files is [{name, data}], data a
// Buffer/Uint8Array of one .fmu's bytes; name is only used for error messages. Returns a Buffer.
export function mergeFmuPackages(files) {
    if (files.length < 2) throw new Error('Merging an FMU needs at least two files.');

    const archives = files.map(({ name, data }) => {
        let entries;
        try {
            entries = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
        } catch (error) {
            throw new Error(`'${name}' could not be read as a zip archive: ${error.message}`);
        }
        if (!entries['modelDescription.xml']) throw new Error(`'${name}' has no modelDescription.xml -- it doesn't look like an FMU.`);
        return { name, entries, guid: guidOf(name, entries['modelDescription.xml']) };
    });

    const { guid: expectedGuid } = archives[0];
    for (const archive of archives) {
        if (archive.guid !== expectedGuid) {
            throw new Error(`'${archive.name}' is not an export of the same model as '${archives[0].name}' -- their modelDescription.xml guids (or FMI versions) differ. Re-export every platform from the identical project before merging.`);
        }
    }

    const merged = { 'modelDescription.xml': archives[0].entries['modelDescription.xml'] };
    for (const archive of archives) {
        for (const [path, bytes] of Object.entries(archive.entries)) {
            if (!path.startsWith('binaries/')) continue;
            if (merged[path] && !areBytesEqual(merged[path], bytes)) {
                throw new Error(`Two of the given files both contain '${path}' with different contents -- they can't be the same export.`);
            }
            merged[path] = bytes;
        }
    }
    return Buffer.from(zipSync(merged, { level: 6 }));
}

function areBytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
    return true;
}
