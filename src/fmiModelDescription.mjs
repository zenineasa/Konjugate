/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Parses an FMU's modelDescription.xml into the small, version-agnostic shape general FMI import
// needs -- unlike the export side's own modelDescriptionXml() (src/fmiExport.mjs), which only
// ever writes Konjugate's own known-good shape, this has to tolerate an ARBITRARY third-party
// FMU's XML: different attribute order/quoting, comments, whitespace -- hence a real XML parser
// (fast-xml-parser) rather than the regex checks the export-side tests use on Konjugate's own
// output. See docs/projectSchema.md's "kind: fmi" paragraph.

import { XMLParser, XMLValidator } from 'fast-xml-parser';

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

// document must already be the parsed <fmiModelDescription> root object.
function parseFmi2(root) {
    if (!root.CoSimulation) {
        throw new FmiModelDescriptionError('This FMU does not declare Co-Simulation support -- Konjugate import only supports FMI Co-Simulation, not Model Exchange.');
    }
    const guid = root['@_guid'];
    if (!guid) throw new FmiModelDescriptionError('modelDescription.xml has no guid.');
    const modelIdentifier = root.CoSimulation['@_modelIdentifier'];
    if (!modelIdentifier) throw new FmiModelDescriptionError('modelDescription.xml\'s <CoSimulation> element has no modelIdentifier.');

    const rawVariables = root.ModelVariables?.ScalarVariable ?? [];
    const variables = [];
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
        if (type !== 'Real') {
            throw new FmiModelDescriptionError(
                `Variable '${name}' is of type ${type ?? 'unknown'} -- Konjugate's FMI import only supports Real-valued input/output/parameter variables in this version.`
            );
        }
        const startText = rawVariable.Real?.['@_start'];
        variables.push({
            name, valueReference, causality,
            variability: rawVariable['@_variability'] || 'continuous',
            start: startText === undefined ? undefined : Number.parseFloat(startText)
        });
    }

    return {
        fmiVersion: '2.0',
        guid,
        modelName: root['@_modelName'] || modelIdentifier,
        modelIdentifier,
        canGetAndSetFMUState: root.CoSimulation['@_canGetAndSetFMUstate'] === 'true',
        variables
    };
}

// document must already be the parsed <fmiModelDescription> root object. FMI 3.0 renames the
// "guid" identity attribute to "instantiationToken" (returned here under the same `guid` field
// so the rest of this codebase -- install identity, resolver lookups -- never has to know which
// FMI version it's dealing with) and requires "State" capitalized in canGetAndSetFMUState/
// canSerializeFMUState, unlike FMI 2.0's canGetAndSetFMUstate/canSerializeFMUstate.
function parseFmi3(root) {
    if (!root.CoSimulation) {
        throw new FmiModelDescriptionError('This FMU does not declare Co-Simulation support -- Konjugate import only supports FMI Co-Simulation, not Model Exchange.');
    }
    const instantiationToken = root['@_instantiationToken'];
    if (!instantiationToken) throw new FmiModelDescriptionError('modelDescription.xml has no instantiationToken.');
    const modelIdentifier = root.CoSimulation['@_modelIdentifier'];
    if (!modelIdentifier) throw new FmiModelDescriptionError('modelDescription.xml\'s <CoSimulation> element has no modelIdentifier.');

    const modelVariables = root.ModelVariables ?? {};
    const variables = [];
    for (const typeName of fmi3TypeElementNames) {
        for (const rawVariable of modelVariables[typeName] ?? []) {
            const causality = rawVariable['@_causality'] || 'local';
            if (!bindableCausalities.has(causality)) continue;
            const name = rawVariable['@_name'];
            if (!name) throw new FmiModelDescriptionError('A model variable is missing its name.');
            if (rawVariable.Dimension !== undefined) {
                throw new FmiModelDescriptionError(`Variable '${name}' is array-shaped -- Konjugate's FMI import only supports scalar variables in this version.`);
            }
            const valueReferenceText = rawVariable['@_valueReference'];
            if (valueReferenceText === undefined) throw new FmiModelDescriptionError(`Variable '${name}' is missing its valueReference.`);
            const valueReference = Number.parseInt(valueReferenceText, 10);
            if (!Number.isInteger(valueReference) || valueReference < 0) {
                throw new FmiModelDescriptionError(`Variable '${name}' has an invalid valueReference.`);
            }
            if (typeName !== 'Float64') {
                throw new FmiModelDescriptionError(
                    `Variable '${name}' is of type ${typeName} -- Konjugate's FMI import only supports Float64-valued input/output/parameter variables in this version.`
                );
            }
            const startText = rawVariable['@_start'];
            variables.push({
                name, valueReference, causality,
                variability: rawVariable['@_variability'] || 'continuous',
                start: startText === undefined ? undefined : Number.parseFloat(startText)
            });
        }
    }

    return {
        fmiVersion: '3.0',
        guid: instantiationToken,
        modelName: root['@_modelName'] || modelIdentifier,
        modelIdentifier,
        canGetAndSetFMUState: root.CoSimulation['@_canGetAndSetFMUState'] === 'true',
        variables
    };
}

// Given the raw bytes/text of one FMU's modelDescription.xml, returns
// { fmiVersion, guid, modelName, modelIdentifier, canGetAndSetFMUState, variables }, where each
// variable is { name, valueReference, causality, variability, start }. Throws
// FmiModelDescriptionError on malformed XML, a non-Co-Simulation FMU, or a variable type/shape
// this version of Konjugate does not support importing.
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
