/* Copyright © 2026 Zenin Easa Panthakkalakath */

export const visualizerApiVersion = 1;
const addonIdPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/;
const commandIdPattern = /^[a-z][A-Za-z0-9]*$/;
const allowedToolstripConditions = new Set(['always', 'resultsActive']);
const allowedContributionContexts = new Set(['resultSession']);

const allowedPermissions = new Set([
    'results.read',
    'timeline.read',
    'timeline.seek',
    'selection.read',
    'results.live.read',
    'simulation.status.read',
    'simulation.pacing.read',
    'simulation.pacing.control',
    'results.export'
]);

const launcherPermissions = new Set(['data.import', 'scenario.run', 'model.open', 'results.export', 'pages.open']);
const contributionIdPattern = /^[a-z][A-Za-z0-9]*$/;

function safeRelativePath(path, description, extensions) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.split(/[\\/]/).includes('..')) {
        throw new Error(`The launcher ${description} must be a relative path inside the add-on directory.`);
    }
    if (extensions && !extensions.some((extension) => path.endsWith(extension))) throw new Error(`The launcher ${description} must end in ${extensions.join(' or ')}.`);
    return path;
}

// A launcher add-on opens a guided starting window instead of visualizing results (see
// docs/proposals/launcherAddons.md). Everything it may refer to -- importers, scenarios, help pages,
// sample files -- is declared here as data, and the window can only name a declared id; it can never
// supply a path or a URL of its own.
export function validateLauncherManifest(manifest) {
    if (manifest.apiVersion !== visualizerApiVersion) throw new Error(`Unsupported launcher API version: ${manifest.apiVersion}.`);
    if (!addonIdPattern.test(manifest.addonId ?? '') || !manifest.name || !manifest.version || !manifest.entry) throw new Error('The launcher manifest is incomplete.');
    safeRelativePath(manifest.entry, 'entry', ['.html']);
    const permissions = manifest.permissions ?? [];
    if (!permissions.every((permission) => launcherPermissions.has(permission))) throw new Error('The launcher requests an unsupported permission.');
    const contributes = manifest.contributes ?? {};
    const toolstrip = contributes.toolstrip ?? [];
    if (toolstrip.length !== 1 || !commandIdPattern.test(toolstrip[0].commandId ?? '') || !toolstrip[0].label || !toolstrip[0].tooltip ||
        toolstrip[0].when !== 'always' || (toolstrip[0].contexts ?? []).length) {
        throw new Error('A launcher must contribute exactly one always-visible toolstrip command with no result context.');
    }
    const unique = (items, key, description) => {
        const seen = new Set();
        for (const item of items) {
            if (!contributionIdPattern.test(item?.[key] ?? '') || seen.has(item[key])) throw new Error(`The launcher has an invalid or duplicated ${description} id.`);
            seen.add(item[key]);
        }
    };
    const importers = contributes.importers ?? [];
    unique(importers, 'importerId', 'importer');
    for (const importer of importers) {
        if (!importer.name) throw new Error('A launcher importer needs a name.');
        safeRelativePath(importer.entry, 'importer entry', ['.mjs']);
        const files = importer.files ?? [];
        if (!files.length) throw new Error('A launcher importer must declare the files it reads.');
        unique(files, 'role', 'importer file role');
        for (const file of files) {
            if (!file.label) throw new Error('A launcher importer file needs a label.');
            if (file.sample !== undefined) safeRelativePath(file.sample, 'importer sample', null);
        }
    }
    const scenarios = contributes.scenarios ?? [];
    unique(scenarios, 'scenarioId', 'scenario');
    for (const scenario of scenarios) {
        if (!scenario.name || !scenario.description || !Number.isFinite(scenario.forkAt) || scenario.forkAt < 0 || !Number.isFinite(scenario.runTime) || !(scenario.runTime > scenario.forkAt)) {
            throw new Error('A launcher scenario needs a name, a description, a fork time and a longer run time.');
        }
        if (scenario.choose !== undefined && !scenario.choose?.label) throw new Error('A launcher scenario choice needs a label.');
        if (scenario.effects !== undefined && (!Array.isArray(scenario.effects) || !scenario.effects.every((line) => typeof line === 'string'))) {
            throw new Error('A launcher scenario\'s effects must be a list of sentences.');
        }
        if (!Array.isArray(scenario.interventions) || !scenario.interventions.length) throw new Error('A launcher scenario needs at least one intervention.');
        for (const intervention of scenario.interventions) {
            if (!contributionIdPattern.test(intervention.parameter ?? '') || !['chosen', 'all', 'global'].includes(intervention.target) ||
                (Number.isFinite(intervention.value) === Number.isFinite(intervention.fractionOfMaximum)) || (intervention.at !== undefined && !(intervention.at >= 0)) ||
                (intervention.duration !== undefined && !(intervention.duration > 0))) {
                throw new Error('A launcher scenario intervention needs a parameter, a target (chosen, all or global), an optional delay and duration, and exactly one of value or fractionOfMaximum.');
            }
        }
    }
    const pages = contributes.pages ?? [];
    unique(pages, 'pageId', 'page');
    for (const page of pages) {
        if (!page.label) throw new Error('A launcher page needs a label.');
        safeRelativePath(page.entry, 'page entry', ['.html']);
    }
    return structuredClone(manifest);
}

