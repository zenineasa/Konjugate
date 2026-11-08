/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The pages of Settings, written down once: the sidebar, its search and the phone's list of pages are all made from this list, and
// a page is reached by its id from anywhere (openSettings('controllers')). Settings holds what belongs to the person, kept on this
// computer, never what belongs to a project: a project's own details stay in Project properties, its run settings in the Run dialog.
// The Extensions Explorer is not one of them: it is a place to browse and install, with a button of its own in the titlebar.
// `icon` is a line drawing's SVG path (24 by 24, drawn with a 1.8 stroke) for the sidebar. `keywords` are the words a search finds a page by besides its title and what the page says; `requires` names what the window must
// have for the page to be shown at all (the push service listens on a port, which a web page cannot). No DOM.

export const settingsPages = Object.freeze([
    { id: 'general', title: 'General', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4', keywords: ['interface', 'size', 'zoom', 'larger', 'smaller', 'welcome', 'tour', 'version', 'about'] },
    { id: 'assistant', title: 'Model assistant', icon: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9zM18.5 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z', keywords: ['ai', 'model', 'provider', 'ollama', 'openai', 'gemini', 'nvidia', 'hugging face', 'api key', 'endpoint', 'configuration'] },
    { id: 'providers', title: 'Providers', icon: 'M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5.5l-3 13', keywords: ['compiler', 'c++', 'clang', 'python', 'interpreter', 'toolchain', 'execution mode', 'in-process', 'shared memory'] },
    { id: 'controllers', title: 'Controllers', icon: 'M7.5 8.5h9a4.5 4.5 0 0 1 4.4 5.4l-.4 2a2.6 2.6 0 0 1-4.6 1L14.5 15h-5l-1.4 1.9a2.6 2.6 0 0 1-4.6-1l-.4-2a4.5 4.5 0 0 1 4.4-5.4zM8 10.8v3M6.5 12.3h3M15.8 11.5h.01M17.6 13.3h.01', keywords: ['gamepad', 'joystick', 'midi', 'knob', 'fader', 'keyboard', 'keys', 'binding', 'bind', 'threshold', 'steer'] },
    { id: 'pushService', title: 'Push service', icon: 'M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3', requires: 'pushService', keywords: ['connections', 'scripts', 'readings', 'port', 'network', 'certificate', 'tls', 'keys', 'grpc', 'websocket', 'live twin', 'listen'] },
    { id: 'newProjects', title: 'New projects', icon: 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8zM14 3.5V8h4.5M12 11v6M9 14h6', keywords: ['owner', 'copyright', 'license', 'contact', 'defaults', 'ownership', 'confidential'] }
].map((page) => Object.freeze(page)));

export const defaultSettingsPage = 'general';

export const settingsPage = (id) => settingsPages.find((page) => page.id === id) ?? null;

const folded = (text) => String(text ?? '').toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// The pages a search finds, in the sidebar's order: every word typed must be in the page's title, its keywords or what it says
// (`textOf(id)`, the page's own words as shown). An empty search finds every page.
// The pages a window offers, given what it has: `has(requirement)` says whether a page's `requires` is there.
export const availableSettingsPages = (has = () => true, pages = settingsPages) => pages.filter((page) => !page.requires || has(page.requires));

export function matchingSettingsPages(query, textOf = () => '', pages = settingsPages) {
    const words = folded(query).split(' ').filter(Boolean);
    if (!words.length) return [...pages];
    return pages.filter((page) => {
        const haystack = folded([page.title, ...page.keywords, textOf(page.id)].join(' '));
        return words.every((word) => haystack.includes(word));
    });
}
