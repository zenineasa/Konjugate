/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The code an importer runs inside in the web edition (docs/proposals/webEditionPackages.md, stage 5), as source text for a Web Worker made
// in a sandboxed frame (renderer/importerFrame.html). The desktop's importerWorker.mjs imports the importer from the package on disk and gives
// it `{ files, helpers, options }`; here the importer's source is made a module from a Blob and given the same. The helpers that need
// the application's own code (the equation and model-building ones) cannot be imported into a frame with no origin, so they are asked of
// the page and answer asynchronously: an importer must `await` them, which on the desktop does no harm. An importer is one file; one that
// imports others is not supported.

export const importerWorkerSource = `
const waiting = new Map();
let counter = 0;
const ask = (name, args) => new Promise((resolve, reject) => {
    const id = ++counter;
    waiting.set(id, { resolve, reject });
    postMessage({ helper: { id, name, args } });
});
let lastProgress = 0;
const helpers = {
    progress({ done, total, message = '' } = {}) {
        const now = Date.now();
        if (done < total && now - lastProgress < 200) return;
        lastProgress = now;
        postMessage({ progress: { done, total, message } });
    },
    reconcileEquationBindings: (...args) => ask('reconcileEquationBindings', args),
    validateEquationLatex: (...args) => ask('validateEquationLatex', args),
    applyOperations: (operations) => ask('applyOperations', [operations]),
    readPackageJson: (path) => ask('readPackageJson', [path])
};
onmessage = async (event) => {
    const message = event.data;
    if (message.helperResult) {
        const entry = waiting.get(message.helperResult.id);
        waiting.delete(message.helperResult.id);
        if (entry) { if (message.helperResult.error) entry.reject(new Error(message.helperResult.error)); else entry.resolve(message.helperResult.value); }
        return;
    }
    if (!message.run) return;
    try {
        const { source, files, options } = message.run;
        const module = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        if (typeof module.default !== 'function') throw new Error('An importer must export a default function.');
        postMessage({ ok: true, result: await module.default({ files, helpers, options }) });
    } catch (error) {
        postMessage({ ok: false, message: String(error && error.message || error) });
    }
};
`;
