/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { convertLatexToMarkup } from '../../node_modules/mathlive/mathlive.min.mjs';
import { guideKindSuffix } from './guideKind.mjs';
import { describeCheckedAt, describeUpdateStatus } from '../updatePanel.mjs';
import { featuredLabel, visibleEpisodes, welcomeLinks, welcomeSectionOrder } from '../welcomeModel.mjs';
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

// One reusable card (thumbnail + title, linking out) for every card-shaped content type this window
// shows: the On-Ramp episodes, More to watch, and recent blog posts. Card fields are escaped
// independently of renderMarkdown's own escaping pass, since post cards carry third-party RSS content
// that never flows through that pipeline at all. An episode card carries its video id (so opening it
// can be remembered) and a small "Opened" mark once it has been.
function renderCard(card, { opened = false } = {}) {
    const thumbnail = card.thumbnailUrl
        ? `<img src="${escapeHtml(card.thumbnailUrl)}" alt="" loading="lazy">`
        : '<div class="cardThumbPlaceholder"></div>';
    const linkAttribute = card.videoId ? `data-episode-link data-video-id="${escapeHtml(card.videoId)}"` : 'data-external-link';
    return `<a class="card${opened ? ' cardOpened' : ''}" href="${escapeHtml(card.url)}" ${linkAttribute}>
        <div class="cardThumb">${thumbnail}${opened ? '<span class="cardOpenedMark">Opened</span>' : ''}</div>
        <div class="cardTitle">${escapeHtml(card.title)}</div>
    </a>`;
}

const youtubeCard = (video) => ({ title: video.title, videoId: video.videoId, url: `https://www.youtube.com/watch?v=${video.videoId}`, thumbnailUrl: `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg` });

// ---- The Welcome window (docs/proposals/welcomeWindow.md)
//
// Built from `welcome`, a state object: the content that arrived with the window, the patches that
// arrive after it (blog posts, the add-on offer, a fresh Featured feed), and the few bits of
// interaction state that must survive a re-render (a Show all, an install in progress, "Copied").
// Every change re-renders the whole page in the order welcomeSectionOrder gives, and the page keeps its
// scroll position, so nothing that arrives late can jump the page or undo what the person just did.
let welcome = null;

function renderRecommendedAddons(entries, status) {
    const items = entries.map((entry) => `<li><strong>${escapeHtml(entry.title || entry.prefix)}</strong><span>${escapeHtml(entry.description || '')}</span></li>`).join('');
    const installed = status.phase === 'installed';
    return `<div class="recommendedAddons">
        <h2>Recommended for you</h2>
        <p>These aren't installed yet, and add real functionality most projects end up wanting.</p>
        <ul class="recommendedAddonsList">${items}</ul>
        ${installed ? '' : `<button id="installRecommendedAddons" type="button" ${status.phase === 'installing' ? 'disabled' : ''}>${status.phase === 'installing' ? 'Installing…' : 'Install recommended'}</button>`}
        <p id="recommendedAddonsStatus" class="recommendedAddonsStatus" ${status.phase === 'idle' || status.phase === 'installing' ? 'hidden' : ''}>${escapeHtml(status.text ?? '')}${installed ? ' <button type="button" id="restartKonjugate">Restart Konjugate</button>' : ''}</p>
    </div>`;
}

