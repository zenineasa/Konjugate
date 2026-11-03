/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Offline use for the web edition: the page's side of scripts/webServiceWorker.js. It registers the worker (the build names its address
// in a <meta> tag, and leaves it out of the pthread variant, which has none), shows a button that saves the build for offline use or
// removes it, and, when a newer build has been downloaded and is waiting, asks whether to switch to it. The switch is the person's
// call and reloads the page, so a simulation that is running is never swapped for a different engine underneath it.

const megabytes = (bytes) => Math.round(bytes / 1_000_000);

// What the offline button says for a worker's status, and whether pressing it does anything. `status` is the worker's own report:
// { state: 'off' | 'saving' | 'ready', bytes, done, total }, or null before it has answered.
export function offlineButtonState(status, { failed = false, shortage = false } = {}) {
    if (!status) return { label: 'Use offline', disabled: true };
    if (status.state === 'saving') {
        const percent = status.total ? Math.floor(100 * status.done / status.total) : 0;
        return { label: `Saving for offline use… ${percent}%`, disabled: true };
    }
    if (status.state === 'ready') return { label: 'Available offline ✓ (remove)', disabled: false };
    if (shortage) return { label: 'Not enough storage for offline use', disabled: true };
    if (failed) return { label: 'Offline copy failed, try again', disabled: false };
    if (status.saved > 0 && status.total) return { label: `Continue saving for offline use (${Math.floor(100 * status.saved / status.total)}% done)`, disabled: false };
    return { label: `Use offline (${megabytes(status.bytes)} MB)`, disabled: false };
}

async function enoughStorage(bytes) {
    try {
        const { quota, usage } = await navigator.storage.estimate();
        return !(quota && quota - usage < bytes * 1.25);
    } catch {
        return true;
    }
}

