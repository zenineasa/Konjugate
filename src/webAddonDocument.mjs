/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The page an add-on runs in, in the web edition (docs/proposals/webEditionPackages.md, stage 3). The frame it runs in has an opaque
// origin and a Content-Security-Policy that allows nothing from outside (renderer/addonFrame.html), so it cannot fetch its own
// script, style or image files. This builds one self-contained document from the package's files: each local script, stylesheet and
// image the entry page names is read from the package and placed in the page, and the add-on's API (the same names as the desktop's
// addonPreload.cjs) is put in front of everything else. Nothing here is a security boundary; the frame is. A page that is not what
// this expects simply loses the part it did not get.

const decoder = new TextDecoder();

const mimeTypes = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
};

// The API the add-on sees as `konjugateVisualizer`. Calls go to the page as messages and are answered there; the page decides whether the
// add-on may have the answer. Written as one string because it is placed in the add-on's document, not run by the page.
// The plumbing every add-on's API shares: calls go to the page as messages and are answered there, and what the page tells it is passed to
// the callbacks registered for that channel. `expose` is the source of the statements that put the API on `window`.
const frameApi = (expose) => `(() => {
    const waiting = new Map();
    const listeners = {};
    let counter = 0;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = ++counter;
        waiting.set(id, { resolve, reject });
        parent.postMessage({ konjugate: 'call', id, method, params }, '*');
    });
    const listen = (channel) => (callback) => { (listeners[channel] ??= []).push(callback); };
    addEventListener('message', (event) => {
        const message = event.data;
        if (event.source !== parent || !message || typeof message !== 'object') return;
        if (message.konjugate === 'result') {
            const entry = waiting.get(message.id);
            waiting.delete(message.id);
            if (!entry) return;
            if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
        } else if (message.konjugate === 'event') {
            for (const callback of listeners[message.channel] ?? []) { try { callback(message.payload); } catch (error) { console.error(error); } }
        }
    });
${expose}
    parent.postMessage({ konjugate: 'ready' }, '*');
})()`;

// The API a result visualizer sees as `konjugateVisualizer`.
export const frameApiSource = frameApi(`    window.konjugateVisualizer = Object.freeze({
        getContext: () => call('getContext'),
        listSignals: () => call('listSignals'),
        getParameterChanges: () => call('getParameterChanges'),
        readSeries: (signalIds, options) => call('readSeries', { signalIds, options }),
        seek: (time) => { call('seek', { time: Number(time) }).catch(() => {}); },
        requestPacing: (pacing) => call('requestPacing', { pacing }),
        exportCsv: (suggestedFilename, csv) => call('exportCsv', { suggestedFilename, csv }),
        getProjectData: () => call('getProjectData'),
        setProjectData: (data) => call('setProjectData', { data }),
        getSettings: () => call('getSettings'),
        setSettings: (settings) => call('setSettings', { settings }),
        onTimelineChange: listen('timelineChange'),
        onSelectionChange: listen('selectionChange'),
        onSamplesAvailable: listen('samplesAvailable'),
        onRunStatusChange: listen('runStatusChange'),
        onPacingChange: listen('pacingChange'),
        onSessionChange: listen('sessionChange')
    });`);

// The API a launcher sees as `konjugateLauncher`: the desktop's launcherPreload.cjs surface. Every method answers { ok, ... } and never rejects
// for a refusal, as there.
const launcherMethods = ['getManifest', 'chooseFile', 'clearFile', 'fetchText', 'openLink', 'fetchFile', 'cacheInfo', 'clearCache', 'keepSession', 'reloadFiles', 'useSample', 'infer', 'runImport', 'runScenario', 'runBaseline', 'openInCanvas', 'restoreSession', 'exportResults', 'openPage', 'checkPython', 'storedFiles', 'storeFiles', 'downloadFile', 'cancelDownload', 'partialDownloads', 'discardPartialDownload', 'fileSize', 'describeStoredFile', 'removeStoredFile', 'useStoredFiles'];
export const launcherApiSource = frameApi(`    const methods = ${JSON.stringify('LAUNCHER_METHODS')};
    const api = {};
    // Positional arguments, named as the desktop's preload names them.
    const shapes = { chooseFile: ['importerId', 'role'], clearFile: ['importerId', 'role', 'name'], useSample: ['importerId'], runImport: ['importerId', 'options'], openPage: ['pageId'], openLink: ['url'], fetchText: ['url'], reloadFiles: ['importerId'] };
    // These take a scenario id and then an options object, spread beside it; runBaseline takes only the options.
    const withScenario = new Set(['openInCanvas', 'runScenario', 'exportResults']);
    for (const name of methods) api[name] = (...args) => call(name, name === 'fetchFile' ? { importerId: args[0], role: args[1], url: args[2], name: args[3], cache: (args[4] || {}).cache } : withScenario.has(name) ? { scenarioId: args[0] ?? null, ...(args[1] || {}) } : name === 'runBaseline' ? { ...(args[0] || {}) } : Object.fromEntries((shapes[name] || []).map((key, index) => [key, args[index]])));
    api.onProgress = listen('launcherProgress');
    window.konjugateLauncher = Object.freeze(api);
`.replace('"LAUNCHER_METHODS"', JSON.stringify(launcherMethods)));

