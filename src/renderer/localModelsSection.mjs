/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Model assistant › Run a model on this computer (docs/proposals/suggestedLocalModels.md): whether Ollama is
// running, with a link to its website if not (the app never downloads it); the suggested models, each downloaded
// through Ollama and then used in one click; and Hugging Face, searched for any other model Ollama can pull. What it
// shows is drawn from what Ollama says each time the page opens, and from pulls in progress, which go on when Settings
// is closed. `api` is window.localModels (absent in the web edition). `endpoint()` is the Ollama endpoint to use ('' for
// Ollama's default), `inUse()` the Ollama model the assistant uses now, if any, and `useModel({ model, title, think,
// timeoutSeconds })` makes the assistant use a model Ollama has.

import { formatBytes, huggingFaceOllamaName, memoryFit, memoryForFile, suggestedLocalModels } from '../suggestedLocalModels.mjs';

export function createLocalModelsSection({ root, api, endpoint = () => '', inUse = () => null, useModel, platform = '' }) {
    const find = (selector) => root.querySelector(selector);
    let status = null;
    let checking = null;
    const pulls = new Map();
    const failures = new Map();
    let chosenRepository = null;
    let files = [];

    const has = (model) => Boolean(status?.models?.some((entry) => entry.name.toLowerCase() === model.toLowerCase()
        || entry.name.toLowerCase() === `${model.toLowerCase()}:latest`));
    const setState = (text) => { find('#localModelsState').textContent = text; };

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // The control for one model: Download (with its progress and Stop while it runs), Use it, or In use.
    function actionFor(model, onUse) {
        const box = element('div', 'localModelAction');
        const pull = pulls.get(model);
        if (pull) {
            const progress = element('progress');
            progress.max = 1;
            if (pull.total > 0) progress.value = pull.completed / pull.total;
            progress.setAttribute('aria-label', `Downloading ${model}`);
            const text = element('small', 'localModelProgressText', pull.total > 0
                ? `${formatBytes(pull.completed)} of ${formatBytes(pull.total)}` : pull.status || 'Starting…');
            const stop = element('button', '', 'Stop');
            stop.type = 'button';
            stop.dataset.localModelStop = model;
            stop.addEventListener('click', () => api.cancelPull(model));
            box.append(progress, text, stop);
            return box;
        }
        const button = element('button', 'doneButton');
        button.type = 'button';
        if (inUse()?.toLowerCase() === model.toLowerCase() && has(model)) {
            button.textContent = 'In use';
            button.disabled = true;
            button.classList.remove('doneButton');
        } else if (has(model)) {
            button.textContent = 'Use it';
            button.dataset.localModelUse = model;
            button.addEventListener('click', async () => {
                button.disabled = true;
                try { await onUse(); } finally { render(); }
            });
        } else {
            button.textContent = 'Download';
            button.dataset.localModelDownload = model;
            button.addEventListener('click', () => download(model));
        }
        box.append(button);
        if (failures.has(model)) box.append(element('small', 'localModelError', failures.get(model)));
        return box;
    }

    async function download(model) {
        failures.delete(model);
        pulls.set(model, { completed: 0, total: 0, status: 'Starting…' });
        render();
        const result = await api.pull(endpoint(), model);
        pulls.delete(model);
        if (!result.ok) failures.set(model, result.error?.message ?? 'The download failed.');
        await check();
    }

    function renderCards() {
        const cards = find('#localModelsCards');
        cards.replaceChildren(...suggestedLocalModels.map((suggestion) => {
            const card = element('article', 'localModelCard');
            card.dataset.localModel = suggestion.model;
            const heading = element('div', 'localModelHeading');
            heading.append(element('strong', '', suggestion.title), element('span', 'localModelBadge', suggestion.badge));
            const facts = element('small', 'localModelFacts', `About ${formatBytes(suggestion.downloadBytes)} to download · needs ${Math.round(suggestion.memoryBytes / 2 ** 30)} GB of memory`);
            card.append(heading, element('p', '', suggestion.description), facts);
            const fit = memoryFit(suggestion.memoryBytes, status?.totalMemory);
            if (!fit.fits) card.append(element('small', 'localModelFit', fit.note));
            card.append(actionFor(suggestion.model, () => useModel({
                model: suggestion.model, title: suggestion.title, ...suggestion.configuration
            })));
            return card;
        }));
    }

    function renderFiles() {
        const results = find('#huggingFaceResults');
        const header = element('div', 'huggingFaceChosen');
        const back = element('button', '', '← Results');
        back.type = 'button';
        back.addEventListener('click', () => { chosenRepository = null; search(); });
        const open = element('button', '', 'Open on Hugging Face');
        open.type = 'button';
        open.addEventListener('click', () => api.openPage(chosenRepository.repository));
        header.append(back, element('strong', '', chosenRepository.repository), open);
        const rows = files.map((file) => {
            const name = huggingFaceOllamaName(chosenRepository.repository, file.quantization);
            const row = element('div', 'huggingFaceFile');
            row.dataset.huggingFaceFile = name;
            const fit = memoryFit(memoryForFile(file.size ?? 0), status?.totalMemory);
            const label = element('span', '', file.quantization);
            const details = element('small', '', `${formatBytes(file.size)}${fit.fits ? '' : ' · won’t fit on this computer'}`);
            const shortName = chosenRepository.repository.split('/').pop().replace(/-GGUF$/i, '');
            row.append(label, details, actionFor(name, () => useModel({ model: name, title: `${shortName} ${file.quantization}`, think: null, timeoutSeconds: 180 })));
            return row;
        });
        results.replaceChildren(header, ...(chosenRepository.license ? [element('small', 'huggingFaceLicense', `Licence: ${chosenRepository.license}. Check the model's page for its terms before you rely on it.`)] : []), ...rows);
        find('#huggingFaceStatus').textContent = files.length ? '' : 'This model has no GGUF file that Ollama can download by itself.';
    }

    let lastResults = [];
    function renderResults() {
        if (chosenRepository) { renderFiles(); return; }
        find('#huggingFaceResults').replaceChildren(...lastResults.map((result) => {
            const button = element('button', 'huggingFaceResult');
            button.type = 'button';
            button.dataset.huggingFaceRepository = result.repository;
            button.append(element('strong', '', result.repository), element('small', '', `${result.downloads.toLocaleString()} downloads${result.license ? ` · ${result.license}` : ''}`));
            button.addEventListener('click', () => choose(result));
            return button;
        }));
    }

    async function search() {
        const query = find('#huggingFaceSearch').value;
        find('#huggingFaceStatus').textContent = 'Searching Hugging Face…';
        try {
            lastResults = await api.searchHuggingFace(query);
            find('#huggingFaceStatus').textContent = lastResults.length ? '' : 'No models found.';
        } catch (error) {
            lastResults = [];
            find('#huggingFaceStatus').textContent = error.message;
        }
        renderResults();
    }

    async function choose(result) {
        chosenRepository = result;
        files = [];
        find('#huggingFaceStatus').textContent = 'Reading the model’s files…';
        find('#huggingFaceResults').replaceChildren();
        try {
            files = await api.huggingFaceFiles(result.repository);
            renderFiles();
        } catch (error) {
            find('#huggingFaceStatus').textContent = error.message;
        }
    }

    function render() {
        if (!api) {
            find('#localModelsDesktopOnly').hidden = false;
            for (const id of ['#localModelsMissing', '#localModelsCards', '#huggingFaceBrowser']) find(id).hidden = true;
            setState('');
            return;
        }
        const running = Boolean(status?.running);
        find('#localModelsMissing').hidden = !status || running;
        find('#localModelsLinuxNote').hidden = platform !== 'linux';
        find('#localModelsCards').hidden = !running;
        find('#huggingFaceBrowser').hidden = !running;
        setState(!status ? 'Looking for Ollama…' : running ? `Ollama ${status.version ?? ''} is running`.replace('  ', ' ') : 'Ollama is not running');
        find('#localModelsState').classList.toggle('stopped', Boolean(status) && !running);
        if (running) {
            renderCards();
            if (find('#huggingFaceBrowser').open) renderResults();
        }
    }

    // Asks Ollama again what it has. Several asks at once share one.
    async function check() {
        if (!api) { render(); return; }
        checking ??= (async () => {
            try {
                status = await api.status(endpoint());
                for (const model of status.pulling ?? []) if (!pulls.has(model)) pulls.set(model, { completed: 0, total: 0, status: 'Downloading…' });
            } catch (error) {
                status = { running: false, models: [], error: error.message };
            } finally {
                checking = null;
            }
        })();
        await checking;
        render();
    }

    if (api) {
        api.onPullProgress((progress) => {
            if (progress.finished) {
                pulls.delete(progress.model);
                if (progress.status === 'failed' && progress.error) failures.set(progress.model, progress.error);
                check();
                return;
            }
            pulls.set(progress.model, progress);
            if (root.isConnected && !root.closest('[hidden]')) render();
        });
        find('#openOllamaPage').addEventListener('click', () => api.openPage('ollama'));
        find('#checkOllamaAgain').addEventListener('click', () => { status = null; render(); check(); });
        find('#huggingFaceSearchButton').addEventListener('click', () => { chosenRepository = null; search(); });
        find('#huggingFaceSearch').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            chosenRepository = null;
            search();
        });
        find('#huggingFaceBrowser').addEventListener('toggle', () => {
            if (find('#huggingFaceBrowser').open && !lastResults.length && !chosenRepository) search();
        });
    }

    return Object.freeze({ check, render, get status() { return status; } });
}
