/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { convertLatexToMarkup } from '../../node_modules/mathlive/mathlive.min.mjs';
import { guideKindSuffix } from './guideKind.mjs';
import { describeCheckedAt, describeUpdateStatus } from '../updatePanel.mjs';
import { highlightLabel, watchLibrary, welcomeLinks, welcomeSectionOrder } from '../welcomeModel.mjs';
import { escapeHtml, guideTutorialCards, renderGuideMarkdown } from './markdownHtml.mjs';

const renderMarkdown = (markdown) => renderGuideMarkdown(markdown, convertLatexToMarkup);

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


// ---- The Welcome window (docs/proposals/welcomeWindow.md)
//
// Built from `welcome`, a state object: the content that arrived with the window, the patches that
// arrive after it (blog posts, the add-on offer, a fresh feed), and the few bits of
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

// With highlights written for this version, a block of its own; without them there is nothing to add to the
// heading and the status line, so it is a single line pointing at the release notes.
function renderWhatsNew(whatsNew) {
    if (!whatsNew.highlights.length) {
        return `<section class="whatsNew whatsNewCompact">
            <span><strong>What's new in ${escapeHtml(whatsNew.version)}</strong> · updated from ${escapeHtml(whatsNew.previous)}</span>
            <a href="${escapeHtml(whatsNew.url)}" data-external-link>Read the release notes</a>
        </section>`;
    }
    return `<section class="whatsNew">
        <h2>What's new in ${escapeHtml(whatsNew.version)}</h2>
        <p class="whatsNewFrom">Updated from ${escapeHtml(whatsNew.previous)}.</p>
        <ul>${whatsNew.highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        <p><a href="${escapeHtml(whatsNew.url)}" data-external-link>Read the full release notes</a></p>
    </section>`;
}

const highlightActionLabel = { video: 'Watch', sponsored: 'Learn more', announcement: 'Read more' };

// The picture and the title both open the item, like the button, so the whole card reads as one link; the picture
// is the item's own image if it has one, else (for a video) the video's thumbnail.
function renderHighlight(item) {
    const source = item.imageUrl ?? item.thumbnailUrl;
    const open = `data-highlight-open="${escapeHtml(item.id)}"`;
    const image = source ? `<button type="button" class="highlightMedia" ${open} tabindex="-1" aria-hidden="true"><img class="highlightImage" src="${escapeHtml(source)}" alt=""></button>` : '';
    const action = item.kind === 'video' && item.playlist ? 'Watch playlist' : (highlightActionLabel[item.kind] ?? 'Learn more');
    return `<section class="highlight highlight-${escapeHtml(item.kind)}${source ? ' highlightWithImage' : ''}">
        ${image}
        <div class="highlightBody">
            <div class="highlightLabel">${escapeHtml(highlightLabel(item.kind, { playlist: item.playlist === true, rotated: item.rotated === true }))}</div>
            <button type="button" class="highlightTitle" ${open}>${escapeHtml(item.title)}</button>
            ${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}
            <button type="button" class="highlightAction" ${open}>${escapeHtml(action)}</button>
        </div>
    </section>`;
}

// Learn by doing: the tutorials this person has not done yet, next first, each started in the project window this
// page belongs to; and the whole list one click away. Every tutorial ends with a model they built themselves.
function renderLearn() {
    const { suggested, total, completed } = welcome.learn;
    const cards = suggested.map((tutorial) => `<div class="tutorialCard">
            <div class="tutorialCardArea">${escapeHtml(tutorial.areaTitle)} · ${escapeHtml(String(tutorial.minutes))} min</div>
            <strong>${escapeHtml(tutorial.title)}</strong>
            <p>${escapeHtml(tutorial.summary)}</p>
            <button type="button" data-start-tutorial="${escapeHtml(tutorial.id)}">Start</button>
        </div>`).join('');
    const progress = completed ? `${completed} of ${total} done · ` : '';
    return `<h2>Learn by doing</h2>
        <p class="sectionIntro">Short tutorials that run inside Konjugate: you build the model yourself, step by step, and can skip any step.</p>
        ${cards ? `<div class="tutorialCards">${cards}</div>` : '<p class="sectionIntro">You have done every tutorial. They are all still there to take again.</p>'}
        <p class="onRampMore">${progress}<button type="button" class="linkButton" data-open-tutorials>See all ${escapeHtml(String(total))} tutorials</button></p>`;
}

// Watch: every video, newest first, the highlighted one aside; the On-Ramp series is one card for its playlist.
function renderWatch() {
    const { shown, hidden } = watchLibrary({ videos: welcome.videos, onRamp: welcome.onRamp, highlightedVideoId: welcome.highlight?.videoId ?? null }, { expanded: welcome.watchExpanded });
    const opened = new Set(welcome.openedEpisodes);
    const cards = shown.map((video) => (video.playlist ? renderCard({ ...video, videoId: undefined }) : renderCard(video, { opened: opened.has(video.videoId) }))).join('');
    const extras = [
        hidden ? `<button type="button" class="linkButton" data-show-all>Show all (${hidden} more)</button>` : '',
        `<a href="${escapeHtml(welcomeLinks.youtubeChannel)}" data-external-link>More on YouTube</a>`
    ].filter(Boolean).join(' · ');
    return `<h2>Watch</h2>
        <div class="cardGrid">${cards}</div>
        <p class="onRampMore">${extras}</p>`;
}

