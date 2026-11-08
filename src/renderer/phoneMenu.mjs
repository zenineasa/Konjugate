/* Copyright © 2026 Zenin Easa Panthakkalakath */

// On a phone the title bar has no room for its file actions and panel buttons, so styles.css hides them below
// the phone layout's breakpoint (phoneLayout.mjs) and this menu lists them instead. Each entry presses the real button, so a menu item always does
// exactly what its button does, and a button that appears or disappears elsewhere in the page needs no change here.
import { onPhoneLayoutChange } from './phoneLayout.mjs';
export { phoneMaxWidth } from './phoneLayout.mjs';

export const phoneMenuEntries = [
    { id: 'loadButton', label: 'Open project' },
    { id: 'saveButton', label: 'Save project' },
    { id: 'saveEncryptedButton', label: 'Save encrypted…' },
    { id: 'exportCsvButton', label: 'Export results as CSV' },
    { id: 'exportCodeButton', label: 'Export simulation code' },
    { id: 'ownershipButton', label: 'Project properties' },
    { id: 'exampleButton', label: 'Examples', separated: true },
    { id: 'exampleGuideButton', label: 'About this example' },
    { id: 'assistantButton', label: 'Model assistant', separated: true },
    { id: 'causalInferenceButton', label: 'Causal inference' },
    { id: 'parameterTuningButton', label: 'Parameter tuning' },
    { id: 'parametersButton', label: 'Parameters' },
    { id: 'settingsButton', label: 'Settings' },
    { id: 'extensionsButton', label: 'Extensions' },
    { id: 'diagnosticsButton', label: 'Diagnostics log' },
    { id: 'offlineButton', label: 'Use offline' },
    { id: 'updateCheckButton', label: 'Check for updates', keepOpen: true },
    { id: 'versionInfoButton', label: 'Version', keepOpen: true },
    { id: 'nodeLabelsButton', label: 'Node labels', useTitle: true, keepOpen: true, separated: true },
    { id: 'edgeLabelsButton', label: 'Relationship labels', useTitle: true, keepOpen: true },
    { id: 'welcomeButton', label: 'About Konjugate', separated: true },
    { id: 'zoomInButton', label: 'Larger interface', keepOpen: true },
    { id: 'zoomOutButton', label: 'Smaller interface', keepOpen: true }
];

// The entries to show, given a way to find each one's button: a button the page has hidden (or does not have) is left out,
// and a disabled one is listed but cannot be chosen.
export function visiblePhoneMenuEntries(lookup, entries = phoneMenuEntries) {
    return entries.flatMap((entry) => {
        const button = lookup(entry.id);
        if (!button || button.hidden) return [];
        // A button that states its own current meaning (the offline one says how far along it is) is listed under that, and one whose
        // title does (a label button says which of its three modes it is in) under its title.
        return [{ ...entry, label: button.dataset?.menuLabel || (entry.useTitle && button.title) || entry.label, disabled: Boolean(button.disabled) }];
    });
}

// The add-on buttons of the rail, which the phone layout hides: listed after the fixed entries, each pressing its own button. An add-on
// has no id of its own in the list above, so these are read from the page as the rail built them.
function addonMenuEntries(root) {
    return [...root.querySelectorAll('#addonRailButtons button[id]')].map((button, index) => ({
        id: button.id, label: button.querySelector('.railToolLabel')?.textContent || button.dataset.tooltip || 'Add-on', separated: index === 0
    }));
}

function installPhoneMenu() {
    const trigger = document.getElementById('phoneMenuButton');
    if (!trigger) return;
    const menu = document.createElement('div');
    menu.id = 'phoneMenu';
    menu.className = 'phoneMenu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    document.body.appendChild(menu);

    const close = () => {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
    };
    const render = () => {
        menu.replaceChildren(...visiblePhoneMenuEntries((id) => document.getElementById(id), [...phoneMenuEntries, ...addonMenuEntries(document)]).map((entry) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            item.textContent = entry.label;
            item.disabled = entry.disabled;
            item.classList.toggle('separated', Boolean(entry.separated));
            item.addEventListener('click', () => {
                if (!entry.keepOpen) close();
                document.getElementById(entry.id).click();
                // An entry that stays open and says what it did (a label mode) is read again.
                if (entry.useTitle) { const [fresh] = visiblePhoneMenuEntries((id) => document.getElementById(id), [entry]); item.textContent = fresh.label; }
            });
            return item;
        }));
    };
    // A line that says how a check is getting on (the update one) is read again as it changes.
    document.addEventListener('konjugate:menu-labels', () => { if (!menu.hidden) render(); });
    trigger.addEventListener('click', () => {
        if (!menu.hidden) { close(); return; }
        render();
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('pointerdown', (event) => {
        if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.hidden) close();
    });
    onPhoneLayoutChange((phone) => { if (!phone) close(); });
}

if (typeof document !== 'undefined') {
    installPhoneMenu();
}
