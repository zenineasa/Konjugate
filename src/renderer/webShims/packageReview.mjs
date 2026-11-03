/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The review a person sees before a package is installed in the web edition: what it is, what it adds and what it may do. The desktop
// shows the same facts in a native message box (packageInstall in src/main.mjs); a browser has none to match, so this is a <dialog>.

// What each permission a package may ask for lets it do, in words; one not listed here is shown by its id.
const permissionWords = {
    'results.read': 'Read the results of a simulation',
    'timeline.read': 'See the time shown in the results',
    'timeline.seek': 'Move the time shown in the results',
    'selection.read': 'See which nodes are selected',
    'results.live.read': 'Read results while a simulation runs',
    'simulation.status.read': 'See how a simulation is getting on',
    'simulation.pacing.read': 'See how fast a simulation runs',
    'simulation.pacing.control': 'Change how fast a simulation runs',
    'results.export': 'Save results to a file',
    'project.data': 'Keep data in the project file',
    'settings.store': 'Keep its own settings',
    'data.import': 'Import data files',
    'scenario.run': 'Run simulations',
    'model.open': 'Open models',
    'pages.open': 'Open its own pages',
    'analysis.infer': 'Run an analysis on your data',
    'network.fetch': 'Fetch files from the internet',
    'links.open': 'Open links',
    'files.store': 'Keep files for you'
};

// What the publisher check found, in words the person can act on. Advisory, as on the desktop: nothing here stops an install.
function describeVerification(verification) {
    if (!verification) return null;
    switch (verification.status) {
        case 'verified': return `Signed by ${verification.owner} (${verification.prefix}), and the signature checks out.`;
        case 'unsigned': return `Not signed, though ${verification.reservedPrefix} is a name reserved by its publisher. It may not be theirs.`;
        case 'unclaimed': return 'Not signed, and its name is not reserved by any publisher, so who made it cannot be checked.';
        case 'unverifiable': return 'Signed, but this browser cannot check the signature, so who made it is not confirmed.';
        default: return `Its signature does not hold: ${verification.reason} Do not install it unless you know why.`;
    }
}

const kindWords = { addon: 'Add-on', plugin: 'Plugin' };

const count = (items, kind) => items.filter((item) => item.kind === kind).length;

function describeAdditions(contributionManifest) {
    const items = contributionManifest.contributes ?? [];
    if (!Array.isArray(items)) {
        const launcher = contributionManifest.kind === 'launcher';
        return (items.toolstrip ?? []).map((button) => `a "${button.label}" button that opens ${launcher ? 'a window for bringing in data and building a model' : "its view of a simulation's results"}`);
    }
    const components = count(items, 'component');
    const examples = count(items, 'example');
    const providers = items.filter((item) => item.runtime === 'python').length;
    return [
        providers ? `${providers} relationship provider${providers === 1 ? '' : 's'} written in Python, for models to use` : null,
        components ? `${components} component template${components === 1 ? '' : 's'} for the component library` : null,
        examples ? `${examples} example model${examples === 1 ? '' : 's'}` : null
    ].filter(Boolean);
}

function text(tag, content, className = '') {
    const element = document.createElement(tag);
    element.textContent = content;
    if (className) element.className = className;
    return element;
}

// Resolves true when the person chooses Install, false when they cancel or dismiss the dialog.
export function reviewPackage({ packageManifest, contributionManifest, notes = [], verification = null }) {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'passwordDialog webPackageReviewDialog';
        const form = document.createElement('form');
        form.method = 'dialog';
        const additions = describeAdditions(contributionManifest);
        const permissions = contributionManifest.permissions ?? [];
        form.append(
            text('span', 'Install package', 'contextKicker'),
            text('strong', `Install ${packageManifest.name} ${packageManifest.version}?`),
            text('p', `${kindWords[packageManifest.packageType] ?? 'Package'} · ${packageManifest.packageId}`)
        );
        const list = document.createElement('ul');
        list.className = 'webPackageReviewList';
        list.append(...(additions.length ? additions.map((item) => text('li', `Adds ${item}`)) : [text('li', 'It adds nothing that shows in the interface.')]));
        form.append(list);
        const publisher = describeVerification(verification);
        if (publisher) form.append(text('p', publisher, verification.status === 'verified' ? 'webPackageVerified' : 'webPackageUnverified'));
        if (notes.length) form.append(...notes.map((note) => text('p', note)));
        form.append(text('p', permissions.length ? 'It may:' : 'It asks for no permissions.'));
        if (permissions.length) {
            const allowed = document.createElement('ul');
            allowed.className = 'webPackageReviewList';
            allowed.append(...permissions.map((permission) => text('li', permissionWords[permission] ?? permission)));
            form.append(allowed);
        }
        // Pyodide can reach the page's own scripts, so a provider is not walled off from it as an add-on will be (stage 3 of the proposal).
        if (additions.some((item) => item.includes('Python'))) form.append(text('p', 'A Python provider runs inside this page, with the same access the page has to your data in this browser. Unlike an add-on, it is not walled off.'));
        if (packageManifest.packageType === 'addon') form.append(text('p', 'It runs in a walled-off frame. It cannot see your models, your other packages or anything else this browser holds for this site, and it cannot reach the internet by itself. It sees only what the permissions above give it.'));
        const hosts = contributionManifest.network?.hosts ?? [];
        if (permissions.includes('network.fetch') && hosts.length) form.append(text('p', `It may ask this page to fetch from ${hosts.join(', ')} and from nowhere else. Some servers do not allow a web page to read them; fetching from those fails with a message, and works in the desktop app.`));
        form.append(text('p', 'It is stored in this browser and takes effect at once. Install packages only from publishers you trust.'));
        const footer = document.createElement('footer');
        const cancel = text('button', 'Cancel');
        cancel.type = 'button';
        const install = text('button', 'Install', 'doneButton');
        install.type = 'submit';
        footer.append(cancel, install);
        form.append(footer);
        dialog.append(form);
        let answer = false;
        cancel.addEventListener('click', () => dialog.close());
        form.addEventListener('submit', () => { answer = true; });
        dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); });
        document.body.append(dialog);
        dialog.showModal();
    });
}
