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
    'simulation.pacing.control'
]);

export function validateAddonManifest(manifest) {
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

export function createVisualizerSession({ sessionId, projectName, result, nodes, selectedNodeId, engineJobId = null, time = 0 }) {
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
