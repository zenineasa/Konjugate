/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A rudimentary `--flag value` / `--flag` (boolean) parser -- no arg-parsing library, matching
// how the engine's own CLI (engine/src/main.cpp) parses its flags by hand.
export function parseCliFlags(args) {
    const flags = {};
    for (let index = 0; index < args.length; index += 1) {
        if (!args[index].startsWith('--')) continue;
        const key = args[index].slice(2);
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            flags[key] = next;
            index += 1;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

// requested (from --configuration) matches a run configuration's name first, then its numeric
// id -- lets a CLI user address a configuration by its human name without needing to know the
// internal id, while still accepting the id for scripts that already have one. With no
// requested value, falls back to the project's own active configuration, then its first one, and for a project that keeps none
// (most of the bundled examples), the one the app gives it when it opens (renderer.mjs's defaultRunConfiguration): a project
// that runs in the app runs from the command line too.
export const defaultRunConfiguration = Object.freeze({ id: 0, name: 'Default', globalTimeStep: 0.01, outputInterval: 0.1 });

export function matchRunConfiguration(runConfigurations, activeRunConfigurationId, requested) {
    if (requested) {
        return runConfigurations.find((item) => item.name === requested)
            ?? runConfigurations.find((item) => String(item.id) === String(requested))
            ?? null;
    }
    return runConfigurations.find((item) => item.id === activeRunConfigurationId) ?? runConfigurations[0] ?? { ...defaultRunConfiguration };
}
