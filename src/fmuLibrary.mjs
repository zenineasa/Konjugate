/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Providers › FMUs in your library (the single FMU workflow, stage 4): what the library holds, which open model uses each FMU,
// and whether one can be removed. Pure, so the main process, the window and the tests share it. Only the models open now can be asked,
// so "no model uses it" means no open window's model does: a project that keeps the FMU in its file installs it again when opened, and
// one that only links it needs it added again, which the confirmation says.

const sizeText = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

// `installed`: the library's FMUs (listInstalledFmus). `usages`: one entry per open project window, { project, fmus: [{ guid, version }] },
// or null for a window that did not answer, whose model may use any of them. Returns one row per FMU, by name then version:
// { guid, version, name, size, usedBy (the projects that use it, each once, sorted), removable, unanswered }.
export function fmuLibraryRows(installed, usages) {
    const unanswered = usages.filter((usage) => !usage).length;
    return installed
        .map((entry) => {
            const usedBy = [...new Set(usages.filter(Boolean)
                .filter((usage) => usage.fmus.some((fmu) => fmu.guid === entry.packageId && fmu.version === entry.version))
                .map((usage) => usage.project))].sort((a, b) => a.localeCompare(b));
            return {
                guid: entry.packageId,
                version: entry.version,
                name: entry.name || entry.manifest?.modelName || entry.packageId,
                size: sizeText(entry.manifest?.archiveBytes),
                usedBy,
                removable: !usedBy.length && !unanswered,
                unanswered
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}

// What Remove asks first.
export function fmuRemovalQuestion({ name, version }) {
    return [
        `Remove ${name} (version ${version}) from your library?`,
        'No model open now uses it.',
        'A project that keeps this FMU in its file installs it again when it is opened.',
        'A project not open now that links this FMU, rather than keeping it in its file, will need it added again with Add › FMU….'
    ].join(' ');
}
