/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Parses an FMU's modelDescription.xml into the small, version-agnostic shape general FMI import
// needs -- unlike the export side's own modelDescriptionXml() (src/fmiExport.mjs), which only
// ever writes Konjugate's own known-good shape, this has to tolerate an ARBITRARY third-party
// FMU's XML: different attribute order/quoting, comments, whitespace -- hence a real XML parser
// (fast-xml-parser) rather than the regex checks the export-side tests use on Konjugate's own
// output. See docs/projectSchema.md's "kind: fmi" paragraph.

import { XMLParser, XMLValidator } from 'fast-xml-parser';

// A variable's start value as a number, as Konjugate passes it: a Boolean's "true" or "false" (or "1" or "0", as XML writes a
// boolean) as 1 or 0, any other type's text as written; undefined when there is none or it is not a single number (an array's).
function startValue(text, type) {
    if (text === undefined || text === null) return undefined;
    const trimmed = String(text).trim();
    if (type === 'Boolean') return trimmed === 'true' || trimmed === '1' ? 1 : trimmed === 'false' || trimmed === '0' ? 0 : undefined;
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) return undefined;
    return Number(trimmed);
}

export class FmiModelDescriptionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FmiModelDescriptionError';
    }
}

// FMI 3.0 replaces FMI 2.0's <ScalarVariable> (wrapping one typed child element, e.g. <Real>)
// with the type itself as the variable element (e.g. <Float64 name="..." valueReference="0" .../>
// directly under <ModelVariables>) -- both shapes need their own repeated-element names forced
// into arrays regardless of count (fast-xml-parser only arrays a repeated element when there's
// more than one occurrence otherwise).
const fmi3TypeElementNames = ['Float32', 'Float64', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Boolean', 'String', 'Binary', 'Enumeration', 'Clock'];

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    isArray: (name) => name === 'ScalarVariable' || fmi3TypeElementNames.includes(name)
});

// The causalities general FMI import actually turns into bindable ports. A variable with any
// other causality (local, independent, calculatedParameter) is simply not exposed -- it plays no
// role in Konjugate's binding model, so it is skipped rather than rejected.
const bindableCausalities = new Set(['input', 'output', 'parameter']);

function scalarVariableType(rawVariable) {
    if (rawVariable.Real !== undefined) return 'Real';
    if (rawVariable.Integer !== undefined) return 'Integer';
    if (rawVariable.Boolean !== undefined) return 'Boolean';
    if (rawVariable.String !== undefined) return 'String';
    if (rawVariable.Enumeration !== undefined) return 'Enumeration';
    return null;
}

