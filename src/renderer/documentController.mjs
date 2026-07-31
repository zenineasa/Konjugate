/* Copyright © 2026 Zenin Easa Panthakkalakath */

export class DocumentController {
    #commands = [];
    #cursor = 0;
    #savedCursor = 0;
    #listeners = new Set();

    get canUndo() { return this.#cursor > 0; }
    get canRedo() { return this.#cursor < this.#commands.length; }
    get dirty() { return this.#cursor !== this.#savedCursor; }

    subscribe(listener) {
        this.#listeners.add(listener);
        listener(this);
        return () => this.#listeners.delete(listener);
    }

    record(command) {
        if (typeof command?.undo !== 'function' || typeof command?.redo !== 'function') {
            throw new TypeError('A document command requires undo and redo functions.');
        }
        const branchPoint = this.#cursor;
        this.#commands.splice(branchPoint);
        this.#commands.push(command);
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

    reset({ saved = true } = {}) {
        this.#commands.length = 0;
        this.#cursor = 0;
        this.#savedCursor = saved ? 0 : -1;
        this.#notify();
    }

    markSaved() {
        this.#savedCursor = this.#cursor;
        this.#notify();
    }

    #notify() {
        this.#listeners.forEach((listener) => listener(this));
    }
}
