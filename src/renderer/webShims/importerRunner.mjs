/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a launcher's importer in the web edition (docs/proposals/webEditionPackages.md, stage 5): in a Web Worker made inside a sandboxed frame
// (importerFrame.html), so the importer has no origin, no storage and no network, as an add-on's window has none. The page gives it the
// file texts and options and the few helpers that need the application's own code, answered here; what comes back is checked by the
// same rules as on the desktop. The frame is removed when the importer finishes or runs too long.

import { applyAssistantProposal } from '../../assistantOperations.mjs';
import { reconcileEquationBindings, validateEquationLatex } from '../../equationModel.mjs';
import { checkedImporterResult, checkedProgress } from '../../launcherImport.mjs';
import { importerWorkerSource } from '../../webImporterWorker.mjs';

const frameAddress = new URL('../importerFrame.html', import.meta.url).href;
export const importerTimeoutMilliseconds = 120_000;

const emptyProject = () => ({
    format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath', metadata: { units: 'SI' },
    runConfigurations: [], sharedParameters: [], nodes: [], edges: [], subsystems: [], edgeGroups: []
});

// `readPackageFile(path)`: the bytes of a file of the add-on's package, or null. Resolves to the importer's checked result.
export function runImporterInFrame({ source, importer, files, options, onProgress, readPackageFile, timeoutMilliseconds = importerTimeoutMilliseconds }) {
    const helperImplementations = {
        reconcileEquationBindings: (...args) => reconcileEquationBindings(...args),
        validateEquationLatex: (...args) => validateEquationLatex(...args),
        applyOperations: (operations) => {
            const { document, temporaryReferences } = applyAssistantProposal(emptyProject(), { proposalVersion: 1, operations });
            return { document, references: temporaryReferences };
        },
        readPackageJson: async (path) => {
            if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..') || !path.endsWith('.json')) throw new Error('An importer may read only JSON files inside its own package.');
            const bytes = await readPackageFile(path);
            if (!bytes) throw new Error(`${path} is not in the package.`);
            return JSON.parse(new TextDecoder().decode(bytes));
        }
    };
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('aria-hidden', 'true');
        frame.hidden = true;
        let finished = false;
        const finish = (settle, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            frame.remove();
            settle(value);
        };
        const timer = setTimeout(() => finish(reject, new Error(`The importer did not finish within ${timeoutMilliseconds / 1000} seconds.`)), timeoutMilliseconds);
        async function onMessage(event) {
            if (event.source !== frame.contentWindow) return;
            const message = event.data;
            if (!message || typeof message !== 'object') return;
            if (message.konjugate === 'importer-shell') {
                frame.contentWindow.postMessage({ start: { workerSource: importerWorkerSource, run: { source, files, options } } }, '*');
            } else if (message.importer?.helper) {
                const { id, name, args } = message.importer.helper;
                let answer;
                try {
                    if (!Object.hasOwn(helperImplementations, name) || !Array.isArray(args)) throw new Error(`Unknown helper: ${String(name).slice(0, 40)}.`);
                    answer = { id, value: await helperImplementations[name](...args) };
                } catch (error) {
                    answer = { id, error: String(error?.message ?? error).slice(0, 300) };
                }
                if (!finished) frame.contentWindow?.postMessage({ helperResult: answer }, '*');
            } else if (message.importer?.progress) {
                const progress = checkedProgress(message.importer.progress);
                if (progress) onProgress?.(progress);
            } else if (message.importer && typeof message.importer.ok === 'boolean') {
                if (!message.importer.ok) return finish(reject, new Error(`The importer failed: ${message.importer.message}`));
                try {
                    finish(resolve, checkedImporterResult(importer, message.importer.result));
                } catch (error) {
                    finish(reject, error);
                }
            }
        }
        window.addEventListener('message', onMessage);
        frame.src = frameAddress;
        document.body.append(frame);
    });
}
