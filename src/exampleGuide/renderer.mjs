/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { convertLatexToMarkup } from '../../node_modules/mathlive/mathlive.min.mjs';
import { guideKindSuffix } from './guideKind.mjs';
import { describeCheckedAt, describeUpdateStatus } from '../updatePanel.mjs';
import { prepareGuideMarkdown } from './markdown.mjs';

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderInline(value) {
    return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/!\[([^\]]*)\]\((https:\/\/[^)]+)\)/g, '<img src="$2" alt="$1">')
        .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2" data-external-link>$1</a>')
        .replace(/\$([^$]+)\$/g, (_match, latex) => `<span class="inlineMath">${convertLatexToMarkup(latex)}</span>`);
}

function renderMarkdown(markdown) {
    const lines = escapeHtml(prepareGuideMarkdown(markdown)).split('\n');
    const output = [];
    let list = null;
    let code = false;
    for (const line of lines) {
        if (line.startsWith('```')) {
            if (code) output.push('</code></pre>'); else output.push('<pre><code>');
            code = !code;
            continue;
        }
        if (code) { output.push(`${line}\n`); continue; }
        const item = line.match(/^[-*] (.+)$/);
        if (item) {
            if (!list) { output.push('<ul>'); list = 'ul'; }
            output.push(`<li>${renderInline(item[1])}</li>`);
            continue;
        }
        if (list) { output.push('</ul>'); list = null; }
        const heading = line.match(/^(#{1,3}) (.+)$/);
        if (heading) { const level = heading[1].length; output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`); }
        else if (/^\$\$.+\$\$$/.test(line)) output.push(`<div class="equation">${convertLatexToMarkup(line.slice(2, -2), { mathstyle: 'displaystyle' })}</div>`);
        else if (line.trim()) output.push(`<p>${renderInline(line)}</p>`);
    }
    if (list) output.push('</ul>');
    return output.join('');
}

// One reusable card (thumbnail + title, linking out) for every card-shaped content type this
// window shows -- today that's curated onramp videos and recent blog posts, and it's deliberately
// kept generic rather than one-off markup per type, since a future "sponsored" content slot is
// expected to reuse this same shape. Card fields are escaped independently of renderMarkdown's own
// escaping pass, since post cards carry third-party RSS content that never flows through that
// pipeline at all.
function renderCard(card) {
    const thumbnail = card.thumbnailUrl
        ? `<img src="${escapeHtml(card.thumbnailUrl)}" alt="" loading="lazy">`
        : '<div class="cardThumbPlaceholder"></div>';
    return `<a class="card" href="${escapeHtml(card.url)}" data-external-link>
        <div class="cardThumb">${thumbnail}</div>
        <div class="cardTitle">${escapeHtml(card.title)}</div>
    </a>`;
}

function renderCardSection(heading, cards) {
    if (!cards.length) return '';
    return `<h2>${escapeHtml(heading)}</h2><div class="cardGrid">${cards.map(renderCard).join('')}</div>`;
}

// The one-time starter-pack offer (see the Recommended add-ons section of docs/extensionsExplorer.md).
// A distinct block rather than reusing renderCard/renderCardSection above -- those are built for
// "thumbnail + title, links out on click," and this needs an in-app action (install, then an
// inline result) instead, which is a different interaction shape, not just different content.
function renderRecommendedAddons(entries) {
    if (!entries.length) return '';
    const items = entries.map((entry) => `<li><strong>${escapeHtml(entry.title || entry.prefix)}</strong><span>${escapeHtml(entry.description || '')}</span></li>`).join('');
    return `<div class="recommendedAddons">
        <h2>Recommended for you</h2>
        <p>These aren't installed yet, and add real functionality most projects end up wanting.</p>
        <ul class="recommendedAddonsList">${items}</ul>
        <button id="installRecommendedAddons" type="button">Install recommended</button>
        <p id="recommendedAddonsStatus" class="recommendedAddonsStatus" hidden></p>
    </div>`;
}

// ---- The Updates section (Welcome window only; see docs/updates.md)
//
// Everything it says comes from describeUpdateStatus (src/updatePanel.mjs), which is tested; this only
// draws it and wires the buttons. The status itself is held by the main process and pushed here
// whenever it changes, so the section stays right while the window is open.
let updateStatus = null;
let checkingForUpdate = false;

function renderUpdatesSection() {
    const container = document.querySelector('#updatesSection');
    if (!container) return;
    if (!updateStatus) {
        container.hidden = true;
        return;
    }
    container.hidden = false;
    const model = describeUpdateStatus(updateStatus);
    const checked = describeCheckedAt(updateStatus.checkedAt, Date.now());
    const buttons = model.actions.map((action, index) => `<button type="button" class="${action.kind === 'skip' || action.secondary ? 'updatesSecondary' : ''}" data-action-index="${index}">${escapeHtml(action.label)}</button>`).join('');
    const links = model.links.map((link) => `<a href="${escapeHtml(link.url)}" data-update-link>${escapeHtml(link.label)}</a>`).join(' · ');
    container.innerHTML = `
        <div class="updatesHeadline">${escapeHtml(model.headline)}</div>
        ${model.detail ? `<p class="updatesDetail">${escapeHtml(model.detail)}</p>` : ''}
        ${model.notice ? `<p class="updatesNotice">${escapeHtml(model.notice)}</p>` : ''}
        ${model.command ? `<pre class="updatesCommand">${escapeHtml(model.command)}</pre>` : ''}
        ${buttons ? `<div class="updatesActions">${buttons}</div>` : ''}
        ${model.hint ? `<p class="updatesHint">${escapeHtml(model.hint)}</p>` : ''}
        <div class="updatesFooter">
            ${model.canCheck ? `<button type="button" class="updatesSecondary" data-check ${checkingForUpdate ? 'disabled' : ''}>${checkingForUpdate ? 'Checking…' : 'Check for updates'}</button>` : ''}
            <span>${links}${checked ? ` · ${escapeHtml(checked)}` : ''}</span>
        </div>`;
    container.querySelectorAll('[data-action-index]').forEach((button) => button.addEventListener('click', async () => {
        const action = model.actions[Number(button.dataset.actionIndex)];
        if (action.kind === 'link') {
            window.exampleGuide.openExternal(action.url);
        } else if (action.kind === 'copy') {
            button.textContent = await window.appUpdate.copyCommand() ? 'Copied' : 'Copy failed';
            setTimeout(renderUpdatesSection, 1500);
        } else if (action.kind === 'skip') {
            updateStatus = (await window.appUpdate.skip(action.version)) ?? updateStatus;
            renderUpdatesSection();
        }
    }));
    container.querySelector('[data-check]')?.addEventListener('click', async () => {
        checkingForUpdate = true;
        renderUpdatesSection();
        try {
            updateStatus = (await window.appUpdate.checkNow()) ?? updateStatus;
        } finally {
            checkingForUpdate = false;
            renderUpdatesSection();
        }
    });
    container.querySelectorAll('[data-update-link]').forEach((link) => link.addEventListener('click', (event) => {
        event.preventDefault();
        window.exampleGuide.openExternal(link.href);
    }));
}

window.appUpdate.onChange((status) => {
    updateStatus = status;
    renderUpdatesSection();
});

document.querySelector('#minimize').addEventListener('click', () => window.windowControls.minimize());
document.querySelector('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
document.querySelector('#close').addEventListener('click', () => window.windowControls.close());
window.windowControls.onMaximizedChange((expanded) => { document.querySelector('#maximize').textContent = expanded ? '❐' : '□'; });
window.exampleGuide.onContent(({ title, version, markdown, cards = [], recommendedAddons = [], kind = 'example' }) => {
    const suffix = guideKindSuffix(kind);
    document.title = `${title} · ${suffix}`;
    document.querySelector('#guideTitle').textContent = `${title} · ${suffix}`;
    const versionHeading = version ? `<h1>Welcome to Konjugate v${escapeHtml(version)}</h1>` : '';
    // Only the Welcome window carries the Updates section; the other guides share this page.
    const updatesSection = kind === 'welcome' ? '<section id="updatesSection" class="updatesSection" aria-live="polite" hidden></section>' : '';
    document.querySelector('#content').innerHTML = versionHeading + updatesSection + renderMarkdown(markdown)
        + renderRecommendedAddons(recommendedAddons)
        + renderCardSection('Get started', cards.filter((card) => card.section === 'video'))
        + renderCardSection('Recent from the blog', cards.filter((card) => card.section === 'post'));
    document.querySelectorAll('[data-external-link]').forEach((link) => link.addEventListener('click', (event) => {
        event.preventDefault();
        window.exampleGuide.openExternal(link.href);
    }));
    document.querySelector('#installRecommendedAddons')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const status = document.querySelector('#recommendedAddonsStatus');
        button.disabled = true;
        button.textContent = 'Installing…';
        try {
            const results = await window.exampleGuide.installRecommendedAddons(recommendedAddons);
            const summary = results.map((result) => `${result.packageId} ${result.version}`).join(', ');
            status.hidden = false;
            status.innerHTML = `Installed ${escapeHtml(summary)}. `;
            const restartButton = document.createElement('button');
            restartButton.type = 'button';
            restartButton.textContent = 'Restart Konjugate';
            restartButton.addEventListener('click', () => window.exampleGuide.restart());
            status.appendChild(restartButton);
            button.remove();
        } catch (error) {
            button.disabled = false;
            button.textContent = 'Install recommended';
            status.hidden = false;
            status.textContent = `Installation failed: ${error.message}`;
        }
    });
    document.querySelector('#content').scrollTop = 0;
    if (kind === 'welcome') {
        window.appUpdate.status().then((status) => {
            updateStatus = status;
            renderUpdatesSection();
        });
    }
});
