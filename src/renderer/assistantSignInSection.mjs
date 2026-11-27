/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Settings › Model assistant › Sign in to a provider (docs/proposals/assistantSignIn.md): one row for each provider a person
// can sign in to in their browser instead of pasting a key. Signing in makes a configuration for that provider, with the
// model it suggests, and puts it in use, so one click gives a working assistant; a provider signed in to before offers
// Use and Sign in again. `api` is window.aiProviders. `providers()` and `configurations()` are the catalog's as they are
// now, `activeUuid()` the configuration in use, `signedIn(configuration)` is told about the configuration a sign-in made
// and `use(uuid)` puts a configuration in use. The section is hidden when no provider offers signing in (the web edition).

export function createAssistantSignInSection({ root, api, providers = () => [], configurations = () => [], activeUuid = () => null, signedIn, use }) {
    const find = (selector) => root.querySelector(selector);
    let waitingFor = null;
    let status = { text: '', tone: 'neutral' };

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, { primary = false, data = {} } = {}) {
        const node = element('button', primary ? 'settingsButton primary' : 'settingsButton', text);
        node.type = 'button';
        Object.assign(node.dataset, data);
        return node;
    }

    const signedInConfiguration = (provider) => configurations().find((configuration) => configuration.provider === provider && configuration.credentialSource === 'signIn');

    async function signIn(provider) {
        waitingFor = provider.id;
        status = { text: `Finish signing in to ${provider.name} in your browser. Konjugate will continue by itself.`, tone: 'neutral' };
        render();
        try {
            const result = await api.signIn(provider.id);
            if (result?.ok) {
                await signedIn(result.configuration);
                status = {
                    text: result.configuration.model
                        ? `Signed in to ${provider.name}. The assistant now uses ${result.configuration.model}.`
                        : `Signed in to ${provider.name}. Choose a model for it in its configuration below.`,
                    tone: 'success'
                };
            } else {
                status = result?.error?.code === 'signInCancelled'
                    ? { text: '', tone: 'neutral' }
                    : { text: result?.error?.message ?? `Could not sign in to ${provider.name}.`, tone: 'error' };
            }
        } catch (error) {
            status = { text: error.message, tone: 'error' };
        } finally {
            waitingFor = null;
            render();
        }
    }

    function row(provider) {
        const item = element('div', 'settingsItem assistantSignInRow');
        item.dataset.signInRow = provider.id;
        item.setAttribute('role', 'listitem');
        const text = element('div', 'settingsItemText');
        const existing = signedInConfiguration(provider.id);
        text.append(element('span', 'settingsItemLabel', provider.name));
        text.append(element('small', 'settingsItemHint', existing
            ? `Signed in${existing.model ? ` · ${existing.model}` : ''}` : provider.signInDescription));
        const control = element('div', 'settingsItemControl');
        if (waitingFor === provider.id) {
            control.append(element('small', 'assistantSignInWaiting', 'Waiting for your browser…'));
            const cancel = button('Cancel', { data: { signInCancel: provider.id } });
            cancel.addEventListener('click', () => api.cancelSignIn());
            control.append(cancel);
        } else if (existing) {
            if (existing.uuid === activeUuid()) {
                control.append(element('i', 'settingsBadge', 'In use'));
            } else {
                const useIt = button('Use it', { primary: true, data: { signInUse: provider.id } });
                useIt.addEventListener('click', async () => {
                    useIt.disabled = true;
                    try { await use(existing.uuid); } finally { render(); }
                });
                control.append(useIt);
            }
            const again = button('Sign in again', { data: { signIn: provider.id } });
            again.disabled = waitingFor !== null;
            again.addEventListener('click', () => signIn(provider));
            control.append(again);
        } else {
            const start = button(`Sign in with ${provider.name}`, { primary: true, data: { signIn: provider.id } });
            start.disabled = waitingFor !== null;
            start.addEventListener('click', () => signIn(provider));
            control.append(start);
        }
        item.append(text, control);
        return item;
    }

    function render() {
        const available = providers().filter((provider) => provider.signIn);
        root.hidden = !available.length;
        find('#assistantSignInList').replaceChildren(...available.map(row));
        const line = find('#assistantSignInStatus');
        line.textContent = status.text;
        line.className = `settingsNote assistantConfigurationStatus ${status.tone}`;
        line.hidden = !status.text;
    }

    return Object.freeze({ render });
}
