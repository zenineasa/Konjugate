/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Model assistant › Use a model you have (docs/proposals/assistantSignIn.md): the vendors' own tools (the Copilot
// CLI, and Claude Code where it is switched on), found on this computer or ready to install. A tool that is signed in offers
// Use it, which makes a configuration for it with its default model and puts it in use. One that is not installed offers
// Install…, which runs the vendor's own installer once the person agrees in the dialog the main process shows; one that is
// not signed in offers Sign in, which runs the tool's own sign-in. While either runs, its last lines are shown (a sign-in
// may print a link or a code) with Stop. `api` is window.aiProviders; `providers()` and `configurations()` are the catalog's,
// `activeUuid()` the configuration in use, and `use(uuid)` puts a configuration in use. Hidden when there is no tool at all
// (the web edition).

import { planUsageMeters } from './assistantPlanUsage.mjs';

const shownLines = 4;
// How long a tool's plan usage is shown before it is asked again (each ask runs the tool once; it costs nothing).
const planUsageSeconds = 60;

export function createAssistantToolsSection({ root, api, providers = () => [], configurations = () => [], activeUuid = () => null, use }) {
    const find = (selector) => root.querySelector(selector);
    let tools = [];
    let checking = null;
    let message = { text: '', tone: 'neutral' };
    let task = null; // { provider, kind: 'install' | 'signIn' | 'switch' | 'signOut', lines: [] }
    // Each signed-in tool's plan usage, as last read: provider → { value, at }.
    const planUsage = new Map();

    api.onToolProgress?.((progress) => {
        if (!task || progress.provider !== task.provider) return;
        task.lines = [...task.lines, progress.line].slice(-shownLines);
        render();
    });

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, data, { primary = false } = {}) {
        const node = element('button', primary ? 'settingsButton primary' : 'settingsButton', text);
        node.type = 'button';
        Object.assign(node.dataset, data);
        node.disabled = task !== null;
        return node;
    }

    const configurationFor = (provider) => configurations().find((configuration) => configuration.provider === provider);
    const describe = (tool) => {
        if (!tool.installed) return tool.description || 'Not installed';
        if (tool.signedIn === true) return `Signed in${tool.account ? ` as ${tool.account}` : ''}${tool.plan ? ` · ${tool.plan} plan` : ''}`;
        if (tool.signedIn === false && tool.elsewhere) return `Not signed in for Konjugate. Your terminal's Claude Code is signed in as ${tool.elsewhere}; Konjugate keeps a sign-in of its own.`;
        if (tool.signedIn === false) return 'Installed, not signed in';
        return 'Installed on this computer';
    };

    async function useTool(tool) {
        message = { text: '', tone: 'neutral' };
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
            message = { text: error.message, tone: 'error' };
        }
        render();
    }

    // Installing or signing in; afterwards the tools are as the main process found them again.
    async function runTask(tool, kind) {
        task = { provider: tool.provider, kind, lines: [] };
        message = { text: '', tone: 'neutral' };
        render();
        try {
            const result = kind === 'install' ? await api.installTool(tool.provider)
                : kind === 'signIn' ? await api.signInWithTool(tool.provider)
                    : await api.signOutOfTool(tool.provider, { thenSignIn: kind === 'switch' });
            planUsage.delete(tool.provider);
            if (result?.ok) {
                tools = result.tools ?? tools;
                const now = tools.find((item) => item.provider === tool.provider);
                const signedInAs = now?.account ? ` as ${now.account}` : '';
                message = kind === 'install'
                    ? { text: now?.installed ? `${tool.name} is installed.${now.signedIn === true ? '' : ' Sign in to use it.'}` : `The installer finished, but Konjugate cannot find ${tool.name} yet.`, tone: now?.installed ? 'success' : 'warning' }
                    : kind === 'signOut'
                        ? { text: `Signed out of ${tool.name} in Konjugate.${tool.ownSignIn ? ' Claude Code in your terminal is not affected.' : ''}`, tone: 'success' }
                        : { text: `Signed in to ${tool.name}${signedInAs}.`, tone: 'success' };
            } else if (!['installCancelled', 'taskCancelled'].includes(result?.error?.code)) {
                message = { text: result?.error?.message || 'That did not finish.', tone: 'error' };
            }
        } catch (error) {
            message = { text: error.message, tone: 'error' };
        } finally {
            task = null;
            render();
        }
    }

    function row(tool) {
        const item = element('div', 'settingsItem assistantToolRow');
        item.dataset.toolRow = tool.provider;
        item.setAttribute('role', 'listitem');
        const text = element('div', 'settingsItemText');
        text.append(element('span', 'settingsItemLabel', tool.name), element('small', 'settingsItemHint', describe(tool)));
        const control = element('div', 'settingsItemControl');
        if (task?.provider === tool.provider) {
            text.append(element('small', 'assistantToolProgress', task.lines.join('\n') || (task.kind === 'install' ? 'Installing…' : task.kind === 'signOut' ? 'Signing out…' : 'Waiting for your browser…')));
            const stop = element('button', 'settingsButton', 'Stop');
            stop.type = 'button';
            stop.dataset.toolStop = tool.provider;
            stop.addEventListener('click', () => api.cancelToolTask());
            control.append(stop);
        } else if (!tool.installed) {
            if (tool.installable) {
                const install = button('Install…', { toolInstall: tool.provider });
                install.addEventListener('click', () => runTask(tool, 'install'));
                control.append(install);
            }
        } else {
            const existing = configurationFor(tool.provider);
            if (existing && existing.uuid === activeUuid()) control.append(element('i', 'settingsBadge', 'In use'));
            else if (tool.signedIn !== false) {
                const useIt = button('Use it', { toolUse: tool.provider }, { primary: true });
                useIt.addEventListener('click', async () => { useIt.disabled = true; await useTool(tool); });
                control.append(useIt);
            }
            if (tool.signedIn !== true) {
                const signIn = button('Sign in', { toolSignIn: tool.provider }, { primary: tool.signedIn === false });
                signIn.addEventListener('click', () => runTask(tool, 'signIn'));
                control.append(signIn);
            } else if (tool.signOutable) {
                // Konjugate's own sign-in of the tool: another account, or none.
                const change = button('Switch account…', { toolSwitch: tool.provider });
                change.title = 'Sign out, then sign in with another account in your browser';
                change.addEventListener('click', () => runTask(tool, 'switch'));
                const out = button('Sign out', { toolSignOut: tool.provider });
                out.title = tool.ownSignIn ? 'Sign Konjugate out of this account (your terminal stays signed in)' : 'Sign out of this account';
                out.addEventListener('click', () => runTask(tool, 'signOut'));
                control.append(change, out);
            }
            const used = tool.signedIn === true && planUsage.get(tool.provider)?.value;
            if (used) text.append(planUsageMeters(used));
        }
        item.append(text, control);
        return item;
    }

    function render() {
        const shown = tools.filter((tool) => tool.installed || tool.installable);
        root.hidden = !shown.length;
        find('#assistantToolList').replaceChildren(...shown.map(row));
        const line = find('#assistantToolStatus');
        if (message.tone === 'error' && message.text && message.text !== render.lastLogged) {
            console.warn(`[assistant] ${message.text}`);
            render.lastLogged = message.text;
        }
        line.textContent = message.text;
        line.className = `settingsNote assistantConfigurationStatus ${message.tone}`;
        line.hidden = !message.text;
    }

    // Asks the main process what is installed. An ask while one is under way (asking Claude Code takes a few seconds) asks
    // again once that one ends, since a tool may have been installed or signed in to in between.
    let askAgain = false;
    function check() {
        if (checking) {
            askAgain = true;
            return checking;
        }
        checking = api.detectTools()
            .then((found) => { tools = Array.isArray(found) ? found : []; })
            .catch(() => { tools = []; })
            .finally(() => {
                checking = null;
                render();
                readPlanUsage();
                if (askAgain) {
                    askAgain = false;
                    check();
                }
            });
        return checking;
    }

    // Each signed-in tool's plan usage, read again once the last reading is older than planUsageSeconds.
    function readPlanUsage() {
        for (const tool of tools) {
            if (!tool.planUsage || tool.signedIn !== true) continue;
            const last = planUsage.get(tool.provider);
            if (last && (last.pending || Date.now() - last.at < planUsageSeconds * 1000)) continue;
            planUsage.set(tool.provider, { ...last, pending: true });
            api.planUsage?.(tool.provider)
                .then((value) => { planUsage.set(tool.provider, { value, at: Date.now() }); })
                .catch(() => { planUsage.set(tool.provider, { value: null, at: Date.now() }); })
                .finally(render);
        }
    }

    return Object.freeze({ check, render });
}
