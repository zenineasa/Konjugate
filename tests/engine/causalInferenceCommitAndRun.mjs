/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Permanent regression test for the causal-inference input-replay feature
// (docs/proposals/causalInferenceInputReplay.md). Unlike continuousTimeDrift.mjs -- which
// deliberately fakes root columns' behavior in a hand-rolled JS simulator specifically to isolate
// the rate-transform's own substep-drift property from root-driving concerns -- this test builds
// a project the same way commitCausalInference() actually does (via applyAssistantProposal, not a
// reimplementation of its logic) and runs it through the real compiled engine binary. It closes
// the gap the causal-inference blog post itself left open: "when we finally run the final model
// on Konjugate, it will have some error compounding as it would not have access to any source of
// truth" -- https://www.konjugate.com/2026/08/recovering-causal-graph-from-system.html, written
// before this feature existed. This is that forward run, for real, checked against the data it
// was fit from.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildThermalSystemCsv } from '../fixtures/thermalSystemCsv.mjs';
import { parseCsv, mapColumnsToNodes, suggestSymbol } from '../../src/csvImport.mjs';
import { applyAssistantProposal } from '../../src/assistantOperations.mjs';
import { replayProviderSource } from '../../src/providerTemplate.mjs';
import { encodeProjectFile } from '../../src/projectFile.mjs';
import { decodeResultFile } from '../../src/engineProtocol.mjs';
import { decodeInferenceReport, decodeValidationReport } from '../../src/reportProtocol.mjs';

// The engine SDK root a C++ provider is compiled against -- engineAdapter.mjs's own
// cppProviderSdkPath() resolves this as "<applicationPath>/engine" in a dev build; this test
// isn't running inside Electron, so it derives the same path directly from its own file location.
const engineSdkPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');

function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

// Small, local reimplementation of renderer.mjs's own LaTeX-generation helpers -- not imported
// from renderer.mjs directly, since that module executes DOM-touching top-level code on load and
// isn't safe to import under plain Node. Kept in exact sync by construction: these are pure
// string-formatting functions with no model-specific logic, and the causal-inference engine test
// suite already re-derives comparable output independently elsewhere.
function upperFirst(text) { return text.charAt(0).toUpperCase() + text.slice(1); }
function formatFittedNumber(value) { if (value === 0) return '0'; return String(Number(value.toPrecision(6))); }
function signedTermLatex(value, symbolLatex) {
    const magnitude = formatFittedNumber(Math.abs(value));
    const term = symbolLatex ? `${magnitude} \\cdot ${symbolLatex}` : magnitude;
    return value < 0 ? `- ${term}` : `+ ${term}`;
}
function latexForFittedEdge(candidate, sourceStateSymbol, targetStateSymbol) {
    const sourceSymbol = `\\mathrm{source${upperFirst(sourceStateSymbol)}}`;
    const termsLatex = candidate.terms.slice().sort((a, b) => a.degree - b.degree)
        .map((term) => signedTermLatex(term.coefficient, term.degree === 1 ? sourceSymbol : `${sourceSymbol}^{${term.degree}}`))
        .join(' ');
    const interceptTerm = signedTermLatex(candidate.intercept, null);
    let combined = `${termsLatex} ${interceptTerm}`;
    if (candidate.interaction) {
        const targetSymbol = `\\mathrm{target${upperFirst(targetStateSymbol)}}`;
        combined += ` ${signedTermLatex(candidate.interaction.coefficient, `${sourceSymbol} \\cdot ${targetSymbol}`)}`;
    }
    return combined.replace(/^\s*\+ /, '');
}
function latexForSelfTerm(selfTerm, targetStateSymbol) {
    return signedTermLatex(selfTerm.rate, `\\mathrm{${targetStateSymbol}}`).replace(/^\+ /, '');
}

const MIN_SCORE = 0.5; // matches the "a real reviewer would deselect this" convention used
                        // throughout the causal-inference tests and docs.

