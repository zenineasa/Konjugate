/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { convertLatexToMarkup } from '../../node_modules/mathlive/mathlive.min.mjs';

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderInline(value) {
    return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\$([^$]+)\$/g, (_match, latex) => `<span class="inlineMath">${convertLatexToMarkup(latex)}</span>`);
}

function renderMarkdown(markdown) {
    const lines = escapeHtml(markdown.replace(/<!--[\s\S]*?-->/g, '')).split('\n');
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

document.querySelector('#minimize').addEventListener('click', () => window.windowControls.minimize());
document.querySelector('#maximize').addEventListener('click', () => window.windowControls.toggleMaximize());
document.querySelector('#close').addEventListener('click', () => window.windowControls.close());
window.windowControls.onMaximizedChange((expanded) => { document.querySelector('#maximize').textContent = expanded ? '❐' : '□'; });
window.exampleGuide.onContent(({ title, markdown }) => {
    document.title = `${title} · Example Guide`;
    document.querySelector('#guideTitle').textContent = `${title} · Example Guide`;
    document.querySelector('#content').innerHTML = renderMarkdown(markdown);
    window.scrollTo(0, 0);
});
