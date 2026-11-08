/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Settings sheet: its pages down the left (from src/renderer/settingsPages.mjs, searched there) and the open page on the right,
// as an operating system's settings are laid out; on a phone, the list of pages first, then a page with a way back to the list. What
// each page shows is the window's: `opened[id]()` fills a page when it is shown. `canLeave(id)` is asked before the page `id` is left
// (a model configuration with changes not saved asks the person), and `beforeClose()` is awaited before the sheet closes (a change
// still being kept is finished).

import { availableSettingsPages, defaultSettingsPage, matchingSettingsPages, settingsPage } from './settingsPages.mjs';
import { isPhoneLayout } from './phoneLayout.mjs';

// `has(requirement)`: whether this window has what a page requires (src/renderer/settingsPages.mjs). `left[id]()` is told when the page
// `id` stops being shown (a key shown once is put away).
export function createSettingsSheet({ dialog, opened = {}, left = {}, has = () => true, canLeave = () => true, beforeClose = async () => {}, onClosed = () => {} }) {
    const find = (selector) => dialog.querySelector(selector);
    const list = find('#settingsSidebarList');
    const search = find('#settingsSearch');
    let current = null;
    let last = defaultSettingsPage;
    const waiting = [];
    const textOf = (id) => find(`[data-settings-page="${id}"]`)?.textContent ?? '';
    const pages = availableSettingsPages(has);
    // A page the window cannot offer is never shown, even when asked for by name.
    const offered = (id) => pages.find((page) => page.id === id) ?? settingsPage(defaultSettingsPage);
    const leave = () => { if (current) left[current]?.(); };

    function renderSidebar() {
        const shown = matchingSettingsPages(search.value, textOf, pages);
        list.replaceChildren(...shown.map((page) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'settingsSidebarItem';
            item.role = 'tab';
            item.dataset.settingsTarget = page.id;
            item.setAttribute('aria-selected', String(page.id === current));
            item.tabIndex = page.id === current || (!current && page === shown[0]) ? 0 : -1;
            const icon = document.createElement('span');
            icon.className = 'settingsSidebarIcon';
            icon.ariaHidden = 'true';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', page.icon);
            svg.append(path);
            icon.append(svg);
            const title = document.createElement('span');
            title.textContent = page.title;
            item.append(icon, title);
            item.addEventListener('click', () => show(page.id));
            return item;
        }));
        find('#settingsSearchEmpty').hidden = shown.length > 0;
    }

    // Shows the page `id` (General for one it does not know, or one this window cannot offer).
    async function show(id) {
        const page = offered(id);
        if (current && current !== page.id && !canLeave(current)) return false;
        if (current !== page.id) leave();
        current = page.id;
        last = page.id;
        for (const section of dialog.querySelectorAll('[data-settings-page]')) section.hidden = section.dataset.settingsPage !== page.id;
        find('#settingsPageTitle').textContent = page.title;
        dialog.dataset.view = 'page';
        renderSidebar();
        await opened[page.id]?.();
        return true;
    }

    // The list of pages, on a phone, with no page open.
    function showList() {
        if (current && !canLeave(current)) return false;
        leave();
        current = null;
        for (const section of dialog.querySelectorAll('[data-settings-page]')) section.hidden = true;
        dialog.dataset.view = 'list';
        renderSidebar();
        list.querySelector('.settingsSidebarItem')?.focus();
        return true;
    }

    // Opens the sheet on the page `id`; with none named, on the page last shown, or on a phone on the list of pages.
    async function open(id = null) {
        if (!dialog.open) {
            search.value = '';
            current = null;
            dialog.showModal();
        }
        if (id || !isPhoneLayout()) return show(id ?? last);
        showList();
        return true;
    }

    async function close() {
        if (!dialog.open) return true;
        if (current && !canLeave(current)) return false;
        await beforeClose();
        dialog.close();
        return true;
    }

    search.addEventListener('input', renderSidebar);
    search.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const first = matchingSettingsPages(search.value, textOf, pages)[0];
        if (first) show(first.id);
    });
    // Up and down move along the pages, as in a list.
    list.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const items = [...list.querySelectorAll('.settingsSidebarItem')];
        const at = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
        items[next]?.focus();
        event.preventDefault();
    });
    find('#settingsClose').addEventListener('click', () => close());
    find('#settingsBack').addEventListener('click', () => showList());
    // Escape on a phone's page goes back to the list; otherwise it closes the sheet, once the page may be left.
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (isPhoneLayout() && dialog.dataset.view === 'page') showList();
        else close();
    });
    dialog.addEventListener('close', () => {
        leave();
        current = null;
        onClosed();
        for (const resolve of waiting.splice(0)) resolve();
    });

    return Object.freeze({
        open, close, show, showList,
        get page() { return dialog.open ? current : null; },
        // Resolves once the sheet is closed (at once if it is).
        closed: () => new Promise((resolve) => (dialog.open ? waiting.push(resolve) : resolve())),
        pages
    });
}