function renderWhatsNew(whatsNew) {
    const highlights = whatsNew.highlights.length ? `<ul>${whatsNew.highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '';
    return `<section class="whatsNew">
        <h2>What's new in ${escapeHtml(whatsNew.version)}</h2>
        <p>Konjugate was updated from ${escapeHtml(whatsNew.previous)}.</p>
        ${highlights}
        <p><a href="${escapeHtml(whatsNew.url)}" data-external-link>Read the full release notes</a></p>
    </section>`;
}

const featuredActionLabel = { video: 'Watch', sponsored: 'Learn more', announcement: 'Read more' };

function renderFeatured(item) {
    const image = item.imageUrl ? `<img class="featuredImage" src="${escapeHtml(item.imageUrl)}" alt="">` : '';
    return `<section class="featured featured-${escapeHtml(item.kind)}">
        <div class="featuredLabel">${escapeHtml(featuredLabel(item.kind))}</div>
        ${image}
        <div class="featuredBody">
            <div class="featuredTitle">${escapeHtml(item.title)}</div>
            ${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}
            <button type="button" data-featured-open="${escapeHtml(item.id)}">${escapeHtml(featuredActionLabel[item.kind] ?? 'Learn more')}</button>
        </div>
        <button type="button" class="featuredDismiss" data-featured-dismiss="${escapeHtml(item.id)}" aria-label="Dismiss this">×</button>
    </section>`;
}

function renderOnRamp() {
    const { shown, hidden } = visibleEpisodes(welcome.onRamp.episodes, welcome.onRampExpanded);
    const opened = new Set(welcome.openedEpisodes);
    const cards = shown.map((episode) => renderCard(episode, { opened: opened.has(episode.videoId) })).join('');
    const extras = [
        hidden ? `<button type="button" class="linkButton" data-show-all>Show all (${hidden} more)</button>` : '',
        welcome.onRamp.playlistUrl ? `<a href="${escapeHtml(welcome.onRamp.playlistUrl)}" data-external-link>Watch the full playlist</a>` : ''
    ].filter(Boolean).join(' · ');
    return `<h2>Learn Konjugate: the On-Ramp</h2>
        <p class="sectionIntro">The tutorial series, in order. Come back to it any time.</p>
        <div class="cardGrid">${cards}</div>
        ${extras ? `<p class="onRampMore">${extras}</p>` : ''}`;
}

function renderCommunity() {
    return `<h2>Community &amp; help</h2>
        <div class="communityRow">
            <a class="communityLink communityDiscord" href="${welcomeLinks.discord}" data-external-link>Join the Discord community</a>
            <a class="communityLink" href="${welcomeLinks.documentation}" data-external-link>Documentation</a>
            <a class="communityLink" href="${welcomeLinks.reportProblem}" data-external-link>Report a problem</a>
            <button type="button" class="communityLink" data-copy-details>${welcome.detailsCopied ? 'Copied' : 'Copy details for a bug report'}</button>
        </div>
        <p class="communityNote">Reporting a problem? Copy the details and paste them into the report: they say which version and system you have.</p>`;
}

const sectionRenderers = {
    heading: () => `<h1>Welcome to Konjugate v${escapeHtml(welcome.version)}</h1>`,
    status: () => '<section id="updatesSection" class="updatesSection" aria-live="polite" hidden></section>',
    recommended: () => renderRecommendedAddons(welcome.recommendedAddons, welcome.recommendedStatus),
    whatsNew: () => renderWhatsNew(welcome.whatsNew),
    featured: () => renderFeatured(welcome.featured),
    onRamp: renderOnRamp,
    moreToWatch: () => `<h2>More to watch</h2><div class="cardGrid">${welcome.moreToWatch.map((video) => renderCard(youtubeCard(video))).join('')}</div>`,
    blog: () => `<h2>Recent from the blog</h2><div class="cardGrid">${welcome.posts.map((post) => renderCard(post)).join('')}</div>`,
    community: renderCommunity,
    footer: () => `<footer class="welcomeFooter">${renderMarkdown(welcome.markdown)}</footer>`
};

function renderWelcome({ resetScroll = false } = {}) {
    const content = document.querySelector('#content');
    const scroll = content.scrollTop;
    const order = welcomeSectionOrder({
        hasRecommended: welcome.recommendedAddons.length > 0, hasWhatsNew: Boolean(welcome.whatsNew), hasFeatured: Boolean(welcome.featured),
        hasMoreToWatch: welcome.moreToWatch.length > 0, hasPosts: welcome.posts.length > 0
    });
    content.innerHTML = order.map((section) => sectionRenderers[section]()).join('');
    content.scrollTop = resetScroll ? 0 : scroll;
    wireWelcome();
    renderUpdatesSection();
}

function wireWelcome() {
    const content = document.querySelector('#content');
    content.querySelectorAll('[data-external-link]').forEach((link) => link.addEventListener('click', (event) => {
        event.preventDefault();
        window.exampleGuide.openExternal(link.href);
    }));
    content.querySelectorAll('[data-episode-link]').forEach((link) => link.addEventListener('click', async (event) => {
        event.preventDefault();
        window.exampleGuide.openExternal(link.href);
        const videoId = link.dataset.videoId;
        if (!welcome.openedEpisodes.includes(videoId) && await window.exampleGuide.markEpisodeOpened(videoId)) {
            welcome.openedEpisodes = [...welcome.openedEpisodes, videoId];
            renderWelcome();
        }
    }));
    content.querySelector('[data-show-all]')?.addEventListener('click', () => {
        welcome.onRampExpanded = true;
        renderWelcome();
    });
    content.querySelector('[data-featured-open]')?.addEventListener('click', (event) => window.exampleGuide.openFeatured(event.currentTarget.dataset.featuredOpen));
    content.querySelector('[data-featured-dismiss]')?.addEventListener('click', async (event) => {
        if (await window.exampleGuide.dismissFeatured(event.currentTarget.dataset.featuredDismiss)) {
            welcome.featured = null;
            renderWelcome();
        }
    });
    content.querySelector('[data-copy-details]')?.addEventListener('click', async () => {
        if (!(await window.exampleGuide.copyBugReportDetails())) return;
        welcome.detailsCopied = true;
        renderWelcome();
        setTimeout(() => { welcome.detailsCopied = false; if (welcome) renderWelcome(); }, 1800);
    });
    content.querySelector('#restartKonjugate')?.addEventListener('click', () => window.exampleGuide.restart());
    content.querySelector('#installRecommendedAddons')?.addEventListener('click', async () => {
        welcome.recommendedStatus = { phase: 'installing', text: '' };
        renderWelcome();
        try {
            const results = await window.exampleGuide.installRecommendedAddons(welcome.recommendedAddons);
            welcome.recommendedStatus = { phase: 'installed', text: `Installed ${results.map((result) => `${result.packageId} ${result.version}`).join(', ')}.` };
        } catch (error) {
            welcome.recommendedStatus = { phase: 'failed', text: `Installation failed: ${error.message}` };
        }
        renderWelcome();
    });
}

// ---- The Updates section (see docs/updates.md)
//
// Everything it says comes from describeUpdateStatus (src/updatePanel.mjs), which is tested; this only
// draws it and wires the buttons. When there is nothing to do it is one quiet line; it opens into a card
// for an available update, a failure, or the Store message. The status itself is held by the main
// process and pushed here whenever it changes.
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
    container.classList.toggle('updatesCompact', model.compact);
    const checked = describeCheckedAt(updateStatus.checkedAt, Date.now());
    const checkButton = model.canCheck
        ? `<button type="button" class="updatesSecondary" data-check ${checkingForUpdate ? 'disabled' : ''}>${checkingForUpdate ? 'Checking…' : 'Check for updates'}</button>` : '';
    const links = model.links.map((link) => `<a href="${escapeHtml(link.url)}" data-update-link>${escapeHtml(link.label)}</a>`).join(' · ');
    if (model.compact) {
        container.innerHTML = `<div class="updatesLine"><span>${escapeHtml(model.headline)}</span>${checkButton}<span class="updatesMeta">${links}${checked ? ` · ${escapeHtml(checked)}` : ''}</span></div>`;
    } else {
        const buttons = model.actions.map((action, index) => `<button type="button" class="${action.kind === 'skip' || action.secondary ? 'updatesSecondary' : ''}" data-action-index="${index}">${escapeHtml(action.label)}</button>`).join('');
        container.innerHTML = `
            <div class="updatesHeadline">${escapeHtml(model.headline)}</div>
            ${model.detail ? `<p class="updatesDetail">${escapeHtml(model.detail)}</p>` : ''}
            ${model.notice ? `<p class="updatesNotice">${escapeHtml(model.notice)}</p>` : ''}
            ${model.command ? `<pre class="updatesCommand">${escapeHtml(model.command)}</pre>` : ''}
            ${buttons ? `<div class="updatesActions">${buttons}</div>` : ''}
            ${model.hint ? `<p class="updatesHint">${escapeHtml(model.hint)}</p>` : ''}
            <div class="updatesFooter">${checkButton}<span>${links}${checked ? ` · ${escapeHtml(checked)}` : ''}</span></div>`;
    }
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

// ---- The window itself

document.querySelector('#minimize').addEventListener('click', () => window.windowControls.minimize());
document.querySelector('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
document.querySelector('#close').addEventListener('click', () => window.windowControls.close());
window.windowControls.onMaximizedChange((expanded) => { document.querySelector('#maximize').textContent = expanded ? '❐' : '□'; });
// Esc closes the window: it is meant to be quick to dismiss. Pressed while a menu or dialog inside the page
// has focus there is none, so this is always about the window.
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) window.windowControls.close();
});

window.exampleGuide.onContent((payload) => {
    const { title, markdown, kind = 'example' } = payload;
    document.title = `${title} · ${guideKindSuffix(kind)}`;
    document.querySelector('#guideTitle').textContent = `${title} · ${guideKindSuffix(kind)}`;
    if (kind === 'welcome') {
        welcome = {
            generation: payload.generation, version: payload.version, markdown,
            onRamp: payload.onRamp, openedEpisodes: payload.openedEpisodes ?? [], onRampExpanded: false,
            whatsNew: payload.whatsNew ?? null, featured: payload.featured ?? null, moreToWatch: payload.moreToWatch ?? [], posts: payload.posts ?? [],
            recommendedAddons: payload.recommendedAddons ?? [], recommendedStatus: { phase: 'idle', text: '' }, detailsCopied: false
        };
        renderWelcome({ resetScroll: true });
        window.appUpdate.status().then((status) => {
            updateStatus = status;
            renderUpdatesSection();
        });
        return;
    }
    welcome = null;
    document.querySelector('#content').innerHTML = renderMarkdown(markdown);
    document.querySelectorAll('[data-external-link]').forEach((link) => link.addEventListener('click', (event) => {
        event.preventDefault();
        window.exampleGuide.openExternal(link.href);
    }));
    document.querySelector('#content').scrollTop = 0;
});

// Content that arrives after the window opened. A patch carries the generation of the open it belongs
// to, so one for a Welcome window that has since been replaced (this window is shared with the example
// and help guides) is ignored.
window.exampleGuide.onWelcomePatch((patch) => {
    if (!welcome || patch.generation !== welcome.generation) return;
    for (const key of ['posts', 'recommendedAddons', 'featured', 'moreToWatch']) {
        if (key in patch) welcome[key] = patch[key] ?? (key === 'featured' ? null : []);
    }
    renderWelcome();
});
