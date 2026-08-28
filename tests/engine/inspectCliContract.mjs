/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Contract test for the `inspect` CLI subcommand (docs/engineCli.md:8) -- a cheap, read-only
// check of a .kjt container's format tag, container version, and whether it's encrypted, without
// touching the model document inside or requiring a password (engine/src/projectContainer.cpp's
// inspectProject() only ever calls parseContainer(), never decrypt()). This is the one report
// type with no caller anywhere in the app (src/main.mjs uses its own pure-JS equivalent,
// src/projectFile.mjs's inspectProjectFile(), instead of spawning the engine for it), so it had no
// test coverage on the JS decode side at all until this file: everything below verifies the
// documented CLI contract directly, independent of whether the app itself happens to use it.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeInspectionReport } from '../../src/reportProtocol.mjs';

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

function model() {
    const node = { id: 1, name: 'Node A', type: 'Generic', position: [0, 0, 0],
        states: [{ id: 2, name: 'x', symbol: 'x', initialValue: 1, unit: '' }],
        sourceTerms: [], appearance: { type: 'primitive', shape: 'box', color: '#2f6970' } };
    return {
        format: 'konjugate', version: 1, copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        metadata: { units: 'SI' }, nodes: [node], edges: []
    };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');
const directory = await mkdtemp(join(tmpdir(), 'konjugateInspectCli-'));

try {
    // A plain, unencrypted project inspects cleanly and reports encrypted: false.
    const plainPath = join(directory, 'plain.kjt');
    const plainReportPath = join(directory, 'plainReport.bin');
    await writeFile(plainPath, await encodeProjectFile(JSON.stringify(model())));
    const plainExitCode = await execute(executable, ['inspect', plainPath, '--report', plainReportPath]);
    assert.equal(plainExitCode, 0, 'Inspecting a plain project should succeed.');
    const plainReport = decodeInspectionReport(await readFile(plainReportPath));
    assert.equal(plainReport.format, 'kjt');
    assert.equal(plainReport.containerVersion, 1);
    assert.equal(plainReport.encrypted, false);

    // An encrypted project inspects just as cleanly, with no password involved -- inspect only
    // reads the container header, it never decrypts the payload -- and reports encrypted: true.
    const encryptedPath = join(directory, 'encrypted.kjt');
    const encryptedReportPath = join(directory, 'encryptedReport.bin');
    await writeFile(encryptedPath, await encodeProjectFile(JSON.stringify(model()), {
        password: 'inspect cli contract password',
        scryptCost: 2 ** 14
    }));
    const encryptedExitCode = await execute(executable, ['inspect', encryptedPath, '--report', encryptedReportPath]);
    assert.equal(encryptedExitCode, 0, 'Inspecting an encrypted project should succeed without a password.');
    const encryptedReport = decodeInspectionReport(await readFile(encryptedReportPath));
    assert.equal(encryptedReport.format, 'kjt');
    assert.equal(encryptedReport.containerVersion, 1);
    assert.equal(encryptedReport.encrypted, true);

    // A file that is not a Konjugate container at all fails with exit code 3 (docs/engineCli.md's
    // documented "Input, container, or payload is invalid" code) and writes no report.
    const invalidPath = join(directory, 'invalid.kjt');
    const invalidReportPath = join(directory, 'invalidReport.bin');
    await writeFile(invalidPath, Buffer.from('not a konjugate container'));
    const invalidExitCode = await execute(executable, ['inspect', invalidPath, '--report', invalidReportPath]);
    assert.equal(invalidExitCode, 3, 'Inspecting a non-container file should fail with the documented INVALID_FORMAT exit code.');
    await assert.rejects(readFile(invalidReportPath), 'No report should be written when inspection fails before a report can be built.');

    console.log('✓ inspect CLI contract: format/version/encrypted round-trip correctly for plain and encrypted containers, and invalid input fails cleanly.');
} finally {
    await rm(directory, { recursive: true, force: true });
}
