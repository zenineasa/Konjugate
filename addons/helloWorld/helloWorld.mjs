/* Copyright © 2026 Konjugate contributors */

const status = document.querySelector('#status');
const details = document.querySelector('#details');

async function loadContext() {
    const context = await window.konjugateVisualizer.getContext();
    if (!context) {
        status.textContent = 'No active result session is available.';
        return;
    }

    const signals = await window.konjugateVisualizer.listSignals();
    document.querySelector('#projectName').textContent = context.projectName;
    document.querySelector('#runName').textContent = context.run.name;
    document.querySelector('#signalCount').textContent = String(signals.length);
    status.textContent = 'The add-on is reading the active result through its declared permission.';
    details.hidden = false;
}

loadContext().catch((error) => {
    status.textContent = `Unable to read the result session: ${error.message}`;
});
