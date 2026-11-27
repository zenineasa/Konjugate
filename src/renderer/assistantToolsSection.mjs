/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Model assistant › Use a model you have (docs/proposals/assistantSignIn.md): the vendors' own tools found on this
// computer (the Copilot CLI, and Claude Code where it is switched on), who each is signed in as, and Use it, which makes a
// configuration for the tool with its default model and puts it in use. The section is hidden when no tool is found, so a
// person without one sees nothing of it. `api` is window.aiProviders; `providers()` and `configurations()` are the catalog's,
// `activeUuid()` the configuration in use, and `use(uuid)` puts a configuration in use.

export function createAssistantToolsSection({ root, api, providers = () => [], configurations = () => [], activeUuid = () => null, use }) {
    const find = (selector) => root.querySelector(selector);
    let tools = [];
    let checking = null;
    let message = '';

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    const configurationFor = (provider) => configurations().find((configuration) => configuration.provider === provider);
    const describe = (tool) => {
        if (tool.signedIn === true) return `Signed in${tool.account ? ` as ${tool.account}` : ''}${tool.plan ? ` · ${tool.plan} plan` : ''}`;
        if (tool.signedIn === false) return 'Installed, not signed in. Sign in with the tool, then check again.';
        return 'Installed on this computer';
    };

    async function useTool(tool) {
        message = '';
        try {
            let configuration = configurationFor(tool.provider);
            if (!configuration) {
                const descriptor = providers().find((provider) => provider.id === tool.provider);
                configuration = await api.saveConfiguration({
                    name: tool.name, provider: tool.provider, model: 'default', timeoutSeconds: descriptor?.defaultTimeoutSeconds ?? 180
                });
            }
            await use(configuration.uuid);
        } catch (error) {
            message = error.message;
        }
        render();
    }

    function row(tool) {
        const item = element('div', 'settingsItem assistantToolRow');
        item.dataset.toolRow = tool.provider;
        item.setAttribute('role', 'listitem');
        const text = element('div', 'settingsItemText');
        text.append(element('span', 'settingsItemLabel', tool.name), element('small', 'settingsItemHint', describe(tool)));
        const control = element('div', 'settingsItemControl');
        const existing = configurationFor(tool.provider);
        if (existing && existing.uuid === activeUuid()) {
            control.append(element('i', 'settingsBadge', 'In use'));
        } else if (tool.signedIn === false) {
            const again = element('button', 'settingsButton', 'Check again');
            again.type = 'button';
            again.dataset.toolCheck = tool.provider;
            again.addEventListener('click', () => check());
            control.append(again);
        } else {
            const useIt = element('button', 'settingsButton primary', 'Use it');
            useIt.type = 'button';
            useIt.dataset.toolUse = tool.provider;
            useIt.addEventListener('click', async () => { useIt.disabled = true; await useTool(tool); });
            control.append(useIt);
        }
        item.append(text, control);
        return item;
    }

    function render() {
        const installed = tools.filter((tool) => tool.installed);
        root.hidden = !installed.length;
        find('#assistantToolList').replaceChildren(...installed.map(row));
        const line = find('#assistantToolStatus');
        line.textContent = message;
        line.hidden = !message;
    }

    // Asks the main process what is installed; a second ask while one is under way waits for that one.
    function check() {
        checking ??= api.detectTools()
            .then((found) => { tools = Array.isArray(found) ? found : []; })
            .catch(() => { tools = []; })
            .finally(() => { checking = null; render(); });
        return checking;
    }

    return Object.freeze({ check, render });
}
