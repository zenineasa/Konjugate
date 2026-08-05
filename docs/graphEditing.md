<!-- Copyright © 2026 Zenin Easa Panthakkalakath -->

# Graph selection and clipboard

Clicking a node selects it exclusively. Shift-clicking a node adds it to or removes it from the current node selection. A multi-selection can be moved as one group with either direct dragging or the move tool, and the complete movement is recorded as one undoable action.

The rectangle-selection tool in the toolstrip selects every visible node whose projected center lies inside the dragged rectangle. A normal drag replaces the current selection, while Shift-drag adds the enclosed nodes. The tool does not open inspectors or move the camera and remains active for repeated selections.

Deleting selected nodes is also one undoable action. Every relationship connected to any deleted node is hidden with it, including relationships to nodes outside the selection. Undo restores each relationship only if it was visible before deletion.

Copy writes a versioned Konjugate graph fragment to an application-specific operating-system clipboard format. A fragment contains the selected nodes and every visible relationship whose two endpoints are selected. Relationships crossing the selection boundary are intentionally excluded, so paste never creates dangling endpoints.

Paste allocates new IDs for every node, state, source term, relationship and parameter. Endpoint references, equation bindings and equation outputs are remapped to those new IDs before the fragment is applied. Relative node layout is retained with a visible position offset. One paste is one undoable action, and malformed or incomplete clipboard fragments are rejected without changing the model.

Subsystems will build on these selection semantics. A future subsystem operation can move a selected graph fragment into a nested container and convert relationships crossing its boundary into explicit ports without changing the contained entities' stable IDs.
