/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { convertLatexToMarkup } from '../../node_modules/mathlive/mathlive.min.mjs';
import { guideKindSuffix } from './guideKind.mjs';

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderInline(value) {
    return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/!\[([^\]]*)\]\((https:\/\/[^)]+)\)/g, '<img src="$2" alt="$1">')
        .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2" data-external-link>$1</a>')
        .replace(/\$([^$]+)\$/g, (_match, latex) => `<span class="inlineMath">${convertLatexToMarkup(latex)}</span>`);
}

function renderMarkdown(markdown) {
    const lines = escapeHtml(markdown.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '')).split('\n');
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

document.querySelector('#minimize').addEventListener('click', () => window.windowControls.minimize());
document.querySelector('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
document.querySelector('#close').addEventListener('click', () => window.windowControls.close());
window.windowControls.onMaximizedChange((expanded) => { document.querySelector('#maximize').textContent = expanded ? '❐' : '□'; });
window.exampleGuide.onContent(({ title, version, markdown, cards = [], kind = 'example' }) => {
    const suffix = guideKindSuffix(kind);
    document.title = `${title} · ${suffix}`;
    document.querySelector('#guideTitle').textContent = `${title} · ${suffix}`;
    const versionHeading = version ? `<h1>Welcome to Konjugate v${escapeHtml(version)}</h1>` : '';
    document.querySelector('#content').innerHTML = versionHeading + renderMarkdown(markdown)
        + renderCardSection('Get started', cards.filter((card) => card.section === 'video'))
        + renderCardSection('Recent from the blog', cards.filter((card) => card.section === 'post'));
    document.querySelectorAll('[data-external-link]').forEach((link) => link.addEventListener('click', (event) => {
        event.preventDefault();
        window.exampleGuide.openExternal(link.href);
    }));
    document.querySelector('#content').scrollTop = 0;
});
