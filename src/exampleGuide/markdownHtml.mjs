/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An example's guide (or a help page) as HTML: the one renderer behind the desktop's guide window and the web edition's guide panel, so a
// guide reads the same in both. The LaTeX converter is passed in (mathlive's convertLatexToMarkup) rather than imported, since each page
// reaches mathlive by its own path: the guide window through node_modules, the web shell through its import map.

import { prepareGuideMarkdown } from './markdown.mjs';

export const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderInline(value, convertLatexToMarkup) {
    return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/!\[([^\]]*)\]\((https:\/\/[^)]+)\)/g, '<img src="$2" alt="$1">')
        .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, '<a href="$2" data-external-link>$1</a>')
        .replace(/\$([^$]+)\$/g, (_match, latex) => `<span class="inlineMath">${convertLatexToMarkup(latex)}</span>`);
}

export function renderGuideMarkdown(markdown, convertLatexToMarkup) {
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
            output.push(`<li>${renderInline(item[1], convertLatexToMarkup)}</li>`);
            continue;
        }
        if (list) { output.push('</ul>'); list = null; }
        const heading = line.match(/^(#{1,3}) (.+)$/);
        if (heading) { const level = heading[1].length; output.push(`<h${level}>${renderInline(heading[2], convertLatexToMarkup)}</h${level}>`); }
        else if (/^\$\$.+\$\$$/.test(line)) output.push(`<div class="equation">${convertLatexToMarkup(line.slice(2, -2), { mathstyle: 'displaystyle' })}</div>`);
        else if (line.trim()) output.push(`<p>${renderInline(line, convertLatexToMarkup)}</p>`);
    }
    if (list) output.push('</ul>');
    return output.join('');
}

// The cards an example's guide opens with, one for each tutorial on that example (docs/proposals/tutorials.md), so someone who opened
// the example learns there are walkthroughs of it. A card's button carries data-start-tutorial, its tutorial's id, for the page to start.
export function guideTutorialCards(tutorials) {
    return tutorials.map((tutorial) => `<section class="tourCard"><div><strong>${escapeHtml(tutorial.title)}</strong><p>${escapeHtml(tutorial.summary)} A ${escapeHtml(String(tutorial.minutes))}-minute tutorial on this example, step by step, right in the app.</p></div><button type="button" data-start-tutorial="${escapeHtml(tutorial.id)}">Take the tutorial</button></section>`).join('');
}
