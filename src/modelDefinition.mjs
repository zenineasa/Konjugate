/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What an editor snapshot (the before/after pair behind undo and redo) copies from a node or relationship definition.
//
// A snapshot copies every field of the definition EXCEPT those named here, rather than naming the fields it does copy.
// A field added to a definition later is then saved by editing and restored by undo with no further change, instead of
// being silently dropped until someone remembers to add it to a list. The lists below are the only place that says what
// editing leaves alone, and each name is there for a reason: the field is owned by something other than the editor card
// (the canvas object owns position, rotation and scale; geometry and colour have their own undoable paths) or it is
// runtime state with nothing to restore.

export const nodeSnapshotExcludedKeys = new Set([
    'id', 'position', 'rotation', 'scale', 'shape', 'importedGeometry', 'geometryFileName', 'color',
    'badgeClass', 'subsystemId', 'deleted', 'enabled'
]);

export const relationshipSnapshotExcludedKeys = new Set(['id', 'groupId', 'offset', 'deleted', 'enabled']);

// A snapshot also carries things that are not fields of the definition; a field of that name would collide.
export const snapshotReservedKeys = new Set(['sharedParameters', 'bindings']);

export function snapshotDefinition(definition, excludedKeys) {
    const snapshot = {};
    for (const [key, value] of Object.entries(definition)) {
        if (excludedKeys.has(key)) continue;
        if (snapshotReservedKeys.has(key)) throw new Error(`A definition cannot have a field named "${key}": a snapshot reserves it.`);
        snapshot[key] = structuredClone(value);
    }
    return snapshot;
}

// The fields of a snapshot that belong to the definition, as copies, ready to assign.
export function snapshotFields(snapshot, excludedKeys) {
    const fields = {};
    for (const [key, value] of Object.entries(snapshot)) {
        if (excludedKeys.has(key) || snapshotReservedKeys.has(key)) continue;
        fields[key] = structuredClone(value);
    }
    return fields;
}
