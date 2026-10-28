/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The vocabulary the evaluation cases and any generated requests are tagged with, and the intake check for requests
// written by other agents (evals/assistant/requestGenerationPrompt.md). A request pool is only useful for training if it
// stays clear of the test cases, so the check refuses anything that repeats or nearly repeats a test request and, for
// training, anything on a model reserved for the test.

export const evalFamilies = Object.freeze([
    'addNode', 'addState', 'addParameter', 'multiStep', 'setEquation', 'updateValue', 'updateParameter', 'updateNode',
    'updateEdge', 'enableDisable', 'remove', 'units', 'reference', 'clarification', 'history'
]);
export const evalStyles = Object.freeze(['terse', 'plain', 'conversational', 'indirect', 'verbose', 'loose', 'typos', 'multiPart']);
export const evalDomainModels = Object.freeze({
    thermal: ['heatedWaterTank', 'thermalManagement', 'twoRoomBuilding', 'thermalEquilibrium', 'blank'],
    electrical: ['singleJointActuator', 'wheeledRobotDrivetrain', 'batteryPoweredJoint', 'blank'],
    mechanical: ['springMassDamper', 'fourBarLinkage', 'blank'],
    robotics: ['articulatedRoboticArm', 'positionControlledJoint', 'blank'],
    fluid: ['pumpSuctionHydraulics', 'blank'],
    logistics: ['logisticsPortNetwork', 'blank'],
    finance: ['financeCompany', 'blank'],
    general: ['blank', 'sirEpidemic', 'predatorPrey', 'webServiceQueue', 'solarHomeEnergy', 'drugDose', 'lakeCatchment', 'saasSubscribers', 'stirredReactor', 'vehicleCruise', 'cropField']
});
// Models whose requests belong to the test only, so that a model trained on the pool is judged on models it has not
// seen. A domain with a single model (fluid, logistics, finance) cannot spare it, and its test scores are correspondingly
// less telling.
export const heldOutModels = Object.freeze(['twoRoomBuilding', 'batteryPoweredJoint', 'fourBarLinkage', 'positionControlledJoint', 'stirredReactor', 'vehicleCruise', 'cropField']);

const normalize = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s.]/gu, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
const words = (text) => new Set(normalize(text).split(' ').filter(Boolean));
function similarity(a, b) {
    const left = words(a), right = words(b);
    const shared = [...left].filter((word) => right.has(word)).length;
    return left.size + right.size ? shared / (left.size + right.size - shared) : 0;
}

// Returns { accepted, rejected: [{ item, reasons }] }. `purpose` is 'train' (keeps off the held-out models) or 'test'.
export function checkGeneratedRequests(items, { testCases = [], purpose = 'train', nearDuplicate = 0.7 } = {}) {
    const accepted = [];
    const rejected = [];
    const seen = [];
    const testRequests = testCases.map((evalCase) => evalCase.request);
    for (const item of items) {
        const reasons = [];
        if (!item || typeof item !== 'object') {
            rejected.push({ item, reasons: ['not an object'] });
            continue;
        }
        if (!(item.domain in evalDomainModels)) reasons.push(`unknown domain “${item.domain}”`);
        else if (!evalDomainModels[item.domain].includes(item.model)) reasons.push(`model “${item.model}” is not one of the ${item.domain} models`);
        if (purpose === 'train' && heldOutModels.includes(item.model)) reasons.push(`model “${item.model}” is reserved for the test`);
        if (!evalFamilies.includes(item.family)) reasons.push(`unknown family “${item.family}”`);
        if (!evalStyles.includes(item.style)) reasons.push(`unknown style “${item.style}”`);
        if (typeof item.request !== 'string' || item.request.trim().length < 2 || item.request.length > 800) reasons.push('request must be a string of 2–800 characters');
        if (typeof item.expectedOutcome !== 'string' || !item.expectedOutcome.trim()) reasons.push('expectedOutcome is required');
        if (item.family === 'history' || item.history !== undefined) {
            const valid = Array.isArray(item.history) && item.history.length > 0 && item.history.every((turn) => typeof turn?.request === 'string' && /^(Asked|Proposed|Applied|Discarded|Rejected|Error): /.test(turn?.outcome ?? ''));
            if (!valid) reasons.push('history must be a non-empty list of { request, outcome } where outcome starts “Asked: ”, “Proposed: ”, “Applied: ”, “Discarded: ”, “Rejected: ” or “Error: ”');
        }
        if (typeof item.request === 'string' && !reasons.length) {
            const key = normalize(item.request) + (item.history ? `|${normalize(JSON.stringify(item.history))}` : '');
            if (seen.some((entry) => entry.key === key)) reasons.push('duplicates an earlier request in this file');
            else if (testRequests.some((request) => normalize(request) === normalize(item.request))) reasons.push('is a test request');
            else {
                const close = testRequests.find((request) => similarity(request, item.request) >= nearDuplicate);
                if (close) reasons.push(`is nearly identical to the test request “${close}”`);
                const alike = seen.find((entry) => entry.model === item.model && similarity(entry.request, item.request) >= 0.9);
                if (alike) reasons.push(`is nearly identical to the earlier request “${alike.request}”`);
            }
            if (!reasons.length) seen.push({ key, request: item.request, model: item.model });
        }
        if (reasons.length) rejected.push({ item, reasons }); else accepted.push(item);
    }
    return { accepted, rejected };
}