// A path the page names, made relative to the package's root, or null when it is not a file of the package (an address on the web, a
// data: URL, an anchor). Throws when it climbs out of the package.
export function packagePath(reference, fromDirectory) {
    const bare = String(reference).trim().split(/[?#]/)[0];
    if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith('//') || String(reference).trim().startsWith('#')) return null;
    const parts = [];
    for (const part of (bare.startsWith('/') ? bare.slice(1) : `${fromDirectory}${bare}`).split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) throw new Error(`The add-on's page refers to ${reference}, which is outside the package.`);
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    return parts.join('/');
}

function toBase64(bytes) {
    let text = '';
    for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(text);
}

const dataUrl = (path, bytes) => `data:${mimeTypes[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream'};base64,${toBase64(bytes)}`;

// Text placed inside a <script> or <style> element must not be able to end it early or open a comment.
const insideScript = (text) => text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const insideStyle = (text) => text.replace(/<\/(style)/gi, '<\\/$1');

// Builds the add-on's document. `entry` is the package-relative path of its page and `readFile(path)` gives a file's bytes or null.
export async function buildAddonDocument({ entry, readFile, apiSource = frameApiSource }) {
    const directoryOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
    const load = async (reference, fromDirectory) => {
        const path = packagePath(reference, fromDirectory);
        if (path === null) return null;
        const bytes = await readFile(path);
        if (!bytes) throw new Error(`The add-on's page refers to ${reference}, which is not in the package.`);
        return { path, bytes };
    };
    const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find((value) => value !== undefined);
    const replaceAsync = async (text, pattern, replacer) => {
        const parts = [];
        let last = 0;
        for (const match of text.matchAll(pattern)) {
            parts.push(text.slice(last, match.index), await replacer(match));
            last = match.index + match[0].length;
        }
        return parts.join('') + text.slice(last);
    };
    // url(...) in a stylesheet, for the files it names.
    const inlineStyleUrls = (css, fromDirectory) => replaceAsync(css, /url\(\s*(?:"([^")]*)"|'([^')]*)'|([^)"'\s]+))\s*\)/gi, async (match) => {
        const loaded = await load(match[1] ?? match[2] ?? match[3], fromDirectory);
        return loaded ? `url("${dataUrl(loaded.path, loaded.bytes)}")` : match[0];
    });

    const entryBytes = await readFile(entry);
    if (!entryBytes) throw new Error(`The add-on's page ${entry} is not in the package.`);
    const base = directoryOf(entry);
    let html = decoder.decode(entryBytes);

    html = await replaceAsync(html, /<script\b[^>]*>\s*<\/script\s*>/gi, async (match) => {
        const source = attribute(match[0], 'src');
        const loaded = source === undefined ? null : await load(source, base);
        if (!loaded) return match[0];
        const type = attribute(match[0], 'type');
        return `<script${type ? ` type="${type}"` : ''}>${insideScript(decoder.decode(loaded.bytes))}</script>`;
    });
    html = await replaceAsync(html, /<link\b[^>]*>/gi, async (match) => {
        if (!/\srel\s*=\s*["']?stylesheet/i.test(match[0])) return match[0];
        const reference = attribute(match[0], 'href');
        const loaded = reference === undefined ? null : await load(reference, base);
        if (!loaded) return match[0];
        return `<style>${insideStyle(await inlineStyleUrls(decoder.decode(loaded.bytes), directoryOf(loaded.path)))}</style>`;
    });
    html = await replaceAsync(html, /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, async (match) => `<style>${insideStyle(await inlineStyleUrls(match[1], base))}</style>`);
    html = await replaceAsync(html, /<(img|source|image)\b[^>]*>/gi, async (match) => {
        const reference = attribute(match[0], 'src');
        const loaded = reference === undefined ? null : await load(reference, base);
        return loaded ? match[0].replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*')/i, `$1"${dataUrl(loaded.path, loaded.bytes)}"`) : match[0];
    });

    const api = `<script>${insideScript(apiSource)}</script>`;
    // The API goes first, so the add-on's own scripts find it; before <head> content if the page has a head, else at the start.
    const withApi = /<head\b[^>]*>/i.test(html)
        ? html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${api}`)
        : /<html\b[^>]*>/i.test(html) ? html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${api}</head>`) : `${api}${html}`;
    return /^\s*<!doctype/i.test(withApi) ? withApi : `<!doctype html>${withApi}`;
}
