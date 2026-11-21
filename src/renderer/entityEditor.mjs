/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The card a node, a relationship, a source term or a relationship group is edited in (docs/proposals/unifiedEntityEditors.md):
// the part every one of them shares, written once. A card is marked `data-entity-editor="<kind>"` in index.html, its tabs
// `data-editor-tab` and their panels `data-editor-panel`; what each kind shows inside its panels stays the caller's.
//
// The shell owns: switching tabs, which tab a card opens on (the one asked for, else Results while results are open, else
// the one a person last chose for that kind, else the first), opening and closing the card, sending a person to a control
// on whichever tab it is, and the one rule for locking every card while results are open.

const lastChosenTab = new Map();

export class EntityEditor {
    // `card`: the element; `hooks`: { hideOthers(card), afterShow(card), resultsOpen(), onSelect(tab) } from the canvas.
    constructor(card, hooks = {}) {
        this.card = card;
        this.kind = card.dataset.entityEditor;
        this.hooks = hooks;
        for (const button of this.tabButtons()) {
            button.addEventListener('click', () => this.select(button.dataset.editorTab, { chosen: true }));
        }
    }

    tabButtons() {
        return [...this.card.querySelectorAll('[data-editor-tab]')];
    }

    // The tabs this card shows now (a tab can be left out for an entity that has nothing for it).
    tabs() {
        return this.tabButtons().filter((button) => !button.hidden).map((button) => button.dataset.editorTab);
    }

    activeTab() {
        return this.card.querySelector('[data-editor-tab].active')?.dataset.editorTab ?? null;
    }

    isOpen() {
        return !this.card.classList.contains('hidden');
    }

    // Shows one tab. `chosen` marks a person's choice, which the kind then opens on next time.
    select(tab, { chosen = false } = {}) {
        if (!this.tabs().includes(tab)) return;
        for (const button of this.tabButtons()) button.classList.toggle('active', button.dataset.editorTab === tab);
        for (const panel of this.card.querySelectorAll('[data-editor-panel]')) panel.hidden = panel.dataset.editorPanel !== tab;
        if (chosen) lastChosenTab.set(this.kind, tab);
        this.hooks.onSelect?.(tab);
    }

    // The tab the card opens on.
    openingTab(requested = null) {
        const tabs = this.tabs();
        if (requested && tabs.includes(requested)) return requested;
        if (this.hooks.resultsOpen?.() && tabs.includes('results')) return 'results';
        const remembered = lastChosenTab.get(this.kind);
        return remembered && tabs.includes(remembered) ? remembered : tabs[0];
    }

    // Hides the other cards, lets `render` fill this one, shows it on its opening tab and applies the results lock.
    open({ tab = null, render = null } = {}) {
        this.hooks.hideOthers?.(this.card);
        render?.();
        this.select(this.openingTab(tab));
        this.card.style.removeProperty('left');
        this.card.style.removeProperty('top');
        this.card.classList.remove('hidden');
        this.hooks.afterShow?.(this.card);
    }

    close() {
        this.card.classList.add('hidden');
    }

    // Shows the tab `control` is on, and focuses it unless told not to. Returns the control, or null.
    reveal(control, { focus = true } = {}) {
        if (!control) return null;
        const panel = control.closest('[data-editor-panel]');
        if (panel?.hidden) this.select(panel.dataset.editorPanel);
        if (focus) control.focus();
        return control;
    }

    // A new project starts every kind on its first tab again.
    static forgetChosenTabs() {
        lastChosenTab.clear();
    }
}

// The controls every editor card disables while results are open: its panels' inputs and buttons (but not those that only
// go somewhere, marked `data-navigation`, nor a Results panel) and its footer's actions.
export const resultLockedControls = '[data-entity-editor] [data-editor-panel]:not([data-editor-panel="results"]) :is(input, select, textarea, button):not([data-navigation]), [data-entity-editor] > footer button';
export const resultLockedMathFields = '[data-entity-editor] [data-editor-panel] math-field';
