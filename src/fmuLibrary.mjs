/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Providers › FMUs in your library (the single FMU workflow, stage 4): what the library holds, which open model uses each FMU,
// and whether one can be removed. Pure, so the main process, the window and the tests share it. Only the models open now can be asked,
// so "no model uses it" means no open window's model does: a project that keeps the FMU in its file installs it again when opened, and
// one that only links it needs it added again, which the confirmation says. A window's Undo and Redo count too: an FMU a node had in a
// state its history can bring back (a deleted FMU node, or the FMU a node had before it was given another) is held for Undo there, and
// is not removable, since the node would come back without it.

const referenceKey = (reference) => `${reference.guid}\u0000${reference.version}`;
const distinctReferences = (references) => [...new Map(references.map((reference) => [referenceKey(reference), reference])).values()];

// The FMUs plain data refers to (an implementation of kind "fmi", anywhere in it), each once, in the order found: [{ guid, version }].
export function fmuReferences(...values) {
    const found = [];
    const seen = new WeakSet();
    const visit = (value) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (value.kind === 'fmi' && typeof value.fmuId === 'string') found.push({ guid: value.fmuId, version: value.fmuVersion });
        Object.values(value).forEach(visit);
    };
    values.forEach(visit);
    return distinctReferences(found);
}

// The FMUs a window's model refers to as it is now kept, cheaply enough to ask at every step of its history: its nodes' implementations
// and terms, deleted nodes too (a deleted node stays in the model, flagged, for Undo), and its component definitions.
export function modelFmuReferences(model) {
    return fmuReferences((model.nodes ?? []).map((node) => [node.implementation, node.sourceTerms]), model.subsystemDefinitions);
}

// What a window answers when asked which FMUs it uses: those its project document uses (`fmus`), and those only a state its Undo or Redo
// can bring back uses (`history`, from `historyReferences`).
export function fmuUsage(project, document, historyReferences = []) {
    const fmus = fmuReferences(document);
    const used = new Set(fmus.map(referenceKey));
    return { project, fmus, history: distinctReferences(historyReferences).filter((reference) => !used.has(referenceKey(reference))) };
}

const sizeText = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

// `installed`: the library's FMUs (listInstalledFmus). `usages`: one entry per open project window, { project, fmus: [{ guid, version }],
// history: [{ guid, version }] } (fmuUsage), or null for a window that did not answer, whose model may use any of them. Returns one row
// per FMU, by name then version: { guid, version, name, size, usedBy (the projects that use it, each once, sorted), heldForUndoBy (those
// whose Undo or Redo can bring back a node that uses it), removable, unanswered }.
export function fmuLibraryRows(installed, usages) {
    const unanswered = usages.filter((usage) => !usage).length;
    const projectsWith = (entry, list) => [...new Set(usages.filter(Boolean)
        .filter((usage) => (usage[list] ?? []).some((fmu) => fmu.guid === entry.packageId && fmu.version === entry.version))
        .map((usage) => usage.project))].sort((a, b) => a.localeCompare(b));
    return installed
        .map((entry) => {
            const usedBy = projectsWith(entry, 'fmus');
            const heldForUndoBy = projectsWith(entry, 'history').filter((project) => !usedBy.includes(project));
            return {
                guid: entry.packageId,
                version: entry.version,
                name: entry.name || entry.manifest?.modelName || entry.packageId,
                size: sizeText(entry.manifest?.archiveBytes),
                usedBy,
                heldForUndoBy,
                removable: !usedBy.length && !heldForUndoBy.length && !unanswered,
                unanswered
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}

// Why a row cannot be removed, as one line: in Settings' list under the FMU, and as the answer to a removal refused.
export function fmuInUseText({ usedBy = [], heldForUndoBy = [], unanswered = 0 }) {
    const parts = [];
    if (usedBy.length) parts.push(`Used by ${usedBy.join(', ')}`);
    if (heldForUndoBy.length) parts.push(`Undo in ${heldForUndoBy.join(', ')} can bring back a node that uses it`);
    if (!parts.length && unanswered) parts.push('An open window did not say whether its model uses it');
    return parts.join('; ');
}

// The answer to a removal refused: why, and what to do instead.
export function fmuRemovalRefusal(row) {
    if (row.usedBy.length || row.heldForUndoBy?.length) {
        // Removing its nodes is not enough: Undo could bring them back without it.
        return `${row.name}: ${fmuInUseText(row)}. Close those projects first.`;
    }
    return 'An open window did not say which FMUs its model uses, so nothing was removed. Try again in a moment.';
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
