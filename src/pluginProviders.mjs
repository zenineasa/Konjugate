/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The relationship providers installed plugins contribute, as choices for an edge's or a source term's implementation
// (`kind: "plugin"`, see docs/projectSchema.md): pinned to the plugin's installed version. Pure functions.

// From the Extensions list: [{ value, label, reference: { pluginId, pluginVersion, providerId } }].
export function pluginProviderChoices(entries = []) {
    const choices = [];
    for (const entry of entries) {
        if (entry.packageType !== 'plugin' || entry.enabled === false) continue;
        for (const contribution of entry.manifest?.contributes ?? []) {
            if (!contribution.providerId || (contribution.kind && contribution.kind !== 'provider')) continue;
            const reference = { pluginId: entry.packageId, pluginVersion: entry.version, providerId: contribution.providerId };
            choices.push({
                value: pluginProviderValue(reference),
                label: `${entry.name ?? entry.packageId} ${entry.version}: ${contribution.providerId}${contribution.runtime ? ` (${contribution.runtime === 'cpp' ? 'C++' : 'Python'})` : ''}`,
                reference
            });
        }
    }
    return choices;
}

export function pluginProviderValue(implementation) {
    return implementation?.pluginId ? JSON.stringify([implementation.pluginId, implementation.pluginVersion, implementation.providerId]) : '';
}