const structureWords = new Set(['node', 'state', 'relationship', 'parameter', 'value', 'name', 'direction']);
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What checkGeneratedRequests cannot see, because it needs the model: an `expectedOutcome` that gives a node a state it
// does not have ("the Tank liquid level becomes ..." when the tank only has a pressure), and requests that quote long
// catalog names word for word, which no person does and which would teach a model to expect exact names. These are
// warnings for a person to look at, not rejections: the first is a heuristic, and the second only matters as a share
// of the batch. `documents` maps a model id to its document; `blank` and unknown models are skipped.
export function reviewGeneratedRequests(items, documents, { maximumVerbatimShare = 0.25 } = {}) {
    const warnings = [];
    let existing = 0;
    let verbatim = 0;
    for (const item of items) {
        const document = documents[item.model];
        if (!document || item.family === 'clarification') continue;
        existing += 1;
        const request = normalize(item.request);
        const names = [...document.nodes.map((node) => node.name), ...document.edges.map((edge) => edge.name)];
        if (names.some((name) => name.trim().split(/\s+/).length >= 3 && request.includes(normalize(name)))) verbatim += 1;
        for (const node of document.nodes) {
            const pattern = new RegExp(`\\b${escapePattern(node.name)}(?:'s)?\\s+([A-Za-z][A-Za-z0-9 ()/,-]*?)\\s+(?:becomes|is set to|are|is|changes|goes)\\b`, 'i');
            const phrase = pattern.exec(item.expectedOutcome ?? '')?.[1]?.trim();
            if (!phrase || structureWords.has(phrase.toLowerCase()) || /\b(?:and|relationships?)\b/i.test(phrase)) continue;
            // “Tank drives Suction Line 1” is a relationship that starts with a node's name, not a state of that node.
            const outcome = normalize(item.expectedOutcome);
            if (names.some((name) => normalize(name).startsWith(`${normalize(node.name)} `) && outcome.includes(normalize(name)))) continue;
            const known = node.states.some((state) => normalize(state.name).includes(normalize(phrase)) || normalize(phrase).includes(normalize(state.name)) || normalize(state.symbol) === normalize(phrase));
            if (!known) warnings.push({ item, message: `the expected outcome gives “${node.name}” a “${phrase}”, but its states are ${node.states.map((state) => state.name).join(', ')}` });
        }
    }
    const share = existing ? verbatim / existing : 0;
    if (share > maximumVerbatimShare) {
        warnings.push({ item: null, message: `${verbatim} of ${existing} requests on existing models quote a long catalog name word for word (${Math.round(share * 100)}%; the limit is ${Math.round(maximumVerbatimShare * 100)}%)` });
    }
    return { warnings, verbatimShare: share };
}
