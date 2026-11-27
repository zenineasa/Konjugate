/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What an FMU says about building it from its sources (docs/proposals/sourceFmuImport.md, stage 1): FMI 3.0's
// sources/buildDescription.xml (FMI 3.0.2 §2.4.10), which also takes precedence in an FMI 2.0.4 FMU (FMI 2.0.4 §2.3), else FMI 2.0's
// <CoSimulation><SourceFiles>. The build configuration for this computer is chosen as §2.4.10 says (the one whose platform tuple
// matches, else the single one without a platform), the exporter is recognised where Konjugate keeps a recipe for it (OpenModelica),
// and everything that would stop a build is said, by name, before anything is compiled: a <Library> (refused at first, decision 7), a
// path leaving sources/, a listed file the FMU does not carry, a language that is not C or C++. Nothing here reads a disk or runs
// anything: `names` are the FMU's archive entries, as inspectFmuArchive (src/fmuPackage.mjs) or an installed FMU's folder gives them.

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { platformTuple } from './fmiBinary.mjs';
import { exporterRecipe } from './fmuRecipes.mjs';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    isArray: (name) => ['BuildConfiguration', 'SourceFileSet', 'SourceFile', 'PreprocessorDefinition', 'IncludeDirectory', 'Library', 'Option'].includes(name)
});

const text = (value) => (value === undefined || value === null ? null : String(value).trim() || null);
const list = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);
// The languages a source file set may name (FMI 3.0.2 §2.4.10.3: "C89", "C99", "C11", "C++11", …; "C" alone, no standard).
const languagePattern = /^(C|C89|C90|C99|C11|C17|C18|C23|C\+\+|C\+\+(98|03|11|14|17|20|23))$/;

export class FmuBuildDescriptionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FmuBuildDescriptionError';
    }
}

// sources/buildDescription.xml as data: `{ fmiVersion, configurations: [{ modelIdentifier, platform, description, sourceFileSets:
// [{ name, language, compiler, compilerOptions, sourceFiles, definitions: [{ name, value, optionValues }], includeDirectories }],
// libraries: [{ name, version, external, description }] }] }`. Throws FmuBuildDescriptionError when it is not that file.
export function parseBuildDescription(xmlText) {
    const validation = XMLValidator.validate(xmlText);
    if (validation !== true) throw new FmuBuildDescriptionError(`it is not valid XML: ${validation.err.msg}`);
    const root = parser.parse(xmlText).fmiBuildDescription;
    if (!root) throw new FmuBuildDescriptionError('it has no <fmiBuildDescription> root element');
    return {
        fmiVersion: text(root['@_fmiVersion']),
        configurations: list(root.BuildConfiguration).map((configuration) => ({
            modelIdentifier: text(configuration['@_modelIdentifier']),
            platform: text(configuration['@_platform']),
            description: text(configuration['@_description']),
            sourceFileSets: list(configuration.SourceFileSet).map((set) => ({
                name: text(set['@_name']),
                language: text(set['@_language']),
                compiler: text(set['@_compiler']),
                compilerOptions: text(set['@_compilerOptions']),
                sourceFiles: list(set.SourceFile).map((file) => text(file?.['@_name'])).filter(Boolean),
                definitions: list(set.PreprocessorDefinition).map((definition) => ({
                    name: text(definition?.['@_name']), value: text(definition?.['@_value']),
                    optionValues: list(definition?.Option).map((option) => text(option?.['@_value'])).filter((value) => value !== null)
                })).filter((definition) => definition.name),
                includeDirectories: list(set.IncludeDirectory).map((directory) => text(directory?.['@_name'])).filter(Boolean)
            })),
            libraries: list(configuration.Library).map((library) => ({
                name: text(library['@_name']), version: text(library['@_version']), external: library['@_external'] === 'true', description: text(library['@_description'])
            }))
        }))
    };
}

// The configuration a computer of platform tuple `tuple` builds (FMI 3.0.2 §2.4.10.1): of those for the FMU's Co-Simulation
// modelIdentifier, the one for this platform, else the one for no platform in particular. `{ configuration }` or `{ problem }`.
export function chooseBuildConfiguration(configurations, modelIdentifier, tuple = platformTuple()) {
    const own = configurations.filter((configuration) => configuration.modelIdentifier === modelIdentifier);
    if (!own.length) {
        const others = [...new Set(configurations.map((configuration) => configuration.modelIdentifier).filter(Boolean))];
        return { problem: `its buildDescription.xml has no build configuration for ${modelIdentifier}${others.length ? ` (only for ${others.join(', ')})` : ''}` };
    }
    const forHere = own.find((configuration) => configuration.platform === tuple);
    if (forHere) return { configuration: forHere };
    const general = own.filter((configuration) => !configuration.platform);
    if (general.length === 1) return { configuration: general[0] };
    if (general.length > 1) return { problem: `its buildDescription.xml has ${general.length} build configurations for ${modelIdentifier} without a platform, and FMI allows one` };
    return { problem: `its buildDescription.xml builds ${modelIdentifier} for ${own.map((configuration) => configuration.platform).join(', ')} only, not for this computer (${tuple})` };
}