function renderCommunity() {
    return `<h2>Community &amp; help</h2>
        <div class="communityRow">
            <a class="communityLink communityDiscord" href="${welcomeLinks.discord}" data-external-link><svg aria-hidden="true" class="communityIcon" focusable="false" viewBox="0 0 24 24"><path d="M19.54 5.34A16.6 16.6 0 0 0 15.4 4.05l-.2.4c1.5.37 2.2.9 2.93 1.55a13.7 13.7 0 0 0-5.1-1.5 13.7 13.7 0 0 0-5.1 1.5c.73-.65 1.6-1.25 3.13-1.55l-.2-.4a16.6 16.6 0 0 0-4.14 1.29C3.1 9.3 2.4 13.15 2.75 16.95a16.7 16.7 0 0 0 5.07 2.6l1.08-1.77c-.6-.22-1.15-.5-1.67-.85l.4-.32a11.9 11.9 0 0 0 10.74 0l.4.32c-.52.35-1.07.63-1.67.85l1.08 1.77a16.7 16.7 0 0 0 5.07-2.6c.42-4.4-.7-8.2-2.71-11.6zM9.35 14.65c-.9 0-1.63-.82-1.63-1.82s.72-1.83 1.63-1.83 1.64.83 1.63 1.83c0 1-.72 1.82-1.63 1.82zm5.3 0c-.9 0-1.63-.82-1.63-1.82s.72-1.83 1.63-1.83 1.64.83 1.63 1.83c0 1-.72 1.82-1.63 1.82z" fill="currentColor"></path></svg>Join us on Discord</a>
            <a class="communityLink communityWhatsapp" href="${welcomeLinks.whatsapp}" data-external-link><svg aria-hidden="true" class="communityIcon" focusable="false" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" fill="currentColor"></path></svg>Follow on WhatsApp</a>
            <a class="communityLink" href="${welcomeLinks.documentation}" data-external-link>Documentation</a>
            <button type="button" class="communityLink" data-help-feedback>Help &amp; feedback</button>
        </div>
        <p class="communityNote">Report a problem on GitHub or by email, with your Konjugate version and system already filled in. Nothing is sent until you send it yourself.</p>`;
}

const sectionRenderers = {
    heading: () => `<h1>Welcome to Konjugate v${escapeHtml(welcome.version)}</h1>`,
    status: () => '<section id="updatesSection" class="updatesSection" aria-live="polite" hidden></section>',
    recommended: () => renderRecommendedAddons(welcome.recommendedAddons, welcome.recommendedStatus),
    whatsNew: () => renderWhatsNew(welcome.whatsNew),
    highlight: () => renderHighlight(welcome.highlight),
    learn: renderLearn,
    watch: renderWatch,
    blog: () => `<h2>Recent from the blog</h2><div class="cardGrid">${welcome.posts.map((post) => renderCard(post)).join('')}</div>`,
    community: renderCommunity,
    footer: () => `<footer class="welcomeFooter">${renderMarkdown(welcome.markdown)}</footer>`
};

function renderWelcome({ resetScroll = false } = {}) {
    const content = document.querySelector('#content');
    const scroll = content.scrollTop;
    const order = welcomeSectionOrder({
        hasRecommended: welcome.recommendedAddons.length > 0, hasWhatsNew: Boolean(welcome.whatsNew), hasHighlight: Boolean(welcome.highlight),
        hasVideos: welcome.videos.length > 0 || Boolean(welcome.onRamp?.playlistUrl), hasPosts: welcome.posts.length > 0
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
        welcome.watchExpanded = true;
        renderWelcome();
    });
    content.querySelectorAll('[data-start-tutorial]').forEach((button) => button.addEventListener('click', () => window.exampleGuide.startTutorial(button.dataset.startTutorial)));
    content.querySelector('[data-open-tutorials]')?.addEventListener('click', () => window.exampleGuide.openTutorials());
    content.querySelectorAll('[data-highlight-open]').forEach((target) => target.addEventListener('click', (event) => window.exampleGuide.openHighlight(event.currentTarget.dataset.highlightOpen)));
    content.querySelector('[data-help-feedback]')?.addEventListener('click', () => window.exampleGuide.openHelpFeedback());
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
            onRamp: payload.onRamp, openedEpisodes: payload.openedEpisodes ?? [], watchExpanded: false,
            learn: payload.learn ?? { suggested: [], total: 0, completed: 0 },
            whatsNew: payload.whatsNew ?? null, highlight: payload.highlight ?? null, videos: payload.videos ?? [], posts: payload.posts ?? [],
            recommendedAddons: payload.recommendedAddons ?? [], recommendedStatus: { phase: 'idle', text: '' }
        };
        renderWelcome({ resetScroll: true });
        window.appUpdate.status().then((status) => {
            updateStatus = status;
            renderUpdatesSection();
        });
        return;
    }
    welcome = null;
    // An example with tutorials (docs/proposals/tutorials.md) offers them first, so someone who opened the example from the Examples
    // dialog learns there are walkthroughs of it.
    document.querySelector('#content').innerHTML = guideTutorialCards(payload.tutorials ?? []) + renderMarkdown(markdown);
    document.querySelectorAll('[data-start-tutorial]').forEach((button) => button.addEventListener('click', () => window.exampleGuide.startTutorial(button.dataset.startTutorial)));
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
    for (const key of ['posts', 'recommendedAddons', 'highlight', 'videos']) {
        if (key in patch) welcome[key] = patch[key] ?? (key === 'highlight' ? null : []);
    }
    renderWelcome();
});