export function installOffline({ host, version = '' }) {
    const address = document.querySelector('meta[name="konjugate-service-worker"]')?.content;
    if (!address || !('serviceWorker' in navigator) || !window.isSecureContext) return null;

    const button = document.createElement('button');
    button.id = 'offlineButton';
    button.type = 'button';
    button.className = 'offlineButton';
    host.append(button);

    // The menu's two lines about the version: which build this is, and a button that looks for a newer one and says what it found.
    const versionLine = document.createElement('button');
    versionLine.id = 'versionInfoButton';
    versionLine.type = 'button';
    versionLine.disabled = true;
    const updateCheck = document.createElement('button');
    updateCheck.id = 'updateCheckButton';
    updateCheck.type = 'button';
    host.append(versionLine, updateCheck);
    const sayMenuLabel = (element, label) => {
        element.textContent = label;
        element.dataset.menuLabel = label;
        document.dispatchEvent(new Event('konjugate:menu-labels'));
    };
    sayMenuLabel(versionLine, `Version ${version}`);
    sayMenuLabel(updateCheck, 'Check for updates');

    let status = null;
    let failed = false;
    let shortage = false;
    // Set from the person's tap until the copy is complete: while it is, an interruption is picked up again rather than reported.
    let wanted = false;
    let wakeLock = null;
    let retries = 0;
    const holdScreenAwake = async () => {
        try { if (wanted && !wakeLock && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
        wakeLock?.addEventListener?.('release', () => { wakeLock = null; });
    };
    const releaseScreen = () => { wakeLock?.release?.().catch(() => {}); wakeLock = null; };
    const render = () => {
        const { label, disabled } = offlineButtonState(status, { failed, shortage });
        button.textContent = label;
        button.dataset.menuLabel = label;
        button.disabled = disabled;
    };
    render();

    const send = async (message) => {
        const registration = await navigator.serviceWorker.ready;
        (navigator.serviceWorker.controller ?? registration.active)?.postMessage(message);
    };

    navigator.serviceWorker.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'status') {
            status = message;
            sayMenuLabel(versionLine, `Version ${version} · build ${String(message.buildId).slice(0, 8)}${message.state === 'ready' ? ' · offline copy' : ''}`);
            if (message.state === 'off' && wanted && !failed) send({ type: 'enableOffline' });
            if (message.state === 'ready') { failed = false; wanted = false; retries = 0; releaseScreen(); }
        } else if (message?.type === 'progress' && message.kind === 'update') {
            // A new build being fetched in the background is not the person's offline copy being saved.
            if (navigator.serviceWorker.controller) sayMenuLabel(updateCheck, `Downloading the new version… ${message.total ? Math.floor(100 * message.done / message.total) : 0}%`);
            return;
        } else if (message?.type === 'progress') {
            status = { ...(status ?? {}), state: 'saving', ...message };
        } else if (message?.type === 'error') {
            console.warn(`Offline copy failed: ${message.message}`);
            // What was fetched is kept, so trying again only fetches the rest.
            if (wanted && retries < 5) { retries += 1; setTimeout(() => send({ type: 'enableOffline' }), 3000 * retries); }
            else { failed = true; wanted = false; releaseScreen(); }
        }
        render();
    });

    button.addEventListener('click', async () => {
        if (status?.state === 'ready') {
            if (window.confirm('Remove the offline copy of Konjugate from this device? It stays available online.')) await send({ type: 'disableOffline' });
            return;
        }
        failed = false;
        wanted = true;
        retries = 0;
        holdScreenAwake();
        shortage = !await enoughStorage(status?.bytes ?? 0);
        if (shortage) { wanted = false; releaseScreen(); render(); return; }
        // Asks the browser not to clear the copy when the device runs short of space.
        navigator.storage?.persist?.().catch(() => {});
        await send({ type: 'enableOffline' });
    });

    const update = createUpdatePrompt();
    navigator.serviceWorker.register(address).then((registration) => {
        const offer = (worker) => {
            if (!navigator.serviceWorker.controller) return;
            update.offer(worker);
            sayMenuLabel(updateCheck, 'New version ready: tap to reload');
        };
        // A new worker that cannot fetch its whole build is dropped by the browser, and the old one carries on: said, not silent.
        const watch = (installing) => {
            installing?.addEventListener('statechange', () => {
                if (installing.state === 'installed') offer(installing);
                // Replaced by a still newer one is not a failure: only a worker that leaves with nothing following it is.
                else if (installing.state === 'redundant' && !registration.installing && !registration.waiting) {
                    console.warn('The new version could not be downloaded.');
                    sayMenuLabel(updateCheck, 'The new version could not be downloaded: tap to try again');
                }
            });
        };
        if (registration.waiting) offer(registration.waiting);
        registration.addEventListener('updatefound', () => {
            // The first worker of all is an install, not an update.
            if (navigator.serviceWorker.controller) sayMenuLabel(updateCheck, 'Downloading the new version…');
            watch(registration.installing);
        });
        updateCheck.addEventListener('click', async () => {
            if (registration.waiting) { update.reload(registration.waiting); return; }
            sayMenuLabel(updateCheck, 'Checking for updates…');
            try {
                await registration.update();
            } catch {
                sayMenuLabel(updateCheck, 'Could not check: are you online? Tap to try again');
                return;
            }
            if (registration.waiting) offer(registration.waiting);
            else if (registration.installing) sayMenuLabel(updateCheck, 'Downloading the new version…');
            else sayMenuLabel(updateCheck, 'You have the latest version: tap to check again');
        });
        // An installed app is often suspended rather than closed, and a browser checks for a newer worker only when a page loads, so
        // look again whenever the app comes back to the front.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            registration.update().catch(() => {});
            // A phone may have stopped the worker while the screen was off; asking again carries on from what was saved.
            if (wanted) { holdScreenAwake(); send({ type: 'enableOffline' }); }
        });
        // The worker can also be stopped while the screen is on, and then reports that it is no longer saving.
        setInterval(() => { if (wanted && status?.state === 'saving') send({ type: 'status' }); }, 15000);
        send({ type: 'status' });
    }).catch((error) => console.warn(`The service worker did not register: ${error.message}`));

    return { button };
}

// "A new version is ready", with Reload and Later. Reload tells the waiting worker to take over, and the page reloads once it has.
function createUpdatePrompt() {
    const element = document.createElement('div');
    element.className = 'webEditionUpdate';
    element.setAttribute('role', 'status');
    element.hidden = true;
    element.innerHTML = '<span>A new version of Konjugate is ready. Reloading stops any simulation that is running.</span>' +
        '<button type="button" class="webEditionUpdateReload">Reload</button><button type="button" class="webEditionUpdateLater">Later</button>';
    document.body.append(element);
    let waiting = null;
    let reloading = false;
    element.querySelector('.webEditionUpdateLater').addEventListener('click', () => { element.hidden = true; });
    const reload = (worker) => {
        reloading = true;
        worker?.postMessage({ type: 'skipWaiting' });
    };
    element.querySelector('.webEditionUpdateReload').addEventListener('click', () => reload(waiting));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
    return { offer(worker) { waiting = worker; element.hidden = false; }, reload };
}
