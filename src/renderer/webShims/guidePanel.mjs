/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The web edition's guide panel: an example's guide (and the causal-inference help) rendered inside the page, beside the model, where
// the desktop opens its guide window. Opening a guide never takes the tab away from the app, so the model, its results and Back stay
// where they were; a link inside a guide that leads off the site opens in a new tab.

import { convertLatexToMarkup } from 'mathlive';
import { guideTutorialCards, renderGuideMarkdown } from '../../exampleGuide/markdownHtml.mjs';
import { guideKindSuffix } from '../../exampleGuide/guideKind.mjs';

let panel = null;

function guidePanel(startTutorial) {
    if (panel) return panel;
    // The guide window's own stylesheet for what is in a guide (exampleGuide/guideContent.css), so a guide reads the same in both.
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('../../exampleGuide/guideContent.css', import.meta.url).href;
    document.head.append(stylesheet);
    panel = document.createElement('aside');
    panel.id = 'guidePanel';
    panel.className = 'guidePanel';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'guidePanelTitle');
    panel.innerHTML = '<header><strong id="guidePanelTitle"></strong><button id="closeGuidePanel" type="button">Close guide</button></header>' +
        '<div id="guidePanelContent" class="guidePanelContent guideContent"></div>';
    panel.querySelector('#closeGuidePanel').addEventListener('click', closeGuidePanel);
    // Esc closes it while it is what the person is reading, as it closes the desktop's guide window.
    panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) closeGuidePanel();
    });
    panel.addEventListener('click', (event) => {
        const tutorial = event.target.closest('[data-start-tutorial]');
        if (!tutorial) return;
        closeGuidePanel();
        startTutorial(tutorial.dataset.startTutorial);
    });
    // In the canvas, as the add-on panels are: a node's or relationship's card opened while the guide is up comes in front of it.
    (document.getElementById('canvas') ?? document.body).append(panel);
    return panel;
}

function closeGuidePanel() {
    if (panel) panel.hidden = true;
}

// Shows `markdown` rendered, titled "<title> · Example Guide" (or "· Help"), with a card for each of `tutorials` first, as the desktop's
// guide does. `startTutorial(id)` starts one in this page.
export function showGuidePanel({ title, markdown, kind = 'example', tutorials = [] }, { startTutorial }) {
    const element = guidePanel(startTutorial);
    element.querySelector('#guidePanelTitle').textContent = `${title} · ${guideKindSuffix(kind)}`;
    const content = element.querySelector('#guidePanelContent');
    content.innerHTML = guideTutorialCards(tutorials) + renderGuideMarkdown(markdown, convertLatexToMarkup);
    for (const link of content.querySelectorAll('a[data-external-link]')) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    }
    element.hidden = false;
    content.scrollTop = 0;
    element.querySelector('#closeGuidePanel').focus({ preventScroll: true });
}
