/* Copyright © 2026 Zenin Easa Panthakkalakath */

// FMI review #4: an FMI 2.0 export says why it refuses a call, through the host's logger, so Konjugate's own import of it says why a run
// stopped rather than "it gave no reason": run at a step that is not a whole number of the FMU's own, the error names that step.
//
//   node tests/engine/fmi2Reasons.mjs

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFmuPackage } from '../../src/fmiExport.mjs';
import { installFmuArchive } from '../../src/fmuPackage.mjs';
import { describeInstalledFmuPorts } from '../../src/fmiResolver.mjs';
import { fmiNodeFromPorts, implementationForFile } from '../../src/nodeProgram.mjs';
import { runWithEngine } from '../../src/engineAdapter.mjs';
import { document } from './fixtures/fmuFidelityFixture.mjs';

const root = join(import.meta.dirname, '..', '..');
const packages = await mkdtemp(join(tmpdir(), 'konjugateFmi2Reasons-'));
try {
    const buffer = await generateFmuPackage({ ...document, runConfigurations: [{ id: 900, globalTimeStep: 0.01, outputInterval: 0.1 }], activeRunConfigurationId: 900 }, {
        modelName: 'Reasons', fmiVersion: '2.0', engineOptions: { applicationPath: root, resourcesPath: '', packaged: false }
    });
    const installed = await installFmuArchive(buffer, { directory: packages });
    const ports = await describeInstalledFmuPorts(packages, installed.guid, installed.version);
    let next = 100;
    const built = fmiNodeFromPorts({ name: 'Reasons', states: [] }, { guid: installed.guid, version: installed.version, ports, newId: () => next++ });
    const host = { format: 'konjugate', version: 1, metadata: { units: 'SI' }, requires: ['fmuStartValues'], edges: [], nodes: [{ id: 1, name: 'Reasons', states: built.states, sourceTerms: [], implementation: implementationForFile(built.implementation) }] };
    let said = '';
    try {
        const outcome = await runWithEngine(JSON.stringify(host), { targetTime: 0.06, globalTimeStep: 0.015, outputInterval: 0.015, pacing: { mode: 'fastest' } },
            { applicationPath: root, resourcesPath: '', packaged: false, fmuDirectory: packages, disabledFmuKeys: [] });
        said = `${outcome.error ?? ''} ${outcome.diagnostics ?? ''}`;
        assert.ok(outcome.error, 'A step of 0.015 is not a whole number of the FMU\'s 0.01: the run should stop.');
    } catch (error) {
        said = error.message;
    }
    assert.doesNotMatch(said, /gave no reason/, `The FMU's refusal gave no reason: ${said}`);
    assert.match(said, /fmi2DoStep: the communication step size 0\.015 is not a whole number of this FMU's fixed internal step 0\.01/, said);
    console.log('✓ FMI 2.0 export: a refused fmi2DoStep says why, and Konjugate\'s run says it.');
} finally {
    await rm(packages, { recursive: true, force: true });
}