export function validateAddonManifest(manifest) {
    if (manifest?.kind === 'launcher') return validateLauncherManifest(manifest);
    if (!manifest || manifest.kind !== 'resultVisualizer') throw new Error('The add-on is not a result visualizer.');
    if (manifest.apiVersion !== visualizerApiVersion) throw new Error(`Unsupported visualizer API version: ${manifest.apiVersion}.`);
    if (!addonIdPattern.test(manifest.addonId ?? '') || !manifest.name || !manifest.version || !manifest.entry) throw new Error('The visualizer manifest is incomplete.');
    if (manifest.entry.startsWith('/') || manifest.entry.split(/[\\/]/).includes('..')) {
        throw new Error('The visualizer entry must remain inside its add-on directory.');
    }
    const permissions = manifest.permissions ?? [];
    if (!permissions.every((permission) => allowedPermissions.has(permission))) {
        throw new Error('The visualizer requests an unsupported permission.');
    }
    const contributions = manifest.contributes?.toolstrip ?? [];
    if (contributions.length !== 1) throw new Error('A version 1 result visualizer must contribute exactly one toolstrip command.');
    const commandIds = new Set();
    contributions.forEach((contribution) => {
        const contexts = contribution.contexts ?? [];
        if (!commandIdPattern.test(contribution.commandId ?? '') || commandIds.has(contribution.commandId) ||
            !contribution.label || !contribution.tooltip || !allowedToolstripConditions.has(contribution.when ?? 'always') ||
            !contexts.every((context) => allowedContributionContexts.has(context)) ||
            !contexts.includes('resultSession') || contribution.when !== 'resultsActive') {
            throw new Error('The add-on contains an invalid toolstrip contribution.');
        }
        commandIds.add(contribution.commandId);
    });
    return structuredClone(manifest);
}

export const validateVisualizerManifest = validateAddonManifest;

export function publicToolstripContributions(manifest) {
    return (manifest.contributes?.toolstrip ?? []).map((contribution) => ({
        addonId: manifest.addonId,
        addonName: manifest.name,
        commandId: contribution.commandId,
        label: contribution.label,
        tooltip: contribution.tooltip,
        symbol: contribution.symbol ?? '◇',
        when: contribution.when ?? 'always',
        contexts: [...(contribution.contexts ?? [])]
    }));
}

export function createVisualizerSession({ sessionId, projectName, result, nodes, edges = [], selectedNodeId, engineJobId = null, time = 0 }) {
    const signals = nodes.flatMap((node) => node.states.map((state) => ({
        signalId: state.id,
        entityId: node.id,
        entityName: node.title,
        name: state.label,
        symbol: state.symbol,
        unit: state.unit ?? ''
    })));
    return {
        sessionId,
        engineJobId,
        projectName,
        run: {
            name: result.configurationName,
            targetTime: Number(result.targetTime),
            outputInterval: Number(result.outputInterval),
            sampleCount: result.samples.length,
            lifecycle: result.lifecycle ?? 'completed',
            simulationTime: Number(result.simulationTime ?? result.targetTime),
            availableResultTime: Number(result.availableResultTime ?? result.targetTime),
            pacing: structuredClone(result.pacing ?? { mode: 'fastest', simulationSecondsPerWallSecond: 1 })
        },
        signals,
        // Structural model metadata (appearance, topology) -- static for the life of the
        // session, unlike signals/samples, so it's read once here rather than through a
        // separate time-varying endpoint.
        nodes: nodes.map(({ id, title, shape, color, rotation, scale, mesh }) => ({ id, title, shape, color, rotation, scale, mesh })),
        edges: edges.map(({ id, title, sourceNodeId, targetNodeId }) => ({ id, title, sourceNodeId, targetNodeId })),
        samples: structuredClone(result.samples),
        selectedNodeId,
        time: Number(time)
    };
}

export function publicVisualizerContext(session) {
    return {
        apiVersion: visualizerApiVersion,
        sessionId: session.sessionId,
        projectName: session.projectName,
        run: structuredClone(session.run),
        nodes: structuredClone(session.nodes),
        edges: structuredClone(session.edges),
        selectedNodeId: session.selectedNodeId,
        time: session.time
    };
}

export function readSignalSeries(session, signalIds, { startTime = 0, endTime = Infinity, maxPoints = 4000 } = {}) {
    const requested = new Set(signalIds);
    const metadata = session.signals.filter((signal) => requested.has(signal.signalId));
    const samples = session.samples.filter((sample) => sample.time >= startTime && sample.time <= endTime);
    const stride = Math.max(1, Math.ceil(samples.length / Math.max(2, maxPoints)));
    const selectedSamples = samples.filter((_sample, index) => index % stride === 0 || index === samples.length - 1);
    return metadata.map((signal) => ({
        ...signal,
        samples: selectedSamples.flatMap((sample) => {
            const state = sample.states.find((candidate) => candidate.stateId === signal.signalId);
            return state ? [{ time: Number(sample.time), value: Number(state.value) }] : [];
        })
    }));
}
