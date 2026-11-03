/* Copyright © 2026 Zenin Easa Panthakkalakath */

// When a project is opened in the web edition and names plugin providers that are not installed here, says so and offers to install the
// plugin from a file, before the person finds out by a run failing (docs/proposals/webEditionPackages.md, "Projects that name a
// plugin"). The model is already open behind it; "Continue without" leaves it so, and the run says the same thing if tried. The desktop
// does not ask: it reads the plugin directory when a model runs and its own tests open such models.

import { missingPluginReferences } from '../pluginReferences.mjs';

const sentence = (item) => {
    const provides = item.providerIds.length ? ` (it provides ${item.providerIds.join(', ')})` : '';
    if (item.reason === 'disabled') return `${item.pluginId} ${item.pluginVersion} is installed but turned off.`;
    if (item.reason === 'incompatible') return `${item.pluginId} ${item.pluginVersion} is installed but needs a newer Konjugate than this.`;
    if (item.reason === 'other-version') return `This project is pinned to ${item.pluginId} ${item.pluginVersion}${provides}, but ${item.installedVersions.join(', ')} is installed. Install ${item.pluginVersion}: a newer version could change the results.`;
    return `${item.pluginId} ${item.pluginVersion}${provides} is not installed.`;
};

const element = (tag, content, className = '') => {
    const node = document.createElement(tag);
    node.textContent = content;
    if (className) node.className = className;
    return node;
};

export async function offerMissingPlugins(project) {
    if (!document.documentElement.hasAttribute('data-web-edition') || !window.extensions?.list) return;
    let missing = missingPluginReferences(project, await window.extensions.list());
    if (!missing.length) return;

    const dialog = document.createElement('dialog');
    dialog.className = 'passwordDialog webPackageReviewDialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    const body = document.createElement('div');
    const notice = element('p', '');
    const install = element('button', 'Install a plugin file…', 'doneButton');
    install.type = 'button';
    const enable = element('button', 'Turn on');
    enable.type = 'button';
    const close = element('button', 'Continue without');
    close.type = 'button';
    const footer = document.createElement('footer');
    footer.append(close, enable, install);
    form.append(element('span', 'Plugins', 'contextKicker'), element('strong', 'This project needs plugins that are not available here'), body, notice, footer);
    dialog.append(form);

    const render = () => {
        const list = document.createElement('ul');
        list.className = 'webPackageReviewList';
        list.append(...missing.map((item) => element('li', sentence(item))));
        body.replaceChildren(list);
        enable.hidden = !missing.some((item) => item.reason === 'disabled');
        install.hidden = missing.every((item) => item.reason === 'disabled' || item.reason === 'incompatible');
    };
    const refresh = async () => {
        missing = missingPluginReferences(project, await window.extensions.list());
        if (!missing.length) { dialog.close(); return; }
        render();
    };
    install.addEventListener('click', async () => {
        notice.textContent = '';
        try {
            if (await window.extensions.install()) await refresh();
        } catch (error) {
            notice.textContent = `Installation failed: ${error.message}`;
        }
    });
    enable.addEventListener('click', async () => {
        for (const item of missing.filter((candidate) => candidate.reason === 'disabled')) await window.extensions.setEnabled('plugin', item.pluginId, item.pluginVersion, true);
        await refresh();
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    render();
    document.body.append(dialog);
    dialog.showModal();
}
