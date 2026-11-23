/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { nameList } from './integrationMethods.mjs';

// The older program format's hazards that change no number (docs/proposals/programSdkV2.md, decision 8). Only a running program
// knows what its describe() declares, so validation, which never compiles or starts one, cannot see them: the engine finds them
// when it starts the programs, or takes the first checkpoint, and writes them into the result as ids (`programWarnings`). Here
// they become validation warnings in plain words, naming the program, its node or relationship and the port, and they stay
// beside validation's own while the program they are about is as it was when they were found.

const languageName = (language) => (language === 'cpp' ? 'C++' : 'Python');

// Where each program lives in a project document, by the id the engine reports: an edge, a source term (a term of a node's own
// part, a value term or a setsValue term) or a node with a program of its own.
function programOwner(projectDocument, entityId) {
    const edge = (projectDocument.edges ?? []).find((candidate) => candidate.id === entityId);
    if (edge) return { kind: 'edge', entityId: edge.id, implementation: edge.implementation, where: `the relationship ${edge.name || `${entityId}`}` };
    for (const node of projectDocument.nodes ?? []) {
        if (node.id === entityId) return { kind: 'node', entityId: node.id, implementation: node.implementation, name: node.name, where: `the node ${node.name}` };
        const term = (node.sourceTerms ?? []).find((candidate) => candidate.id === entityId);
        if (term) return { kind: 'node', entityId: node.id, field: 'sourceTerms', implementation: term.implementation, name: node.name, where: `a term of ${node.name}` };
    }
    return null;
}

// What a warning was found against: the program's source and bindings. A changed program says it again on its next run, or not.
const programSignature = (implementation) => JSON.stringify(implementation ?? null);

// A result's warnings, kept with the programs they were found against (`projectDocument` as the result was made from it).
export function captureProgramWarnings(result, projectDocument) {
    const warnings = result?.programWarnings ?? [];
    return warnings.map((warning) => ({
        ...warning,
        signatures: warning.entityIds.map((entityId) => programSignature(programOwner(projectDocument, entityId)?.implementation))
    }));
}

// The captured warnings that still hold for `projectDocument`, as validation issues.
export function programWarningIssues(captured, projectDocument) {
    const issues = [];
    for (const warning of captured ?? []) {
        const owners = warning.entityIds.map((entityId) => programOwner(projectDocument, entityId));
        if (owners.some((owner, index) => !owner || programSignature(owner.implementation) !== warning.signatures[index])) continue;
        const language = languageName(warning.language);
        if (warning.code === 'inputUnbound') {
            const [owner] = owners;
            issues.push({
                code: 'programInputUnbound',
                severity: 'warning',
                message: `The ${language} program on ${owner.where} declares the input ‘${warning.port}’, but nothing is bound to it, so it reads 0. Bind it among the program's inputs, or take it out of describe().`,
                location: { kind: owner.kind, entityId: String(owner.entityId), field: owner.field ?? '' }
            });
        } else if (warning.code === 'sharedCheckpoint') {
            issues.push({
                code: 'programSharedCheckpoint',
                severity: 'warning',
                message: `The nodes ${nameList(owners.map((owner) => owner.name))} run the same ${language} program, which runs as one object for all of them, and it keeps memory (its checkpoint() returns data): they share that memory, so what one remembers, the others read. Programs in this format keep doing so, so that saved models give the same numbers.`,
                location: { kind: 'node', entityId: String(owners[0].entityId), field: '' }
            });
        }
    }
    return issues;
}
