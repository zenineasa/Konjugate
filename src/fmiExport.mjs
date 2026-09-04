/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Orchestrates a Konjugate model's export as a real, compiled FMI 2.0 Co-Simulation FMU: generates
// the model's C++ source and modelDescription.xml (src/fmiCodeGen.mjs plus the XML builder below),
// asks the engine binary to compile it into a shared library (its generic `buildSharedLibrary`
// command -- see engine/src/main.cpp -- linked against engine/src/fmiGlue.cpp, the FMI C API
// implementation), and zips the result into one .fmu (fflate's zipSync, the same library already
// used for .kja/.kjp packages in src/packageArchive.mjs). See docs/codeExport.md.

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { generateFmiModel } from './fmiCodeGen.mjs';
import { cppProviderSdkPath, resolveEnginePath, runEngine } from './engineAdapter.mjs';

function escapeXml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scalarVariablesXml(variables) {
    // causality="output" defaults to initial="calculated", which the standard forbids from
    // carrying a start value -- confirmed against a real validator (FMPy), not assumed. An input
    // has no initial attribute at all; its start is just its default before the host ever calls
    // fmi2SetReal. Units aren't emitted: Konjugate's own unit strings are free-form author text,
    // not the SI-exponent decomposition FMI's <UnitDefinitions> requires a referenced unit name to
    // resolve to -- declaring them properly is a real, separate scope item, not something to
    // fake with an undeclared unit= attribute (which a validator correctly rejects).
    return variables.map((variable) => (
        `        <ScalarVariable name="${escapeXml(variable.name)}" valueReference="${variable.valueReference}" causality="${variable.causality}" variability="continuous"${variable.causality === 'output' ? ' initial="exact"' : ''}>\n`
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

function modelDescriptionXml({ modelName, guid, modelIdentifier, stateVariables, inputVariables }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="2.0" modelName="${escapeXml(modelName)}" guid="${guid}" generationTool="Konjugate">
    <CoSimulation modelIdentifier="${escapeXml(modelIdentifier)}" canHandleVariableCommunicationStepSize="true"
        canGetAndSetFMUstate="false" canSerializeFMUstate="false" providesDirectionalDerivative="false"/>
    <ModelVariables>
${scalarVariablesXml([...stateVariables, ...inputVariables])}
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

    const { source, stateVariables, inputVariables } = generateFmiModel(document);
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
            modelName: modelName || 'model', guid: randomUUID(), modelIdentifier, stateVariables, inputVariables
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
