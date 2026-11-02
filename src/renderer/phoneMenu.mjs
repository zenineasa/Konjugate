/* Copyright © 2026 Zenin Easa Panthakkalakath */

// On a phone the title bar has no room for its file actions and panel buttons, so styles.css hides them below
// phoneMaxWidth and this menu lists them instead. Each entry presses the real button, so a menu item always does
// exactly what its button does, and a button that appears or disappears elsewhere in the page needs no change here.
export const phoneMaxWidth = 700;

export const phoneMenuEntries = [
    { id: 'loadButton', label: 'Open project' },
    { id: 'saveButton', label: 'Save project' },
    { id: 'saveEncryptedButton', label: 'Save encrypted…' },
    { id: 'exportCsvButton', label: 'Export results as CSV' },
    { id: 'exportCodeButton', label: 'Export simulation code' },
    { id: 'exampleButton', label: 'Examples', separated: true },
    { id: 'exampleGuideButton', label: 'About this example' },
    { id: 'assistantButton', label: 'Model assistant', separated: true },
    { id: 'parametersButton', label: 'Parameters' },
    { id: 'providerToolchainsButton', label: 'Provider toolchains' },
    { id: 'diagnosticsButton', label: 'Diagnostics log' },
    { id: 'offlineButton', label: 'Use offline' },
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
        // A button that states its own current meaning (the offline one says how far along it is) is listed under that.
        return [{ ...entry, label: button.dataset?.menuLabel || entry.label, disabled: Boolean(button.disabled) }];
    });
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
        menu.replaceChildren(...visiblePhoneMenuEntries((id) => document.getElementById(id)).map((entry) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            item.textContent = entry.label;
            item.disabled = entry.disabled;
            item.classList.toggle('separated', Boolean(entry.separated));
            item.addEventListener('click', () => {
                if (!entry.keepOpen) close();
                document.getElementById(entry.id).click();
            });
            return item;
        }));
    };
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
    window.matchMedia(`(min-width: ${phoneMaxWidth + 1}px)`).addEventListener('change', (event) => { if (event.matches) close(); });
}

if (typeof document !== 'undefined') installPhoneMenu();
