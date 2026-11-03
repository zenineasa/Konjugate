/* Copyright © 2026 Zenin Easa Panthakkalakath */

// On a phone each panel that comes up from the bottom edge is a sheet over the model, and two are never wanted at once: the second would
// cover or sit on the first. Opening one puts away any other, through that one's own close button so the page's own state follows. The
// results bar is the other thing on the bottom edge and is not put away (it holds the playback); a sheet opened while it shows stands
// above it instead, by the height this keeps in --sheet-floor.
import { isPhoneLayout } from './phoneLayout.mjs';

const sheetIds = [
    'componentLibraryPanel', 'controlHistoryPanel', 'validationPanel', 'liveParameterPanel', 'forkParameterPanel', 'branchesPanel',
    'parametersPanel', 'diagnosticsPanel', 'assistantPanel', 'addPalette', 'addonPanel'
];

const isOpen = (element) => !element.hidden && !element.classList.contains('hidden');

function dismiss(element) {
    element.querySelector('header button[id^="close"], [data-close-card]')?.click();
    if (!isOpen(element)) return;
    // Nothing of its own put it away (the add menu has no close button): hidden the way the page hides it.
    if (element.classList.contains('contextCard')) element.classList.add('hidden');
    else element.hidden = true;
}

function installSheets() {
    const sheets = sheetIds.map((id) => document.getElementById(id)).filter(Boolean);
    const watcher = new MutationObserver((records) => {
        if (!isPhoneLayout()) return;
        for (const { target } of records) {
            if (!sheets.includes(target) || !isOpen(target)) continue;
            for (const other of sheets) if (other !== target && isOpen(other)) dismiss(other);
        }
    });
    for (const sheet of sheets) watcher.observe(sheet, { attributes: true, attributeFilter: ['hidden', 'class'] });

    const transport = document.getElementById('resultTransport');
    if (!transport) return;
    const setFloor = () => document.documentElement.style.setProperty('--sheet-floor', `${transport.hidden ? 0 : transport.offsetHeight}px`);
    new ResizeObserver(setFloor).observe(transport);
    new MutationObserver(setFloor).observe(transport, { attributes: true, attributeFilter: ['hidden', 'class'] });
    setFloor();
}

if (typeof document !== 'undefined') installSheets();
