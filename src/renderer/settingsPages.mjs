/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The pages of Settings, written down once: the sidebar, its search and the phone's list of pages are all made from this list, and
// a page is reached by its id from anywhere (openSettings('controllers')). Settings holds what belongs to the person, kept on this
// computer, never what belongs to a project: a project's own details stay in Project properties, its run settings in the Run dialog.
// The Extensions Explorer is not one of them: it is a place to browse and install, with a button of its own in the titlebar.
// `keywords` are the words a search finds a page by besides its title and what the page says; `requires` names what the window must
// have for the page to be shown at all (the push service listens on a port, which a web page cannot). No DOM.

export const settingsPages = Object.freeze([
    { id: 'general', title: 'General', icon: '⚙', keywords: ['interface', 'size', 'zoom', 'larger', 'smaller', 'welcome', 'tour', 'version', 'about'] },
    { id: 'assistant', title: 'Model assistant', icon: '✦', keywords: ['ai', 'model', 'provider', 'ollama', 'openai', 'gemini', 'nvidia', 'hugging face', 'api key', 'endpoint', 'configuration'] },
    { id: 'providers', title: 'Providers', icon: '⚒', keywords: ['compiler', 'c++', 'clang', 'python', 'interpreter', 'toolchain', 'execution mode', 'in-process', 'shared memory'] },
    { id: 'controllers', title: 'Controllers', icon: '⌨\uFE0E', keywords: ['gamepad', 'joystick', 'midi', 'knob', 'fader', 'keyboard', 'keys', 'binding', 'bind', 'threshold', 'steer'] },
    { id: 'pushService', title: 'Push service', icon: '⇄', requires: 'pushService', keywords: ['connections', 'scripts', 'readings', 'port', 'network', 'certificate', 'tls', 'keys', 'grpc', 'websocket', 'live twin', 'listen'] },
    { id: 'newProjects', title: 'New projects', icon: '❐', keywords: ['owner', 'copyright', 'license', 'contact', 'defaults', 'ownership', 'confidential'] }
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