// The variable types general FMI import maps to Konjugate's numbers, by FMI version. Each is read as a number and set
// from one: an integer or enumeration rounded to the nearest whole number, a Boolean true for anything but 0 and read
// as 1 or 0 (engine/include/konjugate/fmiImportedNode.hpp). Any other type (String, Binary, Clock) or an array is not a
// port: the FMU keeps its own start value for it, and notExposed below names it so the person importing it is told.
const numericFmi2Types = new Set(['Real', 'Integer', 'Boolean', 'Enumeration']);
const numericFmi3Types = new Set(['Float32', 'Float64', 'Int8', 'UInt8', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Boolean', 'Enumeration']);

function modelExchangeOnly(root) {
    return root.ModelExchange !== undefined
        ? 'This FMU offers only Model Exchange. Konjugate runs FMUs in Co-Simulation, where the FMU integrates its own equations, so it cannot run this one.'
        : 'This FMU declares no Co-Simulation, which is how Konjugate runs FMUs.';
}

// ---- What the node's card says of an FMU (docs/proposals/fmuImportWorkflow.md, stage 3) ----------------------------------
function asArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

// A number written in an attribute, or undefined when there is none or it is not one number.
function numberAttribute(text) {
    if (text === undefined || text === null) return undefined;
    const trimmed = String(text).trim();
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed) ? Number(trimmed) : undefined;
}

function textAttribute(text) {
    const trimmed = text === undefined || text === null ? '' : String(text).trim();
    return trimmed || undefined;
}

function flag(text) {
    return text === 'true';
}

// The model's own description, who made it and with what, and how it would be run by default: the card's "About this FMU".
function modelInformation(root) {
    const experiment = asArray(root.DefaultExperiment)[0];
    const defaultExperiment = experiment ? Object.fromEntries(
        ['startTime', 'stopTime', 'stepSize', 'tolerance'].map((name) => [name, numberAttribute(experiment[`@_${name}`])]).filter(([, value]) => value !== undefined)
    ) : null;
    return Object.fromEntries(Object.entries({
        description: textAttribute(root['@_description']),
        author: textAttribute(root['@_author']),
        version: textAttribute(root['@_version']),
        copyright: textAttribute(root['@_copyright']),
        license: textAttribute(root['@_license']),
        generationTool: textAttribute(root['@_generationTool']),
        generationDateAndTime: textAttribute(root['@_generationDateAndTime']),
        defaultExperiment: defaultExperiment && Object.keys(defaultExperiment).length ? defaultExperiment : undefined
    }).filter(([, value]) => value !== undefined));
}

// What a variable says of itself beyond its type: its description, unit (its own, or its declared type's) and bounds.
function variableDetails({ description, unit, declaredType, min, max }, unitsByType) {
    return Object.fromEntries(Object.entries({
        description: textAttribute(description),
        unit: textAttribute(unit) ?? (declaredType ? unitsByType.get(declaredType) : undefined),
        min: numberAttribute(min),
        max: numberAttribute(max)
    }).filter(([, value]) => value !== undefined));
}

// document must already be the parsed <fmiModelDescription> root object.
function parseFmi2(root) {
    if (!root.CoSimulation) {
        throw new FmiModelDescriptionError(modelExchangeOnly(root));
    }
    const guid = root['@_guid'];
    if (!guid) throw new FmiModelDescriptionError('modelDescription.xml has no guid.');
    const modelIdentifier = root.CoSimulation['@_modelIdentifier'];
    if (!modelIdentifier) throw new FmiModelDescriptionError('modelDescription.xml\'s <CoSimulation> element has no modelIdentifier.');

    const rawVariables = root.ModelVariables?.ScalarVariable ?? [];
    const unitsByType = new Map(asArray(root.TypeDefinitions?.SimpleType)
        .map((type) => [type['@_name'], textAttribute(asArray(type.Real)[0]?.['@_unit'])]).filter(([name, unit]) => name && unit));
    const variables = [];
    const notExposed = [];
    for (const rawVariable of rawVariables) {
        const causality = rawVariable['@_causality'] || 'local';
        if (!bindableCausalities.has(causality)) continue;
        const name = rawVariable['@_name'];
        if (!name) throw new FmiModelDescriptionError('A <ScalarVariable> is missing its name.');
        const valueReferenceText = rawVariable['@_valueReference'];
        if (valueReferenceText === undefined) throw new FmiModelDescriptionError(`Variable '${name}' is missing its valueReference.`);
        const valueReference = Number.parseInt(valueReferenceText, 10);
        if (!Number.isInteger(valueReference) || valueReference < 0) {
            throw new FmiModelDescriptionError(`Variable '${name}' has an invalid valueReference.`);
        }
        const type = scalarVariableType(rawVariable);
        if (!numericFmi2Types.has(type)) {
            notExposed.push({ name, causality, type: type ?? 'unknown' });
            continue;
        }
        // Boolean and Enumeration are also FMI 3.0 element names, which the parser always makes arrays.
        const typed = Array.isArray(rawVariable[type]) ? rawVariable[type][0] : rawVariable[type];
        const startText = typed?.['@_start'];
        variables.push({
            name, valueReference, causality, type,
            variability: rawVariable['@_variability'] || 'continuous',
            start: startValue(startText, type),
            ...variableDetails({
                description: rawVariable['@_description'], unit: typed?.['@_unit'], declaredType: typed?.['@_declaredType'], min: typed?.['@_min'], max: typed?.['@_max']
            }, unitsByType)
        });
    }

    return {
        fmiVersion: '2.0',
        guid,
        modelName: root['@_modelName'] || modelIdentifier,
        modelIdentifier,
        canGetAndSetFMUState: root.CoSimulation['@_canGetAndSetFMUstate'] === 'true',
        modelExchange: root.ModelExchange !== undefined,
        variables,
        notExposed,
        ...modelInformation(root),
        // The C files its Co-Simulation sources are built from (FMI 2.0 §2.3), relative to sources/: what Konjugate builds it from
        // when no buildDescription.xml says more (docs/proposals/sourceFmuImport.md).
        ...(root.CoSimulation.SourceFiles ? { sourceFiles: asArray(root.CoSimulation.SourceFiles.File).map((file) => textAttribute(file?.['@_name'])).filter(Boolean) } : {}),
        coSimulation: {
            canHandleVariableCommunicationStepSize: flag(root.CoSimulation['@_canHandleVariableCommunicationStepSize']),
            canSerializeFMUState: flag(root.CoSimulation['@_canSerializeFMUstate']),
            canBeInstantiatedOnlyOncePerProcess: flag(root.CoSimulation['@_canBeInstantiatedOnlyOncePerProcess']),
            needsExecutionTool: flag(root.CoSimulation['@_needsExecutionTool'])
        }
    };
}

// document must already be the parsed <fmiModelDescription> root object. FMI 3.0 renames the
// "guid" identity attribute to "instantiationToken" (returned here under the same `guid` field
// so the rest of this codebase -- install identity, resolver lookups -- never has to know which
// FMI version it's dealing with) and requires "State" capitalized in canGetAndSetFMUState/
// canSerializeFMUState, unlike FMI 2.0's canGetAndSetFMUstate/canSerializeFMUstate.
function parseFmi3(root) {
    if (!root.CoSimulation) {
        throw new FmiModelDescriptionError(modelExchangeOnly(root));
    }
    const instantiationToken = root['@_instantiationToken'];
    if (!instantiationToken) throw new FmiModelDescriptionError('modelDescription.xml has no instantiationToken.');
    const modelIdentifier = root.CoSimulation['@_modelIdentifier'];
    if (!modelIdentifier) throw new FmiModelDescriptionError('modelDescription.xml\'s <CoSimulation> element has no modelIdentifier.');

    const modelVariables = root.ModelVariables ?? {};
    const unitsByType = new Map(Object.entries(root.TypeDefinitions ?? {})
        .filter(([element]) => element.endsWith('Type'))
        .flatMap(([, types]) => asArray(types))
        .map((type) => [type['@_name'], textAttribute(type['@_unit'])]).filter(([name, unit]) => name && unit));
    const variables = [];
    const notExposed = [];
    for (const typeName of fmi3TypeElementNames) {
        for (const rawVariable of modelVariables[typeName] ?? []) {
            const causality = rawVariable['@_causality'] || 'local';
            if (!bindableCausalities.has(causality)) continue;
            const name = rawVariable['@_name'];
            if (!name) throw new FmiModelDescriptionError('A model variable is missing its name.');
            if (rawVariable.Dimension !== undefined || !numericFmi3Types.has(typeName)) {
                notExposed.push({ name, causality, type: rawVariable.Dimension !== undefined ? `${typeName} array` : typeName });
                continue;
            }
            const valueReferenceText = rawVariable['@_valueReference'];
            if (valueReferenceText === undefined) throw new FmiModelDescriptionError(`Variable '${name}' is missing its valueReference.`);
            const valueReference = Number.parseInt(valueReferenceText, 10);
            if (!Number.isInteger(valueReference) || valueReference < 0) {
                throw new FmiModelDescriptionError(`Variable '${name}' has an invalid valueReference.`);
            }
            const startText = rawVariable['@_start'];
            variables.push({
                name, valueReference, causality, type: typeName,
                variability: rawVariable['@_variability'] || (typeName.startsWith('Float') ? 'continuous' : 'discrete'),
                start: startValue(startText, typeName),
                ...variableDetails({
                    description: rawVariable['@_description'], unit: rawVariable['@_unit'], declaredType: rawVariable['@_declaredType'], min: rawVariable['@_min'], max: rawVariable['@_max']
                }, unitsByType)
            });
        }
    }

    return {
        fmiVersion: '3.0',
        guid: instantiationToken,
        modelName: root['@_modelName'] || modelIdentifier,
        modelIdentifier,
        canGetAndSetFMUState: root.CoSimulation['@_canGetAndSetFMUState'] === 'true',
        modelExchange: root.ModelExchange !== undefined,
        variables,
        notExposed,
        ...modelInformation(root),
        coSimulation: {
            canHandleVariableCommunicationStepSize: flag(root.CoSimulation['@_canHandleVariableCommunicationStepSize']),
            fixedInternalStepSize: numberAttribute(root.CoSimulation['@_fixedInternalStepSize']),
            canSerializeFMUState: flag(root.CoSimulation['@_canSerializeFMUState']),
            canBeInstantiatedOnlyOncePerProcess: flag(root.CoSimulation['@_canBeInstantiatedOnlyOncePerProcess']),
            needsExecutionTool: flag(root.CoSimulation['@_needsExecutionTool'])
        }
    };
}

// Given the raw bytes/text of one FMU's modelDescription.xml, returns
// { fmiVersion, guid, modelName, modelIdentifier, canGetAndSetFMUState, modelExchange, variables, notExposed, coSimulation } and,
// where the FMU says them, description, author, version, copyright, license, generationTool, generationDateAndTime and
// defaultExperiment ({ startTime, stopTime, stepSize, tolerance }); coSimulation is the capability flags the card shows
// (canHandleVariableCommunicationStepSize, fixedInternalStepSize for FMI 3.0, canSerializeFMUState,
// canBeInstantiatedOnlyOncePerProcess, needsExecutionTool). Each variable is { name, valueReference, causality, type,
// variability, start } and, where it says them, its description, unit (its own or its declared type's), min and max (type the FMI version's own name:
// Real, Float64, Int32, Boolean, ...) and each of notExposed is { name, causality, type } for an input, output or
// parameter that is not a number Konjugate can bind (see numericFmi2Types above). Throws FmiModelDescriptionError on
// malformed XML or an FMU without Co-Simulation (Konjugate runs FMUs in Co-Simulation only: Model Exchange would need
// Konjugate to integrate the FMU's equations itself, which it does not).
export function parseModelDescription(xmlText) {
    const validation = XMLValidator.validate(xmlText);
    if (validation !== true) {
        throw new FmiModelDescriptionError(`modelDescription.xml is not valid XML: ${validation.err.msg}`);
    }
    const document = parser.parse(xmlText);
    const root = document.fmiModelDescription;
    if (!root) throw new FmiModelDescriptionError('modelDescription.xml has no <fmiModelDescription> root element.');

    const fmiVersion = root['@_fmiVersion'] || '';
    if (fmiVersion.startsWith('2.')) return parseFmi2(root);
    if (fmiVersion.startsWith('3.')) return parseFmi3(root);
    throw new FmiModelDescriptionError(`Unsupported fmiVersion '${fmiVersion || '(missing)'}' -- Konjugate import supports FMI 2.0 and 3.0.`);
}