// A path inside sources/ as an FMU names it, refused when it would leave sources/ or is not a plain relative path (as archive paths
// are checked, src/fmuPackage.mjs).
function unsafePath(path) {
    return !path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)
        || path.split('/').some((segment) => segment === '..');
}

// The exporter Konjugate keeps a recipe for, when the FMU is one of its: OpenModelica, by its generationTool and the runtime it puts in
// sources/ (sources/simulation and sources/util), so another tool's FMU naming OpenModelica in its description is not taken for one.
export function recogniseExporter(description, names) {
    const tool = String(description?.generationTool ?? '');
    const openModelica = /OpenModelica\b.*?(\d+\.\d+(?:\.\d+)?)/.exec(tool);
    if (openModelica && names.some((name) => name.startsWith('sources/simulation/')) && names.some((name) => name.startsWith('sources/util/'))) {
        return { id: 'openModelica', name: 'OpenModelica', version: openModelica[1] };
    }
    return null;
}

// What the FMU says about building it, for this computer: `{ from, modelIdentifier, platform, configuration, sourceFileCount, language,
// exporter, problems }`, or null when it says nothing (no buildDescription.xml and no <SourceFiles>). `from` is "buildDescription" or
// "sourceFiles"; `configuration` the source file sets and libraries to build (a <SourceFiles> list is one C set, sources/ its include
// directory); `problems` why it cannot be built, each a phrase that follows "Konjugate cannot build it: ".
// `cmakeListsText` is the FMU's sources/CMakeLists.txt as text, read for the one fact an exporter's recipe needs from it (stage 4).
export function fmuBuildInformation({ description, names, buildDescriptionXml = null, cmakeListsText = null, tuple = platformTuple() }) {
    const inSources = new Set(names.filter((name) => name.startsWith('sources/')).map((name) => name.slice('sources/'.length)));
    const hasBuildDescription = buildDescriptionXml !== null && buildDescriptionXml !== undefined;
    if (!hasBuildDescription && !description?.sourceFiles?.length) return null;
    const problems = [];
    const modelIdentifier = description.modelIdentifier;
    let configuration = null;
    let from = 'sourceFiles';
    if (hasBuildDescription) {
        from = 'buildDescription';
        try {
            const chosen = chooseBuildConfiguration(parseBuildDescription(buildDescriptionXml).configurations, modelIdentifier, tuple);
            if (chosen.problem) problems.push(chosen.problem);
            configuration = chosen.configuration ?? null;
        } catch (error) {
            problems.push(`its buildDescription.xml cannot be read: ${error.message}`);
        }
    } else {
        configuration = { modelIdentifier, platform: null, sourceFileSets: [{ name: null, language: 'C', compiler: null, compilerOptions: null, sourceFiles: description.sourceFiles, definitions: [], includeDirectories: [] }], libraries: [] };
    }
    if (configuration) {
        for (const library of configuration.libraries ?? []) {
            problems.push(`it needs the library ${library.name}${library.external ? ' from this computer' : ''}, and Konjugate does not build FMUs with libraries yet`);
        }
        const sets = configuration.sourceFileSets ?? [];
        if (!sets.some((set) => set.sourceFiles.length)) problems.push('it lists no source file to compile');
        for (const set of sets) {
            if (set.language && !languagePattern.test(set.language)) problems.push(`its sources are in ${set.language}, and Konjugate builds C and C++ only`);
            for (const file of set.sourceFiles) {
                if (unsafePath(file)) problems.push(`it lists ${file}, which is not a path inside its sources`);
                else if (!inSources.has(file)) problems.push(`it lists ${file}, which is not in its sources`);
            }
            for (const directory of set.includeDirectories) {
                if (unsafePath(directory)) problems.push(`it asks to include ${directory}, which is not a folder inside its sources`);
            }
        }
    }
    const sets = configuration?.sourceFileSets ?? [];
    const languages = new Set(sets.map((set) => (/^C\+\+/.test(set.language ?? '') ? 'C++' : 'C')));
    const exporter = recogniseExporter(description, names);
    // The exporter's recipe (src/fmuRecipes.mjs): what its sources need beyond the standard, or why they cannot be built here.
    const chosenRecipe = exporterRecipe(exporter, { cmakeListsText, platform: tuple.endsWith('-windows') ? 'win32' : 'other' });
    if (chosenRecipe?.problem) problems.push(chosenRecipe.problem);
    return {
        from, modelIdentifier, platform: tuple, configuration,
        sourceFileCount: sets.reduce((total, set) => total + set.sourceFiles.length, 0),
        language: languages.size === 1 ? [...languages][0] : 'C and C++',
        exporter,
        ...(chosenRecipe?.recipe ? { recipe: chosenRecipe.recipe } : {}),
        problems: [...new Set(problems)]
    };
}
