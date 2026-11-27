/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Each step can carry `references`, what the document referred to when it was recorded (the FMUs, src/fmuLibrary.mjs), and reset its
// state when the history began: together every state Undo and Redo can bring back, which historyReferences gives.
export class DocumentController {
    #commands = [];
    #references = [];
    #baseReferences = [];
    #cursor = 0;
    #savedCursor = 0;
    #supplementalDirty = false;
    #listeners = new Set();

    get canUndo() { return this.#cursor > 0; }
    get canRedo() { return this.#cursor < this.#commands.length; }
    get dirty() { return this.#cursor !== this.#savedCursor || this.#supplementalDirty; }
    get historyReferences() { return [...this.#baseReferences, ...this.#references.flat()]; }

    subscribe(listener) {
        this.#listeners.add(listener);
        listener(this);
        return () => this.#listeners.delete(listener);
    }

    record(command, { references = [] } = {}) {
        if (typeof command?.undo !== 'function' || typeof command?.redo !== 'function') {
            throw new TypeError('A document command requires undo and redo functions.');
        }
        const branchPoint = this.#cursor;
        this.#commands.splice(branchPoint);
        this.#references.splice(branchPoint);
        this.#commands.push(command);
        this.#references.push([...references]);
        this.#cursor += 1;
        if (this.#savedCursor > branchPoint) this.#savedCursor = -1;
        this.#notify();
    }

    undo() {
        if (!this.canUndo) return false;
        this.#commands[this.#cursor - 1].undo();
        this.#cursor -= 1;
        this.#notify();
        return true;
    }

    redo() {
        if (!this.canRedo) return false;
        this.#commands[this.#cursor].redo();
        this.#cursor += 1;
        this.#notify();
        return true;
    }

    reset({ saved = true, references = [] } = {}) {
        this.#commands.length = 0;
        this.#references.length = 0;
        this.#baseReferences = [...references];
        this.#cursor = 0;
        this.#savedCursor = saved ? 0 : -1;
        this.#supplementalDirty = false;
        this.#notify();
    }

    setSupplementalDirty(dirty) {
        this.#supplementalDirty = Boolean(dirty);
        this.#notify();
    }

    markSaved() {
        this.#savedCursor = this.#cursor;
        this.#supplementalDirty = false;
        this.#notify();
    }

    #notify() {
        this.#listeners.forEach((listener) => listener(this));
    }
}
