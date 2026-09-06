/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Orchestrates a Konjugate model's export as a real, compiled FMI 2.0 Co-Simulation FMU: generates
// the model's C++ source and modelDescription.xml (src/fmiCodeGen.mjs plus the XML builder below),
// asks the engine binary to compile it into a shared library (its generic `buildSharedLibrary`
// command -- see engine/src/main.cpp -- linked against engine/src/fmiGlue.cpp, the FMI C API
// implementation), and zips the result into one .fmu (fflate's zipSync, the same library already
// used for .kja/.kjp packages in src/packageArchive.mjs). See docs/codeExport.md.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { generateFmiModel } from './fmiCodeGen.mjs';
import { cppProviderSdkPath, resolveEnginePath, runEngine } from './engineAdapter.mjs';

function escapeXml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
        `        <ScalarVariable name="${escapeXml(variable.name)}" valueReference="${variable.valueReference}" causality="${variable.causality}" variability="${variable.variability}"${variable.causality === 'output' ? ' initial="exact"' : ''}>\n`
        + `            <Real start="${variable.start}"/>\n`
        + `        </ScalarVariable>`
    )).join('\n');
}

// Platform directory naming follows the FMI standard's own convention (win32/win64/linux32/
// linux64/darwin32/darwin64) -- predates Apple Silicon, so arm64 is folded into the 64-bit bucket
// like most real-world FMU exporters do, rather than inventing a nonstandard directory name.
function platformDirectory() {
    const bitness = process.arch === 'x86' || process.arch === 'ia32' ? '32' : '64';
    if (process.platform === 'win32') return `win${bitness}`;
    if (process.platform === 'darwin') return `darwin${bitness}`;
    return `linux${bitness}`;
}

function libraryExtension() {
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
function deterministicGuid(modelIdentifier, source) {
    const digest = createHash('sha256').update(modelIdentifier).update('\n').update(source).digest('hex');
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function modelDescriptionXml({ modelName, guid, modelIdentifier, stateVariables, parameterVariables, supportsStateCapture }) {
    const rollback = supportsStateCapture ? 'true' : 'false';
    return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="2.0" modelName="${escapeXml(modelName)}" guid="${guid}" generationTool="Konjugate">
    <CoSimulation modelIdentifier="${escapeXml(modelIdentifier)}" canHandleVariableCommunicationStepSize="true"
        canGetAndSetFMUstate="${rollback}" canSerializeFMUstate="${rollback}" providesDirectionalDerivative="false"/>
    <ModelVariables>
${scalarVariablesXml([...stateVariables, ...parameterVariables])}
    </ModelVariables>
    <ModelStructure>
        <Outputs>
${stateVariables.map((_variable, index) => `            <Unknown index="${index + 1}"/>`).join('\n')}
        </Outputs>
    </ModelStructure>
</fmiModelDescription>
`;
}

// document must already be flattened (stripEdgeGroups(executionProjectDocument(...))), matching
// every other codeExport.mjs/fmiCodeGen.mjs entry point. engineOptions is the same
// {applicationPath, resourcesPath, packaged} shape resolveEnginePath()/cppProviderSdkPath() take
// elsewhere. Returns a Buffer -- the finished .fmu file's bytes.
export async function generateFmuPackage(document, { modelName, engineOptions }) {
    const executable = await resolveEnginePath(engineOptions);
    if (!executable) throw new Error('The Konjugate engine binary could not be found -- FMU export needs it to compile the generated model.');

    const { source, stateVariables, parameterVariables, supportsStateCapture } = generateFmiModel(document);
    const modelIdentifier = (modelName || 'model').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_');
    const directory = await mkdtemp(join(tmpdir(), 'konjugateFmuExport-'));
    try {
        const sourcePath = join(directory, 'model.cpp');
        await writeFile(sourcePath, source, 'utf8');
        const gluePath = join(cppProviderSdkPath(engineOptions), 'src', 'fmiGlue.cpp');
        const artifactPath = join(directory, `${modelIdentifier}${libraryExtension()}`);
        const execution = await runEngine(executable, [
            'buildSharedLibrary', sourcePath, gluePath,
            '--output', artifactPath,
            '--sdk-path', cppProviderSdkPath(engineOptions)
        ]);
        if (execution.code !== 0) throw new Error(execution.diagnostics || `The engine exited with code ${execution.code} while building the FMU.`);

        const libraryBytes = new Uint8Array(await readFile(artifactPath));
        const xml = modelDescriptionXml({
            modelName: modelName || 'model', guid: deterministicGuid(modelIdentifier, source), modelIdentifier, stateVariables, parameterVariables, supportsStateCapture
        });
        const archive = zipSync({
            'modelDescription.xml': new TextEncoder().encode(xml),
            [`binaries/${platformDirectory()}/${modelIdentifier}${libraryExtension()}`]: libraryBytes
        }, { level: 6 });
        return Buffer.from(archive);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function guidOf(name, xmlBytes) {
    const match = /guid="([^"]*)"/.exec(new TextDecoder().decode(xmlBytes));
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
            throw new Error(`'${archive.name}' is not an export of the same model as '${archives[0].name}' -- their modelDescription.xml guids differ. Re-export every platform from the identical project before merging.`);
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