// Mirrors commitCausalInference()'s exact operation sequence, including the mutual-exclusion
// rule: replayColumns (if accepted as an input) supersedes both a self term and any incoming
// edge for that column, not just root columns -- see docs/proposals/causalInferenceInputReplay.md's
// "Revision, made while implementing."
function buildOperations(mapping, report, columnSeries, replayColumns) {
    const operations = [];
    const resolvedColumns = new Map();
    mapping.forEach((entry, index) => {
        const symbol = entry.suggestedSymbol ?? suggestSymbol(entry.columnName);
        const nodeRef = `node${index}`;
        const stateRef = `${nodeRef}State`;
        operations.push({ kind: 'addNode', ref: nodeRef, name: entry.columnName });
        operations.push({
            kind: 'addState', nodeRef, ref: stateRef, name: symbol, symbol,
            initialValue: columnSeries(entry.columnName)[0].value, unit: ''
        });
        resolvedColumns.set(entry.columnName, { nodeRef, stateRef, symbol });
    });

    const replayTargets = new Set(replayColumns);
    const acceptedCandidates = report.edges
        .filter((edge) => edge.provenance === 'continuousLagged' && edge.score >= MIN_SCORE)
        .filter((edge) => !replayTargets.has(edge.targetColumn));
    const acceptedSelfTerms = report.selfTerms.filter((term) => !replayTargets.has(term.targetColumn));

    acceptedCandidates.forEach((candidate, index) => {
        const source = resolvedColumns.get(candidate.sourceColumn);
        const target = resolvedColumns.get(candidate.targetColumn);
        const edgeRef = `edge${index}`;
        operations.push({
            kind: 'addEdge', ref: edgeRef, name: `${candidate.sourceColumn} -> ${candidate.targetColumn}`,
            sourceNodeRef: source.nodeRef, targetNodeRef: target.nodeRef, directionality: 'directed'
        });
        operations.push({
            kind: 'setEdgeEquation', edgeRef, outputStateRef: target.stateRef,
            latex: latexForFittedEdge(candidate, source.symbol, target.symbol)
        });
    });
    acceptedSelfTerms.forEach((term, index) => {
        const target = resolvedColumns.get(term.targetColumn);
        operations.push({
            kind: 'addSourceTerm', ref: `selfTerm${index}`, nodeRef: target.nodeRef, outputStateRef: target.stateRef,
            latex: latexForSelfTerm(term, target.symbol)
        });
    });
    replayColumns.forEach((columnName, index) => {
        const target = resolvedColumns.get(columnName);
        operations.push({
            kind: 'addSourceTerm', ref: `input${index}`, nodeRef: target.nodeRef, outputStateRef: target.stateRef,
            implementation: { kind: 'cpp', source: replayProviderSource(columnName, columnSeries(columnName), columnName) }
        });
    });
    return operations;
}

function rmsError(samples, rows, columnNames, stateIdByColumn, includeColumns) {
    let sumSquares = 0, count = 0;
    for (let row = 0; row < samples.length && row < rows.length; row += 1) {
        for (const columnName of includeColumns) {
            const stateId = stateIdByColumn.get(columnName);
            const stateEntry = samples[row].states.find((state) => state.stateId === stateId);
            const diff = stateEntry.value - rows[row].values[columnNames.indexOf(columnName)];
            if (!Number.isFinite(diff)) return Infinity;
            sumSquares += diff * diff;
            count += 1;
        }
    }
    return Math.sqrt(sumSquares / count);
}

async function commitAndRun(label, mapping, report, parsedCsv, columnSeries, replayColumns, directory, executable) {
    const operations = buildOperations(mapping, report, columnSeries, replayColumns);
    const base = { format: 'konjugate', version: 1, nodes: [], edges: [] };
    const { document } = applyAssistantProposal(base, { proposalVersion: 1, operations });

    const inputPath = join(directory, `${label}.kjt`);
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));

    const validateReportPath = join(directory, `${label}.validate.bin`);
    assert.equal(await execute(executable, ['validate', inputPath, '--report', validateReportPath]),
        0, `${label}: validate must succeed.`);
    const validation = decodeValidationReport(await readFile(validateReportPath));
    assert.equal(validation.valid, true, `${label}: the committed model must be valid (${JSON.stringify(validation.issues)}).`);

    const configPath = join(directory, `${label}.config.json`);
    const outputPath = join(directory, `${label}.result.bin`);
    await writeFile(configPath, JSON.stringify({
        name: label, targetTime: parsedCsv.rows.length - 1, globalTimeStep: 1, outputInterval: 1,
        providers: { executionMode: 'inProcess', cpp: { sdkPath: engineSdkPath } }
    }));
    assert.equal(await execute(executable, ['run', inputPath, '--configuration', configPath, '--output', outputPath]),
        0, `${label}: run must succeed.`);

    const result = decodeResultFile(await readFile(outputPath));
    const stateIdByColumn = new Map(document.nodes.map((node) => [node.name, node.states[0].id]));
    return { result, stateIdByColumn };
}

const executable = process.argv[2];
if (!executable) throw new Error('Pass the konjugateEngine executable path.');

const directory = await mkdtemp(join(tmpdir(), 'konjugateCausalInferenceCommitAndRun-'));
try {
    const csvContent = buildThermalSystemCsv();
    const inputCsvPath = join(directory, 'thermalSystem.csv');
    const reportPath = join(directory, 'inference.bin');
    await writeFile(inputCsvPath, csvContent);
    assert.equal(await execute(executable, ['infer', inputCsvPath, '--report', reportPath, '--degrees', '1,2']),
        0, 'infer must succeed on the 8-node thermal system.');
    const report = decodeInferenceReport(await readFile(reportPath));

    const parsedCsv = parseCsv(csvContent);
    const mapping = mapColumnsToNodes(parsedCsv.columnNames, []);
    const columnSeries = (columnName) => {
        const columnIndex = parsedCsv.columnNames.indexOf(columnName);
        return parsedCsv.rows.map((row) => ({ time: row.time, value: row.values[columnIndex] }));
    };

    const roots = ['ambientTemperature', 'motorLoad', 'solarIrradiance'];
    const downstream = parsedCsv.columnNames.filter((name) => !roots.includes(name));

    // Variant 1: the 3 structural roots replayed via the input-replay provider -- what a user
    // following the review UI's own default suggestion would commit.
    const withReplay = await commitAndRun('withReplay', mapping, report, parsedCsv, columnSeries, roots, directory, executable);
    const withReplayRms = rmsError(withReplay.result.samples, parsedCsv.rows, parsedCsv.columnNames, withReplay.stateIdByColumn, downstream);
    assert.ok(Number.isFinite(withReplayRms), `withReplay: downstream RMS must be finite, got ${withReplayRms}.`);
    // Generous relative to the actually-observed ~0.90 (matches continuousTimeDrift.mjs's own
    // ~0.90 hand-simulated baseline almost exactly), to tolerate normal variation without being
    // fragile to it.
    assert.ok(withReplayRms < 3.0,
        `withReplay: downstream RMS (${withReplayRms.toFixed(4)}) is unexpectedly large -- the input-replay mechanism may have regressed.`);

    // Variant 2: no replay -- the 3 roots are left with only their own recovered self term (a
    // real, but self-decay-only, dynamic). This is what happens if a user leaves the "input"
    // checkboxes unchecked, or what always happened before this feature existed.
    const withoutReplay = await commitAndRun('withoutReplay', mapping, report, parsedCsv, columnSeries, [], directory, executable);
    const withoutReplayRms = rmsError(withoutReplay.result.samples, parsedCsv.rows, parsedCsv.columnNames, withoutReplay.stateIdByColumn, downstream);
    assert.ok(Number.isFinite(withoutReplayRms), `withoutReplay: downstream RMS must be finite, got ${withoutReplayRms}.`);
    // The actual property under test: replaying the roots must substantially beat leaving them to
    // decay toward equilibrium -- observed ~11x on this system; a 3x floor catches a real
    // regression (the fix silently stopped helping) without being fragile to small legitimate
    // shifts in the fit.
    assert.ok(withoutReplayRms > withReplayRms * 3,
        `Input replay should substantially reduce downstream error: without=${withoutReplayRms.toFixed(4)}, `
        + `with=${withReplayRms.toFixed(4)} (ratio ${(withoutReplayRms / withReplayRms).toFixed(2)}x, expected > 3x).`);

    // Variant 3: mutual exclusion for a NON-root column. thermalStress has real, high-confidence
    // incoming structure (an edge from componentTemperature, its own quadratic self term) --
    // marking it as an input must replace both, not add to them (Konjugate sums every
    // contribution to a state additively, so a double-counted derivative would corrupt it
    // silently -- validation cannot catch this, only comparing the actual result can). See
    // docs/proposals/causalInferenceInputReplay.md's "Mutual exclusion, generalized for any
    // column."
    const mixedColumns = [...roots, 'thermalStress'];
    const mixed = await commitAndRun('mixedAnyColumnReplay', mapping, report, parsedCsv, columnSeries, mixedColumns, directory, executable);
    const thermalStressRms = rmsError(mixed.result.samples, parsedCsv.rows, parsedCsv.columnNames, mixed.stateIdByColumn, ['thermalStress']);
    assert.ok(Number.isFinite(thermalStressRms) && thermalStressRms < 0.5,
        `A replayed non-root column must reproduce its recorded values closely (thermalStress RMS ${thermalStressRms}), `
        + 'not be corrupted by a double-counted edge/self-term contribution still targeting it.');

    console.log(`✓ causal-inference commit-and-run: downstream RMS with replay ${withReplayRms.toFixed(4)}, `
        + `without replay ${withoutReplayRms.toFixed(4)} (${(withoutReplayRms / withReplayRms).toFixed(2)}x worse), `
        + `mixed-scenario replayed thermalStress RMS ${thermalStressRms.toFixed(4)}.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
