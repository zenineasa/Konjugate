/* Copyright © 2026 Zenin Easa Panthakkalakath */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragControls } from 'three/addons/controls/DragControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import 'mathlive';
import { DocumentController } from './documentController.mjs';
import {
    latexForBinding,
    reconcileEquationBindings,
    validateEquationLatex
} from '../equationModel.mjs';
import { validateProjectPassword } from './passwordValidation.mjs';
import { defaultProviderSource } from '../providerTemplate.mjs';
import { eligibleEndpointIds, virtualKeyboardInset } from './viewportLayout.mjs';
import { groupRelationshipBundles } from '../relationshipBundles.mjs';
import { nearestSampleIndex, nodeResultSeries, ResultPlot } from './resultPlot.mjs';
import { suggestedPlaybackRate } from '../resultSession.mjs';
import { seriesToCsv } from '../resultExport.mjs';
import { createGraphFragment, remapGraphFragment, validateGraphFragment } from '../graphClipboard.mjs';
import { deriveSubsystemPorts, executionProjectDocument, hydrateSubsystems } from '../subsystems.mjs';
import {
    expandEdgeGroup,
    hydrateEdgeGroups,
    resolveGroupEdgeForPair,
    stripEdgeGroups,
    unresolvedGroupSymbols
} from '../edgeGroups.mjs';
import { applyAssistantProposal as buildAssistantProposal } from '../assistantOperations.mjs';
import { mapColumnsToNodes, parseCsv, suggestSymbol } from '../csvImport.mjs';
import {
    CSS2DObject,
    CSS2DRenderer
} from 'three/addons/renderers/CSS2DRenderer.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
}[character]));
const modelSymbolPattern = /^[a-z][A-Za-z0-9]*$/;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Backstop so any console.error/console.warn -- including ones nobody has wired up to a
// dedicated UI element -- still reaches the user via the quiet diagnostics badge/panel below,
// instead of only a devtools console most users never open.
const diagnosticsEntries = [];
const diagnosticsSeenIds = new Set();
let diagnosticsUnseenCount = 0;
let diagnosticsNextLocalId = -1;

function formatConsoleArgs(args) {
    return args.map((arg) => (
        arg instanceof Error ? (arg.stack || arg.message)
            : (typeof arg === 'string' ? arg : (() => { try { return JSON.stringify(arg); } catch { return String(arg); } })())
    )).join(' ');
}

function addDiagnosticsEntry(entry) {
    if (diagnosticsSeenIds.has(entry.id)) return;
    diagnosticsSeenIds.add(entry.id);
    diagnosticsEntries.unshift(entry);
    if (diagnosticsEntries.length > 200) diagnosticsEntries.pop();
    diagnosticsUnseenCount += 1;
    renderDiagnosticsBadge();
    if (!$('#diagnosticsPanel').classList.contains('hidden')) renderDiagnosticsList();
}

function renderDiagnosticsBadge() {
    const badge = $('#diagnosticsBadge');
    badge.hidden = diagnosticsUnseenCount === 0;
    badge.textContent = diagnosticsUnseenCount > 99 ? '99+' : String(diagnosticsUnseenCount);
}

function renderDiagnosticsList() {
    const container = $('#diagnosticsList');
    container.innerHTML = '';
    if (!diagnosticsEntries.length) {
        const empty = document.createElement('p');
        empty.className = 'diagnosticsEmpty';
        empty.textContent = 'No issues logged.';
        container.appendChild(empty);
        return;
    }
    for (const entry of diagnosticsEntries) {
        const row = document.createElement('div');
        row.className = `diagnosticsEntry diagnosticsEntry-${entry.severity}`;
        const time = document.createElement('span');
        time.className = 'diagnosticsEntryTime';
        time.textContent = new Date(entry.timestamp).toLocaleTimeString();
        const message = document.createElement('span');
        message.className = 'diagnosticsEntryMessage';
        message.textContent = entry.message;
        row.append(time, message);
        container.appendChild(row);
    }
}

const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.error = (...args) => {
    originalConsoleError(...args);
    addDiagnosticsEntry({ id: diagnosticsNextLocalId--, severity: 'error', message: formatConsoleArgs(args), timestamp: Date.now() });
};
console.warn = (...args) => {
    originalConsoleWarn(...args);
    addDiagnosticsEntry({ id: diagnosticsNextLocalId--, severity: 'warning', message: formatConsoleArgs(args), timestamp: Date.now() });
};
window.diagnostics?.list().then((entries) => entries.forEach(addDiagnosticsEntry));
window.diagnostics?.onIssue(addDiagnosticsEntry);
const defaultWorkerThreads = Math.max(1, Math.min(256, Number(navigator.hardwareConcurrency) || 1));
let nextModelEntityId = 1;
const validModelEntityId = (value) => Number.isSafeInteger(value) && value > 0;
const allocateModelEntityId = () => nextModelEntityId++;
const normalizeExecutionConfiguration = (execution = {}) => ({
    backend: ['automatic', 'serial', 'threadPool', 'partitioned'].includes(execution.backend) ? execution.backend : 'automatic',
    partitionAlgorithm: ['automatic', 'metisKway', 'communicationAwareGreedy'].includes(execution.partitionAlgorithm)
        ? execution.partitionAlgorithm : 'automatic',
    workerThreads: Math.max(1, Math.min(256, Math.round(Number(execution.workerThreads) || defaultWorkerThreads))),
    partitionCount: Math.max(1, Math.min(256, Math.round(Number(execution.partitionCount) || defaultWorkerThreads))),
    partitionCommunicationBias: Math.max(0, Number.isFinite(Number(execution.partitionCommunicationBias))
        ? Number(execution.partitionCommunicationBias) : 4),
    automaticParallelThreshold: Math.max(1, Math.min(1000000, Math.round(Number(execution.automaticParallelThreshold) || 128))),
    automaticMaximumPartitionCutFraction: Math.max(0, Math.min(1,
        Number.isFinite(Number(execution.automaticMaximumPartitionCutFraction))
            ? Number(execution.automaticMaximumPartitionCutFraction) : 0.25))
});
const defaultRunConfiguration = () => ({
    id: allocateModelEntityId(), name: 'Default', globalTimeStep: 0.01, outputInterval: 0.1,
    execution: normalizeExecutionConfiguration()
});

const canvas = $('#canvas');
const webglContainer = $('#webglContainer');
const css2dContainer = $('#css2dContainer');

function setupVirtualKeyboardLayout() {
    const keyboard = window.mathVirtualKeyboard;
    if (!keyboard) return;

    const updateInset = (event) => {
        const visible = event?.type === 'virtual-keyboard-toggle'
            ? Boolean(event.detail?.visible)
            : Boolean(keyboard.visible);
        const bounds = event?.detail?.boundingRect ?? keyboard.boundingRect;
        const inset = virtualKeyboardInset(window.innerHeight, bounds, visible);
        document.documentElement.style.setProperty('--math-keyboard-inset', `${inset}px`);
        if (!inset) return;
        requestAnimationFrame(() => {
            const activeEquation = $$('.equationMathField').find((field) => field.matches(':focus-within'));
            activeEquation?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
    };

    keyboard.addEventListener('geometrychange', updateInset);
    keyboard.addEventListener('virtual-keyboard-toggle', updateInset);
    window.addEventListener('resize', updateInset);
}

customElements.whenDefined('math-field').then(setupVirtualKeyboardLayout);

function geometryFromDocument(mesh) {
    if (!mesh?.position?.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.position, 3));
    if (mesh.normal?.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normal, 3));
    else geometry.computeVertexNormals();
    if (mesh.index?.length) geometry.setIndex(mesh.index);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

function hydrateProjectDocument(document) {
    if (document?.format !== 'konjugate' || document.version !== 1) {
        throw new Error('This is not a supported Konjugate project document.');
    }
    if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) {
        throw new Error('The project must contain node and edge arrays.');
    }
    const ids = new Set();
    const nodeIds = new Set();
    const stateIdsByNode = new Map();
    nextModelEntityId = 1;
    const registerId = (id, message) => {
        if (!validModelEntityId(id) || ids.has(id)) throw new Error(message);
        ids.add(id);
        nextModelEntityId = Math.max(nextModelEntityId, id + 1);
    };
    document.nodes.forEach((node) => {
        registerId(node.id, 'Every node must have a unique positive integer id.');
        nodeIds.add(node.id);
        const stateIds = new Set();
        const stateSymbols = new Set();
        (node.states ?? []).forEach((state) => {
            registerId(state.id, `Every state in “${node.name ?? node.id}” must have a unique positive integer id.`);
            stateIds.add(state.id);
            if (!modelSymbolPattern.test(state.symbol) || stateSymbols.has(state.symbol)) {
                throw new Error(`State symbols in “${node.name ?? node.id}” must be unique lower camel case identifiers.`);
            }
            stateSymbols.add(state.symbol);
        });
        (node.sourceTerms ?? []).forEach((term) => {
            registerId(term.id, `Every source term in “${node.name ?? node.id}” must have a unique positive integer id.`);
            if (!stateSymbols.has(term.state)) {
                throw new Error(`A source term in “${node.name ?? node.id}” references a missing state symbol.`);
            }
        });
        stateIdsByNode.set(node.id, stateIds);
    });
    const subsystems = hydrateSubsystems(document, registerId);
    // Registered before the edges loop below: a group's shared parameters are registered exactly
    // once here, against the group's own definition, so a member edge's own copy of those same
    // parameter ids (see edgeGroups.mjs) is recognized and skipped rather than rejected as a
    // duplicate.
    const edgeGroups = hydrateEdgeGroups(document, registerId);
    document.edges.forEach((edge) => {
        registerId(edge.id, 'Every edge must have a unique positive integer id.');
        if (!nodeIds.has(edge.source?.nodeId) || !nodeIds.has(edge.target?.nodeId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing node.`);
        }
        if (edge.source.stateId && !stateIdsByNode.get(edge.source.nodeId)?.has(edge.source.stateId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing source state.`);
        }
        if (edge.target.stateId && !stateIdsByNode.get(edge.target.nodeId)?.has(edge.target.stateId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing target state.`);
        }
        if (edge.groupId != null) return;
        const parameterSymbols = new Set();
        (edge.parameters ?? []).forEach((parameter) => {
            registerId(parameter.id, `Every parameter in “${edge.name ?? edge.id}” must have a unique positive integer id.`);
            if (!modelSymbolPattern.test(parameter.symbol) || parameterSymbols.has(parameter.symbol)) {
                throw new Error(`Parameter symbols in “${edge.name ?? edge.id}” must be unique lower camel case identifiers.`);
            }
            if (!['constant', 'live'].includes(parameter.mode)) {
                throw new Error(`Parameter mode in “${edge.name ?? edge.id}” must be constant or live.`);
            }
            if (parameter.mode === 'live' && parameter.control && parameterControlError(Number(parameter.value), {
                minimum: Number(parameter.control.minimum),
                maximum: Number(parameter.control.maximum),
                step: Number(parameter.control.step)
            })) {
                throw new Error(`Live parameter slider settings in “${edge.name ?? edge.id}” are invalid.`);
            }
            parameterSymbols.add(parameter.symbol);
        });
    });
    (document.runConfigurations ?? []).forEach((configuration) => {
        registerId(configuration.id, 'Every run configuration must have a unique positive integer id.');
    });

    const nodes = document.nodes.map((node) => {
        const appearance = node.appearance ?? {};
        const importedGeometry = appearance.type === 'mesh'
            ? geometryFromDocument(appearance.mesh)
            : null;
        return {
            id: node.id,
            title: node.name || 'Untitled node',
            type: node.type || 'Custom node',
            shape: importedGeometry ? 'imported' : appearance.shape || 'box',
            position: node.position?.length === 3 ? node.position : [0, 0, 0],
            rotation: node.rotation?.length === 3 ? node.rotation : [0, 0, 0],
            scale: node.scale?.length === 3 ? node.scale : [1, 1, 1],
            color: Number.parseInt(String(appearance.color ?? '#34727a').replace('#', ''), 16),
            importedGeometry,
            geometryFileName: appearance.fileName ?? null,
            badgeClass: '',
            subsystemId: node.subsystemId ?? null,
            deleted: false,
            enabled: node.enabled !== false,
            substepsPerGlobalStep: Math.max(1, Math.min(10000, Number(node.numerics?.substepsPerGlobalStep) || 1)),
            sourceTerms: node.sourceTerms ?? [],
            states: (node.states ?? []).map((state) => ({
                id: state.id,
                label: state.name,
                symbol: state.symbol,
                initialValue: state.initialValue,
                unit: state.unit ?? '',
                value: `${state.initialValue}${state.unit ? ` ${state.unit}` : ''}`,
                className: ''
            }))
        };
    });
    const relationships = document.edges.map((edge) => ({
        id: edge.id,
        groupId: edge.groupId ?? null,
        title: edge.name || 'Untitled relationship',
        source: edge.source.nodeId,
        sourceStateId: edge.source.stateId ?? null,
        target: edge.target.nodeId,
        targetStateId: edge.target.stateId ?? null,
        directionality: edge.directionality ?? 'directed',
        equation: edge.equation ?? '',
        equationModel: edge.equationModel ?? {
            latex: edge.equation ?? '',
            output: { role: 'target', stateId: edge.target.stateId ?? null },
            bindings: [],
            mathJson: null
        },
        implementation: edge.implementation ?? null,
        parameters: edge.parameters ?? [],
        color: Number.parseInt(String(edge.appearance?.color ?? '#9c83c4').replace('#', ''), 16),
        offset: Number(edge.appearance?.offset) || 0,
        waypoints: Array.isArray(edge.appearance?.waypoints) ? edge.appearance.waypoints.map((point) => point.map(Number)) : [],
        deleted: false,
        enabled: edge.enabled !== false
    }));
    const runConfigurations = Array.isArray(document.runConfigurations) && document.runConfigurations.length
        ? document.runConfigurations.map((configuration) => ({
            id: configuration.id ?? allocateModelEntityId(),
            name: configuration.name || 'Untitled',
            globalTimeStep: Number(configuration.globalTimeStep) || 0.01,
            outputInterval: Number(configuration.outputInterval) || 0.1,
            execution: normalizeExecutionConfiguration(configuration.execution)
        }))
        : [defaultRunConfiguration()];
    return {
        metadata: { units: document.metadata?.units || 'SI' },
        runConfigurations,
        activeRunConfigurationId: runConfigurations.some((item) => item.id === document.activeRunConfigurationId)
            ? document.activeRunConfigurationId : runConfigurations[0].id,
        nodes,
        relationships,
        subsystems,
        edgeGroups
    };
}

const emptyProjectDocument = {
    format: 'konjugate',
    version: 1,
    copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
    metadata: { units: 'SI' },
    runConfigurations: [],
    nodes: [],
    edges: [],
    subsystems: [],
    edgeGroups: []
};
const model = hydrateProjectDocument(emptyProjectDocument);
let currentProjectPath = null;
let currentProjectFilename = 'untitled.kjt';
let currentProjectPassword = null;
let activeExampleId = null;

function filenameStem(fileName) {
    return fileName.replace(/\.kjt$/i, '');
}

function camelCaseFilename(value) {
    const words = value.trim().replace(/\.kjt$/i, '')
        .split(/[^A-Za-z0-9]+|(?=[A-Z])/).filter(Boolean);
    if (!words.length) return 'untitled.kjt';
    const stem = words.map((word, index) => {
        const lower = word.toLowerCase();
        return index ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    }).join('');
    return `${stem}.kjt`;
}

function updateDocumentTitle() {
    $('.documentTitle').textContent = filenameStem(currentProjectFilename);
}

function updateEncryptionControls() {
    const encrypted = Boolean(currentProjectPassword);
    $('#encryptionStatus').hidden = !encrypted;
    $('#saveEncryptedButton').dataset.tooltip = encrypted ? 'Encryption options…' : 'Save encrypted…';
    $('#saveEncryptedButton').ariaLabel = encrypted ? 'Encryption options' : 'Save encrypted project';
}

updateDocumentTitle();
updateEncryptionControls();

const nodeObjects = new Map();
const relationshipObjects = new Map();
const subsystemObjects = new Map();
const nodePickTargets = [];
const relationshipPickTargets = [];
// Handles are pushed into nodePickTargets (not a separate DragControls instance) -- DragControls'
// internal _selected/_hovered/_plane state is module-scope, not per-instance, so two concurrent
// instances on the same domElement would race over it. Keyed by relationship id since only the
// selected relationship's waypoints get handles at all.
const waypointHandleObjects = new Map();
let selectedNode = null;
const selectedNodeIds = new Set();
let selectedRelationship = null;
let activeEdgeGroupId = null;
let activeSubsystemId = null;
let currentTool = 'select';
let currentView = 'orbit';
let is2DLocked = false;
const faceDirections = {
    front: new THREE.Vector3(0, 0, 1),
    back: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    left: new THREE.Vector3(-1, 0, 0),
    top: new THREE.Vector3(0, 1, 0),
    bottom: new THREE.Vector3(0, -1, 0)
};
let activeEndpointPick = null;
let endpointPickRestoreCard = null;
let endpointPickMaterialState = new Map();
// Set by applyEdgeTemplate to pick both endpoints from scratch (no node pre-selected) by chaining
// two single-endpoint picks -- the endpoint-pick mechanism itself is otherwise untouched.
let endpointPickContinuation = null;
let cameraAnimation = null;
let pendingImportedGeometry = null;
let pendingGeometryFileName = '';
let currentValidation = { valid: false, issues: [], executableModel: null };
let validationRevision = 0;
let engineValidationTimer = null;
let equationEditSession = null;
let providerEditTarget = null;
let selectedSourceTermNodeId = null;
let selectedSourceTermId = null;
let simulationRunning = false;
let activeResult = null;
let activeEngineJobId = null;
let activeResultPersistedInProject = false;
let liveParameterValues = new Map();
const liveParameterUpdateTimers = new Map();
let runLaunchSettings = {
    targetTime: 1,
    online: false,
    pacing: { mode: 'fastest', simulationSecondsPerWallSecond: 1 }
};
let pendingRestart = null;
let activeResultSampleIndex = 0;
let resultPlaybackTimer = null;
let resultPlaying = false;
let resultPlaybackStartedAt = 0;
let resultPlaybackStartedFrom = 0;
const preferredPlaybackFrameMilliseconds = 100;
let nodeDetailsBeforeResult = null;
let toolBeforeResult = null;
let addonToolstripContributions = [];
let pendingAssistantProposal = null;
let assistantPreviewRevision = 0;
let assistantGenerationController = null;
// Bounded conversation memory for the assistant panel: a compact { request, outcome } summary
// per turn (never the raw proposal JSON, to keep the payload small), capped at 5 and sent on
// every generateProposal call so "Revise proposal" and clarification replies have real context.
// pendingAssistantTurnRecord tracks (by reference, not index, so a later cap-trim can't shift
// it) the turn awaiting an outcome -- asked-but-not-answered, proposed-but-not-applied -- so its
// summary can be corrected in place once the user acts, rather than adding a second entry.
let assistantTurnHistory = [];
let pendingAssistantTurnRecord = null;
let assistantHasBeenPositioned = false;
let activeAssistantConfigurationUuid = null;
let assistantConfigurationCatalog = { configurations: [], providers: [], credentialStorage: null };
let assistantConfigurationBaseline = '';
let assistantDiscoveryTimer = null;
let assistantDiscoveryRevision = 0;
const nodeResultPlot = new ResultPlot($('#nodeResultPlot'), {
    onSeek: (time) => {
        if (!activeResult) return;
        stopResultPlayback();
        projectResultSample(nearestSampleIndex(activeResult.samples, time));
    }
});
const documentController = new DocumentController();

function updateHistoryControls() {
    $('#undoButton').disabled = Boolean(activeResult) || !documentController.canUndo;
    $('#redoButton').disabled = Boolean(activeResult) || !documentController.canRedo;
    $('#saveButton').disabled = !documentController.dirty && currentProjectPath !== null;
    $('.windowTitle i').style.visibility = documentController.dirty ? 'visible' : 'hidden';
    updateSelectionActionControls();
}

function updateSelectionActionControls() {
    const locked = Boolean(activeResult);
    $('#copySelection').disabled = locked || !selectedNodeIds.size;
    $('#createSubsystem').disabled = locked || !selectedNodeIds.size;
    $('#createEdgeGroup').disabled = locked || selectedNodeIds.size < 2;
    $('[data-action="delete"]').disabled = locked || (!selectedNodeIds.size && !selectedRelationship);
    let canPaste = false;
    if (!locked) {
        try {
            canPaste = validateGraphFragment(window.modelClipboard.read());
        } catch {
            canPaste = false;
        }
    }
    $('#pasteSelection').disabled = !canPaste;
}

function recordHistory(action) {
    if (activeResult) return false;
    documentController.record(action);
    return true;
}

function undo() {
    if (activeResult) return;
    finishEquationEdit();
    clearSelection();
    hideCards();
    documentController.undo();
}

function redo() {
    if (activeResult) return;
    finishEquationEdit();
    clearSelection();
    hideCards();
    documentController.redo();
}

documentController.subscribe(updateHistoryControls);

function initializeWindowControls() {
    const updateUiZoomControls = (factor = window.uiZoom.get()) => {
        const percent = Math.round(factor * 100);
        $('#zoomOutButton').disabled = factor <= window.uiZoom.limits.minimum;
        $('#zoomInButton').disabled = factor >= window.uiZoom.limits.maximum;
        $('#zoomOutButton').dataset.tooltip = `Zoom interface out · ${percent}%`;
        $('#zoomInButton').dataset.tooltip = `Zoom interface in · ${percent}%`;
    };
    $('#zoomOutButton').addEventListener('click', () => updateUiZoomControls(window.uiZoom.decrease()));
    $('#zoomInButton').addEventListener('click', () => updateUiZoomControls(window.uiZoom.increase()));
    updateUiZoomControls();
    $('#minimizeButton').addEventListener('click', () => window.windowControls.minimize());
    $('#maximizeButton').ariaLabel = isMac ? 'Enter full screen' : 'Maximize';
    $('#maximizeButton').dataset.tooltip = isMac ? 'Enter full screen' : 'Maximize';
    $('#maximizeButton').addEventListener('click', () => window.windowControls.toggleMaximize());
    $('#closeButton').addEventListener('click', async () => {
        if ((documentController.dirty || (activeResult && !activeResultPersistedInProject)) &&
            !await window.projectFiles.confirmDiscard()) return;
        window.windowControls.close();
    });
    window.windowControls.onMaximizedChange((maximized) => {
        $('#maximizeIcon').textContent = maximized ? '❐' : '□';
        $('#maximizeButton').ariaLabel = isMac
            ? `${maximized ? 'Exit' : 'Enter'} full screen`
            : `${maximized ? 'Restore' : 'Maximize'} window`;
        $('#maximizeButton').dataset.tooltip = $('#maximizeButton').ariaLabel;
    });
}

initializeWindowControls();

window.applicationInfo.get().then(({ version }) => {
    $('#aboutButton').dataset.tooltip = `Konjugate · version ${version}`;
});
$('#aboutButton').addEventListener('click', () => window.applicationInfo.openAbout());

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0a131b, 0.022);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
camera.position.set(0, 7.5, 19);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.domElement.className = 'webglSurface';
renderer.domElement.tabIndex = 0;
renderer.domElement.ariaLabel = '3D model canvas';
webglContainer.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'css2dSurface';
css2dContainer.appendChild(labelRenderer.domElement);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.07;
orbitControls.minDistance = 8;
orbitControls.maxDistance = 5000;
orbitControls.zoomToCursor = true;
orbitControls.target.set(0, -0.7, 0);
orbitControls.listenToKeyEvents(renderer.domElement);

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate');
transformControls.setSpace('world');
transformControls.size = 0.72;
transformControls.enabled = false;
scene.add(transformControls.getHelper());
transformControls.addEventListener('dragging-changed', (event) => {
    orbitControls.enabled = !event.value;
});
// Tracks live Shift state from real pointer events (TransformControls' own objectChange event
// carries no native browser event to read .shiftKey from). An earlier attempt intercepted
// TransformControls' *hover* handling instead, forcing its internal `axis` to 'XYZ' (the name
// of its own centre-cube uniform-scale handle) whenever Shift was held while hovering a scale
// handle. That looked right in isolation, but broke for two real reasons: TransformControls
// re-resolves `axis` from a fresh raycast on pointerdown itself, not only on hover, silently
// reverting the override right as a drag started and leaving its internal drag-plane
// orientation stale against the axis it reverted to (Shift-before-click did nothing useful);
// and since the override only ran on hover, Shift pressed after a drag had already begun was
// never picked up at all (Shift-during-drag did nothing). Reading Shift fresh on every drag
// movement instead, and computing the uniform scale here rather than steering
// TransformControls' own internal state, works regardless of which handle started the drag or
// when Shift is pressed or released during it.
let shiftKeyHeld = false;
renderer.domElement.addEventListener('pointermove', (event) => {
    shiftKeyHeld = event.shiftKey;
});
// Same distance-ratio formula TransformControls' own centre-cube 'XYZ' handle uses internally
// (pointStart/pointEnd are the local-space drag-start and current pointer positions it already
// maintains for whichever handle was actually grabbed), so a Shift-held drag feels the same as
// dragging that handle directly, whatever handle the pointer is actually on.
function uniformScaleFactorForDrag() {
    const startLength = transformControls.pointStart.length();
    if (startLength === 0) return 1;
    const factor = transformControls.pointEnd.length() / startLength;
    return transformControls.pointEnd.dot(transformControls.pointStart) < 0 ? -factor : factor;
}
// position and scale are THREE.Vector3 (support clone/add/sub/equals/copy directly); rotation is
// a THREE.Euler, which doesn't share that API. Reading/writing through plain [x,y,z] arrays lets
// the same drag-tracking code below work for whichever of the three the active tool drives,
// rather than duplicating this whole start/drag/commit sequence three times.
const transformPropertyForTool = { move: 'position', rotate: 'rotation', scale: 'scale' };
function readXYZ(vectorLike) {
    return [vectorLike.x, vectorLike.y, vectorLike.z];
}
// Rotating a multi-node selection also needs to capture/restore each other node's position
// (revolved around the pivot -- see the objectChange handler below), on top of whichever
// property the active tool itself drives. Applied uniformly to every selected node including
// the dragged one is harmless: the dragged node's own position never changes during a rotate
// drag (TransformControls' rotate mode only ever touches quaternion), so its captured start and
// end position are always identical.
function capturedProperties(property) {
    return property === 'rotation' && selectedNodeIds.size > 1 ? [property, 'position'] : [property];
}
function snapshotNode(id, properties) {
    const node = nodeObjects.get(id);
    return Object.fromEntries(properties.map((prop) => [prop, readXYZ(node[prop])]));
}

function changeNodeTransform(node, property, values) {
    if (activeResult) return;
    const before = readXYZ(node[property]);
    if (before.every((value, index) => value === values[index])) return;
    const applyValues = (value) => {
        node[property].set(...value);
        updateRelationships();
        updateSelectionOutline();
    };
    applyValues(values);
    recordHistory({ undo: () => applyValues(before), redo: () => applyValues(values) });
}

// Keeps the Appearance tab's rotation/scale number inputs in sync with the live mesh -- called
// both when the node editor opens and continuously while a rotate/scale gizmo drag is in
// progress, so the two ways of setting these values (precise typing vs. dragging) never show
// stale numbers to each other.
function refreshNodeTransformFields(node) {
    const [rx, ry, rz] = readXYZ(node.rotation).map((radians) => Math.round(THREE.MathUtils.radToDeg(radians) * 100) / 100);
    $('#editNodeRotationX').value = rx;
    $('#editNodeRotationY').value = ry;
    $('#editNodeRotationZ').value = rz;
    const [sx, sy, sz] = readXYZ(node.scale);
    $('#editNodeScaleX').value = sx;
    $('#editNodeScaleY').value = sy;
    $('#editNodeScaleZ').value = sz;
}

transformControls.addEventListener('objectChange', () => {
    const object = transformControls.object;
    const property = transformPropertyForTool[currentTool] ?? 'position';
    if (object && property === 'scale' && shiftKeyHeld) {
        const start = transformStartValues?.get(object.userData.id)?.scale;
        if (start) {
            const factor = uniformScaleFactorForDrag();
            object.scale.set(start[0] * factor, start[1] * factor, start[2] * factor);
        }
    }
    if (object && property === 'rotation' && transformLastQuaternion && selectedNodeIds.size > 1) {
        // Revolve each other selected node's position around the pivot (the dragged node's own
        // position, fixed for the whole drag -- TransformControls' rotate mode only ever
        // touches quaternion, never position) by this frame's incremental rotation, and spin
        // its own orientation by the same amount, so the whole selection turns together as a
        // rigid body instead of each node spinning in place around its own centre. Derived from
        // the actual change in the dragged node's quaternion between frames, rather than
        // approximated from Euler-angle deltas the way the position/scale broadcast below does,
        // since that stays exact however many Euler components a given drag ends up touching at
        // once, and composes correctly across many frames without drifting.
        const deltaQuaternion = object.quaternion.clone().multiply(transformLastQuaternion.clone().invert());
        const pivot = object.position;
        selectedNodeIds.forEach((id) => {
            if (id === object.userData.id) return;
            const other = nodeObjects.get(id);
            if (!other) return;
            const offset = other.position.clone().sub(pivot).applyQuaternion(deltaQuaternion);
            other.position.copy(pivot).add(offset);
            other.quaternion.premultiply(deltaQuaternion);
        });
        transformLastQuaternion.copy(object.quaternion);
    } else if (object && transformLastValue && selectedNodeIds.size > 1) {
        const current = readXYZ(object[property]);
        const delta = current.map((value, index) => value - transformLastValue[index]);
        selectedNodeIds.forEach((id) => {
            if (id === object.userData.id) return;
            const other = nodeObjects.get(id)?.[property];
            if (other) other.set(...readXYZ(other).map((value, index) => value + delta[index]));
        });
        transformLastValue = current;
    }
    updateRelationships();
    updateSelectionOutline();
    if (object && object === selectedNode && !$('#nodeEditor').classList.contains('hidden')) refreshNodeTransformFields(object);
});
let transformStartValues = null;
let transformLastValue = null;
let transformLastQuaternion = null;
transformControls.addEventListener('mouseDown', () => {
    const object = transformControls.object;
    const property = transformPropertyForTool[currentTool] ?? 'position';
    const properties = capturedProperties(property);
    transformStartValues = object ? new Map([...selectedNodeIds].map((id) => [id, snapshotNode(id, properties)])) : null;
    transformLastValue = object ? readXYZ(object[property]) : null;
    transformLastQuaternion = object && property === 'rotation' ? object.quaternion.clone() : null;
});
transformControls.addEventListener('mouseUp', () => {
    const object = transformControls.object;
    const property = transformPropertyForTool[currentTool] ?? 'position';
    const startValue = object && transformStartValues?.get(object.userData.id)?.[property];
    const endValue = object && readXYZ(object[property]);
    if (!object || !startValue || startValue.every((value, index) => value === endValue[index])) {
        transformStartValues = null;
        transformLastValue = null;
        transformLastQuaternion = null;
        return;
    }
    const properties = capturedProperties(property);
    const from = new Map(transformStartValues);
    const to = new Map([...selectedNodeIds].map((id) => [id, snapshotNode(id, properties)]));
    const applyValues = (snapshotMap) => {
        snapshotMap.forEach((snapshot, id) => {
            const node = nodeObjects.get(id);
            if (!node) return;
            Object.entries(snapshot).forEach(([prop, value]) => node[prop].set(...value));
        });
        updateRelationships();
        updateSelectionOutline();
    };
    recordHistory({
        undo: () => applyValues(from),
        redo: () => applyValues(to)
    });
    transformStartValues = null;
    transformLastValue = null;
    transformLastQuaternion = null;
});

// Debug/test hook only; not part of the app's public surface (same pattern as
// window.__relationshipScreenPoint further down). Exposes the transform-tool state and a way
// to simulate a gizmo drag by dispatching
// TransformControls' own mouseDown/objectChange/mouseUp events directly, so interaction tests
// can exercise the rotate/scale/move commit-and-undo path without needing real pointer
// coordinates on the 3D gizmo's own handle geometry.
window.__debugTransform = {
    mode: () => transformControls.getMode(),
    attachedId: () => transformControls.object?.userData.id ?? null,
    selectedId: () => selectedNode?.userData.id ?? null,
    simulateDragTo: (x, y, z) => {
        transformControls.dispatchEvent({ type: 'mouseDown' });
        transformControls.object[transformPropertyForTool[currentTool] ?? 'position'].set(x, y, z);
        transformControls.dispatchEvent({ type: 'objectChange' });
        transformControls.dispatchEvent({ type: 'mouseUp' });
    },
    nodeTransform: (id, property) => {
        const object = nodeObjects.get(id);
        return object ? [object[property].x, object[property].y, object[property].z] : null;
    },
    allNodeIds: () => [...nodeObjects.keys()],
    // Adds a node to the selection the same way a real Shift-click does (selectNode's own
    // additive path), without needing a real screen-coordinate mouse event -- which handle or
    // label ends up under the cursor for a Shift-click is a real-mouse/CSS2D-layout concern the
    // existing multi-selection copy/paste test already covers; this app's own group-transform
    // math is what a multi-select rotate/scale test actually needs a multi-selection *for*.
    selectAdditive: (id) => {
        const node = nodeObjects.get(id);
        if (node) selectNode(node, { additive: true });
    },
    // A lower-level, multi-step alternative to simulateDragTo for exercising the real
    // Shift-uniform-scale override in objectChange: mouseDown captures transformStartValues as
    // usual, then each move step can set the object's scale directly (standing in for whatever
    // per-axis math a real single-axis or corner-handle drag would have produced) and/or set
    // TransformControls' own pointStart/pointEnd (which is all uniformScaleFactorForDrag reads)
    // before dispatching objectChange with a chosen Shift state -- so a test can drive multiple
    // movement steps with Shift toggled on or off between them, the same way a real drag would,
    // without needing real screen coordinates raycast against the gizmo's handle geometry.
    scaleDrag: {
        mouseDown: () => transformControls.dispatchEvent({ type: 'mouseDown' }),
        move: ({ manualScale, pointStart, pointEnd, shiftHeld = false } = {}) => {
            if (manualScale) transformControls.object.scale.set(...manualScale);
            if (pointStart) transformControls.pointStart.set(...pointStart);
            if (pointEnd) transformControls.pointEnd.set(...pointEnd);
            shiftKeyHeld = shiftHeld;
            transformControls.dispatchEvent({ type: 'objectChange' });
            return readXYZ(transformControls.object.scale);
        },
        mouseUp: () => {
            transformControls.dispatchEvent({ type: 'mouseUp' });
            shiftKeyHeld = false;
        }
    }
};

scene.add(new THREE.HemisphereLight(0xbfe4f2, 0x16212a, 2.25));

const keyLight = new THREE.DirectionalLight(0xfff0d6, 3.2);
keyLight.position.set(7, 11, 9);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x65d6db, 2.1);
rimLight.position.set(-8, 4, -7);
scene.add(rimLight);

const floor = new THREE.GridHelper(32, 32, 0x31505a, 0x1c3039);
floor.position.y = -4.8;
floor.material.transparent = true;
floor.material.opacity = 0.22;
scene.add(floor);

function geometryFor(definition) {
    if (definition.importedGeometry) return definition.importedGeometry.clone();
    if (definition.shape === 'cylinder') return new THREE.CylinderGeometry(1.15, 1.15, 2.9, 32);
    if (definition.shape === 'sphere') return new THREE.SphereGeometry(1.05, 32, 24);
    return new THREE.BoxGeometry(2.8, 1.8, 1.8, 2, 1, 1);
}

// A disabled node/edge stays fully present in the model and the saved file -- unlike delete, it
// is never dropped from serializeProjectDocument() -- but the engine treats it exactly as if it
// had been deleted (see compileExecutionPlan/validateModel). This blend is the visual half:
// muted toward grey and slightly transparent, so "disabled" reads clearly without hiding it.
function disabledDisplayColor(color) {
    return new THREE.Color(color).lerp(new THREE.Color(0x74808a), 0.65).getHex();
}

// An edge is effectively disabled -- and rendered as such -- if it is disabled itself, or if
// either endpoint node is, even though the edge's own `enabled` stays untouched in that case.
// Re-enabling the node alone is enough to bring every edge on it back, with no per-edge cleanup.
function isEdgeEffectivelyEnabled(edge) {
    if (edge.enabled === false) return false;
    const sourceNode = model.nodes.find((node) => node.id === edge.source);
    const targetNode = model.nodes.find((node) => node.id === edge.target);
    return sourceNode?.enabled !== false && targetNode?.enabled !== false;
}

function materialFor(definition) {
    const enabled = definition.enabled !== false;
    return new THREE.MeshStandardMaterial({
        color: enabled ? definition.color : disabledDisplayColor(definition.color),
        metalness: 0.2,
        roughness: 0.42,
        transparent: !enabled,
        opacity: enabled ? 1 : 0.55
    });
}

function nodeLabelOffset(geometry) {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const height = bounds.max.y - bounds.min.y;
    return [
        bounds.max.x + 0.08,
        (bounds.min.y + bounds.max.y) / 2 + height * 0.24,
        (bounds.min.z + bounds.max.z) / 2
    ];
}

function createNodeLabel(definition, geometry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'node-label-container';
    wrapper.classList.toggle('disabled', definition.enabled === false);
    wrapper.dataset.node = definition.id;

    const stateRows = definition.states.map((state) => `
        <div>
            <dt>${escapeHtml(state.label)}</dt>
            <dd class="${escapeHtml(state.className ?? '')}">${escapeHtml(state.value)}</dd>
        </div>
    `).join('');

    wrapper.innerHTML = `
        <div class="objectLabel">
            <div>
                <strong>${escapeHtml(definition.title)}</strong>
                <span class="typeBadge ${escapeHtml(definition.badgeClass ?? '')}">${escapeHtml(definition.type)}</span>
                <span class="disabledBadge">Disabled</span>
            </div>
            <dl>${stateRows}</dl>
            <span class="stateCount">${definition.states.length} ${definition.states.length === 1 ? 'state' : 'states'}</span>
        </div>
    `;

    wrapper.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (event.button === 0 && event.shiftKey && !activeEndpointPick) {
            event.preventDefault();
            selectNode(nodeObjects.get(definition.id), { additive: true });
        }
    });
    wrapper.addEventListener('click', (event) => {
        event.stopPropagation();
        if (activeEndpointPick) {
            chooseEndpointNode(definition.id);
            return;
        }
        if (event.shiftKey) return;
        selectNode(nodeObjects.get(definition.id));
        openNodeEditor(definition);
    });
    wrapper.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (activeResult) return;
        stageContextMenuAction(() => {
            const node = nodeObjects.get(definition.id);
            if (!(selectedNodeIds.size > 1 && selectedNodeIds.has(definition.id))) selectNode(node);
            openNodeContextMenu(event.clientX, event.clientY);
        });
    });

    const label = new CSS2DObject(wrapper);
    label.position.fromArray(nodeLabelOffset(geometry));
    label.center.set(0, 0.5);
    return label;
}

function createNode(definition) {
    const mesh = new THREE.Mesh(geometryFor(definition), materialFor(definition));
    mesh.position.fromArray(definition.position);
    mesh.rotation.fromArray(definition.rotation ?? [0, 0, 0]);
    mesh.scale.fromArray(definition.scale ?? [1, 1, 1]);
    mesh.userData = {
        kind: 'node',
        id: definition.id,
        definition
    };

    mesh.add(createNodeLabel(definition, mesh.geometry));
    scene.add(mesh);
    nodeObjects.set(definition.id, mesh);
    nodePickTargets.push(mesh);
}

function createSubsystemObject(definition) {
    const object = new THREE.Mesh(
        new THREE.BoxGeometry(2.7, 1.7, 2.1),
        new THREE.MeshStandardMaterial({ color: 0x195b60, roughness: 0.58, metalness: 0.08 })
    );
    object.position.fromArray(definition.position);
    object.userData = { kind: 'subsystem', id: definition.id, definition };
    const wrapper = document.createElement('div');
    wrapper.className = 'subsystem-label';
    wrapper.innerHTML = `<button class="subsystemLabel" type="button"><strong>${escapeHtml(definition.name)}</strong><small>${definition.ports.length} boundary ${definition.ports.length === 1 ? 'port' : 'ports'} · Open subsystem</small></button>`;
    $('.subsystemLabel', wrapper).addEventListener('click', (event) => {
        event.stopPropagation();
        enterSubsystem(definition.id);
    });
    const label = new CSS2DObject(wrapper);
    label.renderOrder = 20;
    label.position.set(0, 0.35, 0);
    object.add(label);
    scene.add(object);
    subsystemObjects.set(definition.id, object);
}

function subsystemForNodeInView(node) {
    let subsystem = model.subsystems.find((item) => item.id === node.subsystemId && !item.deleted);
    while (subsystem && subsystem.parentSubsystemId !== activeSubsystemId) {
        subsystem = model.subsystems.find((item) => item.id === subsystem.parentSubsystemId && !item.deleted);
    }
    return subsystem?.parentSubsystemId === activeSubsystemId ? subsystem : null;
}

function displayObjectForNode(nodeId) {
    const definition = model.nodes.find((node) => node.id === nodeId);
    if (!definition || definition.deleted) return null;
    if (definition.subsystemId === activeSubsystemId) return nodeObjects.get(nodeId);
    const subsystem = subsystemForNodeInView(definition);
    return subsystem ? subsystemObjects.get(subsystem.id) : null;
}

function refreshSubsystemView() {
    clearSelection();
    nodeObjects.forEach((object, id) => {
        const definition = object.userData.definition;
        object.visible = !definition.deleted && definition.subsystemId === activeSubsystemId;
    });
    subsystemObjects.forEach((object) => {
        const definition = object.userData.definition;
        object.visible = !definition.deleted && definition.parentSubsystemId === activeSubsystemId;
    });
    relationshipObjects.forEach((relationship) => {
        const source = displayObjectForNode(relationship.definition.source);
        const target = displayObjectForNode(relationship.definition.target);
        const visible = !relationship.definition.deleted && source && target && source !== target;
        relationship.line.visible = Boolean(visible);
        if (relationship.marker) relationship.marker.visible = Boolean(visible);
    });
    const breadcrumb = $('#subsystemBreadcrumb');
    breadcrumb.hidden = activeSubsystemId === null;
    if (activeSubsystemId !== null) {
        const current = model.subsystems.find((item) => item.id === activeSubsystemId);
        breadcrumb.innerHTML = `<button type="button" data-subsystem-parent>← ${current?.parentSubsystemId === null ? 'Model' : 'Parent'}</button><span>/</span><button type="button" disabled>${escapeHtml(current?.name ?? 'Subsystem')}</button>`;
        $('[data-subsystem-parent]', breadcrumb).addEventListener('click', () => enterSubsystem(current?.parentSubsystemId ?? null));
    }
    updateRelationships();
    updateModelStatus();
}

function enterSubsystem(id) {
    activeSubsystemId = id;
    hideCards();
    refreshSubsystemView();
}

model.nodes.forEach(createNode);
model.subsystems.forEach(createSubsystemObject);

const selectionOutlines = new Map();

function relationshipPoints(definition) {
    const source = displayObjectForNode(definition.source)?.position ?? nodeObjects.get(definition.source).position;
    const target = displayObjectForNode(definition.target)?.position ?? nodeObjects.get(definition.target).position;

    if (definition.waypoints?.length) {
        return {
            start: source.clone(),
            controlPoints: definition.waypoints.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
            end: target.clone()
        };
    }

    const midpoint = source.clone().lerp(target, 0.5);
    const lateral = new THREE.Vector3()
        .subVectors(target, source)
        .cross(new THREE.Vector3(0, 0, 1))
        .normalize()
        .multiplyScalar(definition.offset);

    const start = source.clone().add(lateral);
    const end = target.clone().add(lateral);
    midpoint.add(lateral);
    midpoint.y -= 0.55;

    return { start, controlPoints: [midpoint], end };
}

function createDirectionMarker(definition, curve) {
    if (definition.directionality !== 'directed') return null;

    const enabled = isEdgeEffectivelyEnabled(definition);
    const marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.14, 0.42, 14),
        new THREE.MeshBasicMaterial({
            color: enabled ? definition.color : disabledDisplayColor(definition.color),
            transparent: !enabled,
            opacity: enabled ? 1 : 0.4,
            depthTest: false
        })
    );
    marker.userData = {
        kind: 'relationship',
        id: definition.id,
        definition
    };
    marker.renderOrder = 8;
    positionDirectionMarker(marker, curve);
    scene.add(marker);
    return marker;
}

function positionDirectionMarker(marker, curve) {
    const position = curve.getPoint(0.64);
    const tangent = curve.getTangent(0.64).normalize();
    marker.position.copy(position);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
}

function createRelationship(definition) {
    const points = relationshipPoints(definition);
    const curve = new THREE.CatmullRomCurve3([
        points.start,
        ...points.controlPoints,
        points.end
    ]);
    const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(42));
    const enabled = isEdgeEffectivelyEnabled(definition);
    const material = new THREE.LineBasicMaterial({
        color: enabled ? definition.color : disabledDisplayColor(definition.color),
        transparent: true,
        opacity: enabled ? 0.92 : 0.4
    });
    const line = new THREE.Line(geometry, material);
    line.userData = {
        kind: 'relationship',
        id: definition.id,
        definition,
        curve
    };
    scene.add(line);

    const marker = createDirectionMarker(definition, curve);
    relationshipObjects.set(definition.id, { line, marker, definition });
    relationshipPickTargets.push(line);
    if (marker) relationshipPickTargets.push(marker);
}

function setRelationshipVisibility(id, visible) {
    const relationship = relationshipObjects.get(id);
    if (!relationship) return;
    relationship.definition.deleted = !visible;
    refreshSubsystemView();
}

function setRelationshipDirectionality(definition, directionality) {
    const relationship = relationshipObjects.get(definition.id);
    if (!relationship) return;
    if (relationship.marker) {
        scene.remove(relationship.marker);
        const markerIndex = relationshipPickTargets.indexOf(relationship.marker);
        if (markerIndex >= 0) relationshipPickTargets.splice(markerIndex, 1);
        relationship.marker.geometry.dispose();
        relationship.marker.material.dispose();
    }
    definition.directionality = directionality;
    relationship.marker = createDirectionMarker(definition, relationship.line.userData.curve);
    if (relationship.marker) relationshipPickTargets.push(relationship.marker);
    invalidateRelationshipBundles();
    syncContextualOverlays();
}

function setNodeVisibility(id, visible) {
    const node = nodeObjects.get(id);
    if (!node) return;
    node.userData.definition.deleted = !visible;
    refreshSubsystemView();
}

// Disabling is distinct from delete: the node/edge stays fully present (and, unlike delete, is
// saved in the file -- see serializeProjectDocument), just visually muted and excluded from the
// engine. Disabling a node cascades to every edge touching it via isEdgeEffectivelyEnabled --
// their own `enabled` field is left untouched, so re-enabling the node alone restores them too.
function setNodeEnabled(id, enabled) {
    const node = nodeObjects.get(id);
    if (!node) return;
    node.userData.definition.enabled = enabled;
    node.material.dispose();
    node.material = materialFor(node.userData.definition);
    const label = node.children.find((child) => child.element?.classList.contains('node-label-container'));
    label?.element.classList.toggle('disabled', !enabled);
    relationshipObjects.forEach((relationship) => {
        if (relationship.definition.source === id || relationship.definition.target === id) {
            refreshRelationshipVisual(relationship.definition);
        }
    });
    invalidateRelationshipBundles();
    syncContextualOverlays();
    // setNodeEnabled is also reached from undo/redo, not just its own button's click handler --
    // keep the open editor's button label truthful either way, same as applyEdgeModel does for
    // its own fields.
    if (selectedNode?.userData.definition.id === id && !$('#nodeEditor').classList.contains('hidden')) {
        $('#toggleNodeEnabled').textContent = enabled ? 'Disable node' : 'Enable node';
    }
}

function setRelationshipEnabled(id, enabled) {
    const relationship = relationshipObjects.get(id);
    if (!relationship) return;
    relationship.definition.enabled = enabled;
    refreshRelationshipVisual(relationship.definition);
    invalidateRelationshipBundles();
    syncContextualOverlays();
    if (selectedRelationship?.id === id && !$('#edgeEditor').classList.contains('hidden')) {
        $('#toggleEdgeEnabled').textContent = enabled ? 'Disable edge' : 'Enable edge';
    }
}

function toggleSelectedNodeEnabled() {
    if (activeResult || !selectedNode) return;
    const id = selectedNode.userData.definition.id;
    const nextEnabled = selectedNode.userData.definition.enabled === false;
    setNodeEnabled(id, nextEnabled);
    recordHistory({
        undo: () => setNodeEnabled(id, !nextEnabled),
        redo: () => setNodeEnabled(id, nextEnabled)
    });
}

function toggleSelectedEdgeEnabled() {
    if (activeResult || !selectedRelationship) return;
    const id = selectedRelationship.id;
    const nextEnabled = selectedRelationship.enabled === false;
    setRelationshipEnabled(id, nextEnabled);
    recordHistory({
        undo: () => setRelationshipEnabled(id, !nextEnabled),
        redo: () => setRelationshipEnabled(id, nextEnabled)
    });
}

// "Disable all"/"Enable all" are explicit, uni-directional bulk actions rather than a toggle --
// a mixed-state selection (some already disabled) has no sensible single "next" state to flip to.
// Undo restores each node's own prior enabled state rather than just the opposite of the target,
// so a bulk disable over a mixed selection undoes back to that same mix.
function setSelectedNodesEnabled(enabled) {
    if (activeResult || !selectedNodeIds.size) return;
    const ids = [...selectedNodeIds];
    const previous = new Map(ids.map((id) => [id, nodeObjects.get(id)?.userData.definition.enabled !== false]));
    const apply = (targetEnabled) => ids.forEach((id) => setNodeEnabled(id, targetEnabled));
    apply(enabled);
    recordHistory({
        undo: () => ids.forEach((id) => setNodeEnabled(id, previous.get(id))),
        redo: () => apply(enabled)
    });
}

function captureNodeAppearance(definition) {
    return {
        shape: definition.shape,
        importedGeometry: definition.importedGeometry?.clone() ?? null,
        geometryFileName: definition.geometryFileName ?? null,
        color: definition.color
    };
}

function applyNodeAppearance(node, appearance) {
    const definition = node.userData.definition;
    definition.importedGeometry?.dispose();
    definition.shape = appearance.shape;
    definition.importedGeometry = appearance.importedGeometry?.clone() ?? null;
    definition.geometryFileName = appearance.geometryFileName ?? null;
    // Callers that build a partial appearance object (switching just the primitive shape, or
    // just importing a file) may not specify color -- fall back to the current value rather
    // than wiping it to undefined and crashing the next time the color picker reads it.
    definition.color = appearance.color ?? definition.color;
    node.geometry.dispose();
    node.geometry = geometryFor(definition);
    node.material.dispose();
    node.material = materialFor(definition);
    const label = node.children.find((child) => child.element?.classList.contains('node-label-container'));
    label?.position.fromArray(nodeLabelOffset(node.geometry));
    updateSelectionOutline();
    updateRelationships();
}

function changeNodeAppearance(node, appearance) {
    if (activeResult) return;
    const before = captureNodeAppearance(node.userData.definition);
    applyNodeAppearance(node, appearance);
    const after = captureNodeAppearance(node.userData.definition);
    recordHistory({
        undo: () => applyNodeAppearance(node, before),
        redo: () => applyNodeAppearance(node, after)
    });
}

model.relationships.forEach(createRelationship);

const relationshipBundleObjects = new Map();

function updateRelationships() {
    relationshipObjects.forEach((relationship) => {
        const points = relationshipPoints(relationship.definition);
        const curve = new THREE.CatmullRomCurve3([
            points.start,
            ...points.controlPoints,
            points.end
        ]);
        relationship.line.geometry.dispose();
        relationship.line.geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(42));
        relationship.line.userData.curve = curve;
        if (relationship.marker) positionDirectionMarker(relationship.marker, curve);
    });

    syncContextualOverlays();
}

updateRelationships();

const dragControls = new DragControls(
    nodePickTargets,
    camera,
    renderer.domElement
);
dragControls.recursive = false;
let dragStartPositions = null;
let dragLastPosition = null;
let waypointDragStart = null;
dragControls.addEventListener('dragstart', (event) => {
    orbitControls.enabled = false;
    if (event.object.userData.kind === 'waypoint') {
        waypointDragStart = event.object.position.clone();
        return;
    }
    if (!selectedNodeIds.has(event.object.userData.id)) selectNode(event.object);
    dragStartPositions = new Map([...selectedNodeIds].map((id) => [id, nodeObjects.get(id).position.clone()]));
    dragLastPosition = event.object.position.clone();
});
dragControls.addEventListener('drag', (event) => {
    if (event.object.userData.kind === 'waypoint') {
        const { relationshipId, index } = event.object.userData;
        const definition = relationshipObjects.get(relationshipId)?.definition;
        if (definition) {
            definition.waypoints[index] = event.object.position.toArray();
            updateRelationships();
        }
        return;
    }
    if (dragLastPosition && selectedNodeIds.size > 1) {
        const delta = event.object.position.clone().sub(dragLastPosition);
        selectedNodeIds.forEach((id) => {
            if (id !== event.object.userData.id) nodeObjects.get(id)?.position.add(delta);
        });
        dragLastPosition.copy(event.object.position);
    }
    updateRelationships();
    updateSelectionOutline();
});
dragControls.addEventListener('dragend', (event) => {
    orbitControls.enabled = true;
    if (event.object.userData.kind === 'waypoint') {
        const { relationshipId, index } = event.object.userData;
        const definition = relationshipObjects.get(relationshipId)?.definition;
        if (definition && waypointDragStart && !event.object.position.equals(waypointDragStart)) {
            const from = waypointDragStart.toArray();
            const to = event.object.position.toArray();
            const applyWaypoint = (point) => {
                definition.waypoints[index] = point;
                updateRelationships();
                if (selectedRelationship?.id === relationshipId) syncWaypointHandles(relationshipId);
            };
            recordHistory({
                undo: () => applyWaypoint(from),
                redo: () => applyWaypoint(to)
            });
        }
        waypointDragStart = null;
        return;
    }
    if (dragStartPositions && !event.object.position.equals(dragStartPositions.get(event.object.userData.id))) {
        const from = new Map([...dragStartPositions].map(([id, position]) => [id, position.clone()]));
        const to = new Map([...selectedNodeIds].map((id) => [id, nodeObjects.get(id).position.clone()]));
        const applyPositions = (positions) => {
            positions.forEach((position, id) => nodeObjects.get(id)?.position.copy(position));
            updateRelationships();
            updateSelectionOutline();
        };
        recordHistory({
            undo: () => applyPositions(from),
            redo: () => applyPositions(to)
        });
    }
    dragStartPositions = null;
    dragLastPosition = null;
});

const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.32;
const pointer = new THREE.Vector2();

function setPointerFromEvent(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
}

function firstIntersection(targets) {
    // Three.js's Raycaster does not itself check .visible (confirmed in node_modules/three/src/
    // core/Raycaster.js) -- an invisible object (soft-deleted, or hidden by subsystem scoping)
    // is exactly as raycast-hittable as a visible one. Skip hits the user can't actually see.
    return raycaster.intersectObjects(targets, true).find((hit) => hit.object.visible);
}

// Debug/test hook only; not part of the app's public surface (mirrors window.__providerEditorView
// in src/providerEditor/renderer.mjs). Exposes the on-screen point for a relationship's rendered
// line midpoint so interaction tests can click it without duplicating the camera-projection math.
function screenPointFor(worldPoint) {
    const rect = renderer.domElement.getBoundingClientRect();
    const projected = worldPoint.clone().project(camera);
    return {
        x: Math.round(rect.left + (projected.x + 1) / 2 * rect.width),
        y: Math.round(rect.top + (1 - projected.y) / 2 * rect.height)
    };
}

window.__relationshipScreenPoint = (title, t = 0.5) => {
    const relationship = [...relationshipObjects.values()].find((entry) => entry.definition.title === title);
    if (!relationship) return null;
    return screenPointFor(relationship.line.userData.curve.getPoint(t));
};

window.__waypointScreenPoint = (title, index) => {
    const relationship = [...relationshipObjects.values()].find((entry) => entry.definition.title === title);
    const handle = waypointHandleObjects.get(relationship?.definition.id)?.[index];
    return handle ? screenPointFor(handle.position) : null;
};

window.__relationshipWaypoints = (title) => {
    const relationship = [...relationshipObjects.values()].find((entry) => entry.definition.title === title);
    return relationship ? structuredClone(relationship.definition.waypoints ?? []) : null;
};

function rootNodeFromIntersection(intersection) {
    let object = intersection?.object;
    while (object && object.userData.kind !== 'node') object = object.parent;
    return object ?? null;
}

function updateSelectionOutline() {
    $$('.node-label-container').forEach((label) => {
        label.classList.toggle('selected', selectedNodeIds.has(Number(label.dataset.node)));
    });
    selectionOutlines.forEach((outline, id) => {
        if (selectedNodeIds.has(id) && nodeObjects.get(id)?.visible) return;
        scene.remove(outline);
        outline.geometry.dispose();
        outline.material.dispose();
        selectionOutlines.delete(id);
    });
    selectedNodeIds.forEach((id) => {
        const node = nodeObjects.get(id);
        if (!node?.visible) return;
        let outline = selectionOutlines.get(id);
        if (!outline) {
            outline = new THREE.BoxHelper(node, 0x62e1d5);
            outline.material.depthTest = false;
            outline.material.transparent = true;
            outline.material.opacity = 0.9;
            outline.renderOrder = 20;
            selectionOutlines.set(id, outline);
            scene.add(outline);
        }
        outline.setFromObject(node);
    });
    updateSelectionActionControls();
}

function selectNode(node, { additive = false } = {}) {
    if (!node?.visible) return;
    if (additive) {
        if (selectedNodeIds.has(node.userData.id)) {
            selectedNodeIds.delete(node.userData.id);
            selectedNode = [...selectedNodeIds].map((id) => nodeObjects.get(id)).filter(Boolean).at(-1) ?? null;
        } else {
            selectedNodeIds.add(node.userData.id);
            selectedNode = node;
        }
    } else {
        selectedNodeIds.clear();
        selectedNodeIds.add(node.userData.id);
        selectedNode = node;
    }
    selectedRelationship = null;
    updateRelationshipSelection();
    updateSelectionOutline();
    if (additive && selectedNodeIds.size !== 1) hideCards();
    if (!activeResult && currentTool in transformPropertyForTool && transformControls.object &&
        !selectedNodeIds.has(transformControls.object.userData.id)) {
        if (selectedNode) transformControls.attach(selectedNode);
        else transformControls.detach();
    }
    if (!activeResult && selectedNodeIds.size > 1) $('#statusText').textContent = `${selectedNodeIds.size} nodes selected`;
    if (activeResult) window.addons.publishEvent('selection.change', selectedNodeIds.size === 1 ? selectedNode?.userData.id : null);
}

function selectRelationship(relationship) {
    selectedNode = null;
    selectedNodeIds.clear();
    selectedRelationship = relationship;
    updateSelectionOutline();
    updateRelationshipSelection();
    if (activeResult) window.addons.publishEvent('selection.change', null);
}

function clearSelection() {
    selectedNode = null;
    selectedNodeIds.clear();
    selectedRelationship = null;
    updateSelectionOutline();
    updateRelationshipSelection();
    transformControls.detach();
    if (activeResult) window.addons.publishEvent('selection.change', null);
}

function selectAllNodes() {
    if (activeResult) return;
    const nodes = [...nodeObjects.values()].filter((node) => node.visible);
    if (!nodes.length) return;
    clearSelection();
    nodes.forEach((node) => selectNode(node, { additive: true }));
    $('#statusText').textContent = `${selectedNodeIds.size} node${selectedNodeIds.size === 1 ? '' : 's'} selected`;
}

function clearWaypointHandles(relationshipId) {
    const handles = waypointHandleObjects.get(relationshipId);
    if (!handles) return;
    handles.forEach((handle) => {
        scene.remove(handle);
        const pickIndex = nodePickTargets.indexOf(handle);
        if (pickIndex >= 0) nodePickTargets.splice(pickIndex, 1);
        handle.geometry.dispose();
        handle.material.dispose();
    });
    waypointHandleObjects.delete(relationshipId);
}

// Rebuilds every handle mesh for one relationship from its current definition.waypoints --
// used both for the initial create-on-select and to resync handle positions/count after an
// undo/redo or an add/remove waypoint mutation, none of which move the handle mesh itself.
function syncWaypointHandles(relationshipId) {
    clearWaypointHandles(relationshipId);
    const definition = relationshipObjects.get(relationshipId)?.definition;
    if (!definition?.waypoints?.length) return;
    waypointHandleObjects.set(relationshipId, definition.waypoints.map(([x, y, z], index) => {
        const handle = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 12, 12),
            new THREE.MeshBasicMaterial({ color: 0xf3f7f6, depthTest: false })
        );
        handle.position.set(x, y, z);
        handle.renderOrder = 9;
        handle.userData = { kind: 'waypoint', relationshipId, index };
        scene.add(handle);
        nodePickTargets.push(handle);
        return handle;
    }));
}

function updateRelationshipSelection() {
    relationshipObjects.forEach((relationship) => {
        const selected = relationship.definition.id === selectedRelationship?.id;
        const validationSeverity = relationship.line.userData.validationSeverity;
        relationship.line.material.color.setHex(
            selected ? 0x62e1d5
                : validationSeverity === 'error' ? 0xd96f78
                    : validationSeverity === 'warning' ? 0xed9f52
                        : relationship.definition.color
        );
        relationship.line.material.opacity = selected ? 1 : 0.92;
        relationship.line.renderOrder = selected ? 7 : 0;
        if (relationship.marker) {
            relationship.marker.material.color.setHex(
                selected ? 0x8cfff5 : relationship.definition.color
            );
            relationship.marker.scale.setScalar(selected ? 1.35 : 1);
        }
    });
    [...waypointHandleObjects.keys()].forEach((id) => {
        if (id !== selectedRelationship?.id) clearWaypointHandles(id);
    });
    if (selectedRelationship) syncWaypointHandles(selectedRelationship.id);
}

function hideCards(except) {
    if (activeEndpointPick && except !== $('#edgeBuilder')) finishEndpointPick();
    $$('.contextCard').forEach((card) => {
        if (card !== except) card.classList.add('hidden');
    });
}

function positionCard(card, clientX, clientY) {
    card.classList.remove('hidden');
    const canvasRect = canvas.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const localX = clientX - canvasRect.left + 8;
    const localY = clientY - canvasRect.top + 8;
    card.style.left = `${Math.max(12, Math.min(localX, canvasRect.width - cardRect.width - 12))}px`;
    card.style.top = `${Math.max(12, Math.min(localY, canvasRect.height - cardRect.height - 12))}px`;
}

function captureNodeModel(node) {
    const definition = node.userData.definition;
    return {
        title: definition.title,
        type: definition.type,
        states: structuredClone(definition.states),
        sourceTerms: structuredClone(definition.sourceTerms),
        substepsPerGlobalStep: definition.substepsPerGlobalStep,
        bindings: model.relationships.map((edge) => ({
            id: edge.id,
            sourceStateId: edge.sourceStateId,
            targetStateId: edge.targetStateId
        }))
    };
}

function refreshNodeLabel(node) {
    const previous = node.children.find((child) => child.element?.classList.contains('node-label-container'));
    if (previous) {
        node.remove(previous);
        previous.element.remove();
    }
    node.add(createNodeLabel(node.userData.definition, node.geometry));
}

function applyNodeModel(node, snapshot) {
    const definition = node.userData.definition;
    definition.title = snapshot.title;
    definition.type = snapshot.type;
    definition.states = structuredClone(snapshot.states);
    definition.sourceTerms = structuredClone(snapshot.sourceTerms);
    definition.substepsPerGlobalStep = snapshot.substepsPerGlobalStep;
    snapshot.bindings.forEach((binding) => {
        const edge = model.relationships.find((candidate) => candidate.id === binding.id);
        if (edge) {
            edge.sourceStateId = binding.sourceStateId;
            edge.targetStateId = binding.targetStateId;
        }
    });
    refreshNodeLabel(node);
    invalidateRelationshipBundles();
    syncContextualOverlays();
    updateValidationStatus();
    if (selectedNode === node && !$('#nodeEditor').classList.contains('hidden')) {
        renderNodeEditorModel(node);
    }
    if (selectedSourceTermNodeId === node.userData.id && !$('#sourceTermEditor').classList.contains('hidden')) {
        const term = definition.sourceTerms.find((candidate) => candidate.id === selectedSourceTermId);
        if (term) renderSourceTermEditor(node, term);
        else $('#sourceTermEditor').classList.add('hidden');
    }
}

function changeNodeModel(node, mutate) {
    if (activeResult) return;
    const before = captureNodeModel(node);
    const after = structuredClone(before);
    mutate(after);
    const symbols = after.states.map((state) => state.symbol);
    if (symbols.some((symbol) => !modelSymbolPattern.test(symbol)) || new Set(symbols).size !== symbols.length) {
        renderNodeEditorModel(node);
        return;
    }
    const validStateIds = new Set(after.states.map((state) => state.id));
    after.bindings.forEach((binding) => {
        const edge = model.relationships.find((candidate) => candidate.id === binding.id);
        if (edge?.source === node.userData.id && !validStateIds.has(binding.sourceStateId)) binding.sourceStateId = null;
        if (edge?.target === node.userData.id && !validStateIds.has(binding.targetStateId)) binding.targetStateId = null;
    });
    applyNodeModel(node, after);
    recordHistory({
        undo: () => applyNodeModel(node, before),
        redo: () => applyNodeModel(node, after)
    });
}

function renderNodeEditorModel(node) {
    const definition = node.userData.definition;
    $('#nodeEditorTitle').textContent = definition.title;
    $('#editNodeName').value = definition.title;
    $('#editNodeType').value = definition.type;
    $('#editNodeSubsteps').value = definition.substepsPerGlobalStep;
    const configuration = model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);
    $('#nodeEffectiveTimeStep').textContent = `${(configuration.globalTimeStep / definition.substepsPerGlobalStep).toPrecision(6)} s`;
    const stateContainer = $('#nodeEditorStates');
    stateContainer.replaceChildren();
    if (!definition.states.length) stateContainer.innerHTML = '<p class="emptyEditorState">No states defined</p>';
    definition.states.forEach((state) => {
        const row = document.createElement('div');
        row.className = 'editorStateRow';
        row.innerHTML = `
            <input data-field="name" value="${escapeHtml(state.label)}" aria-label="State name">
            <input data-field="symbol" value="${escapeHtml(state.symbol)}" aria-label="State symbol">
            <input data-field="value" type="number" value="${escapeHtml(state.initialValue ?? 0)}" aria-label="Initial value">
            <input data-field="unit" value="${escapeHtml(state.unit ?? '')}" aria-label="Unit">
            <button type="button" title="Remove state">×</button>
        `;
        $$('input', row).forEach((input) => input.addEventListener('change', () => {
            changeNodeModel(node, (snapshot) => {
                const target = snapshot.states.find((candidate) => candidate.id === state.id);
                const previousSymbol = target.symbol;
                const field = input.dataset.field;
                target[field === 'name' ? 'label' : field === 'value' ? 'initialValue' : field] =
                    field === 'value' ? Number(input.value) || 0 : input.value.trim();
                target.value = `${target.initialValue}${target.unit ? ` ${target.unit}` : ''}`;
                if (field === 'symbol') {
                    snapshot.sourceTerms.forEach((term) => {
                        if (term.state === previousSymbol) term.state = target.symbol;
                    });
                }
            });
        }));
        $('button', row).addEventListener('click', () => changeNodeModel(node, (snapshot) => {
            snapshot.states = snapshot.states.filter((candidate) => candidate.id !== state.id);
            snapshot.sourceTerms = snapshot.sourceTerms.filter((term) => term.state !== state.symbol);
        }));
        stateContainer.appendChild(row);
    });

    const sourceTermContainer = $('#nodeEditorSourceTerms');
    sourceTermContainer.replaceChildren();
    if (!definition.sourceTerms.length) sourceTermContainer.innerHTML = '<p class="emptyEditorState">No source terms defined</p>';
    definition.sourceTerms.forEach((term) => {
        const kind = term.implementation?.kind ?? 'equation';
        const stateSymbol = kind === 'equation'
            ? term.state
            : definition.states.find((state) => state.id === term.implementation?.output?.stateId)?.symbol;
        const row = document.createElement('div');
        row.className = 'sourceTermSummaryRow';
        row.innerHTML = `
            <button type="button" class="sourceTermOpen">
                <span class="kindBadge">${kind === 'equation' ? 'Equation' : kind === 'cpp' ? 'C++' : 'Python'}</span>
                <span class="sourceTermPreview">${escapeHtml(stateSymbol ? `Updates ${stateSymbol}` : 'No output state chosen')}</span>
            </button>
            <button type="button" class="removeSourceTerm" title="Remove source term">×</button>
        `;
        $('.sourceTermOpen', row).addEventListener('click', () => openSourceTermEditor(node, term));
        $('.removeSourceTerm', row).addEventListener('click', () => changeNodeModel(node, (snapshot) => {
            snapshot.sourceTerms = snapshot.sourceTerms.filter((candidate) => candidate.id !== term.id);
        }));
        sourceTermContainer.appendChild(row);
    });
}

function sourceTermBindingCandidates(definition) {
    return definition.states.map((state) => ({ kind: 'state', stateId: state.id, symbol: state.symbol, label: state.symbol }));
}

function normalizeSourceTermExpressionModel(definition, term, expressionModel = term.expressionModel) {
    const bindings = sourceTermBindingCandidates(definition);
    const base = expressionModel ?? {
        latex: term.expression ?? '',
        output: { stateId: definition.states.find((state) => state.symbol === term.state)?.id ?? null },
        bindings: [],
        mathJson: null
    };
    const output = definition.states.some((state) => state.id === base.output?.stateId)
        ? base.output
        : { stateId: definition.states[0]?.id ?? null };
    const validation = validateEquationLatex(base.latex, bindings);
    return { latex: base.latex ?? '', output, bindings, mathJson: validation.valid ? validation.mathJson : null };
}

function renderSourceTermDiagnostics(latex, bindings) {
    const diagnostics = $('#termEquationDiagnostics');
    const validation = validateEquationLatex(latex, bindings);
    diagnostics.classList.toggle('valid', validation.valid);
    diagnostics.textContent = validation.valid ? 'Valid expression · MathJSON ready' : validation.errors.join(' ');
    return validation;
}

function insertSourceTermBinding(binding) {
    if (activeResult) return;
    const latex = latexForBinding(binding);
    if ($('#termMathField').hidden) {
        const source = $('#termEquation');
        source.setRangeText(latex, source.selectionStart, source.selectionEnd, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        source.focus();
    } else {
        $('#termMathField').insert(latex);
        $('#termMathField').focus();
    }
}

function changeSourceTermModel(node, termId, mutate) {
    changeNodeModel(node, (snapshot) => {
        const term = snapshot.sourceTerms.find((candidate) => candidate.id === termId);
        if (term) mutate(term, snapshot);
    });
}

function sourceTermReferenceValue(reference) {
    return `state:${reference.stateId}`;
}

function sourceTermReferenceToBinding(key, reference) {
    return { key, kind: 'state', stateId: reference.stateId };
}

function renderSourceTermProviderBindingRows(node, term) {
    const definition = node.userData.definition;
    const container = $('#termProviderBindings');
    container.replaceChildren();
    const bindings = term.implementation?.bindings ?? [];
    const candidates = sourceTermBindingCandidates(definition);
    if (!bindings.length) container.innerHTML = '<p class="emptyEditorState">No bindings defined</p>';
    bindings.forEach((binding, index) => {
        const row = document.createElement('div');
        row.className = 'providerBindingRow';
        row.innerHTML = `
            <label class="parameterField"><span>Key</span><input data-field="key" value="${escapeHtml(binding.key ?? '')}"></label>
            <label class="parameterField"><span>Reference</span><select data-field="reference"></select></label>
            <button type="button" title="Remove binding">×</button>
        `;
        const select = $('[data-field="reference"]', row);
        select.replaceChildren(...candidates.map((candidate) => new Option(candidate.label, sourceTermReferenceValue(candidate))));
        select.value = sourceTermReferenceValue(binding);
        $('[data-field="key"]', row).addEventListener('change', (event) => {
            changeSourceTermModel(node, term.id, (snapshotTerm) => {
                snapshotTerm.implementation.bindings[index] = { ...snapshotTerm.implementation.bindings[index], key: event.target.value.trim() };
            });
        });
        select.addEventListener('change', (event) => {
            const candidate = candidates.find((option) => sourceTermReferenceValue(option) === event.target.value);
            if (!candidate) return;
            changeSourceTermModel(node, term.id, (snapshotTerm) => {
                snapshotTerm.implementation.bindings[index] = sourceTermReferenceToBinding(snapshotTerm.implementation.bindings[index].key, candidate);
            });
        });
        $(':scope > button', row).addEventListener('click', () => changeSourceTermModel(node, term.id, (snapshotTerm) => {
            snapshotTerm.implementation.bindings.splice(index, 1);
        }));
        container.appendChild(row);
    });
}

function renderSourceTermEditor(node, term) {
    const definition = node.userData.definition;
    $('#sourceTermEditorTitle').textContent = `${definition.title} · Source term`;
    const implementationKind = term.implementation?.kind ?? 'equation';
    const isEquation = implementationKind === 'equation';
    $('#termImplementationKind').value = implementationKind;
    $('#termEquationHeading').hidden = !isEquation;
    $('#termEquationDiagnostics').hidden = !isEquation;
    $('#termReferencePicker').hidden = !isEquation;
    $('#termProviderSection').hidden = isEquation;

    const output = $('#termOutputState');
    output.replaceChildren(...definition.states.map((state) => new Option(state.symbol, state.id)));

    const mathField = $('#termMathField');
    const latexSource = $('#termEquation');
    if (isEquation) {
        term.expressionModel = normalizeSourceTermExpressionModel(definition, term);
        term.expression = term.expressionModel.latex;
        const latexMode = $('[data-term-equation-mode="latex"]').classList.contains('active');
        mathField.hidden = latexMode;
        latexSource.hidden = !latexMode;
        mathField.value = term.expressionModel.latex;
        latexSource.value = term.expressionModel.latex;
        output.value = term.expressionModel.output.stateId ?? '';
        renderSourceTermDiagnostics(term.expressionModel.latex, term.expressionModel.bindings);
        const references = $('#termStateReferenceChips');
        references.replaceChildren();
        term.expressionModel.bindings.forEach((binding) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = binding.label;
            button.title = 'Insert state reference';
            button.addEventListener('click', () => insertSourceTermBinding(binding));
            references.appendChild(button);
        });
    } else {
        mathField.hidden = true;
        latexSource.hidden = true;
        output.value = term.implementation.output?.stateId ?? '';
        $('#termProviderSource').value = term.implementation.source ?? '';
        $('#termInsertProviderTemplate').hidden = !term.implementation.source?.trim();
        $('#termProviderOutputKey').value = term.implementation.output?.key ?? '';
        renderSourceTermProviderBindingRows(node, term);
    }
}

function openSourceTermEditor(node, term) {
    const editor = $('#sourceTermEditor');
    selectedSourceTermNodeId = node.userData.id;
    selectedSourceTermId = term.id;
    hideCards(editor);
    renderSourceTermEditor(node, term);
    editor.style.removeProperty('left');
    editor.style.removeProperty('top');
    editor.classList.remove('hidden');
    applyInspectorReadOnly();
    requestAnimationFrame(avoidAssistantInspectorOverlap);
}

function previewSourceTermExpression(latex, origin) {
    if (activeResult || !selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    const definition = node?.userData.definition;
    const term = definition?.sourceTerms.find((candidate) => candidate.id === selectedSourceTermId);
    if (!term) return;
    beginEquationEditSession(`sourceTerm:${term.id}`, () => captureNodeModel(node), (snapshot) => applyNodeModel(node, snapshot));
    term.expressionModel = normalizeSourceTermExpressionModel(definition, term, { ...term.expressionModel, latex });
    term.expression = latex;
    if (origin !== 'visual') $('#termMathField').setValue(latex, { silenceNotifications: true });
    if (origin !== 'latex') $('#termEquation').value = latex;
    renderSourceTermDiagnostics(latex, term.expressionModel.bindings);
    updateValidationStatus();
}

function previewSourceTermProviderSource(source) {
    if (activeResult || !selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    const definition = node?.userData.definition;
    const term = definition?.sourceTerms.find((candidate) => candidate.id === selectedSourceTermId);
    if (!term) return;
    beginEquationEditSession(`sourceTerm:${term.id}`, () => captureNodeModel(node), (snapshot) => applyNodeModel(node, snapshot));
    term.implementation = { ...term.implementation, source };
    $('#termInsertProviderTemplate').hidden = !source.trim();
    updateValidationStatus();
}

async function renderNodeResults(node) {
    const panel = $('.nodeResultsPanel');
    let series = nodeResultSeries(activeResult, node.userData.definition);
    if (activeEngineJobId && activeResult?.sampleCount > activeResult.samples.length) {
        const signalIds = node.userData.definition.states.map((state) => state.id);
        const storedSeries = await window.engine.readResultSeries(activeEngineJobId, signalIds, {
            startTime: 0,
            endTime: activeResult.availableResultTime,
            maxPoints: 4000
        });
        const bySignal = new Map(storedSeries.map((item) => [item.signalId, item.samples]));
        series = node.userData.definition.states.map((state) => ({
            nodeId: node.userData.definition.id,
            stateId: state.id,
            name: state.label,
            symbol: state.symbol,
            unit: state.unit ?? '',
            samples: bySignal.get(state.id) ?? []
        })).filter((item) => item.samples.length);
    }
    panel.classList.toggle('hasResults', Boolean(series.length));
    if (!series.length) {
        nodeResultPlot.clear();
        return;
    }
    await nodeResultPlot.render(series, activeResult.samples[activeResultSampleIndex]?.time ?? 0);
}

function selectNodeEditorTab(tabName) {
    $$('[data-node-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.nodeTab === tabName);
    });
    $$('[data-node-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.nodePanel !== tabName;
    });
    $('#nodeModelActions').hidden = Boolean(activeResult) || tabName !== 'model';
    if (tabName === 'results' && selectedNode) requestAnimationFrame(() => renderNodeResults(selectedNode));
}

function openNodeEditor(definition, clientX, clientY) {
    const editor = $('#nodeEditor');
    hideCards(editor);
    const node = nodeObjects.get(definition.id);
    renderNodeEditorModel(node);
    const initialTab = activeResult ? 'results' : 'model';
    selectNodeEditorTab(initialTab);
    $('#editNodeShape').value = definition.shape === 'imported' ? '' : definition.shape;
    $('#editNodeColor').value = `#${definition.color.toString(16).padStart(6, '0')}`;
    $('#editNodeGeometryFile').value = '';
    $('#editGeometryStatus').textContent = definition.geometryFileName ?? 'Choose a CAD or mesh file, or browse the bundled library';
    $('#editGeometryStatus').classList.remove('loading', 'error');
    refreshNodeTransformFields(node);
    $('#toggleNodeEnabled').textContent = definition.enabled === false ? 'Enable node' : 'Disable node';
    editor.style.removeProperty('left');
    editor.style.removeProperty('top');
    editor.classList.remove('hidden');
    applyInspectorReadOnly();
    requestAnimationFrame(avoidAssistantInspectorOverlap);
}

function normalizeEdgeEquationModel(definition, equationModel = definition.equationModel) {
    const sourceNode = model.nodes.find((node) => node.id === definition.source);
    const targetNode = model.nodes.find((node) => node.id === definition.target);
    const base = equationModel ?? {
        latex: definition.equation ?? '',
        output: { role: 'target', stateId: definition.targetStateId ?? null },
        bindings: [],
        mathJson: null
    };
    const bindings = reconcileEquationBindings(base.bindings, sourceNode, targetNode, definition.parameters);
    const outputNode = base.output?.role === 'source' ? sourceNode : targetNode;
    const output = outputNode?.states.some((state) => state.id === base.output?.stateId)
        ? base.output
        : { role: 'target', stateId: targetNode?.states[0]?.id ?? null };
    const validation = validateEquationLatex(base.latex, bindings);
    return { latex: base.latex ?? '', output, bindings, mathJson: validation.valid ? validation.mathJson : null };
}

function captureEdgeModel(definition) {
    const equationModel = normalizeEdgeEquationModel(definition);
    return {
        title: definition.title,
        source: definition.source,
        sourceStateId: definition.sourceStateId,
        target: definition.target,
        targetStateId: definition.targetStateId,
        directionality: definition.directionality,
        equation: definition.equation,
        equationModel: structuredClone(equationModel),
        implementation: structuredClone(definition.implementation ?? null),
        parameters: structuredClone(definition.parameters),
        color: definition.color,
        waypoints: structuredClone(definition.waypoints ?? [])
    };
}

// Applies definition.color/enabled (and every connected node's enabled state, via
// isEdgeEffectivelyEnabled) to the live line and direction-marker materials, without rebuilding
// geometry. Used both when the edge's own color changes and whenever its enabled cascade does.
function refreshRelationshipVisual(definition) {
    const relationship = relationshipObjects.get(definition.id);
    if (!relationship) return;
    const enabled = isEdgeEffectivelyEnabled(definition);
    const color = enabled ? definition.color : disabledDisplayColor(definition.color);
    relationship.line.material.color.setHex(color);
    relationship.line.material.opacity = enabled ? 0.92 : 0.4;
    if (relationship.marker) {
        relationship.marker.material.color.setHex(color);
        relationship.marker.material.transparent = !enabled;
        relationship.marker.material.opacity = enabled ? 1 : 0.4;
        relationship.marker.material.needsUpdate = true;
    }
}

function setRelationshipColor(definition, color) {
    definition.color = color;
    refreshRelationshipVisual(definition);
}

function applyEdgeModel(definition, snapshot) {
    definition.title = snapshot.title;
    definition.source = snapshot.source;
    definition.sourceStateId = snapshot.sourceStateId;
    definition.target = snapshot.target;
    definition.targetStateId = snapshot.targetStateId;
    definition.parameters = structuredClone(snapshot.parameters);
    definition.equationModel = normalizeEdgeEquationModel(definition, snapshot.equationModel);
    definition.equation = definition.equationModel.latex;
    definition.implementation = structuredClone(snapshot.implementation ?? null);
    definition.waypoints = structuredClone(snapshot.waypoints ?? []);
    setRelationshipDirectionality(definition, snapshot.directionality);
    setRelationshipColor(definition, snapshot.color);
    // Before updateRelationships() -- it calls syncContextualOverlays() internally, which reads
    // waypointHandleObjects to decide whether to hide this edge's label; populating the handles
    // first means that decision reflects the new waypoint count, not the pre-mutation one.
    if (selectedRelationship?.id === definition.id) syncWaypointHandles(definition.id);
    updateRelationships();
    updateValidationStatus();
    if (selectedRelationship?.id === definition.id && !$('#edgeEditor').classList.contains('hidden')) {
        renderEdgeEditor(definition);
    }
}

function changeEdgeModel(definition, mutate) {
    if (activeResult) return;
    finishEquationEdit();
    const before = captureEdgeModel(definition);
    const after = structuredClone(before);
    mutate(after);
    if (after.source === after.target) {
        renderEdgeEditor(definition);
        return;
    }
    const parameterSymbols = after.parameters.map((parameter) => parameter.symbol);
    if (parameterSymbols.some((symbol) => !modelSymbolPattern.test(symbol)) || new Set(parameterSymbols).size !== parameterSymbols.length) {
        renderEdgeEditor(definition);
        return;
    }
    applyEdgeModel(definition, after);
    recordHistory({
        undo: () => applyEdgeModel(definition, before),
        redo: () => applyEdgeModel(definition, after)
    });
}

function normalizedParameterControl(parameter) {
    const { minimum, maximum, step } = liveParameterRange(parameter);
    return {
        minimum: Number(parameter.control?.minimum ?? minimum),
        maximum: Number(parameter.control?.maximum ?? maximum),
        step: Number(parameter.control?.step ?? step)
    };
}

function parameterControlError(value, control) {
    if (![value, control.minimum, control.maximum, control.step].every(Number.isFinite)) return 'Value and slider settings must be finite numbers.';
    if (!(control.minimum < control.maximum)) return 'Minimum must be less than maximum.';
    if (!(control.step > 0)) return 'Step must be greater than zero.';
    if (value < control.minimum || value > control.maximum) return 'The initial value must be within the slider bounds.';
    return '';
}

function renderEdgeEditor(definition) {
    $('.edgeEditor > header strong').textContent = definition.title;
    $('#editEdgeName').value = definition.title;
    $('#toggleEdgeEnabled').textContent = definition.enabled === false ? 'Enable edge' : 'Disable edge';
    const source = $('#editEdgeSource');
    const target = $('#editEdgeTarget');
    const options = model.nodes.filter((node) => nodeObjects.get(node.id)?.visible === true);
    source.replaceChildren(...options.map((node) => new Option(node.title, node.id)));
    target.replaceChildren(...options.map((node) => new Option(node.title, node.id)));
    source.value = definition.source;
    target.value = definition.target;
    $('#editEdgeDirectionality').value = definition.directionality;
    $('#editEdgeColor').value = `#${definition.color.toString(16).padStart(6, '0')}`;
    const parameterContainer = $('#edgeEditorParameters');
    parameterContainer.replaceChildren();
    if (!definition.parameters.length) parameterContainer.innerHTML = '<p class="emptyEditorState">No parameters defined</p>';
    definition.parameters.forEach((parameter) => {
        const control = normalizedParameterControl(parameter);
        const row = document.createElement('div');
        row.className = 'editorParameterRow';
        row.innerHTML = `
            <label class="parameterField"><span>Name</span><input data-field="name" value="${escapeHtml(parameter.name)}"></label>
            <label class="parameterField"><span>Symbol</span><input data-field="symbol" value="${escapeHtml(parameter.symbol)}"></label>
            <label class="parameterField"><span>Initial value</span><input data-field="value" type="number" value="${escapeHtml(parameter.value)}"></label>
            <label class="parameterField"><span>Unit</span><input data-field="unit" value="${escapeHtml(parameter.unit ?? '')}"></label>
            <label class="parameterField"><span>Mode</span><select data-field="mode"><option value="constant">Constant</option><option value="live">Live</option></select></label>
            <button type="button" title="Remove parameter">×</button>
            <div class="parameterControlFields" ${parameter.mode === 'live' ? '' : 'hidden'}>
                <label class="parameterField"><span>Slider minimum</span><input data-control-field="minimum" type="number" value="${control.minimum}"></label>
                <label class="parameterField"><span>Slider maximum</span><input data-control-field="maximum" type="number" value="${control.maximum}"></label>
                <label class="parameterField"><span>Slider step</span><input data-control-field="step" type="number" min="0" value="${control.step}"></label>
                <span class="parameterControlError" role="status"></span>
            </div>
        `;
        $('[data-field="mode"]', row).value = parameter.mode ?? 'constant';
        const readControl = () => Object.fromEntries($$('[data-control-field]', row)
            .map((input) => [input.dataset.controlField, Number(input.value)]));
        const showControlError = () => {
            const error = $('[data-field="mode"]', row).value === 'live'
                ? parameterControlError(Number($('[data-field="value"]', row).value), readControl()) : '';
            $('.parameterControlError', row).textContent = error;
            return error;
        };
        $$('[data-control-field], [data-field="value"]', row).forEach((input) => input.addEventListener('input', showControlError));
        $$('[data-field]', row).forEach((input) => input.addEventListener('change', () => {
            if (input.dataset.field === 'mode') $('.parameterControlFields', row).hidden = input.value !== 'live';
            if (showControlError()) return;
            changeEdgeModel(definition, (snapshot) => {
                const targetParameter = snapshot.parameters.find((candidate) => candidate.id === parameter.id);
                targetParameter[input.dataset.field] = input.dataset.field === 'value'
                    ? Number(input.value) || 0
                    : input.value.trim();
                if (targetParameter.mode === 'live') targetParameter.control = readControl();
                else delete targetParameter.control;
            });
        }));
        $$('[data-control-field]', row).forEach((input) => input.addEventListener('change', () => {
            if (showControlError()) return;
            changeEdgeModel(definition, (snapshot) => {
                const targetParameter = snapshot.parameters.find((candidate) => candidate.id === parameter.id);
                targetParameter.value = Number($('[data-field="value"]', row).value) || 0;
                targetParameter.control = readControl();
            });
        }));
        $(':scope > button', row).addEventListener('click', () => changeEdgeModel(definition, (snapshot) => {
            snapshot.parameters = snapshot.parameters.filter((candidate) => candidate.id !== parameter.id);
        }));
        parameterContainer.appendChild(row);
    });
    const implementationKind = definition.implementation?.kind ?? 'equation';
    const isEquation = implementationKind === 'equation';
    $('#editEdgeImplementationKind').value = implementationKind;
    // The math-field/latex-textarea toggle their own `hidden` directly (matching the existing
    // Visual/LaTeX mode toggle) rather than through a hidden ancestor: MathLive's custom element
    // does not reliably accept focus again once an ancestor of it has been display:none'd.
    $('#editEdgeEquationHeading').hidden = !isEquation;
    $('#equationDiagnostics').hidden = !isEquation;
    $('#editEdgeReferencePicker').hidden = !isEquation;
    $('#editEdgeProviderSection').hidden = isEquation;

    const output = $('#editEquationOutput');
    output.replaceChildren();
    [['source', definition.source], ['target', definition.target]].forEach(([role, nodeId]) => {
        const node = model.nodes.find((candidate) => candidate.id === nodeId);
        node?.states.forEach((state) => {
            output.add(new Option(`${role}.${state.symbol}`, `${role}:${state.id}`));
        });
    });

    const mathField = $('#editEdgeMathField');
    const latexSource = $('#editEdgeEquation');
    if (isEquation) {
        definition.equationModel = normalizeEdgeEquationModel(definition);
        definition.equation = definition.equationModel.latex;
        const latexMode = $('[data-equation-mode="latex"]').classList.contains('active');
        mathField.hidden = latexMode;
        latexSource.hidden = !latexMode;
        mathField.value = definition.equationModel.latex;
        latexSource.value = definition.equationModel.latex;
        output.value = `${definition.equationModel.output.role}:${definition.equationModel.output.stateId}`;
        renderEquationDiagnostics(definition.equationModel.latex, definition.equationModel.bindings);
        const references = $('#editStateReferenceChips');
        references.replaceChildren();
        definition.equationModel.bindings.forEach((binding) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = binding.label;
            button.title = binding.kind === 'parameter' ? 'Insert parameter' : 'Insert state reference';
            button.addEventListener('click', () => insertEquationBinding(binding));
            references.appendChild(button);
        });
    } else {
        mathField.hidden = true;
        latexSource.hidden = true;
        output.value = `${definition.implementation.output?.role ?? 'target'}:${definition.implementation.output?.stateId ?? ''}`;
        $('#editEdgeProviderSource').value = definition.implementation.source ?? '';
        $('#editInsertProviderTemplate').hidden = !definition.implementation.source?.trim();
        $('#editProviderOutputKey').value = definition.implementation.output?.key ?? '';
        renderProviderBindingRows(definition);
    }
}

function providerReferenceCandidates(definition) {
    const sourceNode = model.nodes.find((node) => node.id === definition.source);
    const targetNode = model.nodes.find((node) => node.id === definition.target);
    return reconcileEquationBindings([], sourceNode, targetNode, definition.parameters);
}

function providerReferenceValue(reference) {
    return reference.kind === 'parameter'
        ? `parameter:${reference.parameterId}`
        : `state:${reference.role}:${reference.nodeId}:${reference.stateId}`;
}

function providerBindingToReference(binding) {
    return {
        kind: binding.kind,
        role: binding.role,
        nodeId: binding.nodeId,
        stateId: binding.stateId,
        parameterId: binding.parameterId
    };
}

function referenceToProviderBinding(key, reference) {
    return reference.kind === 'parameter'
        ? { key, kind: 'parameter', parameterId: reference.parameterId }
        : { key, kind: 'state', role: reference.role, nodeId: reference.nodeId, stateId: reference.stateId };
}

function renderProviderBindingRows(definition) {
    const container = $('#editEdgeProviderBindings');
    container.replaceChildren();
    const bindings = definition.implementation?.bindings ?? [];
    const candidates = providerReferenceCandidates(definition);
    if (!bindings.length) container.innerHTML = '<p class="emptyEditorState">No bindings defined</p>';
    bindings.forEach((binding, index) => {
        const row = document.createElement('div');
        row.className = 'providerBindingRow';
        row.innerHTML = `
            <label class="parameterField"><span>Key</span><input data-field="key" value="${escapeHtml(binding.key ?? '')}"></label>
            <label class="parameterField"><span>Reference</span><select data-field="reference"></select></label>
            <button type="button" title="Remove binding">×</button>
        `;
        const select = $('[data-field="reference"]', row);
        select.replaceChildren(...candidates.map((candidate) => new Option(candidate.label, providerReferenceValue(candidate))));
        select.value = providerReferenceValue(providerBindingToReference(binding));
        $('[data-field="key"]', row).addEventListener('change', (event) => {
            changeEdgeModel(definition, (snapshot) => {
                snapshot.implementation.bindings[index] = { ...snapshot.implementation.bindings[index], key: event.target.value.trim() };
            });
        });
        select.addEventListener('change', (event) => {
            const candidate = candidates.find((option) => providerReferenceValue(option) === event.target.value);
            if (!candidate) return;
            changeEdgeModel(definition, (snapshot) => {
                snapshot.implementation.bindings[index] = referenceToProviderBinding(snapshot.implementation.bindings[index].key, candidate);
            });
        });
        $(':scope > button', row).addEventListener('click', () => changeEdgeModel(definition, (snapshot) => {
            snapshot.implementation.bindings.splice(index, 1);
        }));
        container.appendChild(row);
    });
}

function renderEquationDiagnostics(latex, bindings) {
    const diagnostics = $('#equationDiagnostics');
    const validation = validateEquationLatex(latex, bindings);
    diagnostics.classList.toggle('valid', validation.valid);
    diagnostics.textContent = validation.valid
        ? 'Valid expression · MathJSON ready'
        : validation.errors.join(' ');
    return validation;
}

function insertEquationBinding(binding) {
    if (activeResult) return;
    const latex = latexForBinding(binding);
    if ($('#editEdgeMathField').hidden) {
        const source = $('#editEdgeEquation');
        source.setRangeText(latex, source.selectionStart, source.selectionEnd, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        source.focus();
    } else {
        $('#editEdgeMathField').insert(latex);
        $('#editEdgeMathField').focus();
    }
}

// A group-member edge is never edited on its own -- no override without detaching, per
// docs/edgeGroups.md -- so every path that would otherwise open the single-edge editor
// on one routes here to the group's own editor instead.
function openRelationshipEditor(definition, clientX, clientY) {
    if (definition.groupId != null) {
        openEdgeGroupEditor(definition.groupId);
        return;
    }
    const editor = $('#edgeEditor');
    selectRelationship(definition);
    hideCards(editor);
    renderEdgeEditor(definition);
    editor.style.removeProperty('left');
    editor.style.removeProperty('top');
    editor.classList.remove('hidden');
    applyInspectorReadOnly();
    requestAnimationFrame(avoidAssistantInspectorOverlap);
}

function openAddPalette(clientX, clientY) {
    const palette = $('#addPalette');
    hideCards(palette);
    positionCard(palette, clientX, clientY);
}

function openNodeContextMenu(clientX, clientY) {
    const menu = $('#nodeContextMenu');
    hideCards(menu);
    const multi = selectedNodeIds.size > 1;
    $('#nodeContextConnect').hidden = multi;
    $('#nodeContextToggle').hidden = multi;
    $('#nodeContextDisableAll').hidden = !multi;
    $('#nodeContextEnableAll').hidden = !multi;
    $('#nodeContextCreateEdgeGroup').hidden = !multi;
    // Scoped to whichever group is currently open for editing -- a node can technically belong
    // to more than one group, but a single context click can only unambiguously mean "this one".
    const activeGroup = currentEdgeGroup();
    const soleSelectedId = !multi ? selectedNode?.userData.id : null;
    $('#nodeContextAddToGroup').hidden = multi || !activeGroup || activeGroup.memberNodeIds.includes(soleSelectedId);
    $('#nodeContextDetachFromGroup').hidden = multi || !activeGroup || !activeGroup.memberNodeIds.includes(soleSelectedId);
    if (multi) {
        $('#nodeContextDeleteLabel').textContent = `Delete ${selectedNodeIds.size} nodes`;
    } else {
        const enabled = selectedNode?.userData.definition.enabled !== false;
        $('#nodeContextToggleLabel').textContent = enabled ? 'Disable node' : 'Enable node';
        $('#nodeContextDeleteLabel').textContent = 'Delete node';
    }
    positionCard(menu, clientX, clientY);
}

function openEdgeContextMenu(clientX, clientY) {
    const menu = $('#edgeContextMenu');
    hideCards(menu);
    const grouped = selectedRelationship?.groupId != null;
    const enabled = selectedRelationship?.enabled !== false;
    $('#edgeContextToggleLabel').textContent = enabled ? 'Disable edge' : 'Enable edge';
    $('#edgeContextAddWaypoint').hidden = grouped || !pendingWaypoint;
    $('#edgeContextToggle').hidden = grouped;
    $('#edgeContextDelete').hidden = grouped;
    $('#edgeContextOpenGroup').hidden = !grouped;
    positionCard(menu, clientX, clientY);
}

function openWaypointContextMenu(clientX, clientY) {
    const menu = $('#waypointContextMenu');
    hideCards(menu);
    positionCard(menu, clientX, clientY);
}

function addStateVariableRow(values = {}) {
    const row = document.createElement('div');
    row.className = 'builderRow stateVariableRow';
    row.innerHTML = `
        <input data-field="name" placeholder="Name" value="${values.name ?? ''}">
        <input data-field="symbol" placeholder="Symbol" value="${values.symbol ?? ''}">
        <input data-field="value" type="number" placeholder="Initial" value="${values.value ?? ''}">
        <input data-field="unit" placeholder="Unit" value="${values.unit ?? ''}">
        <button class="removeBuilderRow" type="button" title="Remove">×</button>
    `;
    $('#stateVariableRows').appendChild(row);
    row.querySelector('.removeBuilderRow').addEventListener('click', () => {
        row.remove();
        refreshSourceStateOptions();
    });
    row.querySelectorAll('input').forEach((input) => input.addEventListener('input', refreshSourceStateOptions));
    refreshSourceStateOptions();
}

function normalizeImportedGeometry(geometry) {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(largestDimension) || largestDimension <= 0) {
        throw new Error('The file contains no usable geometry.');
    }
    geometry.scale(2.8 / largestDimension, 2.8 / largestDimension, 2.8 / largestDimension);
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingSphere();
    return geometry;
}

function geometryFromStepResult(result) {
    if (!result.success || !result.meshes?.length) throw new Error('OpenCascade could not read this STEP file.');
    const geometries = result.meshes.map((resultMesh) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(resultMesh.attributes.position.array, 3)
        );
        if (resultMesh.attributes.normal) {
            geometry.setAttribute(
                'normal',
                new THREE.Float32BufferAttribute(resultMesh.attributes.normal.array, 3)
            );
        } else {
            geometry.computeVertexNormals();
        }
        geometry.setIndex(resultMesh.index.array);
        return geometry.toNonIndexed();
    });
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    if (!merged) throw new Error('The STEP meshes could not be combined.');
    return merged;
}

// Shared by both the on-disk "Import STL or STEP" flow and the bundled shape library, since
// a library entry is parsed exactly like a user-supplied file once its bytes are in hand.
async function geometryFromBytes(buffer, extension) {
    if (extension === 'stl') return normalizeImportedGeometry(new STLLoader().parse(buffer));
    if (extension === 'step' || extension === 'stp') {
        if (!window.occtimportjs) throw new Error('The STEP importer is unavailable.');
        const occt = await window.occtimportjs();
        const result = occt.ReadStepFile(new Uint8Array(buffer), {
            linearUnit: 'millimeter',
            linearDeflectionType: 'bounding_box_ratio',
            linearDeflection: 0.001,
            angularDeflection: 0.5
        });
        return normalizeImportedGeometry(geometryFromStepResult(result));
    }
    throw new Error('Choose an STL, STEP, or STP file.');
}

async function importNodeGeometry(file) {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return geometryFromBytes(await file.arrayBuffer(), extension);
}

// Persists a successfully-imported shape file into the user's own shape library (userData/shapes,
// separate from the read-only bundled one) so it's reusable on other nodes without re-uploading --
// a File's arrayBuffer() can be read more than once, so this doesn't disturb the geometry import
// that already consumed it. Deliberately non-fatal: failing to save to the library shouldn't
// undo an otherwise-successful shape import, so this only ever appends to the status text.
async function saveUploadToShapeLibrary(file, status) {
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await window.shapeLibrary.saveUpload(file.name, bytes);
        shapeLibraryEntries = null;
        // A re-upload could reuse a filename (and therefore id) that already has a cached
        // thumbnail from a different, previously-deleted file -- clear rather than diff.
        shapeLibraryThumbnailCache.clear();
        status.textContent += ' · saved to shape library';
    } catch (error) {
        console.error(error);
    }
}

async function importLibraryShape(id) {
    const shape = await window.shapeLibrary.load(id);
    // shape.data crosses the IPC boundary as a plain Uint8Array (structured clone), not a
    // Node Buffer -- pull out a real ArrayBuffer the same way STLLoader/occt-import-js expect.
    const bytes = shape.data;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const geometry = await geometryFromBytes(buffer, shape.format);
    return { geometry, name: shape.name };
}

let shapeLibraryEntries = null;
let shapeLibraryTarget = null;
let shapeLibraryDomain = 'all';

function domainLabel(domain) {
    if (domain === 'userUploaded') return 'User uploaded';
    return `${domain.charAt(0).toUpperCase()}${domain.slice(1)}`;
}

function shapeDomains(shape) {
    if (Array.isArray(shape?.domains) && shape.domains.length) return shape.domains;
    if (shape?.domain) return [shape.domain];
    return ['general'];
}

function shapeLibraryThumbnailMarkup(id) {
    if (shapeLibraryThumbnailCache.has(id)) {
        const dataUrl = shapeLibraryThumbnailCache.get(id);
        return dataUrl
            ? `<img class="examplesExplorerThumb" src="${escapeHtml(dataUrl)}" alt="">`
            : '<span class="examplesExplorerThumbPlaceholder">No preview</span>';
    }
    return '<img class="examplesExplorerThumb" alt="">';
}

function renderShapeLibraryResults() {
    const query = $('#shapeLibrarySearch').value.trim().toLowerCase();
    const matches = shapeLibraryEntries.filter((shape) => {
        const domains = shapeDomains(shape);
        if (shapeLibraryDomain !== 'all' && !domains.includes(shapeLibraryDomain)) return false;
        if (!query) return true;
        const haystack = [shape.name, ...domains, ...(shape.tags ?? [])].join(' ').toLowerCase();
        return haystack.includes(query);
    });
    // Old buttons are about to be discarded -- drop the observer's references to them first so
    // it doesn't accumulate entries for detached elements across repeated search keystrokes.
    const observer = ensureShapeLibraryThumbnailObserver();
    observer.disconnect();
    $('#shapeLibraryResults').replaceChildren(...matches.map((shape) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'shapeLibraryItem';
        button.dataset.shapeId = shape.id;
        button.classList.toggle('selected', shape.id === shapeLibrarySelectedId);
        const domains = shapeDomains(shape);
        const domainText = domains.map(domainLabel).join(', ');
        button.innerHTML = `${shapeLibraryThumbnailMarkup(shape.id)}<b>${escapeHtml(shape.name)}</b><small>${escapeHtml(domainText)}<span class="shapeFormatBadge">${escapeHtml(shape.format.toUpperCase())}</span></small>`;
        if (!shapeLibraryThumbnailCache.has(shape.id)) observer.observe(button);
        return button;
    }));
    $('#shapeLibraryEmpty').hidden = matches.length > 0;
}

async function openShapeLibrary(target) {
    shapeLibraryTarget = target;
    if (!shapeLibraryEntries) shapeLibraryEntries = await window.shapeLibrary.list();
    shapeLibraryDomain = 'all';
    shapeLibrarySelectedId = null;
    $('#shapeLibrarySearch').value = '';
    $('#shapeLibraryDetailEmpty').hidden = false;
    $('#shapeLibraryDetailContent').hidden = true;
    const domains = ['all', ...new Set(shapeLibraryEntries.flatMap((shape) => shapeDomains(shape)))];
    $('#shapeLibraryDomains').replaceChildren(...domains.map((domain) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = domain === 'all' ? 'All' : domainLabel(domain);
        button.classList.toggle('active', domain === shapeLibraryDomain);
        button.addEventListener('click', () => {
            shapeLibraryDomain = domain;
            $$('#shapeLibraryDomains button').forEach((chip) => chip.classList.toggle('active', chip === button));
            renderShapeLibraryResults();
        });
        return button;
    }));
    renderShapeLibraryResults();
    $('#shapeLibraryDialog').showModal();
    $('#shapeLibrarySearch').focus();
}

async function applyLibraryShape(id) {
    const { geometry, name } = await importLibraryShape(id);
    if (shapeLibraryTarget === 'editor' && selectedNode) {
        changeNodeAppearance(selectedNode, {
            ...captureNodeAppearance(selectedNode.userData.definition),
            shape: 'imported',
            importedGeometry: geometry,
            geometryFileName: name
        });
        $('#editNodeShape').value = '';
        $('#editGeometryStatus').textContent = `${name} applied`;
    } else if (shapeLibraryTarget === 'builder') {
        pendingImportedGeometry?.dispose();
        pendingImportedGeometry = geometry;
        pendingGeometryFileName = name;
        $('#newNodeShape').value = 'imported';
        $('#geometryImportStatus').textContent = `${name} ready`;
    }
    geometry.dispose();
    $('#shapeLibraryDialog').close();
}

// A second, small, permanent three.js scene/renderer for the shape library's own detail pane --
// the main canvas (this file, ~517-535) is otherwise the only one in the renderer process.
// Created lazily on first use and kept alive for the app's lifetime, the same way the main
// canvas is a persistent singleton, rather than being rebuilt on every dialog open.
let shapeLibraryPreviewScene = null;
let shapeLibraryPreviewCamera = null;
let shapeLibraryPreviewRenderer = null;
let shapeLibraryPreviewOrbit = null;
let shapeLibraryPreviewMesh = null;
let shapeLibraryPreviewRevision = 0;
let shapeLibraryPreviewAnimating = false;
let shapeLibrarySelectedId = null;

function ensureShapeLibraryPreview() {
    if (shapeLibraryPreviewRenderer) return;
    const canvas = $('#shapeLibraryPreviewCanvas');
    shapeLibraryPreviewScene = new THREE.Scene();
    shapeLibraryPreviewScene.background = new THREE.Color(0x060d12);
    shapeLibraryPreviewCamera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    shapeLibraryPreviewRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    shapeLibraryPreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Same light rig as the main canvas (~779-787), minus its floor grid -- keeps a previewed
    // shape's shading consistent with how it will actually look once applied to a node.
    shapeLibraryPreviewScene.add(new THREE.HemisphereLight(0xbfe4f2, 0x16212a, 2.25));
    const keyLight = new THREE.DirectionalLight(0xfff0d6, 3.2);
    keyLight.position.set(7, 11, 9);
    shapeLibraryPreviewScene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x65d6db, 2.1);
    rimLight.position.set(-8, 4, -7);
    shapeLibraryPreviewScene.add(rimLight);
    // Rotate only -- zoom/pan would let this small canvas capture page scroll/drag gestures it
    // has no real need for, since normalizeImportedGeometry already frames every shape into the
    // same consistent bounding box regardless of its original size.
    shapeLibraryPreviewOrbit = new OrbitControls(shapeLibraryPreviewCamera, shapeLibraryPreviewRenderer.domElement);
    shapeLibraryPreviewOrbit.enableZoom = false;
    shapeLibraryPreviewOrbit.enablePan = false;
    new ResizeObserver(resizeShapeLibraryPreview).observe(canvas);
}

function resizeShapeLibraryPreview() {
    const canvas = $('#shapeLibraryPreviewCanvas');
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    shapeLibraryPreviewCamera.aspect = rect.width / rect.height;
    shapeLibraryPreviewCamera.updateProjectionMatrix();
    shapeLibraryPreviewRenderer.setSize(rect.width, rect.height, false);
}

function animateShapeLibraryPreview() {
    if (!shapeLibraryPreviewAnimating) return;
    requestAnimationFrame(animateShapeLibraryPreview);
    shapeLibraryPreviewOrbit.update();
    shapeLibraryPreviewRenderer.render(shapeLibraryPreviewScene, shapeLibraryPreviewCamera);
}

function disposeShapeLibraryPreviewMesh() {
    if (!shapeLibraryPreviewMesh) return;
    shapeLibraryPreviewScene.remove(shapeLibraryPreviewMesh);
    shapeLibraryPreviewMesh.geometry.dispose();
    shapeLibraryPreviewMesh.material.dispose();
    shapeLibraryPreviewMesh = null;
}

// Stops the render loop and disposes the previewed mesh -- called on every dialog-close path
// (Cancel, Escape, and Apply's own close()) via the dialog's native 'close' event, so there's
// one single cleanup point rather than duplicating this in each button handler.
function stopShapeLibraryPreview() {
    shapeLibraryPreviewAnimating = false;
    disposeShapeLibraryPreviewMesh();
}

// Resets to the same canonical framing for every newly-selected shape, rather than carrying
// over whatever angle the user last rotated to -- so each shape starts from a consistent,
// predictable view instead of an awkward angle inherited from the previous one.
function frameShapeLibraryPreview() {
    shapeLibraryPreviewCamera.position.set(3, 2.4, 3);
    shapeLibraryPreviewOrbit.target.set(0, 0, 0);
    shapeLibraryPreviewOrbit.update();
}

async function selectShapeLibraryPreview(id) {
    const shape = shapeLibraryEntries.find((entry) => entry.id === id);
    $('#shapeLibraryDetailEmpty').hidden = true;
    $('#shapeLibraryDetailContent').hidden = false;
    const domains = shapeDomains(shape);
    const domainText = domains.map(domainLabel).join(' · ');
    $('#shapeLibraryDetailTitle').textContent = shape?.name ?? '';
    $('#shapeLibraryDetailMeta').textContent = shape ? `${domainText} · ${shape.format.toUpperCase()} · Loading…` : '';
    ensureShapeLibraryPreview();
    resizeShapeLibraryPreview();
    // A later click while this load is still in flight must win -- discard a now-stale result
    // rather than overwriting whatever the user has since selected.
    const revision = ++shapeLibraryPreviewRevision;
    let geometry;
    try {
        ({ geometry } = await importLibraryShape(id));
    } catch (error) {
        if (revision === shapeLibraryPreviewRevision) $('#shapeLibraryDetailMeta').textContent = `Could not preview this shape: ${error.message}`;
        return;
    }
    if (revision !== shapeLibraryPreviewRevision) {
        geometry.dispose();
        return;
    }
    disposeShapeLibraryPreviewMesh();
    const material = new THREE.MeshStandardMaterial({ color: 0x42c9bc, roughness: 0.55, metalness: 0.1 });
    shapeLibraryPreviewMesh = new THREE.Mesh(geometry, material);
    shapeLibraryPreviewScene.add(shapeLibraryPreviewMesh);
    frameShapeLibraryPreview();
    $('#shapeLibraryDetailMeta').textContent = shape ? `${domainText} · ${shape.format.toUpperCase()}` : '';
    // Guarded so switching between several shapes never spawns more than one concurrent
    // requestAnimationFrame chain -- animateShapeLibraryPreview() re-schedules itself as long as
    // this stays true, so it only needs to be (re)started when nothing is running yet.
    if (!shapeLibraryPreviewAnimating) {
        shapeLibraryPreviewAnimating = true;
        animateShapeLibraryPreview();
    }
}

// Static per-card thumbnails for the shape library grid, distinct from the live rotating preview
// above -- one shared offscreen renderer (never inserted into the DOM) renders each shape exactly
// once, caches the resulting PNG, and stops. This keeps WebGL context/render-loop cost constant
// regardless of how many shapes exist: no per-card context, no continuous rendering.
let shapeLibraryThumbnailCache = new Map(); // id -> dataURL (success) | null (permanent failure)
let shapeLibraryThumbnailQueue = [];
let shapeLibraryThumbnailQueued = new Set();
let shapeLibraryThumbnailBusy = false;
let shapeLibraryThumbnailObserver = null;
let shapeLibraryThumbnailScene = null;
let shapeLibraryThumbnailCamera = null;
let shapeLibraryThumbnailRenderer = null;

function ensureShapeLibraryThumbnailRenderer() {
    if (shapeLibraryThumbnailRenderer) return;
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 100;
    shapeLibraryThumbnailScene = new THREE.Scene();
    shapeLibraryThumbnailScene.background = new THREE.Color(0x060d12);
    shapeLibraryThumbnailCamera = new THREE.PerspectiveCamera(42, canvas.width / canvas.height, 0.1, 100);
    shapeLibraryThumbnailCamera.position.set(3, 2.4, 3);
    shapeLibraryThumbnailCamera.lookAt(0, 0, 0);
    // preserveDrawingBuffer is required for toDataURL() to read back a framebuffer that would
    // otherwise be cleared right after this single render call.
    shapeLibraryThumbnailRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    shapeLibraryThumbnailRenderer.setSize(canvas.width, canvas.height, false);
    // Same light rig as ensureShapeLibraryPreview (~2411-2419), for shading consistency between
    // a shape's card thumbnail and its live detail-pane preview.
    shapeLibraryThumbnailScene.add(new THREE.HemisphereLight(0xbfe4f2, 0x16212a, 2.25));
    const keyLight = new THREE.DirectionalLight(0xfff0d6, 3.2);
    keyLight.position.set(7, 11, 9);
    shapeLibraryThumbnailScene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x65d6db, 2.1);
    rimLight.position.set(-8, 4, -7);
    shapeLibraryThumbnailScene.add(rimLight);
}

async function generateShapeLibraryThumbnail(id) {
    try {
        ensureShapeLibraryThumbnailRenderer();
        const { geometry } = await importLibraryShape(id);
        const material = new THREE.MeshStandardMaterial({ color: 0x42c9bc, roughness: 0.55, metalness: 0.1 });
        const mesh = new THREE.Mesh(geometry, material);
        shapeLibraryThumbnailScene.add(mesh);
        shapeLibraryThumbnailRenderer.render(shapeLibraryThumbnailScene, shapeLibraryThumbnailCamera);
        const dataUrl = shapeLibraryThumbnailRenderer.domElement.toDataURL('image/png');
        shapeLibraryThumbnailScene.remove(mesh);
        geometry.dispose();
        material.dispose();
        return dataUrl;
    } catch (error) {
        console.error(error);
        return null;
    }
}

function shapeLibraryItemButton(id) {
    return $$('#shapeLibraryResults .shapeLibraryItem').find((item) => item.dataset.shapeId === id);
}

// The queue's only real job is bounding work to one shape at a time (STEP parsing runs on this
// thread and would jank the UI if several ran concurrently) -- staleness is handled by simply
// re-checking whether a matching card still exists right before doing the work, rather than a
// revision counter, since a shape scrolled/filtered away and back is still valid to thumbnail.
async function runShapeLibraryThumbnailQueue() {
    if (shapeLibraryThumbnailBusy) return;
    shapeLibraryThumbnailBusy = true;
    while (shapeLibraryThumbnailQueue.length) {
        const id = shapeLibraryThumbnailQueue.shift();
        shapeLibraryThumbnailQueued.delete(id);
        if (shapeLibraryThumbnailCache.has(id) || !shapeLibraryItemButton(id)) continue;
        const dataUrl = await generateShapeLibraryThumbnail(id);
        shapeLibraryThumbnailCache.set(id, dataUrl);
        const button = shapeLibraryItemButton(id);
        const img = button?.querySelector('img.examplesExplorerThumb');
        if (dataUrl && img) img.src = dataUrl;
    }
    shapeLibraryThumbnailBusy = false;
}

function enqueueShapeLibraryThumbnail(id) {
    if (shapeLibraryThumbnailCache.has(id) || shapeLibraryThumbnailQueued.has(id)) return;
    shapeLibraryThumbnailQueued.add(id);
    shapeLibraryThumbnailQueue.push(id);
    runShapeLibraryThumbnailQueue();
}

function ensureShapeLibraryThumbnailObserver() {
    if (shapeLibraryThumbnailObserver) return shapeLibraryThumbnailObserver;
    shapeLibraryThumbnailObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            shapeLibraryThumbnailObserver.unobserve(entry.target);
            enqueueShapeLibraryThumbnail(entry.target.dataset.shapeId);
        });
    }, { root: $('#shapeLibraryResults'), rootMargin: '200px 0px' });
    return shapeLibraryThumbnailObserver;
}

let componentLibraryEntries = null;
let componentLibraryDomains = new Set();
let componentLibraryType = 'all';
let componentLibraryPlacementCount = 0;
let pendingBidirectionalTemplate = null;

function renderComponentLibraryItem(template) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'componentLibraryItem';
    button.dataset.templateId = template.id;
    button.title = template.description ?? '';
    button.innerHTML = `<span class="componentLibrarySwatch" style="background:${escapeHtml(template.color ?? '#42c9bc')}"></span><span><b>${escapeHtml(template.name)}</b><small>${template.kind === 'node' ? 'Node' : 'Edge'} · ${escapeHtml(template.domains.map(domainLabel).join(', '))}</small></span>`;
    button.addEventListener('click', () => applyComponentTemplate(template));
    return button;
}

function renderComponentLibraryResults() {
    const query = $('#componentLibrarySearch').value.trim().toLowerCase();
    const matches = componentLibraryEntries.filter((template) => {
        if (componentLibraryType !== 'all' && template.kind !== componentLibraryType) return false;
        if (componentLibraryDomains.size && !template.domains.some((domain) => componentLibraryDomains.has(domain))) return false;
        if (!query) return true;
        const haystack = [template.name, template.description ?? '', ...template.domains].join(' ').toLowerCase();
        return haystack.includes(query);
    });
    const container = $('#componentLibraryResults');
    if (query || componentLibraryDomains.size) {
        container.replaceChildren(...matches.map(renderComponentLibraryItem));
    } else {
        const domains = [...new Set(componentLibraryEntries.flatMap((template) => template.domains))].sort();
        container.replaceChildren(...domains.map((domain) => {
            const items = matches.filter((template) => template.domains.includes(domain));
            if (!items.length) return null;
            const section = document.createElement('div');
            section.className = 'componentLibrarySection';
            section.innerHTML = `<h3>${escapeHtml(domainLabel(domain))}</h3>`;
            items.forEach((template) => section.appendChild(renderComponentLibraryItem(template)));
            return section;
        }).filter(Boolean));
    }
    $('#componentLibraryEmpty').hidden = matches.length > 0;
}

function renderComponentLibraryChips() {
    const types = [['all', 'All'], ['node', 'Nodes'], ['edge', 'Edges']];
    $('#componentLibraryTypeChips').replaceChildren(...types.map(([type, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.classList.toggle('active', type === componentLibraryType);
        button.addEventListener('click', () => {
            componentLibraryType = type;
            $$('#componentLibraryTypeChips button').forEach((chip) => chip.classList.toggle('active', chip === button));
            renderComponentLibraryResults();
        });
        return button;
    }));
    const domains = [...new Set(componentLibraryEntries.flatMap((template) => template.domains))].sort();
    $('#componentLibraryDomainChips').replaceChildren(...domains.map((domain) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = domainLabel(domain);
        button.classList.toggle('active', componentLibraryDomains.has(domain));
        button.addEventListener('click', () => {
            if (componentLibraryDomains.has(domain)) componentLibraryDomains.delete(domain);
            else componentLibraryDomains.add(domain);
            button.classList.toggle('active', componentLibraryDomains.has(domain));
            renderComponentLibraryResults();
        });
        return button;
    }));
}

async function openComponentLibraryPanel() {
    componentLibraryEntries = await window.componentLibrary.list();
    componentLibraryDomains = new Set();
    componentLibraryType = 'all';
    $('#componentLibrarySearch').value = '';
    renderComponentLibraryChips();
    renderComponentLibraryResults();
    $('#componentLibraryPanel').hidden = false;
    $('#componentLibraryButton').classList.add('active');
    $('#componentLibraryButton').ariaExpanded = 'true';
}

function closeComponentLibraryPanel() {
    $('#componentLibraryPanel').hidden = true;
    $('#componentLibraryButton').classList.remove('active');
    $('#componentLibraryButton').ariaExpanded = 'false';
}

// Places the new node with a small, deterministic per-application offset so repeated placements
// from the sidebar don't stack exactly on top of one another -- there is no drag-to-position
// interaction yet (see docs/proposals/componentLibrary.md), so this mirrors "Add node"'s own
// fixed-position default as closely as possible while staying usable for several placements in a row.
function applyNodeTemplate(template) {
    const id = allocateModelEntityId();
    const resolvedStates = template.states.map((state) => ({
        id: allocateModelEntityId(),
        label: state.label,
        symbol: state.symbol,
        initialValue: state.initialValue,
        unit: state.unit ?? '',
        value: `${state.initialValue}${state.unit ? ` ${state.unit}` : ''}`
    }));
    componentLibraryPlacementCount += 1;
    const definition = {
        id,
        title: template.name,
        type: 'Custom node',
        shape: template.shape ?? 'box',
        importedGeometry: null,
        geometryFileName: null,
        // X is deliberately biased toward positive and cascaded, not plane-matched: the component
        // library sidebar docks over the left side of the canvas while it's open, so placing new
        // nodes there would put them behind it on screen, and successive drops need to not land
        // exactly on top of each other. Y/Z still follow whatever plane the rest of the model is
        // already in, the same as the "Add node" builder.
        position: [
            1.5 + ((componentLibraryPlacementCount - 1) % 5) * 1.6,
            sharedVisibleNodeAxisValue(1) ?? -0.7,
            sharedVisibleNodeAxisValue(2) ?? 0
        ],
        subsystemId: activeSubsystemId,
        deleted: false,
        enabled: true,
        color: Number.parseInt((template.color ?? '#34727a').replace('#', ''), 16),
        states: resolvedStates,
        sourceTerms: [],
        substepsPerGlobalStep: 1
    };
    // Built against `definition` after its states are resolved, via the same function the node
    // editor's own source term UI uses -- a self-referencing coupling (e.g. displacement's rate
    // equals velocity) needs no cross-node binding, just a symbol match against this node's own states.
    definition.sourceTerms = (template.sourceTerms ?? []).map((term) => {
        const built = { id: allocateModelEntityId(), state: term.state, expression: term.expression };
        built.expressionModel = normalizeSourceTermExpressionModel(definition, built);
        built.expression = built.expressionModel.latex;
        return built;
    });
    hideCards();
    model.nodes.push(definition);
    createNode(definition);
    updateModelStatus();
    selectNode(nodeObjects.get(id));
    recordHistory({
        undo: () => setNodeVisibility(id, false),
        redo: () => setNodeVisibility(id, true)
    });
}

// Arms the existing endpoint-pick flow for both endpoints in sequence (no node needs to be
// pre-selected), pre-loading the builder with the template's equation and parameters first. Binding
// is automatic: the latex already references role-prefixed state symbols (e.g. sourceTemperature),
// so reconcileEquationBindings/normalizeEdgeEquationModel resolve it exactly like a hand-typed
// equation would -- a state named differently just leaves that symbol unresolved, which the builder's
// own live diagnostics and the model validator already surface, with no separate binding step to build.
function applyEdgeTemplate(template) {
    openEdgeBuilder();
    $('#newEdgeName').value = template.name;
    if (template.color) $('#newEdgeColor').value = template.color;
    $('#edgeParameterRows').replaceChildren();
    (template.parameters ?? []).forEach((parameter) => addEdgeParameterRow(parameter));
    $('#edgeEquation').value = template.latex;
    $('#edgeMathField').setValue(template.latex, { silenceNotifications: true });
    renderBuilderEquationDiagnostics();
    const hint = $('#componentLibraryHint');
    const portList = (port) => [port].flat().map((symbol) => `"${symbol}"`).join('/');
    hint.textContent = `Pick a source and target node for "${template.name}". States named ${portList(template.ports.source)} (source) and ${portList(template.ports.target)} (target) bind automatically; anything else is left for you to fix afterward.`;
    hint.hidden = false;
    startEndpointPick('source');
    endpointPickContinuation = () => {
        startEndpointPick('target');
        endpointPickContinuation = () => {
            hint.hidden = true;
            // Most templates are happy with the builder's own default output (the target's first
            // state), but one whose relevant state isn't the target's first -- e.g. a rod's
            // correction lands on velocity while position is declared first -- names it explicitly
            // instead. Required on every template (see validateComponentTemplate), since that
            // default is not reliable across a chained two-endpoint pick to begin with.
            const roleNode = model.nodes.find((node) => node.id === Number($(`#edge${template.output.role[0].toUpperCase()}${template.output.role.slice(1)}`).value));
            const state = roleNode?.states.find((candidate) => candidate.symbol === template.output.state);
            const option = state && [...$('#edgeEquationOutput').options].find((candidate) => candidate.value === `${template.output.role}:${state.id}`);
            if (option) $('#edgeEquationOutput').value = option.value;
            if (template.bidirectional) pendingBidirectionalTemplate = template;
        };
    };
}

function applyComponentTemplate(template) {
    if (activeResult) return;
    if (template.kind === 'node') applyNodeTemplate(template);
    else applyEdgeTemplate(template);
}

$('#componentLibraryButton').addEventListener('click', () => {
    if ($('#componentLibraryPanel').hidden) openComponentLibraryPanel();
    else closeComponentLibraryPanel();
});
$('#closeComponentLibraryPanel').addEventListener('click', closeComponentLibraryPanel);
$('#componentLibrarySearch').addEventListener('input', renderComponentLibraryResults);

function stateVariablesFromBuilder() {
    return $$('.stateVariableRow').map((row) => ({
        name: $('[data-field="name"]', row).value.trim(),
        symbol: $('[data-field="symbol"]', row).value.trim(),
        value: $('[data-field="value"]', row).value,
        unit: $('[data-field="unit"]', row).value.trim()
    })).filter((state) => state.name && state.symbol);
}

function refreshSourceStateOptions() {
    const states = stateVariablesFromBuilder();
    $$('.sourceState').forEach((select) => {
        const selected = select.value;
        select.replaceChildren(...states.map((state) => new Option(`${state.name} (${state.symbol})`, state.symbol)));
        if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    });
    $$('#sourceTermRows .providerBindingRow [data-field="reference"]').forEach((select) => {
        const selected = select.value;
        select.replaceChildren(...states.map((state) => new Option(state.symbol, `state:${state.symbol}`)));
        if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    });
}

function addSourceTermRow() {
    const row = document.createElement('div');
    row.className = 'builderRow sourceTermRow';
    row.innerHTML = `
        <select class="sourceState" aria-label="Updated state"></select>
        <select class="sourceTermKind" aria-label="Implementation">
            <option value="equation">Equation</option>
            <option value="cpp">C++ program</option>
            <option value="python">Python program</option>
        </select>
        <input class="sourceExpression" placeholder="Source expression, e.g. qDot / heatCapacity">
        <button class="removeBuilderRow" type="button" title="Remove">×</button>
        <div class="sourceTermProviderFields" hidden>
            <textarea class="sourceTermProviderSource" rows="8" spellcheck="false" placeholder="#include &lt;konjugate/relationshipProvider.hpp&gt;…"></textarea>
            <div class="templateButtonGroup">
                <button type="button" class="openSourceTermProviderEditor templateButton">Open code editor</button>
                <button type="button" class="insertSourceTermTemplate templateButton" hidden>Reset template</button>
            </div>
            <div class="sourceTermProviderBindingRows"></div>
            <button type="button" class="addSourceTermBinding templateButton">＋ Add binding</button>
            <label class="editorField"><span>Output key</span><input class="sourceTermProviderOutputKey" placeholder="e.g. rateGradient"></label>
        </div>
    `;
    $('#sourceTermRows').appendChild(row);
    refreshSourceStateOptions();

    const kindSelect = $('.sourceTermKind', row);
    const expressionInput = $('.sourceExpression', row);
    const providerFields = $('.sourceTermProviderFields', row);
    const providerSource = $('.sourceTermProviderSource', row);
    const resetTemplateButton = $('.insertSourceTermTemplate', row);
    const outputKeyInput = $('.sourceTermProviderOutputKey', row);

    const bindingCandidates = () => stateVariablesFromBuilder().map((state) => ({ symbol: state.symbol, label: state.symbol }));
    const refreshBindingRowOptions = () => {
        const candidates = bindingCandidates();
        $$('.providerBindingRow', providerFields).forEach((bindingRow) => {
            const select = $('[data-field="reference"]', bindingRow);
            const previous = select.value;
            select.replaceChildren(...candidates.map((candidate) => new Option(candidate.label, `state:${candidate.symbol}`)));
            if ([...select.options].some((option) => option.value === previous)) select.value = previous;
        });
    };
    const currentBindingKeys = () => $$('.providerBindingRow [data-field="key"]', providerFields).map((input) => ({ key: input.value }));
    const regenerateTemplate = () => {
        providerSource.value = defaultProviderSource(kindSelect.value, currentBindingKeys(), outputKeyInput.value, $('#newNodeName').value);
        resetTemplateButton.hidden = !providerSource.value.trim();
    };
    const addBindingRow = () => {
        const bindingRow = document.createElement('div');
        bindingRow.className = 'providerBindingRow';
        bindingRow.innerHTML = `
            <label class="parameterField"><span>Key</span><input data-field="key"></label>
            <label class="parameterField"><span>Reference</span><select data-field="reference"></select></label>
            <button type="button" title="Remove binding">×</button>
        `;
        $('.sourceTermProviderBindingRows', providerFields).appendChild(bindingRow);
        refreshBindingRowOptions();
        bindingRow.querySelector('button').addEventListener('click', () => bindingRow.remove());
    };

    kindSelect.addEventListener('change', () => {
        const isEquation = kindSelect.value === 'equation';
        expressionInput.hidden = !isEquation;
        providerFields.hidden = isEquation;
        if (!isEquation && !providerSource.value.trim()) regenerateTemplate();
    });
    resetTemplateButton.addEventListener('click', () => {
        if (providerSource.value.trim() && !window.confirm('Replace the current provider source with a freshly generated template?')) return;
        regenerateTemplate();
    });
    providerSource.addEventListener('input', () => { resetTemplateButton.hidden = !providerSource.value.trim(); });
    $('.addSourceTermBinding', row).addEventListener('click', addBindingRow);
    $('.openSourceTermProviderEditor', row).addEventListener('click', () => {
        providerEditTarget = { type: 'builderSourceTerm', sourceElement: providerSource };
        window.providerEditor.openWindow({ source: providerSource.value, kind: kindSelect.value, title: $('#newNodeName').value });
    });

    row.querySelector('.removeBuilderRow').addEventListener('click', () => { row.remove(); refreshSourceStateOptions(); });
}

function addEdgeParameterRow(values = {}) {
    const control = normalizedParameterControl({ value: Number(values.value) || 0, control: values.control });
    const row = document.createElement('div');
    row.className = 'builderRow parameterRow';
    row.innerHTML = `
        <label class="parameterField"><span>Name</span><input data-field="name" value="${values.name ?? ''}"></label>
        <label class="parameterField"><span>Symbol</span><input data-field="symbol" value="${values.symbol ?? ''}"></label>
        <label class="parameterField"><span>Initial value</span><input data-field="value" type="number" value="${values.value ?? ''}"></label>
        <label class="parameterField"><span>Unit</span><input data-field="unit" value="${values.unit ?? ''}"></label>
        <label class="parameterField"><span>Mode</span><select data-field="mode"><option value="constant">Constant</option><option value="live">Live</option></select></label>
        <button class="removeBuilderRow" type="button" title="Remove">×</button>
        <div class="parameterControlFields" ${values.mode === 'live' ? '' : 'hidden'}>
            <label class="parameterField"><span>Slider minimum</span><input data-control-field="minimum" type="number" value="${control.minimum}"></label>
            <label class="parameterField"><span>Slider maximum</span><input data-control-field="maximum" type="number" value="${control.maximum}"></label>
            <label class="parameterField"><span>Slider step</span><input data-control-field="step" type="number" min="0" value="${control.step}"></label>
            <span class="parameterControlError" role="status"></span>
        </div>
    `;
    $('[data-field="mode"]', row).value = values.mode ?? 'constant';
    $('#edgeParameterRows').appendChild(row);
    const validateControl = () => {
        $('.parameterControlFields', row).hidden = $('[data-field="mode"]', row).value !== 'live';
        const controlValues = Object.fromEntries($$('[data-control-field]', row)
            .map((input) => [input.dataset.controlField, Number(input.value)]));
        const error = $('[data-field="mode"]', row).value === 'live'
            ? parameterControlError(Number($('[data-field="value"]', row).value), controlValues) : '';
        $('.parameterControlError', row).textContent = error;
        return error;
    };
    $$('input, select', row).forEach((input) => input.addEventListener('input', () => {
        validateControl();
        refreshStateReferences();
    }));
    row.querySelector('.removeBuilderRow').addEventListener('click', () => {
        row.remove();
        refreshStateReferences();
    });
    refreshStateReferences();
}

function refreshEndpointOptions() {
    const nodeOptions = model.nodes
        .filter((node) => nodeObjects.get(node.id)?.visible !== false)
        .map((node) => new Option(node.title, node.id));
    const source = $('#edgeSource');
    const target = $('#edgeTarget');
    const previousSource = source.value;
    const previousTarget = target.value;
    source.replaceChildren(new Option('Choose a node…', ''), ...nodeOptions.map((option) => option.cloneNode(true)));
    target.replaceChildren(new Option('Choose a node…', ''), ...nodeOptions.map((option) => option.cloneNode(true)));
    if (model.nodes.some((node) => node.id === Number(previousSource))) source.value = previousSource;
    if (model.nodes.some((node) => node.id === Number(previousTarget))) target.value = previousTarget;
    refreshStateReferences();
}

function finishEndpointPick() {
    activeEndpointPick = null;
    endpointPickContinuation = null;
    $('#componentLibraryHint').hidden = true;
    canvas.classList.remove('pickingEndpoint');
    $('#endpointPickBanner').hidden = true;
    $$('[data-pick-endpoint]').forEach((button) => button.classList.remove('active'));
    $$('.node-label-container').forEach((label) => label.classList.remove('endpointEligible'));
    endpointPickMaterialState.forEach((state, nodeId) => {
        const material = nodeObjects.get(nodeId)?.material;
        if (!material) return;
        material.emissive.copy(state.emissive);
        material.emissiveIntensity = state.emissiveIntensity;
        material.opacity = state.opacity;
        material.transparent = state.transparent;
        material.needsUpdate = true;
    });
    endpointPickMaterialState = new Map();
    dragControls.enabled = !activeResult && currentTool === 'select';
    $('.edgeBuilder > header strong').textContent = 'Connect stateful nodes';
    if (endpointPickRestoreCard?.isConnected) endpointPickRestoreCard.classList.remove('hidden');
    endpointPickRestoreCard = null;
}

function chooseEndpointNode(nodeId) {
    if (!activeEndpointPick) return;
    const otherEndpoint = Number(activeEndpointPick === 'source' ? $('#edgeTarget').value : $('#edgeSource').value);
    if (nodeId === otherEndpoint) return;
    $(`#edge${activeEndpointPick[0].toUpperCase()}${activeEndpointPick.slice(1)}`).value = nodeId;
    refreshStateReferences();
    const continuation = endpointPickContinuation;
    endpointPickContinuation = null;
    finishEndpointPick();
    continuation?.();
}

function startEndpointPick(endpoint) {
    finishEndpointPick();
    activeEndpointPick = endpoint;
    dragControls.enabled = false;
    canvas.classList.add('pickingEndpoint');
    const button = $(`[data-pick-endpoint="${endpoint}"]`);
    button.classList.add('active');
    const otherEndpoint = Number(endpoint === 'source' ? $('#edgeTarget').value : $('#edgeSource').value);
    const eligibleIds = new Set(eligibleEndpointIds(
        model.nodes,
        otherEndpoint,
        (node) => nodeObjects.get(node.id)?.visible !== false
    ));
    nodeObjects.forEach((node, nodeId) => {
        endpointPickMaterialState.set(nodeId, {
            emissive: node.material.emissive.clone(),
            emissiveIntensity: node.material.emissiveIntensity,
            opacity: node.material.opacity,
            transparent: node.material.transparent
        });
        const eligible = eligibleIds.has(nodeId);
        node.material.emissive.setHex(eligible ? 0x174d49 : 0x000000);
        node.material.emissiveIntensity = eligible ? 0.85 : 0;
        node.material.opacity = eligible ? 1 : 0.28;
        node.material.transparent = !eligible;
        node.material.needsUpdate = true;
        node.children.find((child) => child.isCSS2DObject)?.element.classList.toggle('endpointEligible', eligible);
    });
    endpointPickRestoreCard = $('#edgeBuilder').classList.contains('hidden') ? null : $('#edgeBuilder');
    endpointPickRestoreCard?.classList.add('hidden');
    const endpointLabel = endpoint === 'source' ? 'source' : 'target';
    $('#endpointPickTitle').textContent = `Choose the ${endpointLabel} node`;
    $('#endpointPickHint').textContent = eligibleIds.size
        ? 'Select a highlighted node on the canvas'
        : 'No eligible nodes are available';
    $('#endpointPickBanner').hidden = false;
}

function refreshStateReferences() {
    const container = $('#stateReferenceChips');
    container.replaceChildren();
    const sourceNode = model.nodes.find((node) => node.id === Number($('#edgeSource').value));
    const targetNode = model.nodes.find((node) => node.id === Number($('#edgeTarget').value));
    const parameters = $$('.parameterRow').map((row, index) => ({
        id: `builderParameter${index}`,
        symbol: $('[data-field="symbol"]', row).value.trim()
    })).filter((parameter) => modelSymbolPattern.test(parameter.symbol));
    const bindings = reconcileEquationBindings([], sourceNode, targetNode, parameters);
    bindings.forEach((binding) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = binding.label;
        button.addEventListener('click', () => insertBuilderEquationBinding(binding));
        container.appendChild(button);
    });
    const output = $('#edgeEquationOutput');
    const selectedOutput = output.value;
    output.replaceChildren();
    for (const [role, node] of [['source', sourceNode], ['target', targetNode]]) {
        node?.states.forEach((state) => output.add(new Option(`${role}.${state.symbol}`, `${role}:${state.id}`)));
    }
    if ([...output.options].some((option) => option.value === selectedOutput)) output.value = selectedOutput;
    else if (targetNode?.states[0]) output.value = `target:${targetNode.states[0].id}`;
    renderBuilderEquationDiagnostics(bindings);
    refreshProviderBindingRowOptions(bindings);
}

function refreshProviderBindingRowOptions(candidates) {
    $$('#providerBindingRows .providerBindingRow').forEach((row) => {
        const select = $('[data-field="reference"]', row);
        const previous = select.value;
        select.replaceChildren(...candidates.map((candidate) => new Option(candidate.label, providerReferenceValue(candidate))));
        if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    });
}

function addProviderBindingRow(values = {}) {
    const row = document.createElement('div');
    row.className = 'builderRow providerBindingRow';
    row.innerHTML = `
        <label class="parameterField"><span>Key</span><input data-field="key" value="${escapeHtml(values.key ?? '')}"></label>
        <label class="parameterField"><span>Reference</span><select data-field="reference"></select></label>
        <button class="removeBuilderRow" type="button" title="Remove binding">×</button>
    `;
    $('#providerBindingRows').appendChild(row);
    const sourceNode = model.nodes.find((node) => node.id === Number($('#edgeSource').value));
    const targetNode = model.nodes.find((node) => node.id === Number($('#edgeTarget').value));
    const parameters = $$('.parameterRow').map((parameterRow, index) => ({
        id: `builderParameter${index}`,
        symbol: $('[data-field="symbol"]', parameterRow).value.trim()
    })).filter((parameter) => modelSymbolPattern.test(parameter.symbol));
    const candidates = reconcileEquationBindings([], sourceNode, targetNode, parameters);
    refreshProviderBindingRowOptions(candidates);
    if (values.referenceValue) $('[data-field="reference"]', row).value = values.referenceValue;
    row.querySelector('.removeBuilderRow').addEventListener('click', () => row.remove());
}

function renderBuilderEquationDiagnostics(bindings = null) {
    const availableBindings = bindings ?? (() => {
        const sourceNode = model.nodes.find((node) => node.id === Number($('#edgeSource').value));
        const targetNode = model.nodes.find((node) => node.id === Number($('#edgeTarget').value));
        const parameters = $$('.parameterRow').map((row, index) => ({
            id: `builderParameter${index}`,
            symbol: $('[data-field="symbol"]', row).value.trim()
        })).filter((parameter) => modelSymbolPattern.test(parameter.symbol));
        return reconcileEquationBindings([], sourceNode, targetNode, parameters);
    })();
    const validation = validateEquationLatex($('#edgeMathField').value, availableBindings);
    const diagnostics = $('#builderEquationDiagnostics');
    diagnostics.classList.toggle('valid', validation.valid);
    diagnostics.textContent = validation.valid ? 'Valid expression · MathJSON ready' : validation.errors.join(' ');
}

function insertBuilderEquationBinding(binding) {
    const latex = latexForBinding(binding);
    if ($('#edgeMathField').hidden) {
        const source = $('#edgeEquation');
        source.setRangeText(latex, source.selectionStart, source.selectionEnd, 'end');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        source.focus();
    } else {
        $('#edgeMathField').insert(latex);
        $('#edgeMathField').focus();
    }
}

function updateModelStatus() {
    const status = $$('.modelStatus span');
    const visibleNodes = model.nodes.filter((node) => !node.deleted).length;
    const visibleRelationships = model.relationships.filter((relationship) => !relationship.deleted).length;
    status[0].textContent = `${visibleNodes} nodes`;
    status[1].textContent = `${visibleRelationships} relationships`;
    status[2].textContent = `${model.metadata.units} units`;
    syncContextualOverlays();
    updateValidationStatus();
}

function navigateToValidationIssue(item) {
    $('#validationPanel').hidden = true;
    $('#validationSummary').ariaExpanded = 'false';
    if (item.location.kind === 'node') {
        const node = nodeObjects.get(Number(item.location.entityId));
        if (!node) return;
        selectNode(node);
        openNodeEditor(node.userData.definition);
        const field = { name: '#editNodeName', states: '#nodeEditorStates input', sourceTerms: '#nodeEditorSourceTerms input' }[item.location.field];
        if (field) requestAnimationFrame(() => $(field)?.focus());
    } else if (item.location.kind === 'edge') {
        const relationship = model.relationships.find((candidate) => candidate.id === Number(item.location.entityId));
        if (!relationship) return;
        openRelationshipEditor(relationship);
        const field = { source: '#editEdgeSource', target: '#editEdgeTarget', equation: '#editEdgeMathField', output: '#editEquationOutput', parameters: '#edgeEditorParameters input' }[item.location.field];
        if (field) requestAnimationFrame(() => $(field)?.focus());
    }
}

function updateValidationStatus() {
    scheduleEngineValidation();
}

function scheduleEngineValidation(projectDocument = null) {
    const revision = ++validationRevision;
    clearTimeout(engineValidationTimer);
    renderValidationPending();
    engineValidationTimer = setTimeout(async () => {
        try {
            const result = await window.engine.validate(JSON.stringify(stripEdgeGroups(executionProjectDocument(projectDocument ?? serializeProjectDocument()))));
            if (revision !== validationRevision) return;
            if (!result.available) {
                renderValidationFailure('The C++ validation engine is unavailable. Build the engine before editing or running models.');
                return;
            }
            currentValidation = {
                valid: result.report.valid,
                issues: result.report.issues,
                executableModel: null
            };
            $('#validationSummary').dataset.validationSource = 'engine';
            renderValidationStatus();
        } catch (error) {
            if (revision !== validationRevision) return;
            console.error('C++ model validation failed.', error);
            renderValidationFailure(`The C++ validation engine failed: ${error.message}`);
        }
    }, 180);
}

function renderValidationPending() {
    const summary = $('#validationSummary');
    delete summary.dataset.validationSource;
    summary.classList.remove('error', 'warning');
    summary.classList.add('pending');
    $('#statusText').textContent = 'Validating…';
    $('#runButton').disabled = true;
    $('#runButton').title = 'Wait for model validation to finish';
    $('#validationPanelTitle').textContent = 'Validating…';
    $('#validationIssues').innerHTML = '<p class="validationEmpty">The C++ engine is validating this model.</p>';
}

function renderValidationFailure(message) {
    currentValidation = {
        valid: false,
        issues: [{
            code: 'validationEngineUnavailable',
            severity: 'error',
            message,
            location: { kind: 'model', entityId: '', field: '' }
        }],
        executableModel: null
    };
    $('#validationSummary').dataset.validationSource = 'engineError';
    renderValidationStatus();
}

function renderValidationStatus() {
    const errors = currentValidation.issues.filter((item) => item.severity === 'error').length;
    const warnings = currentValidation.issues.filter((item) => item.severity === 'warning').length;
    const summary = $('#validationSummary');
    summary.classList.remove('pending');
    summary.classList.toggle('error', errors > 0);
    summary.classList.toggle('warning', !errors && warnings > 0);
    $('#statusText').textContent = errors ? `${errors} model ${errors === 1 ? 'error' : 'errors'}`
        : warnings ? `${warnings} model ${warnings === 1 ? 'warning' : 'warnings'}` : 'Model valid';
    $('#runButton').disabled = Boolean(activeResult) || errors > 0 || simulationRunning;
    $('#runButton').title = errors ? 'Resolve model errors before running' : 'Run simulation';

    const severityByEntity = new Map();
    currentValidation.issues.forEach((item) => {
        const entityId = Number(item.location.entityId);
        if (!validModelEntityId(entityId)) return;
        const previous = severityByEntity.get(entityId);
        if (!previous || item.severity === 'error') severityByEntity.set(entityId, item.severity);
    });
    nodeObjects.forEach((node, id) => {
        const label = node.children.find((child) => child.isCSS2DObject)?.element;
        label?.classList.toggle('validationError', severityByEntity.get(id) === 'error');
        label?.classList.toggle('validationWarning', severityByEntity.get(id) === 'warning');
    });
    relationshipObjects.forEach((relationship, id) => {
        relationship.line.userData.validationSeverity = severityByEntity.get(id) ?? null;
    });
    relationshipBundleObjects.forEach((overlay, key) => {
        const bundle = activeRelationshipBundles().find((candidate) => candidate.key === key);
        const severities = bundle?.relationships.map((item) => severityByEntity.get(item.id)).filter(Boolean) ?? [];
        overlay.element.classList.toggle('validationError', severities.includes('error'));
        overlay.element.classList.toggle('validationWarning', !severities.includes('error') && severities.includes('warning'));
    });
    updateRelationshipSelection();

    $('#validationPanelTitle').textContent = currentValidation.issues.length
        ? `${errors} errors · ${warnings} warnings` : 'No issues';
    const container = $('#validationIssues');
    container.replaceChildren();
    if (!currentValidation.issues.length) container.innerHTML = '<p class="validationEmpty">This model is structurally valid and ready for a simulation runtime.</p>';
    currentValidation.issues.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `validationIssue ${item.severity}`;
        button.innerHTML = `<i></i><span><strong>${escapeHtml(item.message)}</strong><small>${escapeHtml(item.location.kind)}${item.location.field ? ` · ${escapeHtml(item.location.field)}` : ''}</small></span>`;
        button.addEventListener('click', () => navigateToValidationIssue(item));
        container.appendChild(button);
    });
}

function formatResultTime(time) {
    return `${Number(time).toLocaleString(undefined, { maximumSignificantDigits: 6 })} s`;
}

function updateResultExtent() {
    if (!activeResult) return;
    const targetTime = Number(activeResult.targetTime);
    const availableTime = Number(activeResult.availableResultTime);
    const extent = Math.max(targetTime, availableTime, activeResult.samples.at(-1)?.time ?? 0, Number.EPSILON);
    $('#resultTimeline').max = String(extent);
    $('#resultTimeline').style.setProperty('--available-progress', `${100 * Math.min(availableTime, extent) / extent}%`);
    $('#resultExtent').value = `available ${formatResultTime(availableTime)} · target ${formatResultTime(targetTime)}`;
    $('#simulationProgress').value = `${formatResultTime(availableTime)} / ${formatResultTime(targetTime)}`;
}

function updateDisplayedState(stateId, numericValue) {
    const node = model.nodes.find((candidate) => candidate.states.some((state) => state.id === stateId));
    const state = node?.states.find((candidate) => candidate.id === stateId);
    if (!state) return;
    state.value = `${Number(numericValue).toPrecision(6)}${state.unit ? ` ${state.unit}` : ''}`;
    const label = $(`.node-label-container[data-node="${node.id}"]`);
    const value = $$('dd', label)[node.states.indexOf(state)];
    if (value) value.textContent = state.value;
}

function projectResultSample(index) {
    if (!activeResult?.samples.length) return;
    activeResultSampleIndex = Math.max(0, Math.min(index, activeResult.samples.length - 1));
    projectResultSampleValue(activeResult.samples[activeResultSampleIndex]);
}

function projectResultSampleValue(sample) {
    if (!sample) return;
    sample.states.forEach((state) => updateDisplayedState(state.stateId, state.value));
    $('#resultTimeline').value = String(sample.time);
    $('#resultCurrentTime').value = formatResultTime(sample.time);
    $('#statusText').textContent = `Result · ${formatResultTime(sample.time)}`;
    nodeResultPlot.setCursor(sample.time);
    window.addons.publishEvent('timeline.change', sample.time);
}

function stopResultPlayback() {
    clearTimeout(resultPlaybackTimer);
    resultPlaybackTimer = null;
    resultPlaying = false;
    $('#resultPlayPause').textContent = '▶';
    $('#resultPlayPause').ariaLabel = 'Play results';
}

function scheduleResultPlayback() {
    if (!resultPlaying || !activeResult) return;
    const rate = Number($('#resultPlaybackRate').value) || 1;
    const finalTime = Number(activeResult.samples.at(-1).time);
    resultPlaybackTimer = setTimeout(async () => {
        const elapsed = (performance.now() - resultPlaybackStartedAt) / 1000;
        const targetTime = Math.min(finalTime, resultPlaybackStartedFrom + elapsed * rate);
        const reachedEnd = targetTime >= finalTime;
        const projectedIndex = nearestSampleIndex(activeResult.samples, targetTime);
        activeResultSampleIndex = projectedIndex;
        const fullResolutionSample = activeEngineJobId && activeResult.sampleCount > activeResult.samples.length
            ? await window.engine.readResultSample(activeEngineJobId, targetTime) : null;
        if (!resultPlaying) return;
        projectResultSampleValue(fullResolutionSample ?? activeResult.samples[projectedIndex]);
        if (reachedEnd) stopResultPlayback();
        else scheduleResultPlayback();
    }, preferredPlaybackFrameMilliseconds);
}

function selectSuggestedPlaybackRate() {
    const selector = $('#resultPlaybackRate');
    selector.querySelector('[data-suggested]')?.remove();
    const samples = activeResult?.samples ?? [];
    const duration = samples.length > 1 ? Number(samples.at(-1).time) - Number(samples[0].time) : 0;
    const rate = suggestedPlaybackRate(duration);
    let option = [...selector.options].find((candidate) => Number(candidate.value) === rate);
    if (!option) {
        option = document.createElement('option');
        option.value = String(rate);
        option.dataset.suggested = '';
        option.textContent = `${rate.toLocaleString()}× · fit`;
        selector.appendChild(option);
    }
    selector.value = option.value;
}

function applyInspectorReadOnly() {
    const locked = Boolean(activeResult);
    $$('[data-result-readonly]').forEach((notice) => { notice.hidden = !locked; });
    $$('#nodeEditor [data-node-panel]:not([data-node-panel="results"]) :is(input, select, textarea, button), #nodeEditor > footer button, #edgeEditor section :is(input, select, textarea, button), #edgeEditor > footer button, #edgeGroupEditor section :is(input, select, textarea, button), #edgeGroupEditor > footer button').forEach((control) => {
        control.disabled = locked;
    });
    $$('#nodeEditor math-field, #edgeEditor math-field, #edgeGroupEditor math-field').forEach((field) => {
        field.readOnly = locked;
        field.toggleAttribute('read-only', locked);
    });
}

function setResultModeLocked(locked) {
    canvas.classList.toggle('resultModeLocked', locked);
    $('#addButton').disabled = locked;
    $('#componentLibraryButton').disabled = locked;
    if (locked) closeComponentLibraryPanel();
    $('#assistantButton').disabled = locked;
    $('[data-action="delete"]').disabled = locked;
    $('[data-tool="move"]').disabled = locked;
    $('[data-tool="rotate"]').disabled = locked;
    $('[data-tool="scale"]').disabled = locked;
    $('#runConfigurationButton').disabled = locked;
    $('#runButton').disabled = locked || simulationRunning || !currentValidation.valid;
    $('#exportCsvButton').disabled = !locked;
    transformControls.detach();
    if (locked) {
        discardAssistantProposal();
        hideAssistantPanel();
        $$('.toolstrip [data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === 'select'));
        setTool('select');
    } else if (toolBeforeResult) {
        const restoredTool = toolBeforeResult;
        toolBeforeResult = null;
        $$('.toolstrip [data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === restoredTool));
        setTool(restoredTool);
    }
    $('#nodeModelActions').hidden = locked || !$('[data-node-tab="model"]').classList.contains('active');
    applyInspectorReadOnly();
    updateHistoryControls();
    refreshAddonToolstripContributions();
}

function activateResult(result) {
    stopResultPlayback();
    if (!activeResult) nodeDetailsBeforeResult = $('[data-detail="nodes"]').classList.contains('active');
    if (!activeResult) toolBeforeResult = currentTool;
    activeResult = result;
    setResultModeLocked(true);
    setLabelDetail('nodes', true);
    $('#resultTransport').hidden = false;
    updateLiveResultControls();
    updateResultExtent();
    projectResultSample(result.samples.length - 1);
    if (selectedNode && !$('#nodeEditor').classList.contains('hidden')) selectNodeEditorTab('results');
}

function formatExecutionDuration(nanoseconds) {
    const milliseconds = Number(nanoseconds || 0) / 1e6;
    return milliseconds < 0.01 ? `${Math.round(Number(nanoseconds || 0) / 1000)} µs` : `${milliseconds.toFixed(milliseconds < 10 ? 2 : 1)} ms`;
}

function formatExecutionBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderExecutionSummary() {
    const execution = activeResult?.execution;
    const partitionPlan = activeResult?.partitionPlan;
    const available = Boolean(execution && partitionPlan);
    $('#executionSummaryButton').hidden = !available;
    if (!available) {
        $('#executionSummaryCard').classList.add('hidden');
        $('#executionSummaryButton').ariaExpanded = 'false';
        return;
    }
    const backendNames = { serial: 'Serial', threadPool: 'Thread pool', partitioned: 'Partitioned' };
    const reasonDescriptions = {
        explicitSelection: 'This backend was selected explicitly in the run configuration.',
        singleNode: 'Serial execution was selected because the model has only one node.',
        belowParallelWorkThreshold: 'Serial execution was selected because the estimated work is below the parallel threshold.',
        independentParallelWork: 'Partitioned execution was selected because the heavy node workloads are independent.',
        partitionCutWithinLimit: 'Partitioned execution was selected because the communication cut remains within the configured limit.',
        partitionCommunicationCutTooHigh: 'The shared thread pool was selected to avoid an expensive partition communication cut.'
    };
    const backendName = backendNames[execution.backend] ?? execution.backend;
    $('#executionSummaryBackend').textContent = backendName;
    $('#executionSummaryTitle').textContent = `${backendName} · ${execution.workerThreads} worker${execution.workerThreads === 1 ? '' : 's'}`;
    $('#executionSummaryReason').textContent = reasonDescriptions[execution.selectionReason] ?? 'The engine selected this execution strategy for the current model.';
    const communication = execution.partitionCommunication ?? {};
    const selected = partitionPlan.selected ?? partitionPlan.greedy ?? {};
    const algorithmNames = { metisKway: 'METIS k-way', communicationAwareGreedy: 'Built-in greedy' };
    const fallbackNames = { metisUnavailable: 'METIS unavailable', metisPartitioningFailed: 'METIS planning failed' };
    const roundRobin = partitionPlan.roundRobin ?? {};
    const nodeComputeNanoseconds = (execution.nodeMetrics ?? []).reduce((total, item) => total + Number(item.computeNanoseconds || 0), 0);
    const metrics = [
        ['Planning', formatExecutionDuration(execution.planningNanoseconds)],
        ['Node computation', formatExecutionDuration(nodeComputeNanoseconds)],
        ['Synchronization', formatExecutionDuration(execution.synchronizationComputeNanoseconds)],
        ['Partitioner', `${algorithmNames[partitionPlan.algorithm] ?? partitionPlan.algorithm}${partitionPlan.fallbackReason
            ? ` · ${fallbackNames[partitionPlan.fallbackReason] ?? partitionPlan.fallbackReason}` : ''}`],
        ['Compute imbalance', `${Number(selected.computeImbalance || 1).toFixed(2)}×`],
        ['Communication cut', `${selected.communicationCutWeight ?? 0} · round robin ${roundRobin.communicationCutWeight ?? 0}`],
        ['Boundary messages', Number(communication.boundaryMessages || 0).toLocaleString()],
        ['Boundary payload', formatExecutionBytes(communication.boundaryPayloadBytes)],
        ['Message preparation', formatExecutionDuration(communication.messagePreparationNanoseconds)],
        ['Transport publishing', formatExecutionDuration(communication.transportPublishNanoseconds)],
        ['Partition waiting', formatExecutionDuration(communication.boundaryWaitNanoseconds)]
    ];
    const list = $('#executionSummaryMetrics');
    list.replaceChildren();
    metrics.forEach(([label, value]) => {
        const term = document.createElement('dt');
        const description = document.createElement('dd');
        term.textContent = label;
        description.textContent = value;
        list.append(term, description);
    });
}

function updateLiveResultControls() {
    const lifecycle = activeResult?.lifecycle;
    const live = simulationRunning && ['running', 'paused'].includes(lifecycle);
    const paused = lifecycle === 'paused';
    $('#resultTransport').classList.toggle('liveMode', live);
    $('#simulationProgress').hidden = !live;
    $('.resultMode b').textContent = live ? 'Simulation' : 'Results';
    $('.resultMode small').textContent = live ? `${paused ? 'Paused' : 'Running'} · model locked` : `${lifecycle === 'stopped' ? 'Stopped · ' : ''}Model locked`;
    $('#simulationExecutionControls').hidden = !live;
    $('#resultPlaybackControls').hidden = live;
    $('#simulationPauseResume').innerHTML = paused ? '<span aria-hidden="true">▶</span> Resume' : '<span aria-hidden="true">❚❚</span> Pause';
    $('#simulationPauseResume').ariaLabel = paused ? 'Resume simulation' : 'Pause simulation';
    const canContinue = ['stopped', 'completed'].includes(lifecycle) && !live && Boolean(activeResult?.checkpoints?.length);
    $('#continueRun').hidden = !canContinue;
    $('#continueRun').textContent = lifecycle === 'completed' ? 'Extend simulation' : 'Continue';
    $('#continueRun').ariaLabel = lifecycle === 'completed' ? 'Extend simulation from the final checkpoint' : 'Continue simulation from the latest checkpoint';
    $$('.reviewControl').forEach((control) => { control.hidden = live; });
    $('#resultPlaybackRate').hidden = live;
    $('#simulationPacing').hidden = !live || activeResult?.pacing?.mode === 'fastest';
    const liveParameters = model.relationships.flatMap((relationship) => (relationship.parameters ?? [])
        .filter((parameter) => parameter.mode === 'live')
        .map((parameter) => ({ relationship, parameter })));
    const hasLiveControls = live && runLaunchSettings.online && liveParameters.length > 0;
    $('#liveParameterButton').hidden = !hasLiveControls;
    $('#liveParameterCount').textContent = liveParameters.length ? String(liveParameters.length) : '';
    if (!hasLiveControls) {
        $('#liveParameterPanel').hidden = true;
        $('#liveParameterButton').ariaExpanded = 'false';
    }
    $('#closeResults').lastChild.textContent = 'Close and edit';
    if (activeResult?.pacing) {
        const { mode, simulationSecondsPerWallSecond: ratio } = activeResult.pacing;
        const value = mode === 'limitedRatio' ? `limitedRatio:${ratio}` : mode;
        if ([...$('#simulationPacing').options].some((option) => option.value === value)) $('#simulationPacing').value = value;
    }
    renderExecutionSummary();
}

$('#executionSummaryButton').addEventListener('click', () => {
    const opening = $('#executionSummaryCard').classList.contains('hidden');
    $('#executionSummaryCard').classList.toggle('hidden', !opening);
    $('#executionSummaryButton').ariaExpanded = String(opening);
});
$('#closeExecutionSummary').addEventListener('click', () => {
    $('#executionSummaryCard').classList.add('hidden');
    $('#executionSummaryButton').ariaExpanded = 'false';
});

function liveParameterRange(parameter) {
    const value = Number(parameter.value) || 0;
    const magnitude = Math.max(Math.abs(value), 1);
    const minimum = Number.isFinite(Number(parameter.control?.minimum))
        ? Number(parameter.control.minimum) : Math.min(0, value - magnitude);
    const maximum = Number.isFinite(Number(parameter.control?.maximum))
        ? Number(parameter.control.maximum) : Math.max(0, value + magnitude);
    const fallbackStep = Math.max((maximum - minimum) / 100, 0.001);
    const step = Number(parameter.control?.step) > 0 ? Number(parameter.control.step) : fallbackStep;
    return { minimum, maximum, step };
}

function scheduleLiveParameterUpdate(parameterId, value, immediate = false) {
    liveParameterValues.set(parameterId, value);
    clearTimeout(liveParameterUpdateTimers.get(parameterId));
    const apply = async () => {
        liveParameterUpdateTimers.delete(parameterId);
        if (!activeEngineJobId || !simulationRunning) return;
        try {
            await window.engine.setParameterValue(activeEngineJobId, parameterId, value);
        } catch (error) {
            $('#statusText').textContent = error.message;
        }
    };
    if (immediate) apply();
    else liveParameterUpdateTimers.set(parameterId, setTimeout(apply, 50));
}

function renderLiveParameterControls() {
    const container = $('#liveParameterRows');
    container.replaceChildren();
    model.relationships.forEach((relationship) => (relationship.parameters ?? [])
        .filter((parameter) => parameter.mode === 'live')
        .forEach((parameter) => {
            const { minimum, maximum, step } = liveParameterRange(parameter);
            const value = (liveParameterValues.get(parameter.id) ?? Number(parameter.value)) || 0;
            const row = document.createElement('div');
            row.className = 'liveParameterRow';
            row.innerHTML = `
                <div class="liveParameterLabel"><strong>${escapeHtml(parameter.name)}</strong><small>${escapeHtml(relationship.title)}${parameter.unit ? ` · ${escapeHtml(parameter.unit)}` : ''}</small></div>
                <button data-adjust="-1" type="button" aria-label="Decrease ${escapeHtml(parameter.name)}">−</button>
                <input type="range" min="${minimum}" max="${maximum}" step="${step}" value="${value}" aria-label="${escapeHtml(parameter.name)}">
                <button data-adjust="1" type="button" aria-label="Increase ${escapeHtml(parameter.name)}">+</button>
                <input type="number" step="${step}" value="${value}" aria-label="${escapeHtml(parameter.name)} value">
            `;
            const slider = $('input[type="range"]', row);
            const numberInput = $('input[type="number"]', row);
            const setValue = (nextValue, immediate = false) => {
                const normalized = Math.min(maximum, Math.max(minimum, Number(nextValue)));
                slider.value = normalized;
                numberInput.value = normalized;
                scheduleLiveParameterUpdate(parameter.id, normalized, immediate);
            };
            slider.addEventListener('input', () => setValue(slider.value));
            slider.addEventListener('change', () => setValue(slider.value, true));
            numberInput.addEventListener('change', () => setValue(numberInput.value, true));
            $$('[data-adjust]', row).forEach((button) => button.addEventListener('click', () =>
                setValue((Number(numberInput.value) || 0) + Number(button.dataset.adjust) * step, true)));
            container.appendChild(row);
        }));
}

function applyLiveResult(jobId, result) {
    if (!simulationRunning || (activeEngineJobId && jobId !== activeEngineJobId)) return;
    activeEngineJobId ??= jobId;
    const followLatest = !activeResult || activeResultSampleIndex >= activeResult.samples.length - 1;
    if (pendingRestart) {
        result = {
            ...result,
            samples: [...pendingRestart.samples, ...result.samples],
            checkpoints: [...pendingRestart.checkpoints, ...result.checkpoints]
        };
    }
    if (!activeResult || pendingRestart?.starting) {
        if (pendingRestart) pendingRestart.starting = false;
        activateResult(result);
    }
    else {
        activeResult = result;
        updateResultExtent();
        projectResultSample(followLatest ? result.samples.length - 1 : Math.min(activeResultSampleIndex, result.samples.length - 1));
        updateLiveResultControls();
    }
}

async function discardResultPlayback({ markProjectChanged = false } = {}) {
    if (!activeResult) return;
    if (simulationRunning) return;
    stopResultPlayback();
    if (activeEngineJobId) await window.engine.releaseResult(activeEngineJobId);
    window.addons.closeContext('resultSession');
    activeResult = null;
    activeEngineJobId = null;
    activeResultPersistedInProject = false;
    simulationRunning = false;
    $('#liveParameterPanel').hidden = true;
    $('#executionSummaryCard').classList.add('hidden');
    $('#executionSummaryButton').ariaExpanded = 'false';
    setResultModeLocked(false);
    nodeResultPlot.clear();
    $('.nodeResultsPanel').classList.remove('hasResults');
    $('#resultTransport').hidden = true;
    model.nodes.forEach((node) => node.states.forEach((state) => updateDisplayedState(state.id, state.initialValue)));
    if (nodeDetailsBeforeResult !== null) setLabelDetail('nodes', nodeDetailsBeforeResult);
    nodeDetailsBeforeResult = null;
    if (markProjectChanged) documentController.setSupplementalDirty(true);
    renderValidationStatus();
}

async function exportResultsCsv() {
    if (!activeResult || !activeEngineJobId) return;
    const signals = model.nodes.filter((node) => !node.deleted).flatMap((node) => node.states.map((state) => ({
        signalId: state.id,
        header: `${node.title} — ${state.label}${state.unit ? ` (${state.unit})` : ''}`
    })));
    if (!signals.length) return;
    $('#exportCsvButton').disabled = true;
    try {
        const series = await window.engine.readResultSeries(activeEngineJobId, signals.map((signal) => signal.signalId), {
            startTime: 0,
            endTime: activeResult.availableResultTime ?? Infinity,
            maxPoints: Infinity
        });
        const csv = seriesToCsv(series, signals);
        const outcome = await window.projectFiles.exportResultsCsv(`${filenameStem(currentProjectFilename)}.csv`, csv);
        if (outcome) $('#statusText').textContent = `Exported ${outcome.fileName}`;
    } catch (error) {
        console.error('Results could not be exported as CSV.', error);
        $('#statusText').textContent = 'CSV export failed';
    } finally {
        $('#exportCsvButton').disabled = !activeResult;
    }
}

function requestCloseResultsConfirmation() {
    const dialog = $('#closeResultsDialog');
    const form = $('form', dialog);
    const cancel = $('#closeResultsCancel');
    $('#closeResultsMessage').textContent = activeResultPersistedInProject
        ? 'Closing the results panel will remove these results from the current session. You can load them again by reopening the saved project.'
        : 'If you want to load these results again later, save the project with simulation results before closing. Once the results panel is closed, the results will be removed from this session and cannot be reopened unless they were saved.';
    return new Promise((resolve) => {
        const finish = (confirmed) => {
            form.removeEventListener('submit', onSubmit);
            dialog.removeEventListener('cancel', onCancel);
            cancel.removeEventListener('click', onCancelClick);
            dialog.close();
            resolve(confirmed);
        };
        const onSubmit = (event) => { event.preventDefault(); finish(true); };
        const onCancel = (event) => { event.preventDefault(); finish(false); };
        const onCancelClick = () => finish(false);
        form.addEventListener('submit', onSubmit);
        dialog.addEventListener('cancel', onCancel);
        cancel.addEventListener('click', onCancelClick);
        dialog.showModal();
    });
}

async function closeResultPlayback() {
    if (!activeResult || simulationRunning || !await requestCloseResultsConfirmation()) return;
    await discardResultPlayback({ markProjectChanged: activeResultPersistedInProject });
    $('#statusText').textContent = 'Results removed · model editing enabled';
}

$('#resultTimeline').addEventListener('input', (event) => {
    stopResultPlayback();
    projectResultSample(nearestSampleIndex(activeResult.samples, Number(event.target.value)));
    updateLiveResultControls();
});
$('#resultStart').addEventListener('click', () => { stopResultPlayback(); projectResultSample(0); });
$('#resultPrevious').addEventListener('click', () => { stopResultPlayback(); projectResultSample(activeResultSampleIndex - 1); });
$('#resultNext').addEventListener('click', () => { stopResultPlayback(); projectResultSample(activeResultSampleIndex + 1); });
$('#resultEnd').addEventListener('click', () => { stopResultPlayback(); projectResultSample(activeResult.samples.length - 1); });
$('#resultPlayPause').addEventListener('click', () => {
    if (resultPlaying) {
        stopResultPlayback();
        return;
    }
    if (activeResultSampleIndex >= activeResult.samples.length - 1) projectResultSample(0);
    resultPlaying = true;
    resultPlaybackStartedAt = performance.now();
    resultPlaybackStartedFrom = Number(activeResult.samples[activeResultSampleIndex].time);
    $('#resultPlayPause').textContent = '❚❚';
    $('#resultPlayPause').ariaLabel = 'Pause results';
    scheduleResultPlayback();
});
$('#resultPlaybackRate').addEventListener('change', () => {
    if (resultPlaying) {
        clearTimeout(resultPlaybackTimer);
        resultPlaybackStartedAt = performance.now();
        resultPlaybackStartedFrom = Number(activeResult.samples[activeResultSampleIndex].time);
        scheduleResultPlayback();
    }
});
$('#simulationPacing').addEventListener('change', async (event) => {
    if (!activeEngineJobId) return;
    const [mode, ratio] = event.target.value.split(':');
    await window.engine.setPacing(activeEngineJobId, {
        mode,
        simulationSecondsPerWallSecond: mode === 'realTime' ? 1 : Number(ratio || 1)
    });
});
$('#liveParameterButton').addEventListener('click', () => {
    const panel = $('#liveParameterPanel');
    panel.hidden = !panel.hidden;
    $('#liveParameterButton').ariaExpanded = String(!panel.hidden);
    if (!panel.hidden) renderLiveParameterControls();
});
$('#closeLiveParameterPanel').addEventListener('click', () => {
    $('#liveParameterPanel').hidden = true;
    $('#liveParameterButton').ariaExpanded = 'false';
});
$('#simulationPauseResume').addEventListener('click', async () => {
    if (!activeEngineJobId || !simulationRunning) return;
    const nextState = activeResult?.lifecycle === 'paused' ? 'running' : 'paused';
    await window.engine.setExecutionState(activeEngineJobId, nextState);
});
$('#simulationStop').addEventListener('click', async () => {
    if (!activeEngineJobId || !simulationRunning) return;
    await window.engine.setExecutionState(activeEngineJobId, 'stopped');
});
$('#continueRun').addEventListener('click', () => {
    const checkpoint = activeResult.checkpoints.at(-1);
    if (!checkpoint) return;
    pendingRestart = {
        starting: true,
        checkpoint: structuredClone(checkpoint),
        samples: structuredClone(activeResult.samples.slice(0, -1)),
        checkpoints: structuredClone(activeResult.checkpoints.slice(0, -1))
    };
    runLaunchSettings.targetTime = Math.max(runLaunchSettings.targetTime, checkpoint.time + model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId).globalTimeStep);
    $('#runLaunchDescription').textContent = `Continue from ${formatResultTime(checkpoint.time)}.`;
    $('#runTargetTime').value = runLaunchSettings.targetTime;
    $('#runOnlineMode').checked = runLaunchSettings.online;
    $('#runPacingMode').value = runLaunchSettings.pacing.mode === 'limitedRatio' ? 'limitedRatio' : 'realTime';
    $('#runPacingRatio').value = runLaunchSettings.pacing.simulationSecondsPerWallSecond;
    updateRunModeFields();
    $('#runLaunchDialog').showModal();
});
$('#closeResults').addEventListener('click', closeResultPlayback);
$('#saveResults').addEventListener('click', () => saveProject());
$('#exportCsvButton').addEventListener('click', () => exportResultsCsv());
window.addons.onRequest('timeline.seek', (time) => {
    if (!activeResult) return;
    stopResultPlayback();
    projectResultSample(nearestSampleIndex(activeResult.samples, Number(time)));
});

function createAddonContext(contextNames) {
    const contexts = {};
    for (const contextName of contextNames) {
        if (contextName !== 'resultSession' || !activeResult) return null;
        contexts.resultSession = {
            projectName: filenameStem(currentProjectFilename),
            engineJobId: activeEngineJobId,
            result: activeResult,
            nodes: model.nodes.map((node) => {
                const object = nodeObjects.get(node.id);
                return {
                    id: node.id,
                    title: node.title,
                    shape: node.shape,
                    color: node.color,
                    rotation: object ? [object.rotation.x, object.rotation.y, object.rotation.z] : [0, 0, 0],
                    scale: object ? [object.scale.x, object.scale.y, object.scale.z] : [1, 1, 1],
                    mesh: node.importedGeometry ? {
                        position: Array.from(node.importedGeometry.getAttribute('position').array),
                        normal: node.importedGeometry.getAttribute('normal') ? Array.from(node.importedGeometry.getAttribute('normal').array) : null,
                        index: node.importedGeometry.getIndex() ? Array.from(node.importedGeometry.getIndex().array) : null
                    } : null,
                    states: node.states.map(({ id, label, symbol, unit }) => ({ id, label, symbol, unit }))
                };
            }),
            edges: model.relationships.filter((edge) => edge.enabled && !edge.deleted).map((edge) => ({
                id: edge.id,
                title: edge.title,
                sourceNodeId: edge.source,
                targetNodeId: edge.target
            })),
            selectedNodeId: selectedNode?.userData.id ?? null,
            time: activeResult.samples[activeResultSampleIndex]?.time ?? 0
        };
    }
    return contexts;
}

function addonConditionMatches(condition) {
    return condition === 'always' || (condition === 'resultsActive' && Boolean(activeResult));
}

function refreshAddonToolstripContributions() {
    let visibleCount = 0;
    addonToolstripContributions.forEach(({ contribution, button }) => {
        const visible = addonConditionMatches(contribution.when);
        button.hidden = !visible;
        if (visible) visibleCount += 1;
    });
    $('#addonToolstripSeparator').hidden = visibleCount === 0;
}

async function initializeAddonToolstripContributions() {
    try {
        const contributions = await window.addons.listToolstripContributions();
        const container = $('#addonToolstripContributions');
        container.replaceChildren();
        addonToolstripContributions = contributions.map((contribution) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'toolButton addonTool';
            button.ariaLabel = contribution.tooltip;
            button.dataset.tooltip = contribution.tooltip;
            button.dataset.addonId = contribution.addonId;
            button.dataset.commandId = contribution.commandId;
            const symbol = document.createElement('span');
            symbol.textContent = contribution.symbol;
            button.append(symbol, document.createTextNode(contribution.label));
            button.addEventListener('click', async () => {
                const contexts = createAddonContext(contribution.contexts);
                if (!contexts) return;
                try {
                    await window.addons.invokeCommand(contribution.addonId, contribution.commandId, contexts);
                } catch (error) {
                    console.error(`Add-on command ${contribution.addonId}.${contribution.commandId} failed.`, error);
                    $('#statusText').textContent = `${contribution.addonName} unavailable`;
                }
            });
            container.appendChild(button);
            return { contribution, button };
        });
        refreshAddonToolstripContributions();
    } catch (error) {
        console.error('Add-on contributions could not be loaded.', error);
    }
}

async function startSimulation() {
    if (simulationRunning || !currentValidation.valid) return;
    simulationRunning = true;
    liveParameterValues = new Map(model.relationships.flatMap((relationship) =>
        (relationship.parameters ?? []).filter((parameter) => parameter.mode === 'live')
            .map((parameter) => [parameter.id, Number(parameter.value) || 0])));
    if (pendingRestart && activeResult) {
        activeResult = { ...activeResult, lifecycle: 'running' };
        updateLiveResultControls();
    }
    $('#runButton').disabled = true;
    $('#runButton').title = 'Simulation is running';
    $('#statusText').textContent = 'Running simulation…';
    const previousResultSessionId = activeEngineJobId;
    try {
        const configuration = model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);
        const execution = await window.engine.start(JSON.stringify(stripEdgeGroups(executionProjectDocument(serializeProjectDocument()))), {
            ...configuration,
            targetTime: runLaunchSettings.targetTime,
            pacing: runLaunchSettings.pacing,
            ...(pendingRestart ? { startCheckpoint: pendingRestart.checkpoint } : {})
        });
        if (!execution.available) throw new Error('The C++ simulation engine is unavailable.');
        activeEngineJobId = execution.jobId;
        if (previousResultSessionId && previousResultSessionId !== execution.jobId) {
            window.engine.releaseResult(previousResultSessionId).catch((error) => {
                console.error('Previous result session could not be released.', error);
            });
        }
    } catch (error) {
        console.error('C++ simulation failed.', error);
        $('#statusText').textContent = 'Simulation failed';
        $('#runButton').title = error.message;
        simulationRunning = false;
        $('#runButton').disabled = Boolean(activeResult) || !currentValidation.valid;
        if (currentValidation.valid) $('#runButton').title = 'Run simulation';
    }
}

$('#runButton').addEventListener('click', () => {
    if (simulationRunning || !currentValidation.valid) return;
    pendingRestart = null;
    $('#runLaunchDescription').textContent = "Run from the model's initial state.";
    $('#runTargetTime').value = runLaunchSettings.targetTime;
    $('#runOnlineMode').checked = runLaunchSettings.online;
    $('#runPacingMode').value = runLaunchSettings.pacing.mode === 'limitedRatio' ? 'limitedRatio' : 'realTime';
    $('#runPacingRatio').value = runLaunchSettings.pacing.simulationSecondsPerWallSecond;
    updateRunModeFields();
    $('#runLaunchError').textContent = '';
    $('#runLaunchDialog').showModal();
});

$('#runLaunchCancel').addEventListener('click', () => $('#runLaunchDialog').close());
function updateRunModeFields() {
    const online = $('#runOnlineMode').checked;
    $('#runModeName').textContent = online ? 'Online' : 'Offline';
    $('#runModeDescription').textContent = online
        ? 'Synchronize the run with wall-clock time for live interaction.'
        : 'Run at maximum speed without wall-clock synchronization.';
    $('#runPacingModeField').hidden = !online;
    $('#runPacingRatioField').hidden = !online || $('#runPacingMode').value !== 'limitedRatio';
}
$('#runOnlineMode').addEventListener('change', updateRunModeFields);
$('#runPacingMode').addEventListener('change', (event) => {
    $('#runPacingRatioField').hidden = !$('#runOnlineMode').checked || event.target.value !== 'limitedRatio';
});
$('#runLaunchDialog form').addEventListener('submit', (event) => {
    event.preventDefault();
    const configuration = model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);
    const targetTime = Number($('#runTargetTime').value);
    const online = $('#runOnlineMode').checked;
    const pacingMode = online ? $('#runPacingMode').value : 'fastest';
    const pacingRatio = pacingMode === 'realTime' ? 1 : Number($('#runPacingRatio').value);
    const startTime = pendingRestart?.checkpoint.time ?? 0;
    if (!(targetTime > startTime) || targetTime - startTime < configuration.globalTimeStep ||
        (pacingMode === 'limitedRatio' && (!(pacingRatio > 0) || !Number.isFinite(pacingRatio)))) {
        $('#runLaunchError').textContent = `Target time must be at least one global timestep after ${formatResultTime(startTime)}; limited pacing requires a positive ratio.`;
        return;
    }
    runLaunchSettings = {
        targetTime,
        online,
        pacing: { mode: pacingMode, simulationSecondsPerWallSecond: pacingRatio }
    };
    $('#runLaunchDialog').close();
    startSimulation();
});

window.engine.onUpdate(({ jobId, result }) => applyLiveResult(jobId, result));
window.engine.onComplete(({ jobId, result }) => {
    if (jobId !== activeEngineJobId) return;
    applyLiveResult(jobId, result);
    simulationRunning = false;
    activeResultPersistedInProject = false;
    documentController.setSupplementalDirty(true);
    selectSuggestedPlaybackRate();
    updateLiveResultControls();
    $('#statusText').textContent = result.lifecycle === 'stopped' ? 'Simulation stopped · partial results retained' : 'Simulation complete';
});
window.engine.onError(({ jobId, message }) => {
    if (jobId !== activeEngineJobId) return;
    console.error(`[Simulation Error] Job ${jobId} failed:`, message);
    simulationRunning = false;
    updateLiveResultControls();
    $('#statusText').textContent = 'Simulation failed';
    $('#runButton').title = message;
    if (!activeResult) {
        activeEngineJobId = null;
        $('#runButton').disabled = !currentValidation.valid;
    }
});

function applyRunConfiguration(configuration) {
    const index = model.runConfigurations.findIndex((item) => item.id === configuration.id);
    model.runConfigurations[index] = structuredClone(configuration);
    if (selectedNode && !$('#nodeEditor').classList.contains('hidden')) renderNodeEditorModel(selectedNode);
    updateValidationStatus();
}

function updateExecutionConfigurationFields() {
    const backend = $('#runExecutionBackend').value;
    $('#runWorkerThreads').disabled = backend === 'serial';
    const partitionControlsEnabled = backend === 'automatic' || backend === 'partitioned';
    $('#runPartitionAlgorithm').disabled = !partitionControlsEnabled;
    $('#runPartitionCount').disabled = !partitionControlsEnabled;
    $('#runPartitionCommunicationBias').disabled = !partitionControlsEnabled || $('#runPartitionAlgorithm').value === 'metisKway';
    $('#runAutomaticParallelThreshold').disabled = backend !== 'automatic';
    $('#runAutomaticMaximumPartitionCutFraction').disabled = backend !== 'automatic';
}

$('#runConfigurationButton').addEventListener('click', () => {
    if (activeResult) return;
    const configuration = model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);
    $('#runConfigurationName').value = configuration.name;
    $('#runGlobalTimeStep').value = configuration.globalTimeStep;
    $('#runOutputInterval').value = configuration.outputInterval;
    const execution = normalizeExecutionConfiguration(configuration.execution);
    $('#runExecutionBackend').value = execution.backend;
    $('#runWorkerThreads').value = execution.workerThreads;
    $('#runPartitionAlgorithm').value = execution.partitionAlgorithm;
    $('#runPartitionCount').value = execution.partitionCount;
    $('#runPartitionCommunicationBias').value = execution.partitionCommunicationBias;
    $('#runAutomaticParallelThreshold').value = execution.automaticParallelThreshold;
    $('#runAutomaticMaximumPartitionCutFraction').value = execution.automaticMaximumPartitionCutFraction;
    updateExecutionConfigurationFields();
    $('#runConfigurationError').textContent = '';
    $('#runConfigurationDialog').showModal();
});
$('#runExecutionBackend').addEventListener('change', updateExecutionConfigurationFields);
$('#runPartitionAlgorithm').addEventListener('change', updateExecutionConfigurationFields);
$('#runConfigurationCancel').addEventListener('click', () => $('#runConfigurationDialog').close());
$('#runConfigurationDialog form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (activeResult) return;
    const before = structuredClone(model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId));
    const after = {
        ...before,
        name: $('#runConfigurationName').value.trim() || 'Untitled',
        globalTimeStep: Number($('#runGlobalTimeStep').value),
        outputInterval: Number($('#runOutputInterval').value),
        execution: {
            backend: $('#runExecutionBackend').value,
            partitionAlgorithm: $('#runPartitionAlgorithm').value,
            workerThreads: Number($('#runWorkerThreads').value),
            partitionCount: Number($('#runPartitionCount').value),
            partitionCommunicationBias: Number($('#runPartitionCommunicationBias').value),
            automaticParallelThreshold: Number($('#runAutomaticParallelThreshold').value),
            automaticMaximumPartitionCutFraction: Number($('#runAutomaticMaximumPartitionCutFraction').value)
        }
    };
    const outputRatio = after.outputInterval / after.globalTimeStep;
    const execution = after.execution;
    const validExecution = Number.isInteger(execution.workerThreads) && execution.workerThreads >= 1 && execution.workerThreads <= 256 &&
        Number.isInteger(execution.partitionCount) && execution.partitionCount >= 1 && execution.partitionCount <= 256 &&
        Number.isFinite(execution.partitionCommunicationBias) && execution.partitionCommunicationBias >= 0 &&
        Number.isInteger(execution.automaticParallelThreshold) && execution.automaticParallelThreshold >= 1 &&
        execution.automaticParallelThreshold <= 1000000 &&
        Number.isFinite(execution.automaticMaximumPartitionCutFraction) &&
        execution.automaticMaximumPartitionCutFraction >= 0 && execution.automaticMaximumPartitionCutFraction <= 1;
    if (!(after.globalTimeStep > 0) || !(after.outputInterval > 0) || after.outputInterval < after.globalTimeStep ||
        Math.abs(outputRatio - Math.round(outputRatio)) > 1e-9 || !validExecution) {
        $('#runConfigurationError').textContent = validExecution
            ? 'Use positive values; output interval must be an integer multiple of the global timestep.'
            : 'Execution values must be within their displayed bounds.';
        return;
    }
    applyRunConfiguration(after);
    recordHistory({ undo: () => applyRunConfiguration(before), redo: () => applyRunConfiguration(after) });
    $('#runConfigurationDialog').close();
});

function toolchainFields(kind) {
    const prefix = kind === 'python' ? 'toolchainPython' : 'toolchainCpp';
    return { path: $(`#${prefix}Path`), detected: $(`#${prefix}Detected`), status: $(`#${prefix}Status`) };
}

async function refreshToolchainField(kind) {
    const { path, detected, status } = toolchainFields(kind);
    const { overridePath, detectedPath } = await window.providerToolchains.get(kind);
    path.value = overridePath ?? '';
    path.placeholder = detectedPath ? `Auto-detected: ${detectedPath}` : 'Leave blank to auto-detect';
    detected.textContent = detectedPath ? `Auto-detected: ${detectedPath}` : 'Not auto-detected on this machine.';
    status.textContent = '';
    status.className = 'assistantConfigurationStatus';
}

async function testToolchainField(kind) {
    const { path, status } = toolchainFields(kind);
    status.textContent = 'Testing…';
    status.className = 'assistantConfigurationStatus';
    const result = await window.providerToolchains.test(kind, path.value);
    status.textContent = result.message;
    status.className = `assistantConfigurationStatus ${result.valid ? '' : 'error'}`;
}

async function browseToolchainField(kind) {
    const path = await window.providerToolchains.browse(kind);
    if (path) toolchainFields(kind).path.value = path;
}

function updateProviderExecutionModeWarning() {
    $('#providerExecutionModeWarning').hidden = $('#providerExecutionMode').value !== 'inProcess';
}

async function refreshProviderExecutionMode() {
    const { executionMode } = await window.providerToolchains.executionMode.get();
    $('#providerExecutionMode').value = executionMode;
    updateProviderExecutionModeWarning();
}

$('#providerToolchainsButton').addEventListener('click', async () => {
    $('#providerToolchainsError').textContent = '';
    await Promise.all([refreshToolchainField('cpp'), refreshToolchainField('python'), refreshProviderExecutionMode()]);
    $('#providerToolchainsDialog').showModal();
});
$('#providerToolchainsCancel').addEventListener('click', () => $('#providerToolchainsDialog').close());
$('#toolchainCppBrowse').addEventListener('click', () => browseToolchainField('cpp'));
$('#toolchainPythonBrowse').addEventListener('click', () => browseToolchainField('python'));
$('#toolchainCppTest').addEventListener('click', () => testToolchainField('cpp'));
$('#toolchainPythonTest').addEventListener('click', () => testToolchainField('python'));
$('#providerExecutionMode').addEventListener('change', updateProviderExecutionModeWarning);
$('#providerToolchainsDialog').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#providerToolchainsError');
    error.textContent = '';
    try {
        await window.providerToolchains.set('cpp', $('#toolchainCppPath').value);
        await window.providerToolchains.set('python', $('#toolchainPythonPath').value);
        await window.providerToolchains.executionMode.set($('#providerExecutionMode').value);
        $('#providerToolchainsDialog').close();
    } catch (submitError) {
        error.textContent = submitError.message;
    }
});

function syncContextualOverlays() {
    const bundles = activeRelationshipBundles();
    const activeKeys = new Set(bundles.map((bundle) => bundle.key));
    relationshipBundleObjects.forEach((overlay, key) => {
        if (activeKeys.has(key)) return;
        scene.remove(overlay.anchor);
        overlay.element.remove();
        relationshipBundleObjects.delete(key);
    });
    bundles.forEach((bundle) => {
        let overlay = relationshipBundleObjects.get(bundle.key);
        if (!overlay) {
            overlay = createRelationshipBundleOverlay(bundle.key);
            relationshipBundleObjects.set(bundle.key, overlay);
        }
        const sourceObject = nodeObjects.get(bundle.source);
        const targetObject = nodeObjects.get(bundle.target);
        // A CSS2D overlay always wins DOM hit-testing over the WebGL canvas beneath it, even
        // though 3D raycasting ignores it entirely -- so a visible label can silently block
        // clicks meant for a waypoint handle it happens to sit near or on top of. Hiding it
        // while any of its relationships has waypoint handles showing (i.e. is the selected
        // relationship and has at least one waypoint) keeps that whole editing gesture clear.
        const editingWaypoints = bundle.relationships.some((relationship) => waypointHandleObjects.has(relationship.id));
        overlay.anchor.visible = Boolean(sourceObject?.visible && targetObject?.visible) && !editingWaypoints;
        const curveMidpoints = bundle.relationships
            .map((relationship) => relationshipObjects.get(relationship.id)?.line.userData.curve?.getPoint(0.5))
            .filter(Boolean);
        if (curveMidpoints.length) {
            overlay.anchor.position.set(0, 0, 0);
            curveMidpoints.forEach((point) => overlay.anchor.position.add(point));
            overlay.anchor.position.multiplyScalar(1 / curveMidpoints.length);
        } else {
            overlay.anchor.position.copy(sourceObject.position).lerp(targetObject.position, 0.5);
        }
        renderRelationshipBundle(overlay, bundle);
    });
}

function createRelationshipBundleOverlay(key) {
    const element = $('#relationshipBundleTemplate').content.firstElementChild.cloneNode(true);
    element.dataset.bundle = key;
    const anchor = new THREE.Object3D();
    const object = new CSS2DObject(element);
    object.center.set(0.5, 0.5);
    anchor.add(object);
    scene.add(anchor);
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
    element.addEventListener('click', (event) => {
        if (event.shiftKey) return;
        const row = event.target.closest('.relationshipRow');
        const bundle = activeRelationshipBundles().find((candidate) => candidate.key === key);
        const definition = row
            ? model.relationships.find((relationship) => relationship.id === Number(row.dataset.relationship))
            : bundle?.relationships[0];
        if (definition) openRelationshipEditor(definition);
    });
    element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (activeResult) return;
        stageContextMenuAction(() => {
            const row = event.target.closest('.relationshipRow');
            const bundle = activeRelationshipBundles().find((candidate) => candidate.key === key);
            const definition = row
                ? model.relationships.find((relationship) => relationship.id === Number(row.dataset.relationship))
                : bundle?.relationships[0];
            if (!definition) return;
            selectRelationship(definition);
            openEdgeContextMenu(event.clientX, event.clientY);
        });
    });
    $('.collapseBundle', element).addEventListener('click', (event) => {
        event.stopPropagation();
        element.classList.toggle('pinned');
        const pinned = element.classList.contains('pinned');
        event.currentTarget.textContent = pinned ? '−' : '＋';
        event.currentTarget.title = pinned ? 'Use automatic detail' : 'Keep expanded';
    });
    return { anchor, element, signature: '' };
}

function renderRelationshipBundle(overlay, bundle) {
    const source = model.nodes.find((node) => node.id === bundle.source);
    const target = model.nodes.find((node) => node.id === bundle.target);
    $('header strong', overlay.element).textContent = `${source.title} ↔ ${target.title}`;
    $('header span', overlay.element).textContent = `${bundle.relationships.length} ${bundle.relationships.length === 1 ? 'relationship' : 'relationships'}`;
    const signature = JSON.stringify(bundle.relationships.map((relationship) => ({
        id: relationship.id,
        title: relationship.title,
        directionality: relationship.directionality,
        equation: relationship.equation,
        parameter: relationship.parameters?.[0],
        enabled: isEdgeEffectivelyEnabled(relationship)
    })));
    if (overlay.signature === signature) return;
    overlay.signature = signature;
    $$('.relationshipRow', overlay.element).forEach((row) => row.remove());
    bundle.relationships.forEach((relationship) => {
        const row = document.createElement('button');
        const parameter = relationship.parameters?.[0];
        const summary = parameter
            ? `${parameter.value}${parameter.unit ? ` ${parameter.unit}` : ''}`
            : relationship.equation ? 'Equation' : 'No equation';
        const enabled = isEdgeEffectivelyEnabled(relationship);
        row.className = 'relationshipRow';
        row.classList.toggle('disabled', !enabled);
        row.dataset.relationship = relationship.id;
        row.type = 'button';
        row.innerHTML = `
            <i class="relationColor" style="background:#${relationship.color.toString(16).padStart(6, '0')}"></i>
            <span><b>${relationship.directionality === 'directed' ? '→' : '⇄'}</b> ${escapeHtml(relationship.title)}</span>
            <em>${enabled ? escapeHtml(summary) : 'Disabled'}</em>
        `;
        overlay.element.appendChild(row);
    });
}

function invalidateRelationshipBundles() {
    relationshipBundleObjects.forEach((overlay) => {
        overlay.signature = '';
    });
}

function activeRelationshipBundles() {
    return groupRelationshipBundles(model.relationships, (relationship) => (
        relationshipObjects.get(relationship.id)?.line.visible === true &&
        nodeObjects.get(relationship.source)?.visible === true &&
        nodeObjects.get(relationship.target)?.visible === true
    ));
}

function serializeGeometry(geometry) {
    return {
        position: Array.from(geometry.attributes.position.array),
        normal: geometry.attributes.normal ? Array.from(geometry.attributes.normal.array) : [],
        index: geometry.index ? Array.from(geometry.index.array) : []
    };
}

function serializeProjectDocument() {
    const visibleNodes = model.nodes.filter((node) => !node.deleted);
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    return {
        format: 'konjugate',
        version: 1,
        copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
        metadata: { units: model.metadata.units },
        runConfigurations: structuredClone(model.runConfigurations),
        activeRunConfigurationId: model.activeRunConfigurationId,
        nodes: visibleNodes.map((node) => {
            const object = nodeObjects.get(node.id);
            return {
                id: node.id,
                name: node.title,
                type: node.type,
                ...(node.subsystemId === null ? {} : { subsystemId: node.subsystemId }),
                enabled: node.enabled !== false,
                numerics: { substepsPerGlobalStep: node.substepsPerGlobalStep },
                position: object.position.toArray(),
                // Omitted when at the identity value, like subsystemId above -- keeps a node
                // that was never rotated/scaled serializing exactly as it did before these
                // fields existed, rather than growing every node's JSON with inert zeros/ones.
                ...(object.rotation.x === 0 && object.rotation.y === 0 && object.rotation.z === 0
                    ? {} : { rotation: object.rotation.toArray().slice(0, 3) }),
                ...(object.scale.x === 1 && object.scale.y === 1 && object.scale.z === 1
                    ? {} : { scale: object.scale.toArray() }),
                states: node.states.map((state) => ({
                    id: state.id ?? allocateModelEntityId(),
                    name: state.label,
                    symbol: state.symbol,
                    initialValue: (state.initialValue ?? Number.parseFloat(state.value)) || 0,
                    unit: state.unit ?? ''
                })),
                sourceTerms: (node.sourceTerms ?? []).map((term) => {
                    const bindings = node.states.map((state) => ({
                        kind: 'state', nodeId: node.id, stateId: state.id, symbol: state.symbol
                    }));
                    const validation = validateEquationLatex(term.expression, bindings);
                    return {
                        ...term,
                        expressionModel: {
                            latex: term.expression,
                            bindings,
                            output: { stateId: node.states.find((state) => state.symbol === term.state)?.id ?? null },
                            mathJson: validation.valid ? validation.mathJson : null
                        }
                    };
                }),
                appearance: node.importedGeometry
                    ? {
                        type: 'mesh',
                        fileName: node.geometryFileName,
                        color: `#${node.color.toString(16).padStart(6, '0')}`,
                        mesh: serializeGeometry(node.importedGeometry)
                    }
                    : {
                        type: 'primitive',
                        shape: node.shape,
                        color: `#${node.color.toString(16).padStart(6, '0')}`
                    }
            };
        }),
        edges: model.relationships
            .filter((edge) => (
                !edge.deleted &&
                visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
            ))
            .map((edge) => ({
                id: edge.id,
                ...(edge.groupId == null ? {} : { groupId: edge.groupId }),
                name: edge.title,
                source: { nodeId: edge.source, stateId: edge.sourceStateId ?? '' },
                target: { nodeId: edge.target, stateId: edge.targetStateId ?? '' },
                directionality: edge.directionality,
                enabled: edge.enabled !== false,
                equation: edge.equationModel?.latex ?? edge.equation ?? '',
                equationModel: normalizeEdgeEquationModel(edge),
                ...(edge.implementation ? { implementation: edge.implementation } : {}),
                parameters: edge.parameters ?? [],
                appearance: {
                    color: `#${edge.color.toString(16).padStart(6, '0')}`,
                    offset: edge.offset,
                    waypoints: edge.waypoints ?? []
                }
            })),
        subsystems: model.subsystems.filter((subsystem) => !subsystem.deleted).map((subsystem) => ({
            id: subsystem.id,
            name: subsystem.name,
            parentSubsystemId: subsystem.parentSubsystemId,
            position: subsystemObjects.get(subsystem.id)?.position.toArray() ?? subsystem.position,
            ports: structuredClone(subsystem.ports)
        })),
        // Node deletion (deleteSelected) only toggles visibility -- it has no reason to know
        // about edgeGroups, and doesn't touch group.memberNodeIds -- so a group whose members
        // were deleted directly (rather than via "detach"/"delete group") would otherwise still
        // list now-invisible node ids here. hydrateEdgeGroups() throws on a member id that isn't
        // in the exported nodes array, which single-edge/node edits never re-trigger mid-session,
        // but any full-document round trip does -- a save+reload, or (already possible today,
        // independent of this) the AI assistant's own commit path, both call
        // hydrateProjectDocument() on exactly this output. Filtering to currently-visible members
        // here keeps every serialization self-consistent regardless of how a member became
        // invisible, without needing every hiding path to separately know about group membership.
        edgeGroups: model.edgeGroups
            .filter((group) => !group.deleted)
            .map((group) => ({
                id: group.id,
                name: group.name,
                memberNodeIds: group.memberNodeIds.filter((id) => visibleNodeIds.has(id)),
                color: `#${group.color.toString(16).padStart(6, '0')}`,
                definition: structuredClone(group.definition)
            }))
            .filter((group) => group.memberNodeIds.length >= 2)
    };
}

function clearRenderedModel() {
    clearSelection();
    relationshipBundleObjects.forEach((overlay) => {
        scene.remove(overlay.anchor);
        overlay.element.remove();
    });
    relationshipBundleObjects.clear();
    relationshipObjects.forEach((relationship) => {
        scene.remove(relationship.line);
        relationship.line.geometry.dispose();
        relationship.line.material.dispose();
        if (relationship.marker) {
            scene.remove(relationship.marker);
            relationship.marker.geometry.dispose();
            relationship.marker.material.dispose();
        }
    });
    nodeObjects.forEach((node) => {
        node.traverse((child) => child.element?.remove());
        scene.remove(node);
        node.geometry.dispose();
        node.material.dispose();
        node.userData.definition.importedGeometry?.dispose();
    });
    subsystemObjects.forEach((object) => {
        object.traverse((child) => child.element?.remove());
        scene.remove(object);
        object.geometry.dispose();
        object.material.dispose();
    });
    relationshipObjects.clear();
    nodeObjects.clear();
    subsystemObjects.clear();
    relationshipPickTargets.length = 0;
    nodePickTargets.length = 0;
}

async function loadProjectDocument(document, {
    path = null,
    fileName = 'untitled.kjt',
    saved = true,
    password = null,
    embeddedResult = null
} = {}) {
    await discardResultPlayback();
    discardAssistantProposal();
    hideAssistantPanel();
    const nextModel = hydrateProjectDocument(document);
    clearRenderedModel();
    model.metadata = nextModel.metadata;
    model.runConfigurations = nextModel.runConfigurations;
    model.activeRunConfigurationId = nextModel.activeRunConfigurationId;
    model.nodes.splice(0, model.nodes.length, ...nextModel.nodes);
    model.relationships.splice(0, model.relationships.length, ...nextModel.relationships);
    model.subsystems.splice(0, model.subsystems.length, ...nextModel.subsystems);
    model.nodes.forEach(createNode);
    model.subsystems.forEach(createSubsystemObject);
    model.relationships.forEach(createRelationship);
    activeSubsystemId = null;
    refreshSubsystemView();
    invalidateRelationshipBundles();
    updateRelationships();
    updateModelStatus();
    currentProjectPath = path;
    window.projectFiles.pathChanged(currentProjectPath);
    currentProjectFilename = fileName;
    currentProjectPassword = password;
    documentController.reset({ saved });
    updateDocumentTitle();
    updateEncryptionControls();
    setCameraView('orbit', false);
    fitCurrentView();
    if (embeddedResult) {
        activeEngineJobId = embeddedResult.sessionId;
        activeResultPersistedInProject = true;
        activateResult(embeddedResult.result);
        selectSuggestedPlaybackRate();
    }
}

function replaceModelContents(document) {
    const nextModel = hydrateProjectDocument(document);
    clearRenderedModel();
    model.metadata = nextModel.metadata;
    model.runConfigurations = nextModel.runConfigurations;
    model.activeRunConfigurationId = nextModel.activeRunConfigurationId;
    model.nodes.splice(0, model.nodes.length, ...nextModel.nodes);
    model.relationships.splice(0, model.relationships.length, ...nextModel.relationships);
    model.subsystems.splice(0, model.subsystems.length, ...nextModel.subsystems);
    model.nodes.forEach(createNode);
    model.subsystems.forEach(createSubsystemObject);
    model.relationships.forEach(createRelationship);
    activeSubsystemId = null;
    refreshSubsystemView();
    invalidateRelationshipBundles();
    updateRelationships();
    updateModelStatus();
}

function showAssistantPanel() {
    $('#validationPanel').hidden = true;
    $('#validationSummary').ariaExpanded = 'false';
    $('#assistantPanel').hidden = false;
    $('#assistantButton').ariaExpanded = 'true';
    if (!assistantHasBeenPositioned) positionAssistantPanel();
    else clampAssistantPanel();
    requestAnimationFrame(avoidAssistantInspectorOverlap);
    refreshAssistantConfigurations();
}

function hideAssistantPanel() {
    assistantGenerationController?.abort();
    assistantGenerationController = null;
    $('#assistantPanel').hidden = true;
    $('#assistantButton').ariaExpanded = 'false';
}

function visibleModelInspector() {
    return [$('#nodeEditor'), $('#edgeEditor'), $('#edgeGroupEditor')].find((editor) => !editor.classList.contains('hidden')) ?? null;
}

function assistantBounds(left, top) {
    const panel = $('#assistantPanel');
    const canvasRect = canvas.getBoundingClientRect();
    return {
        left: Math.max(10, Math.min(left, window.innerWidth - panel.offsetWidth - 10)),
        top: Math.max(canvasRect.top + 10, Math.min(top, window.innerHeight - panel.offsetHeight - 10))
    };
}

function setAssistantPosition(left, top) {
    const panel = $('#assistantPanel');
    const bounds = assistantBounds(left, top);
    panel.style.left = `${bounds.left}px`;
    panel.style.top = `${bounds.top}px`;
    panel.style.removeProperty('right');
    panel.style.removeProperty('bottom');
    assistantHasBeenPositioned = true;
}

function positionAssistantPanel() {
    const panel = $('#assistantPanel');
    const inspector = visibleModelInspector();
    const rightBoundary = inspector ? inspector.getBoundingClientRect().left - 10 : window.innerWidth - 10;
    setAssistantPosition(rightBoundary - panel.offsetWidth, canvas.getBoundingClientRect().top + 10);
}

function clampAssistantPanel() {
    const panel = $('#assistantPanel');
    if (panel.hidden) return;
    const rect = panel.getBoundingClientRect();
    setAssistantPosition(rect.left, rect.top);
}

function avoidAssistantInspectorOverlap() {
    const panel = $('#assistantPanel');
    const inspector = visibleModelInspector();
    if (panel.hidden || !inspector) return;
    const panelRect = panel.getBoundingClientRect();
    const inspectorRect = inspector.getBoundingClientRect();
    const overlaps = panelRect.right > inspectorRect.left && panelRect.left < inspectorRect.right &&
        panelRect.bottom > inspectorRect.top && panelRect.top < inspectorRect.bottom;
    if (overlaps) setAssistantPosition(inspectorRect.left - panelRect.width - 10, panelRect.top);
}

function setAssistantCollapsed(collapsed) {
    const panel = $('#assistantPanel');
    panel.classList.toggle('collapsed', collapsed);
    $('#collapseAssistantPanel').textContent = collapsed ? '□' : '−';
    $('#collapseAssistantPanel').ariaLabel = collapsed ? 'Expand model assistant' : 'Collapse model assistant';
    $('#collapseAssistantPanel').ariaExpanded = String(!collapsed);
    requestAnimationFrame(clampAssistantPanel);
}

function updateAssistantCollapsedStatus(text) {
    $('#assistantCollapsedStatus').textContent = text;
}

function installAssistantDragging() {
    const panel = $('#assistantPanel');
    const header = $('#assistantPanelHeader');
    let drag = null;
    header.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        setAssistantPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });
    const finish = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
        drag = null;
    };
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
}

function renderAssistantProposal(proposal, prepared) {
    $('#assistantEmpty').hidden = true;
    $('#assistantClarification').hidden = true;
    $('#assistantProposal').hidden = false;
    $('#assistantProposalSummary').textContent = proposal.summary?.trim() || 'Proposed model changes';
    const assumptions = Array.isArray(proposal.assumptions) ? proposal.assumptions.filter((item) => typeof item === 'string' && item.trim()) : [];
    $('#assistantAssumptionsSection').hidden = !assumptions.length;
    $('#assistantAssumptions').replaceChildren(...assumptions.map((assumption) => {
        const item = document.createElement('li');
        item.textContent = assumption;
        return item;
    }));
    $('#assistantChanges').replaceChildren(...prepared.changes.map((change) => {
        const item = document.createElement('li');
        item.className = `assistantChange ${change.action ?? 'update'}`;
        const content = document.createElement(change.focusEntityId ? 'button' : 'div');
        if (change.focusEntityId) {
            content.type = 'button';
            content.dataset.focusEntity = change.focusEntityId;
            content.setAttribute('aria-label', `${change.label}. Inspect this object in the current model.`);
        }
        const heading = document.createElement('span');
        const badge = document.createElement('b');
        badge.textContent = change.action === 'remove' ? 'Remove' : change.action === 'add' ? 'Add' : 'Update';
        const label = document.createElement('strong');
        label.textContent = change.label;
        heading.append(badge, label);
        content.append(heading);
        if (change.fields?.length) {
            const details = document.createElement('dl');
            change.fields.forEach((field) => {
                const row = document.createElement('div');
                const name = document.createElement('dt');
                const values = document.createElement('dd');
                name.textContent = field.field;
                values.textContent = `${formatAssistantValue(field.before)} → ${formatAssistantValue(field.after)}`;
                row.append(name, values);
                details.append(row);
            });
            content.append(details);
        }
        item.append(content);
        return item;
    }));
    $('#assistantError').hidden = true;
    $('#assistantProposalStatus').className = 'pending';
    $('#assistantProposalStatus').textContent = 'Validating the candidate model with the C++ engine…';
    $('#applyAssistantProposal').disabled = true;
}

function formatAssistantValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function renderAssistantTranscript() {
    const transcript = $('#assistantTranscript');
    transcript.hidden = assistantTurnHistory.length === 0;
    transcript.replaceChildren(...assistantTurnHistory.map((turn) => {
        const item = document.createElement('li');
        item.className = 'assistantTranscriptTurn';
        const you = document.createElement('p');
        you.className = 'assistantTranscriptYou';
        you.textContent = turn.request;
        const outcome = document.createElement('p');
        outcome.className = 'assistantTranscriptOutcome';
        outcome.textContent = turn.outcome;
        item.append(you, outcome);
        return item;
    }));
    // Keep the most recent exchange in view rather than wherever the scroll position happened
    // to be left (replaceChildren doesn't move it on its own), the same way a chat log would.
    transcript.scrollTop = transcript.scrollHeight;
}

function pushAssistantTurn(request, outcome) {
    const record = { request, outcome };
    assistantTurnHistory = [...assistantTurnHistory, record].slice(-5);
    renderAssistantTranscript();
    return record;
}

function updateAssistantTurnOutcome(record, outcome) {
    if (!record || !assistantTurnHistory.includes(record)) return;
    record.outcome = outcome;
    renderAssistantTranscript();
}

function resetAssistantConversation() {
    assistantTurnHistory = [];
    pendingAssistantTurnRecord = null;
    renderAssistantTranscript();
}

function renderAssistantClarification(response) {
    $('#assistantEmpty').hidden = true;
    $('#assistantProposal').hidden = true;
    $('#assistantClarification').hidden = false;
    $('#assistantClarificationQuestion').textContent = response.question;
    const suggestions = Array.isArray(response.suggestions) ? response.suggestions : [];
    $('#assistantClarificationOptions').hidden = !suggestions.length;
    $('#assistantClarificationOptions').replaceChildren(...suggestions.map((suggestion) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'assistantClarificationOption';
        button.textContent = suggestion;
        button.dataset.suggestion = suggestion;
        return button;
    }));
    updateAssistantCollapsedStatus('Needs clarification');
}

function dismissAssistantClarification() {
    updateAssistantTurnOutcome(pendingAssistantTurnRecord, 'You did not answer.');
    pendingAssistantTurnRecord = null;
    $('#assistantClarification').hidden = true;
    $('#assistantEmpty').hidden = false;
    $('#generateAssistantProposal').textContent = 'Generate proposal';
    updateAssistantCollapsedStatus('Your model remains unchanged');
}

function inspectAssistantEntity(entityId) {
    const node = nodeObjects.get(entityId);
    if (node?.visible) {
        selectNode(node);
        openNodeEditor(node.userData.definition);
        return true;
    }
    const relationship = relationshipObjects.get(entityId);
    if (relationship?.line.visible) {
        openRelationshipEditor(relationship.definition);
        return true;
    }
    return false;
}

async function previewAssistantProposal(proposal) {
    if (activeResult) throw new Error('Close simulation results before preparing model changes.');
    const revision = ++assistantPreviewRevision;
    showAssistantPanel();
    try {
        const baseDocument = serializeProjectDocument();
        const prepared = buildAssistantProposal(baseDocument, proposal);
        renderAssistantProposal(proposal, prepared);
        const validation = await window.engine.validate(JSON.stringify(prepared.document));
        if (revision !== assistantPreviewRevision) return { valid: false, superseded: true };
        if (!validation.available) throw new Error('The native validation engine is unavailable.');
        if (!validation.report.valid) {
            const message = validation.report.issues
                .filter((issue) => issue.severity === 'error')
                .map((issue) => issue.message)
                .join(' ') || 'The native validator rejected this proposal.';
            throw new Error(message);
        }
        pendingAssistantProposal = {
            proposal: structuredClone(proposal),
            document: prepared.document,
            baseDocument: JSON.stringify(baseDocument),
            changes: prepared.changes
        };
        $('#assistantProposalStatus').className = 'valid';
        $('#assistantProposalStatus').textContent = `Native validation passed · ${prepared.changes.length} ${prepared.changes.length === 1 ? 'change' : 'changes'}`;
        $('#applyAssistantProposal').disabled = false;
        $('#generateAssistantProposal').textContent = 'Revise proposal';
        updateAssistantCollapsedStatus('Proposal ready to review');
        return { valid: true, changes: structuredClone(prepared.changes) };
    } catch (error) {
        if (revision !== assistantPreviewRevision) return { valid: false, superseded: true };
        pendingAssistantProposal = null;
        $('#assistantEmpty').hidden = true;
        $('#assistantClarification').hidden = true;
        $('#assistantProposal').hidden = false;
        $('#assistantProposalStatus').className = '';
        $('#assistantProposalStatus').textContent = 'Proposal rejected';
        $('#assistantError').textContent = error.message;
        $('#assistantError').hidden = false;
        $('#applyAssistantProposal').disabled = true;
        updateAssistantTurnOutcome(pendingAssistantTurnRecord, `Rejected: ${error.message}`);
        pendingAssistantTurnRecord = null;
        return { valid: false, error: error.message };
    }
}

// General "back to the empty state" reset, used both for an explicit Discard click and whenever
// something else (switching model configuration, a hard generation error) needs to clear
// whatever the panel was showing -- proposal or clarification -- without assuming which.
function discardAssistantProposal() {
    assistantPreviewRevision += 1;
    pendingAssistantProposal = null;
    pendingAssistantTurnRecord = null;
    $('#assistantProposal').hidden = true;
    $('#assistantClarification').hidden = true;
    $('#assistantEmpty').hidden = false;
    $('#generateAssistantProposal').textContent = 'Generate proposal';
    updateAssistantCollapsedStatus('Your model remains unchanged');
}

function commitAssistantProposal() {
    if (!pendingAssistantProposal || activeResult) return false;
    const currentDocument = serializeProjectDocument();
    if (JSON.stringify(currentDocument) !== pendingAssistantProposal.baseDocument) {
        $('#assistantError').textContent = 'The model changed after this proposal was prepared. Preview it again against the current model.';
        $('#assistantError').hidden = false;
        $('#applyAssistantProposal').disabled = true;
        pendingAssistantProposal = null;
        return false;
    }
    const before = currentDocument;
    const after = structuredClone(pendingAssistantProposal.document);
    updateAssistantTurnOutcome(pendingAssistantTurnRecord, `Applied: ${pendingAssistantProposal.proposal.summary?.trim() || 'the proposed changes'}`);
    replaceModelContents(after);
    recordHistory({
        undo: () => replaceModelContents(before),
        redo: () => replaceModelContents(after)
    });
    discardAssistantProposal();
    hideAssistantPanel();
    return true;
}

// { csvContent, mapping: [{columnName, nodeId|null, stateId|null, createNew, suggestedSymbol?}],
//   candidates: [{sourceColumn, targetColumn, lag, coefficient, intercept, score, provenance, accepted}] | null }
let causalInferenceState = null;

function existingNodesForMapping() {
    // A plain-data projection decoupled from the live Three.js-backed model, matching what
    // src/csvImport.mjs's pure functions expect -- state.label is this app's live-model field
    // for what csvImport.mjs (and the on-disk document) call "name".
    return model.nodes.filter((node) => !node.deleted).map((node) => ({
        id: node.id,
        states: node.states.map((state) => ({ id: state.id, symbol: state.symbol, name: state.label }))
    }));
}

// Every footer button below follows the same rule as the section it belongs to: hidden until
// the step it acts on is actually reachable (there is nothing to click yet, so don't show a
// button for it), disabled only once reachable but currently inactionable (e.g. candidates exist
// but none are checked). "Run inference" appears together with the mapping section and then
// stays available for as long as it's shown, since re-running with different settings once you've
// reached that point is a real, ongoing capability, not a one-shot step.
function resetCausalInference() {
    causalInferenceState = null;
    $('#causalInferenceFile').value = '';
    $('#causalInferenceStatus').className = 'equationDiagnostics';
    $('#causalInferenceStatus').textContent = '';
    $('#causalInferenceMappingSection').hidden = true;
    $('#causalInferenceMappingRows').replaceChildren();
    $('#causalInferenceDegreeMode').value = 'linear';
    $('#causalInferenceDegreeValueField').hidden = true;
    $('#causalInferenceDegreeValue').value = '3';
    $('#causalInferenceContinuousTime').checked = false;
    $('#causalInferenceContinuousTimeHint').hidden = true;
    $('#runCausalInference').hidden = true;
    $('#runCausalInference').disabled = true;
    $('#causalInferenceCandidatesSection').hidden = true;
    $('#causalInferenceCandidateRows').replaceChildren();
    $('#causalInferenceSelfTermSection').hidden = true;
    $('#causalInferenceSelfTermRows').replaceChildren();
    $('#commitCausalInference').hidden = true;
    $('#commitCausalInference').disabled = true;
}

function openCausalInference() {
    if (activeResult) return;
    hideCards($('#causalInference'));
    resetCausalInference();
    $('#causalInference').classList.remove('hidden');
}

function renderCausalInferenceMapping() {
    const container = $('#causalInferenceMappingRows');
    container.replaceChildren();
    const nodesForMapping = existingNodesForMapping();
    causalInferenceState.mapping.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'causalInferenceMappingRow';
        const label = document.createElement('span');
        label.textContent = entry.columnName;
        row.append(label);
        const select = document.createElement('select');
        select.append(new Option(`Create node “${entry.suggestedSymbol ?? suggestSymbol(entry.columnName)}”`, 'create'));
        nodesForMapping.forEach((node) => {
            const modelNode = model.nodes.find((candidate) => candidate.id === node.id);
            node.states.forEach((state) => {
                select.append(new Option(`${modelNode.title} · ${state.name}`, `${node.id}:${state.id}`));
            });
        });
        select.value = entry.createNew ? 'create' : `${entry.nodeId}:${entry.stateId}`;
        select.addEventListener('change', () => {
            if (select.value === 'create') {
                causalInferenceState.mapping[index] =
                    { columnName: entry.columnName, nodeId: null, stateId: null, createNew: true, suggestedSymbol: suggestSymbol(entry.columnName) };
            } else {
                const [nodeId, stateId] = select.value.split(':').map(Number);
                causalInferenceState.mapping[index] = { columnName: entry.columnName, nodeId, stateId, createNew: false };
            }
        });
        row.append(select);
        container.append(row);
    });
}

// Nothing is accepted unless at least one candidate edge OR self term is checked -- either
// render function can leave the other's items unaffected, so this always looks at both rather
// than each function only reasoning about its own list.
function updateCommitCausalInferenceEnabled() {
    const hasAcceptedCandidate = causalInferenceState.candidates.some((item) => item.accepted);
    const hasAcceptedSelfTerm = (causalInferenceState.selfTerms ?? []).some((item) => item.accepted);
    $('#commitCausalInference').disabled = !hasAcceptedCandidate && !hasAcceptedSelfTerm;
}

function renderCausalInferenceCandidates() {
    const container = $('#causalInferenceCandidateRows');
    container.replaceChildren();
    if (!causalInferenceState.candidates.length) {
        const empty = document.createElement('p');
        empty.className = 'builderHint';
        empty.textContent = 'No candidate relationships were found.';
        container.append(empty);
        updateCommitCausalInferenceEnabled();
        return;
    }
    causalInferenceState.candidates.forEach((candidate, index) => {
        const row = document.createElement('label');
        row.className = 'causalInferenceCandidateRow';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = candidate.accepted;
        checkbox.addEventListener('change', () => {
            causalInferenceState.candidates[index].accepted = checkbox.checked;
            updateCommitCausalInferenceEnabled();
        });
        const main = document.createElement('span');
        main.className = 'causalInferenceCandidateMain';
        main.textContent = `${candidate.sourceColumn} → ${candidate.targetColumn}`;
        const meta = document.createElement('span');
        meta.className = 'causalInferenceCandidateMeta';
        meta.textContent = candidate.provenance === 'correlationOnly'
            ? `score ${candidate.score.toFixed(2)}`
            : `lag ${candidate.lag} · score ${candidate.score.toFixed(2)}`;
        main.append(meta);
        const tag = document.createElement('span');
        tag.className = `causalInferenceCandidateTag ${candidate.provenance}`;
        tag.textContent = candidate.provenance === 'lagged' ? 'Lagged'
            : candidate.provenance === 'continuousLagged' ? 'Continuous'
            : 'Correlation-only';
        row.append(checkbox, main, tag);
        container.append(row);
    });
    updateCommitCausalInferenceEnabled();
}

function renderCausalInferenceSelfTerms() {
    const container = $('#causalInferenceSelfTermRows');
    container.replaceChildren();
    const selfTerms = causalInferenceState.selfTerms ?? [];
    $('#causalInferenceSelfTermSection').hidden = selfTerms.length === 0;
    selfTerms.forEach((term, index) => {
        const row = document.createElement('label');
        row.className = 'causalInferenceCandidateRow';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = term.accepted;
        checkbox.addEventListener('change', () => {
            causalInferenceState.selfTerms[index].accepted = checkbox.checked;
            updateCommitCausalInferenceEnabled();
        });
        const main = document.createElement('span');
        main.className = 'causalInferenceCandidateMain';
        main.textContent = `${term.targetColumn} (self)`;
        const meta = document.createElement('span');
        meta.className = 'causalInferenceCandidateMeta';
        meta.textContent = `rate ${formatFittedNumber(term.rate)}`;
        main.append(meta);
        const tag = document.createElement('span');
        tag.className = 'causalInferenceCandidateTag continuousLagged';
        tag.textContent = 'Continuous';
        row.append(checkbox, main, tag);
        container.append(row);
    });
    updateCommitCausalInferenceEnabled();
}

function upperFirst(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatFittedNumber(value) {
    if (value === 0) return '0';
    return String(Number(value.toPrecision(6)));
}

// symbolLatex is null for a bare constant term (the intercept).
function signedTermLatex(value, symbolLatex) {
    const magnitude = formatFittedNumber(Math.abs(value));
    const term = symbolLatex ? `${magnitude} \\cdot ${symbolLatex}` : magnitude;
    return value < 0 ? `- ${term}` : `+ ${term}`;
}

// Generates LaTeX text, not a hand-built mathJson tree -- validateEquationLatex()/ComputeEngine
// already parses programmatically-interpolated numeric literals (decimals, negatives,
// scientific notation) with no special-casing, and every symbol reference here is one of
// reconcileEquationBindings()'s own auto-generated role-prefixed names (e.g. "sourceTemperature"),
// which are always multi-letter by construction and so never trip the \mathrm{} single-letter
// "_upright" parsing quirk documented in docs/proposals/causalInference.md. candidate.terms is one
// entry per fitted polynomial degree (always at least a degree-1 entry); degree 1 renders as the
// bare source symbol, degree >= 2 as the symbol raised to that power -- Power is already a
// supported mathJson primitive, so no equation-engine changes are needed for this.
function latexForFittedEdge(candidate, sourceStateSymbol) {
    const sourceSymbol = `\\mathrm{source${upperFirst(sourceStateSymbol)}}`;
    const termsLatex = candidate.terms
        .slice()
        .sort((a, b) => a.degree - b.degree)
        .map((term) => signedTermLatex(term.coefficient, term.degree === 1 ? sourceSymbol : `${sourceSymbol}^{${term.degree}}`))
        .join(' ')
        .replace(/^\+ /, '');
    const interceptTerm = signedTermLatex(candidate.intercept, null);
    return `${termsLatex} ${interceptTerm}`;
}

// A self-term's rate applies to the node's own state directly -- an addSourceTerm's bindings
// expose every one of that node's states by its raw symbol (unlike an edge's source/target-
// prefixed synthesized symbols), and there's no intercept (see SelfTerm's doc comment in
// causalInference.hpp for why: extending self-terms with their own intercept share would mean
// propagating or fixing a pre-existing gap in how the discrete path already splits intercepts,
// out of scope here). Still needs the same \mathrm{} wrapping latexForFittedEdge uses -- a bare
// multi-letter LaTeX token like "componentTemperature" parses as implicit multiplication of
// single-letter variables (c*o*m*p*o*n*e*n*t...) unless wrapped, regardless of whether the symbol
// happens to be single- or multi-letter.
function latexForSelfTerm(selfTerm, targetStateSymbol) {
    return signedTermLatex(selfTerm.rate, `\\mathrm{${targetStateSymbol}}`).replace(/^\+ /, '');
}

async function commitCausalInference() {
    if (!causalInferenceState?.candidates || activeResult) return;
    const acceptedCandidates = causalInferenceState.candidates.filter((candidate) => candidate.accepted);
    const acceptedSelfTerms = (causalInferenceState.selfTerms ?? []).filter((term) => term.accepted);
    if (!acceptedCandidates.length && !acceptedSelfTerms.length) return;
    const status = $('#causalInferenceStatus');

    // New nodes land on a circle -- every edge between two imported nodes is then a chord inside
    // it, so nothing crosses through the middle of an unrelated node the way the generic 4-column
    // grid default (assistantOperations.mjs's defaultPosition) can. Existing nodes the CSV matched
    // keep whatever position they already have; only genuinely new nodes are placed, and the
    // circle is centered on those existing nodes (if any) so the new ones appear near what they
    // actually connect to rather than at an unrelated part of the model.
    const newEntryCount = causalInferenceState.mapping.filter((entry) => entry.createNew).length;
    const existingPositions = causalInferenceState.mapping
        .filter((entry) => !entry.createNew)
        .map((entry) => model.nodes.find((node) => node.id === entry.nodeId)?.position)
        .filter((position) => position?.length === 3);
    const circleCenter = existingPositions.length
        ? existingPositions.reduce((sum, position) => [0, 1, 2].map((axis) => sum[axis] + position[axis] / existingPositions.length), [0, 0, 0])
        : [0, 0, 0];
    // Radius derived from the chord-length formula (chord = 2*radius*sin(pi/n)) so adjacent new
    // nodes stay a constant ~3.6 units apart -- the same spacing defaultPosition's grid columns
    // use -- regardless of how many columns this CSV creates.
    const nodeSpacing = 3.6;
    const circleRadius = newEntryCount > 1 ? nodeSpacing / (2 * Math.sin(Math.PI / newEntryCount)) : 0;
    let newNodeIndex = 0;
    const nextCirclePosition = () => {
        const angle = (2 * Math.PI * newNodeIndex) / newEntryCount;
        newNodeIndex += 1;
        return [circleCenter[0] + circleRadius * Math.cos(angle), circleCenter[1] + circleRadius * Math.sin(angle), circleCenter[2]];
    };

    const operations = [];
    const resolvedColumns = new Map();
    causalInferenceState.mapping.forEach((entry, mappingIndex) => {
        if (entry.createNew) {
            const symbol = entry.suggestedSymbol ?? suggestSymbol(entry.columnName);
            const nodeRef = `causalInferenceNode${mappingIndex}`;
            const stateRef = `${nodeRef}State`;
            operations.push({ kind: 'addNode', ref: nodeRef, name: entry.columnName, position: nextCirclePosition(), shape: 'sphere' });
            operations.push({ kind: 'addState', nodeRef, ref: stateRef, name: symbol, symbol, initialValue: 0, unit: '' });
            resolvedColumns.set(entry.columnName, { nodeRef, stateRef, symbol });
        } else {
            const node = model.nodes.find((candidate) => candidate.id === entry.nodeId);
            const state = node.states.find((candidate) => candidate.id === entry.stateId);
            resolvedColumns.set(entry.columnName, { nodeId: entry.nodeId, stateId: entry.stateId, symbol: state.symbol });
        }
    });
    acceptedCandidates.forEach((candidate, index) => {
        const source = resolvedColumns.get(candidate.sourceColumn);
        const target = resolvedColumns.get(candidate.targetColumn);
        const edgeRef = `causalInferenceEdge${index}`;
        operations.push({
            kind: 'addEdge', ref: edgeRef, name: `${candidate.sourceColumn} → ${candidate.targetColumn}`,
            sourceNodeRef: source.nodeRef ?? source.nodeId, targetNodeRef: target.nodeRef ?? target.nodeId,
            directionality: 'directed'
        });
        operations.push({
            kind: 'setEdgeEquation', edgeRef, outputStateRef: target.stateRef ?? target.stateId,
            latex: latexForFittedEdge(candidate, source.symbol)
        });
    });
    acceptedSelfTerms.forEach((term, index) => {
        const target = resolvedColumns.get(term.targetColumn);
        operations.push({
            kind: 'addSourceTerm', ref: `causalInferenceSelfTerm${index}`,
            nodeRef: target.nodeRef ?? target.nodeId, outputStateRef: target.stateRef ?? target.stateId,
            latex: latexForSelfTerm(term, target.symbol)
        });
    });

    const baseDocument = serializeProjectDocument();
    let prepared;
    try {
        prepared = buildAssistantProposal(baseDocument, { proposalVersion: 1, operations });
    } catch (error) {
        status.className = 'equationDiagnostics';
        status.textContent = error.message;
        return;
    }
    const validation = await window.engine.validate(JSON.stringify(prepared.document));
    if (!validation.available || !validation.report.valid) {
        status.className = 'equationDiagnostics';
        status.textContent = validation.available
            ? (validation.report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join(' ')
                || 'The native validator rejected this import.')
            : 'The native validation engine is unavailable.';
        return;
    }

    const before = baseDocument;
    const after = prepared.document;
    replaceModelContents(after);
    recordHistory({ undo: () => replaceModelContents(before), redo: () => replaceModelContents(after) });
    resetCausalInference();
    $('#causalInference').classList.add('hidden');
}

$('#causalInferenceButton').addEventListener('click', openCausalInference);

async function loadCausalInferenceCsv(content) {
    const status = $('#causalInferenceStatus');
    try {
        const parsed = parseCsv(content);
        causalInferenceState = {
            csvContent: content,
            mapping: mapColumnsToNodes(parsed.columnNames, existingNodesForMapping()),
            candidates: null
        };
        status.className = 'equationDiagnostics valid';
        status.textContent = `Parsed ${parsed.columnNames.length} column${parsed.columnNames.length === 1 ? '' : 's'}, ${parsed.rows.length} rows.`;
        $('#causalInferenceMappingSection').hidden = false;
        $('#causalInferenceCandidatesSection').hidden = true;
        $('#causalInferenceCandidateRows').replaceChildren();
        $('#commitCausalInference').hidden = true;
        $('#commitCausalInference').disabled = true;
        renderCausalInferenceMapping();
        $('#runCausalInference').hidden = false;
        $('#runCausalInference').disabled = false;
    } catch (error) {
        causalInferenceState = null;
        status.className = 'equationDiagnostics';
        status.textContent = error.message;
        $('#causalInferenceMappingSection').hidden = true;
        $('#runCausalInference').hidden = true;
        $('#runCausalInference').disabled = true;
    }
}

$('#causalInferenceFile').addEventListener('change', async () => {
    const file = $('#causalInferenceFile').files[0];
    if (!file) return;
    await loadCausalInferenceCsv(await file.text());
});

// A real OS file-picker dialog behind <input type="file"> can't be driven by this app's
// interaction-test harness (a raw Electron BrowserWindow driven via webContents.executeJavaScript
// -- no Playwright setInputFiles/CDP bridge here, and .files can't be set from page-context JS
// for security reasons). This exposes the exact same CSV-loading path the real file input's
// change handler calls above, so a test can exercise parsing, column mapping, inference and
// commit end to end without a real file-picker -- the same reasoning as window.__debugTransform
// above for the 3D transform gizmo.
window.__debugCausalInference = {
    loadCsv: (content) => loadCausalInferenceCsv(content),
    // A candidate's fitted polynomial terms have no dedicated review-list UI to assert against
    // (renderCausalInferenceCandidates only shows source/target/lag/score/provenance) and the
    // resulting edge's equation is otherwise only readable by clicking its canvas line open --
    // fragile this deep into the interaction suite, where accumulated camera/geometry state from
    // 60+ prior tests can leave a relationship's projected midpoint raycasting to the wrong
    // object. Exposing the raw candidate data lets a test verify a fitted term (e.g. a degree >=
    // 2 one) reached the UI without depending on canvas hit-testing at all.
    candidates: () => structuredClone(causalInferenceState?.candidates ?? null),
    selfTerms: () => structuredClone(causalInferenceState?.selfTerms ?? null),
    // Committed source terms have no node/edge-style count in .modelStatus to assert against, and
    // (like candidates() above) reading them back via a node's own editor is fragile this deep
    // into the interaction suite -- the serialized document is the only reliable place to check
    // one actually landed.
    document: () => serializeProjectDocument()
};

$('#causalInferenceDegreeMode').addEventListener('change', () => {
    $('#causalInferenceDegreeValueField').hidden = $('#causalInferenceDegreeMode').value === 'linear';
});

$('#causalInferenceContinuousTime').addEventListener('change', () => {
    $('#causalInferenceContinuousTimeHint').hidden = !$('#causalInferenceContinuousTime').checked;
});

function causalInferenceDegreesFromUi() {
    const mode = $('#causalInferenceDegreeMode').value;
    if (mode === 'linear') return [1];
    const degree = Number($('#causalInferenceDegreeValue').value);
    return mode === 'auto' ? [1, degree] : [degree];
}

$('#runCausalInference').addEventListener('click', async () => {
    if (!causalInferenceState || activeResult) return;
    const button = $('#runCausalInference');
    const status = $('#causalInferenceStatus');
    button.disabled = true;
    status.className = 'equationDiagnostics';
    status.textContent = 'Running inference…';
    try {
        const continuousTime = $('#causalInferenceContinuousTime').checked;
        const config = { candidateDegrees: causalInferenceDegreesFromUi(), continuousTime };
        // continuousTime requires candidateLags == {1} engine-side (a predictor from 2+ CSV rows
        // back has no single-Euler-step interpretation) -- candidateLags otherwise defaults to
        // {1, 2, 3} engine-side, so this must be explicit or the engine rejects the request.
        if (continuousTime) config.candidateLags = [1];
        const result = await window.engine.infer(causalInferenceState.csvContent, config);
        if (!result.available) throw new Error('The native inference engine is unavailable.');
        causalInferenceState.candidates = result.report.edges.map((edge) => ({ ...edge, accepted: true }));
        causalInferenceState.selfTerms = (result.report.selfTerms ?? []).map((term) => ({ ...term, accepted: true }));
        const selfTermCount = causalInferenceState.selfTerms.length;
        status.className = 'equationDiagnostics valid';
        status.textContent = `Found ${causalInferenceState.candidates.length} candidate relationship${causalInferenceState.candidates.length === 1 ? '' : 's'}`
            + (selfTermCount ? ` and ${selfTermCount} self term${selfTermCount === 1 ? '' : 's'}.` : '.');
        $('#causalInferenceCandidatesSection').hidden = false;
        $('#commitCausalInference').hidden = false;
        renderCausalInferenceCandidates();
        renderCausalInferenceSelfTerms();
    } catch (error) {
        status.className = 'equationDiagnostics';
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

$('#cancelCausalInference').addEventListener('click', () => {
    resetCausalInference();
    $('#causalInference').classList.add('hidden');
});

$('#commitCausalInference').addEventListener('click', () => { commitCausalInference(); });

function assistantModelSummary() {
    const document = serializeProjectDocument();
    return {
        format: document.format,
        version: document.version,
        units: document.metadata.units,
        nodes: document.nodes.map((node) => ({
            id: node.id, name: node.name, type: node.type, enabled: node.enabled !== false,
            states: node.states.map((state) => ({ id: state.id, name: state.name, symbol: state.symbol, initialValue: state.initialValue, unit: state.unit }))
        })),
        edges: document.edges.map((edge) => ({
            id: edge.id, name: edge.name, sourceNodeId: edge.source.nodeId,
            targetNodeId: edge.target.nodeId, directionality: edge.directionality, enabled: edge.enabled !== false
        }))
    };
}

async function refreshAssistantConfigurations() {
    const select = $('#assistantConfiguration');
    try {
        const result = await window.aiProviders.listConfigurations();
        assistantConfigurationCatalog = result;
        const previous = activeAssistantConfigurationUuid || select.value;
        select.replaceChildren(...result.configurations.map((configuration) => {
            const locality = configuration.provider === 'localDemonstration' || configuration.provider === 'ollama' ? 'Local' : 'Online';
            return new Option(`${configuration.name} · ${locality}`, configuration.uuid);
        }));
        activeAssistantConfigurationUuid = result.configurations.some((item) => item.uuid === previous)
            ? previous : result.activeConfigurationUuid;
        select.value = activeAssistantConfigurationUuid;
        select.disabled = false;
    } catch (error) {
        select.replaceChildren(new Option('Configurations unavailable', ''));
        select.disabled = true;
        renderAssistantGenerationError(error.message);
    }
}

function activeConfigurationRecord() {
    return assistantConfigurationCatalog.configurations.find((configuration) => configuration.uuid === $('#assistantConfiguration').value);
}

function selectedProviderDescriptor() {
    return assistantConfigurationCatalog.providers.find((provider) => provider.id === $('#assistantConfigurationProvider').value);
}

function assistantConfigurationDraftSignature() {
    return JSON.stringify({ ...assistantConfigurationFormValue(), credential: $('#assistantConfigurationCredential').value });
}

function assistantConfigurationIsDirty() {
    return assistantConfigurationBaseline && assistantConfigurationDraftSignature() !== assistantConfigurationBaseline;
}

function selectedAssistantModel() {
    return $('#assistantConfigurationModel').value === '__custom__'
        ? $('#assistantCustomModel').value.trim() : $('#assistantConfigurationModel').value;
}

function setAssistantModelChoices(models, selectedModel = '') {
    const discovered = models.some((model) => model.id === selectedModel);
    const options = [new Option(models.length ? 'Select a model' : 'Discover available models', '')];
    options.push(...models.map((model) => new Option(model.name, model.id)));
    if (selectedModel && !discovered) options.push(new Option(selectedModel, selectedModel));
    options.push(new Option('Custom model ID…', '__custom__'));
    $('#assistantConfigurationModel').replaceChildren(...options);
    $('#assistantConfigurationModel').value = selectedModel || '';
    $('#assistantCustomModel').value = '';
    $('#assistantCustomModel').hidden = true;
}

function syncAssistantCustomModel() {
    const custom = $('#assistantConfigurationModel').value === '__custom__';
    $('#assistantCustomModel').hidden = !custom;
    if (custom) $('#assistantCustomModel').focus();
}

function setAssistantConfigurationStatus(message = '', tone = 'neutral') {
    const status = $('#assistantConfigurationStatus');
    status.textContent = message;
    status.className = `assistantConfigurationStatus ${tone}`;
}

function assistantConfigurationErrorMessage(error) {
    const message = error?.message || 'The model provider could not be reached.';
    if ($('#assistantConfigurationProvider').value === 'ollama' &&
        /connect|fetch|network|refused|abort|timed?\s*out/i.test(message)) {
        return 'Ollama is not reachable. Install Ollama if needed, start the Ollama service, then try again.';
    }
    return message;
}

function confirmAssistantConfigurationNavigation() {
    return !assistantConfigurationIsDirty() || window.confirm('Discard unsaved changes to this model configuration?');
}

function renderAssistantConfigurationList() {
    const query = $('#searchAssistantConfigurations').value.trim().toLowerCase();
    const selectedUuid = $('#assistantConfigurationUuid').value;
    const configurations = assistantConfigurationCatalog.configurations.filter((configuration) =>
        `${configuration.name} ${configuration.provider} ${configuration.model}`.toLowerCase().includes(query));
    $('#assistantConfigurationList').replaceChildren(...configurations.map((configuration) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.configurationUuid = configuration.uuid;
        button.classList.toggle('selected', configuration.uuid === selectedUuid);
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(configuration.uuid === selectedUuid));
        const provider = assistantConfigurationCatalog.providers.find((item) => item.id === configuration.provider);
        const title = document.createElement('strong');
        title.textContent = configuration.name;
        const details = document.createElement('span');
        details.textContent = configuration.builtIn ? 'Built-in · Local' : `${provider?.name ?? configuration.provider} · ${configuration.model || 'No model selected'}`;
        button.append(title, details);
        if (configuration.uuid === activeAssistantConfigurationUuid) {
            const active = document.createElement('i');
            active.textContent = 'Active';
            button.append(active);
        }
        return button;
    }));
}

function syncAssistantProviderFields({ replaceEndpoint = false } = {}) {
    const provider = selectedProviderDescriptor();
    if (!provider) return;
    if (replaceEndpoint || !$('#assistantConfigurationEndpoint').value) $('#assistantConfigurationEndpoint').value = provider.defaultEndpoint;
    if (replaceEndpoint && !$('#assistantConfigurationUuid').value) {
        $('#assistantConfigurationTimeout').value = provider.defaultTimeoutSeconds ?? 60;
    }
    $('#assistantCredentialField').hidden = !provider.credentialRequired;
    const existing = assistantConfigurationCatalog.configurations.find((item) => item.uuid === $('#assistantConfigurationUuid').value);
    $('#assistantConfigurationCredential').required = provider.credentialRequired && !existing?.credentialConfigured;
}

function populateAssistantConfiguration(configuration = null) {
    assistantDiscoveryRevision += 1;
    const providers = assistantConfigurationCatalog.providers;
    const selectableProviders = providers.filter((provider) => provider.id !== 'localDemonstration');
    const initialProvider = configuration?.provider ?? selectableProviders.find((provider) => provider.id === 'ollama')?.id ?? selectableProviders[0]?.id ?? '';
    $('#assistantConfigurationUuid').value = configuration?.uuid ?? '';
    $('#assistantConfigurationName').value = configuration?.name ?? 'My local model';
    $('#assistantConfigurationProvider').value = initialProvider;
    $('#assistantConfigurationEndpoint').value = configuration?.endpoint ?? '';
    setAssistantModelChoices([], configuration?.model ?? '');
    const initialDescriptor = providers.find((provider) => provider.id === initialProvider);
    $('#assistantConfigurationTimeout').value = configuration?.timeoutSeconds ?? initialDescriptor?.defaultTimeoutSeconds ?? 60;
    $('#assistantConfigurationCredential').value = '';
    $('#assistantConfigurationDialogTitle').textContent = configuration?.name ?? 'New configuration';
    $('#assistantCredentialHint').textContent = configuration?.credentialConfigured ? 'Leave blank to preserve the stored key' : 'Stored only when this configuration is saved';
    $('#assistantConfigurationFields').disabled = Boolean(configuration?.builtIn);
    $('#deleteAssistantConfiguration').hidden = !configuration || configuration.builtIn;
    $('#testAssistantConfiguration').hidden = Boolean(configuration?.builtIn);
    $('#saveAssistantConfiguration').hidden = Boolean(configuration?.builtIn);
    setAssistantConfigurationStatus(
        assistantConfigurationCatalog.credentialStorage?.plainText
            ? 'Secure persistent credentials are unavailable with the current operating-system backend.' : '',
        assistantConfigurationCatalog.credentialStorage?.plainText ? 'error' : 'neutral'
    );
    syncAssistantProviderFields();
    assistantConfigurationBaseline = assistantConfigurationDraftSignature();
    renderAssistantConfigurationList();
    clearTimeout(assistantDiscoveryTimer);
    if (!configuration?.builtIn && initialProvider === 'ollama') {
        assistantDiscoveryTimer = setTimeout(discoverAssistantModels, 350);
    }
}

function openAssistantConfigurationDialog() {
    const providers = assistantConfigurationCatalog.providers;
    $('#assistantConfigurationProvider').replaceChildren(...providers.map((provider) => {
        const option = new Option(provider.name, provider.id);
        option.disabled = provider.id === 'localDemonstration';
        return option;
    }));
    $('#searchAssistantConfigurations').value = '';
    populateAssistantConfiguration(activeConfigurationRecord());
    $('#assistantConfigurationDialog').showModal();
}

function assistantConfigurationFormValue() {
    return {
        uuid: $('#assistantConfigurationUuid').value || undefined,
        name: $('#assistantConfigurationName').value,
        provider: $('#assistantConfigurationProvider').value,
        endpoint: $('#assistantConfigurationEndpoint').value,
        model: selectedAssistantModel(),
        timeoutSeconds: Number($('#assistantConfigurationTimeout').value)
    };
}

async function saveAssistantConfiguration() {
    const credential = $('#assistantConfigurationCredential').value || undefined;
    const saved = await window.aiProviders.saveConfiguration(assistantConfigurationFormValue(), credential);
    activeAssistantConfigurationUuid = saved.uuid;
    await window.aiProviders.setActiveConfiguration(saved.uuid);
    await refreshAssistantConfigurations();
    $('#assistantConfiguration').value = saved.uuid;
    $('#assistantConfigurationCredential').value = '';
    populateAssistantConfiguration(assistantConfigurationCatalog.configurations.find((configuration) => configuration.uuid === saved.uuid));
    setAssistantConfigurationStatus('Configuration saved and selected.');
}

async function discoverAssistantModels() {
    const revision = ++assistantDiscoveryRevision;
    setAssistantConfigurationStatus('Discovering models…');
    try {
        const models = await window.aiProviders.listDraftModels(
            assistantConfigurationFormValue(), $('#assistantConfigurationCredential').value || undefined
        );
        if (revision !== assistantDiscoveryRevision || !$('#assistantConfigurationDialog').open) return;
        const selectedModel = selectedAssistantModel();
        setAssistantModelChoices(models, selectedModel || models[0]?.id || '');
        setAssistantConfigurationStatus(models.length ? '' : 'Connected, but no compatible models were found.', models.length ? 'neutral' : 'warning');
    } catch (error) {
        if (revision !== assistantDiscoveryRevision || !$('#assistantConfigurationDialog').open) return;
        setAssistantConfigurationStatus(assistantConfigurationErrorMessage(error), 'error');
    }
}

function renderAssistantGenerationError(message) {
    pendingAssistantProposal = null;
    updateAssistantTurnOutcome(pendingAssistantTurnRecord, `Error: ${message}`);
    pendingAssistantTurnRecord = null;
    $('#assistantEmpty').hidden = true;
    $('#assistantClarification').hidden = true;
    $('#assistantProposal').hidden = false;
    $('#assistantProposalSummary').textContent = 'No proposal generated';
    $('#assistantProposalStatus').className = '';
    $('#assistantProposalStatus').textContent = 'The request needs attention';
    $('#assistantAssumptionsSection').hidden = true;
    $('#assistantChanges').replaceChildren();
    $('#assistantError').textContent = message;
    $('#assistantError').hidden = false;
    $('#applyAssistantProposal').disabled = true;
    updateAssistantCollapsedStatus('Request needs attention');
}

async function requestAssistantProposal() {
    if (activeResult) return { valid: false, error: 'Close simulation results before preparing model changes.' };
    assistantGenerationController?.abort();
    const controller = new AbortController();
    assistantGenerationController = controller;
    const requestUuid = crypto.randomUUID();
    controller.signal.addEventListener('abort', () => {
        window.aiProviders.cancelRequest(requestUuid).catch(() => {});
    }, { once: true });
    const request = $('#assistantPrompt').value.trim();
    const button = $('#generateAssistantProposal');
    button.disabled = true;
    button.textContent = 'Preparing…';
    updateAssistantCollapsedStatus('Preparing proposal…');
    $('#assistantEmpty').hidden = false;
    $('#assistantProposal').hidden = true;
    $('#assistantClarification').hidden = true;
    try {
        const response = await window.aiProviders.generateProposal(
            requestUuid, $('#assistantConfiguration').value, request, assistantModelSummary(), assistantTurnHistory
        );
        if (controller.signal.aborted) return { valid: false, cancelled: true };
        // Clear the prompt only once a response has actually arrived, not before sending --
        // losing what was typed to a network hiccup or timeout would be worse than a stale
        // textarea. Still empties for a clarification exactly as it would for a proposal, so a
        // reply is always typed fresh rather than editing the question back down to an answer.
        $('#assistantPrompt').value = '';
        if (response.responseKind === 'clarification') {
            pendingAssistantTurnRecord = pushAssistantTurn(request, `Asked: ${response.question}`);
            renderAssistantClarification(response);
            return { valid: false, clarification: response };
        }
        pendingAssistantTurnRecord = pushAssistantTurn(request, `Proposed: ${response.summary?.trim() || 'model changes'}`);
        return await previewAssistantProposal(response);
    } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return { valid: false, cancelled: true };
        renderAssistantGenerationError(error.message);
        return { valid: false, error: error.message };
    } finally {
        if (assistantGenerationController === controller) {
            assistantGenerationController = null;
            button.disabled = false;
            button.textContent = pendingAssistantProposal ? 'Revise proposal'
                : !$('#assistantClarification').hidden ? 'Answer'
                    : 'Generate proposal';
        }
    }
}

$('#assistantButton').addEventListener('click', () => {
    if ($('#assistantPanel').hidden) showAssistantPanel();
    else hideAssistantPanel();
});
$('#closeAssistantPanel').addEventListener('click', hideAssistantPanel);
$('#collapseAssistantPanel').addEventListener('click', () => {
    setAssistantCollapsed(!$('#assistantPanel').classList.contains('collapsed'));
});
$('#discardAssistantProposal').addEventListener('click', () => {
    if (pendingAssistantProposal) {
        updateAssistantTurnOutcome(pendingAssistantTurnRecord, `Discarded: ${pendingAssistantProposal.proposal.summary?.trim() || 'a proposed change'}`);
    }
    discardAssistantProposal();
});
$('#applyAssistantProposal').addEventListener('click', commitAssistantProposal);
$('#assistantChanges').addEventListener('click', (event) => {
    const control = event.target.closest('[data-focus-entity]');
    if (control) inspectAssistantEntity(Number(control.dataset.focusEntity));
});
$('#dismissAssistantClarification').addEventListener('click', dismissAssistantClarification);
$('#assistantClarificationOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-suggestion]');
    if (!button) return;
    $('#assistantPrompt').value = button.dataset.suggestion;
    $('#assistantPrompt').focus();
});
$('#newAssistantConversation').addEventListener('click', () => {
    const hasSomethingToLose = assistantTurnHistory.length > 0 || Boolean(pendingAssistantProposal) || !$('#assistantClarification').hidden;
    if (hasSomethingToLose && !window.confirm('Start a new conversation? This clears the assistant’s memory of this exchange and cannot be undone.')) return;
    assistantGenerationController?.abort();
    discardAssistantProposal();
    resetAssistantConversation();
});
$('#assistantPromptForm').addEventListener('submit', (event) => {
    event.preventDefault();
    requestAssistantProposal();
});
$('#assistantConfiguration').addEventListener('change', async () => {
    activeAssistantConfigurationUuid = $('#assistantConfiguration').value;
    assistantGenerationController?.abort();
    discardAssistantProposal();
    resetAssistantConversation();
    await window.aiProviders.setActiveConfiguration(activeAssistantConfigurationUuid).catch((error) => renderAssistantGenerationError(error.message));
});
$('#manageAssistantConfigurations').addEventListener('click', openAssistantConfigurationDialog);
$('#assistantConfigurationProvider').addEventListener('change', () => {
    syncAssistantProviderFields({ replaceEndpoint: true });
    setAssistantModelChoices([]);
    clearTimeout(assistantDiscoveryTimer);
    if ($('#assistantConfigurationProvider').value === 'ollama') {
        assistantDiscoveryTimer = setTimeout(discoverAssistantModels, 350);
    }
});
$('#assistantConfigurationModel').addEventListener('change', syncAssistantCustomModel);
$('#cancelAssistantConfiguration').addEventListener('click', () => {
    if (confirmAssistantConfigurationNavigation()) $('#assistantConfigurationDialog').close();
});
$('#assistantConfigurationDialog').addEventListener('cancel', (event) => {
    if (!confirmAssistantConfigurationNavigation()) event.preventDefault();
});
$('#newAssistantConfiguration').addEventListener('click', () => {
    if (!confirmAssistantConfigurationNavigation()) return;
    populateAssistantConfiguration();
});
$('#searchAssistantConfigurations').addEventListener('input', renderAssistantConfigurationList);
$('#assistantConfigurationList').addEventListener('click', (event) => {
    const control = event.target.closest('[data-configuration-uuid]');
    if (!control || !confirmAssistantConfigurationNavigation()) return;
    const configuration = assistantConfigurationCatalog.configurations.find((item) => item.uuid === control.dataset.configurationUuid);
    if (configuration) populateAssistantConfiguration(configuration);
});
$('#assistantConfigurationDialog').addEventListener('submit', async (event) => {
    event.preventDefault();
    setAssistantConfigurationStatus('Saving configuration…');
    try { await saveAssistantConfiguration(); } catch (error) { setAssistantConfigurationStatus(error.message, 'error'); }
});
$('#discoverAssistantModels').addEventListener('click', discoverAssistantModels);
$('#testAssistantConfiguration').addEventListener('click', async () => {
    setAssistantConfigurationStatus('Testing connection…');
    try {
        const result = await window.aiProviders.testDraftConnection(
            assistantConfigurationFormValue(), $('#assistantConfigurationCredential').value || undefined
        );
        setAssistantConfigurationStatus('Connection successful.');
    } catch (error) { setAssistantConfigurationStatus(assistantConfigurationErrorMessage(error), 'error'); }
});
$('#deleteAssistantConfiguration').addEventListener('click', async () => {
    const uuid = $('#assistantConfigurationUuid').value;
    if (!uuid || !window.confirm('Delete this model configuration and its stored credential?')) return;
    const index = assistantConfigurationCatalog.configurations.findIndex((configuration) => configuration.uuid === uuid);
    await window.aiProviders.removeConfiguration(uuid);
    activeAssistantConfigurationUuid = null;
    await refreshAssistantConfigurations();
    const next = assistantConfigurationCatalog.configurations[Math.min(index, assistantConfigurationCatalog.configurations.length - 1)];
    populateAssistantConfiguration(next ?? null);
    setAssistantConfigurationStatus('Configuration deleted.');
});
$('#assistantPrompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        $('#assistantPromptForm').requestSubmit();
    }
});
installAssistantDragging();
window.addEventListener('resize', clampAssistantPanel);

window.konjugateAssistant = Object.freeze({
    getModelSummary: assistantModelSummary,
    requestProposal: requestAssistantProposal,
    previewProposal: previewAssistantProposal,
    applyProposal: commitAssistantProposal,
    discardProposal: discardAssistantProposal,
    dismissClarification: dismissAssistantClarification,
    getTurnHistory: () => structuredClone(assistantTurnHistory),
    resetConversation: resetAssistantConversation
});

function openNodeBuilder(clientX, clientY) {
    const builder = $('#nodeBuilder');
    hideCards(builder);
    $('#newNodeName').value = 'New node';
    $('#newNodeShape').value = 'box';
    $('#newNodeColor').value = '#34727a';
    $('#nodeGeometryFile').value = '';
    $('#geometryImportStatus').classList.remove('loading', 'error');
    $('#geometryImportStatus').textContent = 'No geometry selected';
    pendingImportedGeometry?.dispose();
    pendingImportedGeometry = null;
    pendingGeometryFileName = '';
    $('#stateVariableRows').replaceChildren();
    $('#sourceTermRows').replaceChildren();
    addStateVariableRow();
    positionCard(builder, clientX, clientY);
    $('#newNodeName').select();
}

function openEdgeBuilder(clientX, clientY) {
    const builder = $('#edgeBuilder');
    hideCards(builder);
    pendingBidirectionalTemplate = null;
    $('#newEdgeName').value = 'New relationship';
    $('#newEdgeColor').value = '#9c83c4';
    $('#edgeImplementationKind').value = 'equation';
    $('#edgeEquation').value = '';
    $('#edgeMathField').setValue('', { silenceNotifications: true });
    $('#edgeMathField').hidden = false;
    $('#edgeEquation').hidden = true;
    $('#edgeEquationHeading').hidden = false;
    $('#builderEquationDiagnostics').hidden = false;
    $('#edgeReferencePicker').hidden = false;
    $('#edgeProviderSection').hidden = true;
    $('#edgeProviderSource').value = '';
    $('#insertProviderTemplate').hidden = true;
    $('#providerOutputKey').value = '';
    $('#providerBindingRows').replaceChildren();
    $$('[data-builder-equation-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.builderEquationMode === 'visual');
    });
    $('#edgeParameterRows').replaceChildren();
    finishEndpointPick();
    $('#edgeSource').replaceChildren();
    $('#edgeTarget').replaceChildren();
    refreshEndpointOptions();
    addEdgeParameterRow({ name: 'Coefficient', symbol: 'k', value: '1' });
    builder.style.removeProperty('left');
    builder.style.removeProperty('top');
    builder.classList.remove('hidden');
}

// Reuses the edge builder's own endpoint-pick flow: pre-fills the source with the node that was
// right-clicked, then immediately starts picking the target on the canvas, same as clicking the
// builder's own "pick target" control would.
function connectFromNode(node) {
    openEdgeBuilder();
    $('#edgeSource').value = String(node.userData.definition.id);
    refreshStateReferences();
    startEndpointPick('target');
}

let nodePointerDown = null;
let relationshipPointerDown = null;
const relationshipHoldDurationMs = 450;
// Distinguishes a genuine "press and hold in place" from a drag that happens to start on an
// edge (e.g. panning) -- cancels the pending hold if the pointer moves before it fires.
const relationshipHoldTravelLimit = 6;
// Staged by the contextmenu handler below and consumed by #edgeContextMenu's/#waypointContextMenu's
// own click handlers -- context-menu opening is itself deferred (see stageContextMenuAction), so
// this can't just be a local passed straight into an inline handler.
let pendingWaypoint = null;
let pendingWaypointRemoval = null;

// The 42 here must match curve.getPoints(42) in createRelationship/updateRelationships -- a
// Line raycast intersection's .index is a segment index into that same sampled geometry, so
// intersection.index / 42 approximates the hit's parameter along the curve. Each existing
// waypoint i sits at exactly t = (i+1)/(waypoints.length+1) on an open CatmullRomCurve3, so the
// insertion index is just how many existing waypoints come before the hit along the curve.
function waypointInsertionIndex(definition, hitSegmentIndex) {
    const waypoints = definition.waypoints ?? [];
    const tHit = hitSegmentIndex / 42;
    return waypoints.filter((_, i) => (i + 1) / (waypoints.length + 1) < tHit).length;
}

function captureAdditiveNodeSelection(event) {
    if (event.button !== 0 || !event.shiftKey || activeEndpointPick || currentTool === 'rectangleSelect') return;
    const label = event.target.closest?.('.node-label-container');
    let node = label ? nodeObjects.get(Number(label.dataset.node)) : null;
    if (!node && event.currentTarget === renderer.domElement) {
        setPointerFromEvent(event);
        node = rootNodeFromIntersection(firstIntersection(nodePickTargets));
    }
    if (!node) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectNode(node, { additive: true });
}

renderer.domElement.addEventListener('pointerdown', captureAdditiveNodeSelection, { capture: true });
css2dContainer.addEventListener('pointerdown', captureAdditiveNodeSelection, { capture: true });

let rectangleSelection = null;

function updateSelectionRectangle(clientX, clientY) {
    if (!rectangleSelection) return;
    const canvasBounds = canvas.getBoundingClientRect();
    const left = Math.min(rectangleSelection.startX, clientX);
    const top = Math.min(rectangleSelection.startY, clientY);
    const rectangle = $('#selectionRectangle');
    rectangle.style.left = `${left - canvasBounds.left}px`;
    rectangle.style.top = `${top - canvasBounds.top}px`;
    rectangle.style.width = `${Math.abs(clientX - rectangleSelection.startX)}px`;
    rectangle.style.height = `${Math.abs(clientY - rectangleSelection.startY)}px`;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
    if (currentTool !== 'rectangleSelect' || event.button !== 0 || activeResult) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    rectangleSelection = { startX: event.clientX, startY: event.clientY, additive: event.shiftKey };
    const rectangle = $('#selectionRectangle');
    rectangle.hidden = false;
    updateSelectionRectangle(event.clientX, event.clientY);
}, { capture: true });

window.addEventListener('pointermove', (event) => {
    if (rectangleSelection) updateSelectionRectangle(event.clientX, event.clientY);
});

window.addEventListener('pointerup', (event) => {
    if (!rectangleSelection || event.button !== 0) return;
    const selection = rectangleSelection;
    rectangleSelection = null;
    $('#selectionRectangle').hidden = true;
    const left = Math.min(selection.startX, event.clientX);
    const right = Math.max(selection.startX, event.clientX);
    const top = Math.min(selection.startY, event.clientY);
    const bottom = Math.max(selection.startY, event.clientY);
    const rendererBounds = renderer.domElement.getBoundingClientRect();
    const hits = [...nodeObjects.values()].filter((node) => {
        if (!node.visible) return false;
        const projected = node.position.clone().project(camera);
        const x = rendererBounds.left + (projected.x + 1) * rendererBounds.width / 2;
        const y = rendererBounds.top + (1 - projected.y) * rendererBounds.height / 2;
        return x >= left && x <= right && y >= top && y <= bottom;
    });
    if (!selection.additive) clearSelection();
    hits.forEach((node) => {
        if (!selectedNodeIds.has(node.userData.id)) selectNode(node, { additive: true });
    });
    if (hits.length) $('#statusText').textContent = `${selectedNodeIds.size} node${selectedNodeIds.size === 1 ? '' : 's'} selected`;
});

// OrbitControls' default right-drag pans the camera, and on macOS `contextmenu` fires practically
// on mousedown -- before any drag distance exists to measure and before the eventual `pointerup`
// even happens, let alone reports where it happens. So instead of deciding at `contextmenu` time,
// each handler below only *stages* what it would open; the actual opening is deferred until the
// right button is released, at which point the total pointerdown-to-pointerup travel decides
// whether this was a click (stage the action) or a drag that panned the camera (discard it).
// Listeners live on `window` in the capture phase (rather than on renderer.domElement) so they
// also see drags that start on a CSS2D label/overlay, which stop propagation to the canvas on
// their own pointerdown.
let rightPointerDown = null;
let stagedContextMenuAction = null;
window.addEventListener('pointerdown', (event) => {
    if (event.button === 2) { rightPointerDown = { x: event.clientX, y: event.clientY }; stagedContextMenuAction = null; }
}, { capture: true });
window.addEventListener('pointerup', (event) => {
    if (event.button !== 2 || !rightPointerDown) return;
    const dragged = Math.hypot(event.clientX - rightPointerDown.x, event.clientY - rightPointerDown.y) > 4;
    rightPointerDown = null;
    if (!dragged) stagedContextMenuAction?.();
    stagedContextMenuAction = null;
}, { capture: true });
function stageContextMenuAction(action) {
    stagedContextMenuAction = action;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || transformControls.dragging) return;
    setPointerFromEvent(event);
    const subsystemHit = firstIntersection([...subsystemObjects.values()].filter((object) => object.visible));
    if (subsystemHit) {
        nodePointerDown = null;
        enterSubsystem(subsystemHit.object.userData.id);
        return;
    }
    const nodeIntersection = firstIntersection(nodePickTargets);
    const node = rootNodeFromIntersection(nodeIntersection);

    if (node) {
        const wasSelected = selectedNodeIds.has(node.userData.id);
        if (!wasSelected) selectNode(node);
        if (activeEndpointPick) {
            nodePointerDown = null;
            chooseEndpointNode(node.userData.id);
            return;
        }
        nodePointerDown = { id: node.userData.id, x: event.clientX, y: event.clientY, wasSelected };
        if (!activeResult && currentTool in transformPropertyForTool && selectedNodeIds.has(node.userData.id)) transformControls.attach(node);
        return;
    }

    nodePointerDown = null;

    if (activeEndpointPick) return;
    if (event.shiftKey) return;

    // A waypoint handle isn't reachable via rootNodeFromIntersection's node-only walk (by
    // design -- it degrades to null for any non-'node' kind), so it falls through to here just
    // like empty canvas would. Bail out without touching selection and let DragControls' own
    // pointerdown (registered earlier, same element) start the drag -- otherwise clearSelection()
    // below would tear down the very handle the user is about to drag before DragControls sees it.
    if (nodeIntersection?.object.userData.kind === 'waypoint') return;

    const relationshipHit = firstIntersection(relationshipPickTargets);
    if (relationshipHit) {
        // A quick click still opens the editor (via pointerup below, once travel is known) --
        // pressing and holding in place instead enters waypoint routing: the edge gets
        // selected (which is what already makes its waypoint handles visible) without the
        // editor card popping up over it.
        const definition = relationshipHit.object.userData.definition;
        relationshipPointerDown = {
            definition,
            x: event.clientX,
            y: event.clientY,
            holdTriggered: false,
            timer: setTimeout(() => {
                relationshipPointerDown.holdTriggered = true;
                selectRelationship(definition);
                transformControls.detach();
                $('#statusText').textContent = `Editing waypoints · ${definition.title}`;
            }, relationshipHoldDurationMs)
        };
        return;
    }

    clearSelection();
    hideCards();
});

renderer.domElement.addEventListener('pointermove', (event) => {
    if (!relationshipPointerDown || relationshipPointerDown.holdTriggered) return;
    const travel = Math.hypot(event.clientX - relationshipPointerDown.x, event.clientY - relationshipPointerDown.y);
    if (travel > relationshipHoldTravelLimit) {
        clearTimeout(relationshipPointerDown.timer);
        relationshipPointerDown = null;
    }
});

renderer.domElement.addEventListener('pointerup', (event) => {
    if (relationshipPointerDown) {
        clearTimeout(relationshipPointerDown.timer);
        const { definition, x, y, holdTriggered } = relationshipPointerDown;
        relationshipPointerDown = null;
        if (holdTriggered || event.button !== 0) return;
        const pointerTravel = Math.hypot(event.clientX - x, event.clientY - y);
        if (pointerTravel <= 4) {
            selectRelationship(definition);
            transformControls.detach();
            openRelationshipEditor(definition);
        }
        return;
    }

    if (event.button !== 0 || !nodePointerDown || activeEndpointPick) {
        nodePointerDown = null;
        return;
    }
    const pointerTravel = Math.hypot(
        event.clientX - nodePointerDown.x,
        event.clientY - nodePointerDown.y
    );
    const node = nodeObjects.get(nodePointerDown.id);
    const { wasSelected } = nodePointerDown;
    nodePointerDown = null;
    if (pointerTravel <= 4 && node?.visible && !event.shiftKey) {
        if (wasSelected && selectedNodeIds.size > 1) selectNode(node);
        openNodeEditor(node.userData.definition);
    }
});

renderer.domElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    setPointerFromEvent(event);
    const nodeIntersection = firstIntersection(nodePickTargets);
    const node = rootNodeFromIntersection(nodeIntersection);

    if (node) {
        stageContextMenuAction(() => {
            if (activeResult) { selectNode(node); return; }
            if (!(selectedNodeIds.size > 1 && selectedNodeIds.has(node.userData.id))) selectNode(node);
            openNodeContextMenu(event.clientX, event.clientY);
        });
        return;
    }

    if (nodeIntersection?.object.userData.kind === 'waypoint') {
        const { relationshipId, index } = nodeIntersection.object.userData;
        stageContextMenuAction(() => {
            if (activeResult) return;
            pendingWaypointRemoval = { relationshipId, index };
            openWaypointContextMenu(event.clientX, event.clientY);
        });
        return;
    }

    const relationshipHit = firstIntersection(relationshipPickTargets);
    if (relationshipHit) {
        stageContextMenuAction(() => {
            const definition = relationshipHit.object.userData.definition;
            selectRelationship(definition);
            if (!activeResult) {
                // relationshipHit.index only exists on a Line-geometry hit (the edge itself, not
                // its direction-marker cone, which reports .faceIndex instead) -- so this is
                // simultaneously "was the line clicked" and the sample index needed below.
                pendingWaypoint = relationshipHit.index === undefined ? null : {
                    relationshipId: definition.id,
                    point: relationshipHit.point.toArray(),
                    insertionIndex: waypointInsertionIndex(definition, relationshipHit.index)
                };
                openEdgeContextMenu(event.clientX, event.clientY);
            }
        });
        return;
    }

    stageContextMenuAction(() => {
        if (!activeResult) openAddPalette(event.clientX, event.clientY);
    });
});

$$('[data-close-card]').forEach((button) => {
    button.addEventListener('click', () => {
        if (button.closest('#edgeEditor')) finishEquationEdit();
        if (button.closest('#edgeGroupEditor')) finishEquationEdit();
        if (button.closest('#edgeBuilder')) finishEndpointPick();
        if (button.closest('#sourceTermEditor')) {
            finishEquationEdit();
            const node = selectedSourceTermNodeId ? nodeObjects.get(selectedSourceTermNodeId) : null;
            selectedSourceTermNodeId = null;
            selectedSourceTermId = null;
            button.closest('.contextCard').classList.add('hidden');
            if (node) openNodeEditor(node.userData.definition);
            return;
        }
        button.closest('.contextCard').classList.add('hidden');
    });
});

$$('[data-node-tab]').forEach((button) => {
    button.addEventListener('click', () => selectNodeEditorTab(button.dataset.nodeTab));
});

$('#editNodeName').addEventListener('change', (event) => {
    if (!selectedNode) return;
    changeNodeModel(selectedNode, (snapshot) => {
        snapshot.title = event.target.value.trim() || 'Untitled node';
    });
});
$('#editNodeType').addEventListener('change', (event) => {
    if (!selectedNode) return;
    changeNodeModel(selectedNode, (snapshot) => {
        snapshot.type = event.target.value.trim() || 'Custom node';
    });
});
$('#editNodeSubsteps').addEventListener('change', (event) => {
    if (!selectedNode) return;
    const substeps = Math.max(1, Math.min(10000, Math.trunc(Number(event.target.value) || 1)));
    changeNodeModel(selectedNode, (snapshot) => { snapshot.substepsPerGlobalStep = substeps; });
});
$('#editAddState').addEventListener('click', () => {
    if (!selectedNode) return;
    changeNodeModel(selectedNode, (snapshot) => {
        snapshot.states.push({
            id: allocateModelEntityId(),
            label: 'New state',
            symbol: `x${snapshot.states.length + 1}`,
            initialValue: 0,
            unit: '',
            value: '0',
            className: ''
        });
    });
});
$('#editAddSourceTerm').addEventListener('click', () => {
    if (!selectedNode?.userData.definition.states.length) return;
    changeNodeModel(selectedNode, (snapshot) => {
        snapshot.sourceTerms.push({
            id: allocateModelEntityId(),
            state: snapshot.states[0].symbol,
            expression: '0'
        });
    });
});

$('#editEdgeName').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.title = event.target.value.trim() || 'Untitled relationship';
    });
});
$('#editEdgeSource').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.source = event.target.value;
        snapshot.sourceStateId = null;
    });
});
$('#editEdgeTarget').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.target = event.target.value;
        snapshot.targetStateId = null;
    });
});
$('#editEdgeDirectionality').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.directionality = event.target.value;
    });
});
$('#editEdgeColor').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.color = Number.parseInt(event.target.value.replace('#', ''), 16);
    });
});

// A single live-edit session mechanism shared by every free-text field (edge equations,
// edge provider source, source-term equations, source-term provider source) so keystrokes
// preview immediately while only one undo/redo entry is recorded per continuous edit.
function beginEquationEditSession(key, capture, apply) {
    if (equationEditSession?.key === key) return;
    finishEquationEdit();
    equationEditSession = { key, before: capture(), capture, apply };
}

function finishEquationEdit() {
    if (!equationEditSession) return;
    const { before, capture, apply } = equationEditSession;
    equationEditSession = null;
    const after = capture();
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    recordHistory({
        undo: () => apply(before),
        redo: () => apply(after)
    });
}

function previewProviderSource(source) {
    if (activeResult || !selectedRelationship) return;
    const definition = selectedRelationship;
    beginEquationEditSession(`edge:${definition.id}`, () => captureEdgeModel(definition), (snapshot) => applyEdgeModel(definition, snapshot));
    definition.implementation = { ...definition.implementation, source };
    $('#editInsertProviderTemplate').hidden = !source.trim();
    updateValidationStatus();
}

function previewEdgeEquation(latex, origin) {
    if (activeResult || !selectedRelationship) return;
    const definition = selectedRelationship;
    beginEquationEditSession(`edge:${definition.id}`, () => captureEdgeModel(definition), (snapshot) => applyEdgeModel(definition, snapshot));
    const equationModel = normalizeEdgeEquationModel(definition, {
        ...definition.equationModel,
        latex
    });
    definition.equationModel = equationModel;
    definition.equation = latex;
    if (origin !== 'visual') $('#editEdgeMathField').setValue(latex, { silenceNotifications: true });
    if (origin !== 'latex') $('#editEdgeEquation').value = latex;
    renderEquationDiagnostics(latex, equationModel.bindings);
    updateRelationships();
    updateValidationStatus();
}

$('#editEdgeMathField').addEventListener('input', (event) => {
    previewEdgeEquation(event.target.value, 'visual');
});
$('#editEdgeMathField').addEventListener('change', (event) => {
    finishEquationEdit();
});
$('#editEdgeEquation').addEventListener('input', (event) => {
    previewEdgeEquation(event.target.value, 'latex');
});
$('#editEdgeEquation').addEventListener('change', (event) => {
    finishEquationEdit();
});
$('#editEquationOutput').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    const [role, stateId] = event.target.value.split(':');
    changeEdgeModel(selectedRelationship, (snapshot) => {
        if (snapshot.implementation) snapshot.implementation.output = { ...snapshot.implementation.output, role, stateId };
        else snapshot.equationModel.output = { role, stateId };
    });
});
$('#editEdgeImplementationKind').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    const kind = event.target.value;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        if (kind === 'equation') {
            snapshot.implementation = null;
            return;
        }
        const [role, stateId] = $('#editEquationOutput').value.split(':');
        const bindings = snapshot.implementation?.bindings ?? [];
        const output = snapshot.implementation?.output ?? { key: 'output', role, stateId };
        snapshot.implementation = {
            kind,
            providerApiVersion: 1,
            source: snapshot.implementation?.source
                || defaultProviderSource(kind, bindings, output.key, snapshot.title),
            bindings,
            output
        };
    });
});
$('#editInsertProviderTemplate').addEventListener('click', () => {
    if (!selectedRelationship?.implementation) return;
    const { kind, bindings, output } = selectedRelationship.implementation;
    if ($('#editEdgeProviderSource').value.trim() &&
        !window.confirm('Replace the current provider source with a freshly generated template?')) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.implementation.source = defaultProviderSource(kind, bindings, output?.key, snapshot.title);
    });
});
$('#editOpenProviderEditor').addEventListener('click', () => {
    if (!selectedRelationship?.implementation) return;
    providerEditTarget = { type: 'editor', relationshipId: selectedRelationship.id };
    window.providerEditor.openWindow({
        source: $('#editEdgeProviderSource').value,
        kind: selectedRelationship.implementation.kind,
        title: selectedRelationship.title
    });
});
window.providerEditor.onApplied(({ source }) => {
    const fail = (error) => window.providerEditor.reportApplied({ applied: false, error });
    const succeed = () => window.providerEditor.reportApplied({ applied: true });
    if (!providerEditTarget) return fail('Nothing is being edited anymore.');
    if (providerEditTarget.type === 'editor') {
        if (activeResult) return fail('Results are locked — close them to apply changes.');
        const relationship = model.relationships.find((candidate) => candidate.id === providerEditTarget.relationshipId);
        if (!relationship?.implementation || relationship.deleted) return fail('This relationship no longer exists.');
        changeEdgeModel(relationship, (snapshot) => {
            snapshot.implementation.source = source;
        });
        return succeed();
    }
    if (providerEditTarget.type === 'builder') {
        if ($('#edgeBuilder').classList.contains('hidden')) return fail('The relationship builder was closed.');
        $('#edgeProviderSource').value = source;
        $('#insertProviderTemplate').hidden = !source.trim();
        return succeed();
    }
    if (providerEditTarget.type === 'sourceTerm') {
        if (activeResult) return fail('Results are locked — close them to apply changes.');
        const node = nodeObjects.get(providerEditTarget.nodeId);
        const term = node?.userData.definition.sourceTerms.find((candidate) => candidate.id === providerEditTarget.termId);
        if (!node || node.userData.definition.deleted || !term?.implementation) return fail('This source term no longer exists.');
        changeSourceTermModel(node, providerEditTarget.termId, (snapshotTerm) => {
            snapshotTerm.implementation.source = source;
        });
        return succeed();
    }
    if (providerEditTarget.type === 'builderSourceTerm') {
        if (!document.body.contains(providerEditTarget.sourceElement)) return fail('The source term builder was closed.');
        providerEditTarget.sourceElement.value = source;
        providerEditTarget.sourceElement.dispatchEvent(new Event('input', { bubbles: true }));
        return succeed();
    }
    if (providerEditTarget.type === 'group') {
        if (activeResult) return fail('Results are locked — close them to apply changes.');
        const group = model.edgeGroups.find((candidate) => candidate.id === providerEditTarget.groupId && !candidate.deleted);
        if (!group?.definition.implementation) return fail('This edge group no longer exists.');
        changeEdgeGroupModel(group, (snapshot) => { snapshot.definition.implementation.source = source; });
        return succeed();
    }
    return fail('Unknown edit target.');
});
$('#editEdgeProviderSource').addEventListener('input', (event) => {
    previewProviderSource(event.target.value);
});
$('#editEdgeProviderSource').addEventListener('change', () => {
    finishEquationEdit();
});
$('#editProviderOutputKey').addEventListener('change', (event) => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.implementation.output = { ...snapshot.implementation.output, key: event.target.value.trim() };
    });
});
$('#editAddProviderBinding').addEventListener('click', () => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        const candidates = providerReferenceCandidates(snapshot);
        if (!candidates.length) return;
        snapshot.implementation.bindings.push(
            referenceToProviderBinding(`input${snapshot.implementation.bindings.length + 1}`, candidates[0]));
    });
});
$('#termOutputState').addEventListener('change', (event) => {
    if (!selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    const stateId = Number(event.target.value);
    changeSourceTermModel(node, selectedSourceTermId, (term) => {
        if (term.implementation) {
            term.implementation.output = { ...term.implementation.output, stateId };
        } else {
            const state = node.userData.definition.states.find((candidate) => candidate.id === stateId);
            if (state) term.state = state.symbol;
            term.expressionModel = { ...term.expressionModel, output: { stateId } };
        }
    });
});
$('#termImplementationKind').addEventListener('change', (event) => {
    if (!selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    const kind = event.target.value;
    changeSourceTermModel(node, selectedSourceTermId, (term) => {
        if (kind === 'equation') {
            term.implementation = null;
            return;
        }
        const stateId = Number($('#termOutputState').value) || node.userData.definition.states[0]?.id || null;
        const bindings = term.implementation?.bindings ?? [];
        const output = term.implementation?.output ?? { key: 'output', stateId };
        term.implementation = {
            kind,
            providerApiVersion: 1,
            source: term.implementation?.source
                || defaultProviderSource(kind, bindings, output.key, node.userData.definition.title),
            bindings,
            output
        };
    });
});
$('#termInsertProviderTemplate').addEventListener('click', () => {
    if (!selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    const term = node.userData.definition.sourceTerms.find((candidate) => candidate.id === selectedSourceTermId);
    if (!term?.implementation) return;
    if ($('#termProviderSource').value.trim() &&
        !window.confirm('Replace the current provider source with a freshly generated template?')) return;
    changeSourceTermModel(node, selectedSourceTermId, (snapshotTerm) => {
        snapshotTerm.implementation.source = defaultProviderSource(
            snapshotTerm.implementation.kind, snapshotTerm.implementation.bindings,
            snapshotTerm.implementation.output?.key, node.userData.definition.title);
    });
});
$('#termAddProviderBinding').addEventListener('click', () => {
    if (!selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    changeSourceTermModel(node, selectedSourceTermId, (term) => {
        const candidates = sourceTermBindingCandidates(node.userData.definition);
        if (!candidates.length) return;
        term.implementation.bindings.push(
            sourceTermReferenceToBinding(`input${term.implementation.bindings.length + 1}`, candidates[0]));
    });
});
$('#termOpenProviderEditor').addEventListener('click', () => {
    if (!selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    const definition = node.userData.definition;
    const term = definition.sourceTerms.find((candidate) => candidate.id === selectedSourceTermId);
    if (!term?.implementation) return;
    providerEditTarget = { type: 'sourceTerm', nodeId: node.userData.id, termId: term.id };
    window.providerEditor.openWindow({
        source: $('#termProviderSource').value,
        kind: term.implementation.kind,
        title: definition.title
    });
});
$('#termProviderSource').addEventListener('input', (event) => {
    previewSourceTermProviderSource(event.target.value);
});
$('#termProviderSource').addEventListener('change', () => {
    finishEquationEdit();
});
$('#termProviderOutputKey').addEventListener('change', (event) => {
    if (!selectedSourceTermNodeId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    changeSourceTermModel(node, selectedSourceTermId, (term) => {
        term.implementation.output = { ...term.implementation.output, key: event.target.value.trim() };
    });
});
$('#termMathField').addEventListener('input', (event) => {
    previewSourceTermExpression(event.target.value, 'visual');
});
$('#termMathField').addEventListener('change', () => finishEquationEdit());
$('#termEquation').addEventListener('input', (event) => {
    previewSourceTermExpression(event.target.value, 'latex');
});
$('#termEquation').addEventListener('change', () => finishEquationEdit());
$$('[data-term-equation-mode]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-term-equation-mode]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    const latexMode = button.dataset.termEquationMode === 'latex';
    $('#termMathField').hidden = latexMode;
    $('#termEquation').hidden = !latexMode;
    (latexMode ? $('#termEquation') : $('#termMathField')).focus();
}));
$('[data-delete-source-term]').addEventListener('click', () => {
    if (!selectedSourceTermNodeId || !selectedSourceTermId) return;
    const node = nodeObjects.get(selectedSourceTermNodeId);
    changeNodeModel(node, (snapshot) => {
        snapshot.sourceTerms = snapshot.sourceTerms.filter((candidate) => candidate.id !== selectedSourceTermId);
    });
    selectedSourceTermNodeId = null;
    selectedSourceTermId = null;
    $('#sourceTermEditor').classList.add('hidden');
    openNodeEditor(node.userData.definition);
});
$$('[data-equation-mode]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-equation-mode]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    const latexMode = button.dataset.equationMode === 'latex';
    $('#editEdgeMathField').hidden = latexMode;
    $('#editEdgeEquation').hidden = !latexMode;
    (latexMode ? $('#editEdgeEquation') : $('#editEdgeMathField')).focus();
}));
$('#editAddEdgeParameter').addEventListener('click', () => {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.parameters.push({
            id: allocateModelEntityId(),
            name: 'Parameter',
            symbol: `p${snapshot.parameters.length + 1}`,
            value: 0,
            unit: '',
            mode: 'constant'
        });
    });
});

$('#editNodeShape').addEventListener('change', (event) => {
    if (!selectedNode) return;
    changeNodeAppearance(selectedNode, {
        ...captureNodeAppearance(selectedNode.userData.definition),
        shape: event.target.value,
        importedGeometry: null,
        geometryFileName: null
    });
    $('#editGeometryStatus').textContent = 'Choose a CAD or mesh file';
});

$('#editNodeColor').addEventListener('change', (event) => {
    if (!selectedNode) return;
    changeNodeAppearance(selectedNode, {
        ...captureNodeAppearance(selectedNode.userData.definition),
        color: Number.parseInt(event.target.value.replace('#', ''), 16)
    });
});

$('#editNodeGeometryFile').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file || !selectedNode) return;
    const node = selectedNode;
    const status = $('#editGeometryStatus');
    status.classList.remove('error');
    status.classList.add('loading');
    status.textContent = `Loading ${file.name}…`;
    try {
        const geometry = await importNodeGeometry(file);
        changeNodeAppearance(node, {
            ...captureNodeAppearance(node.userData.definition),
            shape: 'imported',
            importedGeometry: geometry,
            geometryFileName: file.name
        });
        geometry.dispose();
        $('#editNodeShape').value = '';
        status.textContent = `${file.name} applied`;
        await saveUploadToShapeLibrary(file, status);
    } catch (error) {
        status.classList.add('error');
        status.textContent = error.message;
        $('#editNodeShape').value = node.userData.definition.shape === 'imported'
            ? ''
            : node.userData.definition.shape;
    } finally {
        status.classList.remove('loading');
        event.target.value = '';
    }
});

$('#editBrowseShapeLibrary').addEventListener('click', () => {
    if (!selectedNode) return;
    openShapeLibrary('editor');
});

$$('#editNodeRotationX, #editNodeRotationY, #editNodeRotationZ').forEach((input) => input.addEventListener('change', () => {
    if (!selectedNode) return;
    const degrees = [$('#editNodeRotationX'), $('#editNodeRotationY'), $('#editNodeRotationZ')].map((field) => Number(field.value) || 0);
    changeNodeTransform(selectedNode, 'rotation', degrees.map((value) => THREE.MathUtils.degToRad(value)));
    refreshNodeTransformFields(selectedNode);
}));
$$('#editNodeScaleX, #editNodeScaleY, #editNodeScaleZ').forEach((input) => input.addEventListener('change', () => {
    if (!selectedNode) return;
    const values = [$('#editNodeScaleX'), $('#editNodeScaleY'), $('#editNodeScaleZ')].map((field) => Number(field.value));
    // Zero, negative or unparsable scale would collapse or invert the node's geometry --
    // reject it and snap the fields back to the last valid (live) values instead.
    if (values.some((value) => !(value > 0))) { refreshNodeTransformFields(selectedNode); return; }
    changeNodeTransform(selectedNode, 'scale', values);
    refreshNodeTransformFields(selectedNode);
}));

$('#shapeLibrarySearch').addEventListener('input', renderShapeLibraryResults);
$('#shapeLibraryResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-shape-id]');
    if (!button) return;
    shapeLibrarySelectedId = button.dataset.shapeId;
    $$('#shapeLibraryResults .shapeLibraryItem').forEach((item) => item.classList.toggle('selected', item === button));
    selectShapeLibraryPreview(shapeLibrarySelectedId);
});
$('#shapeLibraryApply').addEventListener('click', () => {
    if (shapeLibrarySelectedId) applyLibraryShape(shapeLibrarySelectedId);
});
$('#shapeLibraryCancel').addEventListener('click', () => $('#shapeLibraryDialog').close());
$('#shapeLibraryDialog').addEventListener('close', stopShapeLibraryPreview);
// Separate from stopShapeLibraryPreview, which is documented as that subsystem's own single
// cleanup point -- this just stops scheduling further thumbnail work; any generation already
// in flight finishes naturally and gets cached for next time.
$('#shapeLibraryDialog').addEventListener('close', () => {
    shapeLibraryThumbnailQueue.length = 0;
    shapeLibraryThumbnailQueued.clear();
});

$('#addButton').addEventListener('click', (event) => {
    if (activeResult) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openAddPalette(rect.left, rect.bottom + 3);
});

// Shared by openProject() (dialog-driven) and checkPendingProjectOpen() (an OS-initiated
// open this window was created for) -- everything after a file/requiresPassword payload has
// already been obtained, including the password-retry loop.
async function loadOpenedProjectFile(file) {
    let password = null;
    let passwordError = '';
    while (file.requiresPassword) {
        password = await requestProjectPassword({
            error: passwordError,
            title: `Unlock ${file.fileName}`,
            hint: `Enter the password for ${file.fileName}.`
        });
        if (password === null) return;
        try {
            file = await window.projectFiles.unlock(file.path, password);
        } catch {
            passwordError = 'Incorrect password, or this project has been modified.';
        }
    }
    await loadProjectDocument(JSON.parse(file.content), {
        path: file.path,
        fileName: file.fileName,
        password: file.encrypted ? password : null,
        embeddedResult: file.embeddedResult
    });
    activeExampleId = null;
    $('#exampleGuideButton').hidden = true;
    $('#statusText').textContent = file.embeddedResult ? 'Project and simulation results loaded' : 'Project loaded';
}

async function openProject() {
    if (simulationRunning) return;
    try {
        if ((documentController.dirty || (activeResult && !activeResultPersistedInProject)) &&
            !await window.projectFiles.confirmDiscard()) return;
        const file = await window.projectFiles.open();
        if (!file) return;
        await loadOpenedProjectFile(file);
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Load failed · ${error.message}`;
    }
}

// Asks main whether this window was created specifically to open an OS-provided file (a
// double-click, a relaunch's argv, or macOS's open-file) -- called once at startup so a fresh
// window can load straight into that file using the exact same UI as a manual Open.
async function checkPendingProjectOpen() {
    const pending = await window.projectFiles.pendingOpen();
    if (!pending) return;
    if (pending.error) {
        $('#statusText').textContent = `Load failed · ${pending.error}`;
        return;
    }
    try {
        await loadOpenedProjectFile(pending);
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Load failed · ${error.message}`;
    }
}

function requestSaveContentChoice() {
    const dialog = $('#saveContentDialog');
    const form = $('form', dialog);
    const cancel = $('#saveContentCancel');
    $('input[name="saveContent"][value="modelAndResults"]', form).checked = true;
    return new Promise((resolve) => {
        const finish = (choice) => {
            form.removeEventListener('submit', onSubmit);
            dialog.removeEventListener('cancel', onCancel);
            cancel.removeEventListener('click', onCancelClick);
            dialog.close();
            resolve(choice);
        };
        const onSubmit = (event) => {
            event.preventDefault();
            finish($('input[name="saveContent"]:checked', form).value);
        };
        const onCancel = (event) => { event.preventDefault(); finish(null); };
        const onCancelClick = () => finish(null);
        form.addEventListener('submit', onSubmit);
        dialog.addEventListener('cancel', onCancel);
        cancel.addEventListener('click', onCancelClick);
        dialog.showModal();
    });
}

async function saveProject(saveAs = false, password = currentProjectPassword) {
    try {
        const hasEmbeddableResult = Boolean(activeResult && activeEngineJobId && !simulationRunning);
        const contentChoice = hasEmbeddableResult ? await requestSaveContentChoice() : 'model';
        if (!contentChoice) return false;
        const includeResults = contentChoice === 'modelAndResults';
        const content = `${JSON.stringify(serializeProjectDocument(), null, 4)}\n`;
        const result = await window.projectFiles.save(
            saveAs ? null : currentProjectPath,
            content,
            currentProjectFilename,
            password,
            includeResults ? activeEngineJobId : null
        );
        if (!result) return false;
        currentProjectPath = result.path;
        currentProjectFilename = result.fileName;
        currentProjectPassword = result.encrypted ? password : null;
        updateDocumentTitle();
        updateEncryptionControls();
        activeResultPersistedInProject = result.includesResults;
        documentController.markSaved();
        $('#statusText').textContent = `${result.encrypted ? 'Encrypted project' : 'Project'} saved${result.includesResults ? ' with simulation results' : ' · model only'}`;
        return true;
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Save failed · ${error.message}`;
        return false;
    }
}

async function loadExample(id) {
    if (!id) return;
    try {
        if (simulationRunning) return;
        if ((documentController.dirty || (activeResult && !activeResultPersistedInProject)) && !await window.projectFiles.confirmDiscard()) return;
        const example = await window.projectFiles.loadExample(id);
        await loadProjectDocument(JSON.parse(example.content), {
            fileName: example.suggestedFilename,
            saved: false,
            embeddedResult: example.embeddedResult
        });
        activeExampleId = id;
        $('#exampleGuideButton').hidden = false;
        await window.projectFiles.openExampleGuide(id);
        $('#statusText').textContent = 'Example loaded as an unsaved copy';
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Example failed · ${error.message}`;
    } finally {
        // .close() on an already-closed <dialog> is a harmless no-op, so this is safe even if
        // loadExample is ever invoked from somewhere other than the explorer's own Open button.
        $('#examplesExplorerDialog').close();
    }
}

$('#exampleGuideButton').addEventListener('click', () => {
    if (activeExampleId) window.projectFiles.openExampleGuide(activeExampleId);
});

function requestProjectPassword({
    confirm = false,
    error = '',
    title = confirm ? 'Save encrypted project' : 'Unlock project',
    hint = confirm
        ? 'Choose a password. It cannot be recovered if you forget it.'
        : 'Enter the password used to protect this project.',
    submitLabel = confirm ? 'Save encrypted' : 'Unlock'
} = {}) {
    const dialog = $('#passwordDialog');
    const form = $('form', dialog);
    const password = $('#projectPassword');
    const confirmation = $('#confirmProjectPassword');
    const submit = $('#passwordSubmit');
    const cancel = $('#passwordCancel');
    $('#passwordDialogTitle').textContent = title;
    $('#passwordDialogHint').textContent = hint;
    submit.textContent = submitLabel;
    $('#confirmPasswordField').hidden = !confirm;
    $('#passwordError').textContent = error;
    password.value = '';
    confirmation.value = '';
    confirmation.required = confirm;

    return new Promise((resolve) => {
        const updateValidation = () => {
            const { valid, message } = validateProjectPassword(
                password.value,
                confirmation.value,
                confirm,
                error
            );
            $('#passwordError').textContent = message;
            confirmation.setAttribute('aria-invalid', String(confirm && Boolean(confirmation.value) && password.value !== confirmation.value));
            submit.disabled = !valid;
        };
        const finish = (value) => {
            form.removeEventListener('submit', onSubmit);
            dialog.removeEventListener('cancel', onCancel);
            password.removeEventListener('input', updateValidation);
            confirmation.removeEventListener('input', updateValidation);
            cancel.removeEventListener('click', onCancelClick);
            password.value = '';
            confirmation.value = '';
            dialog.close();
            resolve(value);
        };
        const onCancel = (event) => {
            event.preventDefault();
            finish(null);
        };
        const onCancelClick = () => finish(null);
        const onSubmit = (event) => {
            event.preventDefault();
            updateValidation();
            if (submit.disabled) return;
            const submittedPassword = password.value;
            finish(submittedPassword);
        };
        form.addEventListener('submit', onSubmit);
        dialog.addEventListener('cancel', onCancel);
        password.addEventListener('input', updateValidation);
        confirmation.addEventListener('input', updateValidation);
        cancel.addEventListener('click', onCancelClick);
        updateValidation();
        dialog.showModal();
        password.focus();
    });
}

let examplesExplorerEntries = null;
let examplesExplorerDomain = 'all';
let examplesExplorerSelectedId = null;

function renderExamplesExplorerResults() {
    const query = $('#examplesExplorerSearch').value.trim().toLowerCase();
    const matches = examplesExplorerEntries.filter((example) => {
        if (examplesExplorerDomain !== 'all' && !example.domains.includes(examplesExplorerDomain)) return false;
        if (!query) return true;
        const haystack = [example.label, example.description, ...example.domains].join(' ').toLowerCase();
        return haystack.includes(query);
    });
    $('#examplesExplorerResults').replaceChildren(...matches.map((example) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'examplesExplorerItem';
        button.dataset.exampleId = example.id;
        button.classList.toggle('selected', example.id === examplesExplorerSelectedId);
        const thumb = example.thumbnailUrl
            ? `<img class="examplesExplorerThumb" src="${escapeHtml(example.thumbnailUrl)}" alt="">`
            : '<span class="examplesExplorerThumbPlaceholder">No preview</span>';
        button.innerHTML = `${thumb}<b>${escapeHtml(example.label)}</b>`;
        return button;
    }));
    $('#examplesExplorerEmpty').hidden = matches.length > 0;
}

function renderExamplesExplorerDetail() {
    const example = examplesExplorerEntries.find((entry) => entry.id === examplesExplorerSelectedId);
    $('#examplesExplorerDetailEmpty').hidden = Boolean(example);
    $('#examplesExplorerDetailContent').hidden = !example;
    if (!example) return;
    const thumbnail = $('#examplesExplorerDetailThumbnail');
    thumbnail.hidden = !example.thumbnailUrl;
    thumbnail.src = example.thumbnailUrl ?? '';
    $('#examplesExplorerDetailTitle').textContent = example.label;
    $('#examplesExplorerDetailDescription').textContent = example.description || 'No description available.';
}

async function openExamplesExplorer() {
    if (!examplesExplorerEntries) {
        try {
            examplesExplorerEntries = await window.projectFiles.listExamples();
        } catch (error) {
            console.error(error);
            $('#exampleButton').disabled = true;
            return;
        }
    }
    examplesExplorerDomain = 'all';
    examplesExplorerSelectedId = null;
    $('#examplesExplorerSearch').value = '';
    const domains = ['all', ...new Set(examplesExplorerEntries.flatMap((example) => example.domains))];
    $('#examplesExplorerDomains').replaceChildren(...domains.map((domain) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = domain === 'all' ? 'All' : domainLabel(domain);
        button.classList.toggle('active', domain === examplesExplorerDomain);
        button.addEventListener('click', () => {
            examplesExplorerDomain = domain;
            $$('#examplesExplorerDomains button').forEach((chip) => chip.classList.toggle('active', chip === button));
            renderExamplesExplorerResults();
        });
        return button;
    }));
    renderExamplesExplorerResults();
    renderExamplesExplorerDetail();
    $('#examplesExplorerDialog').showModal();
    $('#examplesExplorerSearch').focus();
}

let extensionsEntries = null;
let extensionsTab = 'addon';
let extensionsSelectedKey = null;

function extensionsPackageKey(entry) {
    return `${entry.packageType}:${entry.packageId}:${entry.version}`;
}

function showExtensionsNotice(message) {
    $('#extensionsRestartNotice').textContent = message;
    $('#extensionsRestartNotice').hidden = false;
}

function renderExtensionsResults() {
    const matches = extensionsEntries.filter((entry) => entry.packageType === extensionsTab);
    $('#extensionsResults').replaceChildren(...matches.map((entry) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'examplesExplorerItem extensionsItem';
        button.dataset.packageKey = extensionsPackageKey(entry);
        button.classList.toggle('selected', extensionsPackageKey(entry) === extensionsSelectedKey);
        button.classList.toggle('disabledItem', !entry.enabled);
        const meta = `${escapeHtml(entry.version)} · ${entry.source === 'bundled' ? 'Bundled' : 'Installed'}${entry.enabled ? '' : ' · Disabled'}`;
        button.innerHTML = `<b>${escapeHtml(entry.name)}</b><span class="extensionsItemMeta">${meta}</span>`;
        return button;
    }));
    $('#extensionsEmpty').textContent = extensionsTab === 'addon' ? 'No add-ons are installed.' : 'No plugins are installed.';
    $('#extensionsEmpty').hidden = matches.length > 0;
}

function renderExtensionsDetail() {
    const entry = extensionsEntries.find((candidate) => extensionsPackageKey(candidate) === extensionsSelectedKey);
    $('#extensionsDetailEmpty').hidden = Boolean(entry);
    $('#extensionsDetailContent').hidden = !entry;
    if (!entry) return;
    $('#extensionsDetailBadge').textContent = entry.source === 'bundled' ? 'Bundled' : 'Installed';
    $('#extensionsDetailBadge').classList.toggle('bundled', entry.source === 'bundled');
    $('#extensionsDetailEnabledBadge').hidden = entry.enabled;
    $('#extensionsDetailTitle').textContent = entry.name;
    $('#extensionsDetailId').textContent = entry.packageId;
    $('#extensionsDetailVersion').textContent = entry.version;
    $('#extensionsDetailPermissions').replaceChildren(...entry.permissions.map((permission) => {
        const item = document.createElement('li');
        item.textContent = permission;
        return item;
    }));
    $('#extensionsToggleEnabled').textContent = entry.enabled ? 'Disable' : 'Enable';
    $('#extensionsUninstall').hidden = entry.source === 'bundled';
}

async function refreshExtensionsList() {
    extensionsEntries = await window.extensions.list();
    renderExtensionsResults();
    renderExtensionsDetail();
}

async function openExtensionsDialog() {
    try {
        await refreshExtensionsList();
    } catch (error) {
        console.error(error);
        return;
    }
    extensionsTab = 'addon';
    extensionsSelectedKey = null;
    $('#extensionsRestartNotice').hidden = true;
    $$('.extensionsTab').forEach((tab) => tab.classList.toggle('active', tab.dataset.extensionsTab === extensionsTab));
    renderExtensionsResults();
    renderExtensionsDetail();
    $('#extensionsDialog').showModal();
}

$$('.extensionsTab').forEach((tab) => tab.addEventListener('click', () => {
    extensionsTab = tab.dataset.extensionsTab;
    extensionsSelectedKey = null;
    $$('.extensionsTab').forEach((candidate) => candidate.classList.toggle('active', candidate === tab));
    renderExtensionsResults();
    renderExtensionsDetail();
}));

$('#extensionsResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-package-key]');
    if (!button) return;
    extensionsSelectedKey = button.dataset.packageKey;
    $$('#extensionsResults .extensionsItem').forEach((item) => item.classList.toggle('selected', item === button));
    renderExtensionsDetail();
});

$('#extensionsInstall').addEventListener('click', async () => {
    try {
        const installed = await window.extensions.install();
        if (!installed) return;
        extensionsTab = installed.packageType;
        extensionsSelectedKey = `${installed.packageType}:${installed.packageId}:${installed.version}`;
        await refreshExtensionsList();
        $$('.extensionsTab').forEach((tab) => tab.classList.toggle('active', tab.dataset.extensionsTab === extensionsTab));
        renderExtensionsResults();
        renderExtensionsDetail();
        showExtensionsNotice(`Installed ${installed.packageId} ${installed.version}. Restart Konjugate to activate it.`);
    } catch (error) {
        showExtensionsNotice(`Installation failed: ${error.message}`);
    }
});

$('#extensionsToggleEnabled').addEventListener('click', async () => {
    const entry = extensionsEntries.find((candidate) => extensionsPackageKey(candidate) === extensionsSelectedKey);
    if (!entry) return;
    try {
        await window.extensions.setEnabled(entry.packageType, entry.packageId, entry.version, !entry.enabled);
        const verb = entry.enabled ? 'Disabled' : 'Enabled';
        await refreshExtensionsList();
        showExtensionsNotice(`${verb} ${entry.packageId} ${entry.version}. This takes effect immediately -- no restart needed.`);
    } catch (error) {
        showExtensionsNotice(`Could not update: ${error.message}`);
    }
});

$('#extensionsUninstall').addEventListener('click', async () => {
    const entry = extensionsEntries.find((candidate) => extensionsPackageKey(candidate) === extensionsSelectedKey);
    if (!entry) return;
    if (!window.confirm(`Uninstall ${entry.name} ${entry.version}? This cannot be undone.`)) return;
    try {
        await window.extensions.uninstall(entry.packageType, entry.packageId, entry.version);
        extensionsSelectedKey = null;
        await refreshExtensionsList();
        showExtensionsNotice(`Uninstalled ${entry.packageId} ${entry.version}. Restart Konjugate if it was active.`);
    } catch (error) {
        showExtensionsNotice(`Uninstall failed: ${error.message}`);
    }
});

$('#extensionsClose').addEventListener('click', () => $('#extensionsDialog').close());

$('#newWindowButton').addEventListener('click', () => window.windowControls.newWindow());
$('#loadButton').addEventListener('click', openProject);
$('#extensionsButton').addEventListener('click', openExtensionsDialog);
$('#saveButton').addEventListener('click', () => saveProject());
$('#saveEncryptedButton').addEventListener('click', async (event) => {
    if (!currentProjectPassword) {
        const password = await requestProjectPassword({ confirm: true });
        if (password !== null) await saveProject(true, password);
        return;
    }
    const menu = $('#encryptionMenu');
    const rect = event.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.right - 245)}px`;
    menu.style.top = `${rect.bottom + 5}px`;
    menu.classList.toggle('hidden');
});

async function verifyCurrentProjectPassword(actionLabel) {
    let error = '';
    while (true) {
        const password = await requestProjectPassword({
            error,
            title: actionLabel,
            hint: `Enter the current password for ${currentProjectFilename}.`,
            submitLabel: 'Continue'
        });
        if (password === null) return false;
        if (password === currentProjectPassword) return true;
        error = 'The current password is incorrect.';
    }
}

$('#changePasswordButton').addEventListener('click', async () => {
    $('#encryptionMenu').classList.add('hidden');
    if (!await verifyCurrentProjectPassword('Change encryption password')) return;
    const password = await requestProjectPassword({
        confirm: true,
        title: `Change password for ${currentProjectFilename}`,
        hint: 'Choose a new password. It cannot be recovered if you forget it.',
        submitLabel: 'Change password'
    });
    if (password !== null) await saveProject(false, password);
});

$('#removeEncryptionButton').addEventListener('click', async () => {
    $('#encryptionMenu').classList.add('hidden');
    if (!await verifyCurrentProjectPassword('Remove encryption')) return;
    await saveProject(false, null);
});

$('#encryptionMenu').addEventListener('pointerdown', (event) => event.stopPropagation());

$('#diagnosticsButton').addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = $('#diagnosticsPanel');
    const rect = event.currentTarget.getBoundingClientRect();
    panel.style.left = `${Math.max(8, rect.right - 320)}px`;
    panel.style.top = `${rect.bottom + 5}px`;
    const opening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden');
    if (opening) {
        renderDiagnosticsList();
        diagnosticsUnseenCount = 0;
        renderDiagnosticsBadge();
    }
});
$('#diagnosticsPanel').addEventListener('pointerdown', (event) => event.stopPropagation());
$('#diagnosticsClearButton').addEventListener('click', () => {
    diagnosticsEntries.length = 0;
    renderDiagnosticsList();
});
window.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#diagnosticsButton') && !event.target.closest('#diagnosticsPanel')) {
        $('#diagnosticsPanel').classList.add('hidden');
    }
});
$('#exampleButton').addEventListener('click', openExamplesExplorer);
$('#examplesExplorerSearch').addEventListener('input', renderExamplesExplorerResults);
$('#examplesExplorerResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-example-id]');
    if (!button) return;
    examplesExplorerSelectedId = button.dataset.exampleId;
    $$('#examplesExplorerResults .examplesExplorerItem').forEach((item) => item.classList.toggle('selected', item === button));
    renderExamplesExplorerDetail();
});
$('#examplesExplorerLoad').addEventListener('click', () => {
    if (examplesExplorerSelectedId) loadExample(examplesExplorerSelectedId);
});
$('#examplesExplorerCancel').addEventListener('click', () => $('#examplesExplorerDialog').close());

$$('[data-add-kind]').forEach((button) => {
    button.addEventListener('click', () => {
        const rect = $('#addPalette').getBoundingClientRect();
        if (button.dataset.addKind === 'node') openNodeBuilder(rect.left, rect.top);
        else openEdgeBuilder(rect.left, rect.top);
    });
});

$('#addStateVariable').addEventListener('click', () => addStateVariableRow());
$('#addSourceTerm').addEventListener('click', addSourceTermRow);
$('#addEdgeParameter').addEventListener('click', () => addEdgeParameterRow());
$('#edgeSource').addEventListener('change', refreshStateReferences);
$('#edgeTarget').addEventListener('change', refreshStateReferences);
$('#edgeMathField').addEventListener('input', (event) => {
    $('#edgeEquation').value = event.target.value;
    renderBuilderEquationDiagnostics();
});
$('#edgeEquation').addEventListener('input', (event) => {
    $('#edgeMathField').setValue(event.target.value, { silenceNotifications: true });
    renderBuilderEquationDiagnostics();
});
$$('[data-builder-equation-mode]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-builder-equation-mode]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    const latexMode = button.dataset.builderEquationMode === 'latex';
    $('#edgeMathField').hidden = latexMode;
    $('#edgeEquation').hidden = !latexMode;
    (latexMode ? $('#edgeEquation') : $('#edgeMathField')).focus();
}));
function builderProviderBindingKeys() {
    return $$('#providerBindingRows .providerBindingRow [data-field="key"]').map((input) => ({ key: input.value }));
}

$('#edgeImplementationKind').addEventListener('change', (event) => {
    const kind = event.target.value;
    const isEquation = kind === 'equation';
    $('#edgeEquationHeading').hidden = !isEquation;
    $('#builderEquationDiagnostics').hidden = !isEquation;
    $('#edgeReferencePicker').hidden = !isEquation;
    $('#edgeProviderSection').hidden = isEquation;
    // The math-field/latex-textarea toggle their own `hidden` directly (matching the existing
    // Visual/LaTeX mode toggle) rather than through a hidden ancestor: MathLive's custom element
    // does not reliably accept focus again once an ancestor of it has been display:none'd.
    const latexMode = $('[data-builder-equation-mode="latex"]').classList.contains('active');
    $('#edgeMathField').hidden = !isEquation || latexMode;
    $('#edgeEquation').hidden = !isEquation || !latexMode;
    if (!isEquation && !$('#edgeProviderSource').value.trim()) {
        $('#edgeProviderSource').value = defaultProviderSource(
            kind, builderProviderBindingKeys(), $('#providerOutputKey').value, $('#newEdgeName').value);
    }
    $('#insertProviderTemplate').hidden = !$('#edgeProviderSource').value.trim();
});
$('#insertProviderTemplate').addEventListener('click', () => {
    if ($('#edgeProviderSource').value.trim() &&
        !window.confirm('Replace the current provider source with a freshly generated template?')) return;
    $('#edgeProviderSource').value = defaultProviderSource(
        $('#edgeImplementationKind').value, builderProviderBindingKeys(), $('#providerOutputKey').value, $('#newEdgeName').value);
    $('#insertProviderTemplate').hidden = !$('#edgeProviderSource').value.trim();
});
$('#edgeProviderSource').addEventListener('input', (event) => {
    $('#insertProviderTemplate').hidden = !event.target.value.trim();
});
$('#openProviderEditor').addEventListener('click', () => {
    providerEditTarget = { type: 'builder' };
    window.providerEditor.openWindow({
        source: $('#edgeProviderSource').value,
        kind: $('#edgeImplementationKind').value,
        title: $('#newEdgeName').value
    });
});
$('#addProviderBinding').addEventListener('click', () => addProviderBindingRow());
$('#builderBrowseShapeLibrary').addEventListener('click', () => openShapeLibrary('builder'));
$('#nodeGeometryFile').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    const status = $('#geometryImportStatus');
    status.classList.remove('error');
    status.classList.add('loading');
    status.textContent = `Loading ${file.name}…`;
    $('#createNode').disabled = true;
    try {
        const geometry = await importNodeGeometry(file);
        pendingImportedGeometry?.dispose();
        pendingImportedGeometry = geometry;
        pendingGeometryFileName = file.name;
        $('#newNodeShape').value = 'imported';
        status.textContent = `${file.name} ready`;
        await saveUploadToShapeLibrary(file, status);
    } catch (error) {
        pendingImportedGeometry?.dispose();
        pendingImportedGeometry = null;
        pendingGeometryFileName = '';
        status.classList.add('error');
        status.textContent = error.message;
    } finally {
        status.classList.remove('loading');
        $('#createNode').disabled = false;
    }
});
$$('[data-pick-endpoint]').forEach((button) => {
    button.addEventListener('click', () => startEndpointPick(button.dataset.pickEndpoint));
});
$('#cancelEndpointPick').addEventListener('click', finishEndpointPick);
$('#connectFromNode').addEventListener('click', () => {
    if (!activeResult && selectedNode) connectFromNode(selectedNode);
});

// The position component (x=0, y=1, z=2) every currently visible node happens to share, or null
// if they don't all agree -- used so a freshly created node lands in whatever plane the rest of
// the model is already sitting in, rather than always the same fixed default regardless of what's
// on screen (most relevant while 2D-locked, but not conditional on it: a model that's flat for
// any reason should stay flat for a new node the same way pasting now respects it).
function sharedVisibleNodeAxisValue(axisIndex) {
    // Requires at least 2 nodes to agree, not 1 -- a lone existing node trivially "shares" every
    // axis with itself, which would otherwise drop every subsequent new node exactly on top of it
    // instead of at a predictable default.
    const values = model.nodes
        .filter((node) => !node.deleted && nodeObjects.get(node.id)?.visible !== false)
        .map((node) => nodeObjects.get(node.id).position.getComponent(axisIndex));
    return values.length > 1 && values.every((value) => value === values[0]) ? values[0] : null;
}

$('#createNode').addEventListener('click', () => {
    if (activeResult) return;
    const states = stateVariablesFromBuilder();
    if (!states.length) {
        $('#stateVariableRows input').focus();
        return;
    }
    if (states.some((state) => !modelSymbolPattern.test(state.symbol)) ||
        new Set(states.map((state) => state.symbol)).size !== states.length) {
        $('.stateVariableRow [data-field="symbol"]')?.focus();
        return;
    }
    if ($('#newNodeShape').value === 'imported' && !pendingImportedGeometry) {
        $('#nodeGeometryFile').click();
        return;
    }

    const id = allocateModelEntityId();
    const resolvedStates = states.map((state) => ({
        id: allocateModelEntityId(),
        label: state.name,
        symbol: state.symbol,
        initialValue: Number(state.value) || 0,
        unit: state.unit,
        value: `${Number(state.value) || 0}${state.unit ? ` ${state.unit}` : ''}`
    }));
    const symbolToStateId = new Map(resolvedStates.map((state) => [state.symbol, state.id]));
    const definition = {
        id,
        title: $('#newNodeName').value.trim() || 'Untitled node',
        type: 'Custom node',
        shape: $('#newNodeShape').value,
        importedGeometry: pendingImportedGeometry?.clone() ?? null,
        geometryFileName: pendingGeometryFileName || null,
        position: [
            sharedVisibleNodeAxisValue(0) ?? 0,
            sharedVisibleNodeAxisValue(1) ?? -0.7,
            sharedVisibleNodeAxisValue(2) ?? 0
        ],
        subsystemId: activeSubsystemId,
        deleted: false,
        enabled: true,
        color: Number.parseInt($('#newNodeColor').value.replace('#', ''), 16),
        states: resolvedStates,
        sourceTerms: $$('.sourceTermRow').map((row) => {
            const stateSymbol = $('.sourceState', row).value;
            const kind = $('.sourceTermKind', row)?.value ?? 'equation';
            const termId = allocateModelEntityId();
            if (kind === 'equation') {
                return { id: termId, state: stateSymbol, expression: $('.sourceExpression', row).value.trim() };
            }
            const bindings = $$('.providerBindingRow', row).map((bindingRow) => ({
                key: $('[data-field="key"]', bindingRow).value.trim(),
                kind: 'state',
                stateId: symbolToStateId.get($('[data-field="reference"]', bindingRow).value.replace('state:', ''))
            })).filter((binding) => binding.stateId);
            return {
                id: termId,
                state: stateSymbol,
                expression: '',
                implementation: {
                    kind,
                    providerApiVersion: 1,
                    source: $('.sourceTermProviderSource', row).value,
                    bindings,
                    output: { key: $('.sourceTermProviderOutputKey', row).value.trim(), stateId: symbolToStateId.get(stateSymbol) }
                }
            };
        }).filter((term) => term.state && (term.expression || term.implementation)),
        substepsPerGlobalStep: 1
    };

    hideCards();
    model.nodes.push(definition);
    createNode(definition);
    pendingImportedGeometry?.dispose();
    pendingImportedGeometry = null;
    pendingGeometryFileName = '';
    updateModelStatus();
    selectNode(nodeObjects.get(id));
    if (currentTool in transformPropertyForTool) transformControls.attach(nodeObjects.get(id));
    recordHistory({
        undo: () => setNodeVisibility(id, false),
        redo: () => setNodeVisibility(id, true)
    });
});

$('#createEdge').addEventListener('click', () => {
    if (activeResult) return;
    const source = Number($('#edgeSource').value);
    const target = Number($('#edgeTarget').value);
    if (!source || !target || source === target) {
        $('#edgeTarget').focus();
        return;
    }

    const parameters = $$('.parameterRow').map((row) => ({
        id: allocateModelEntityId(),
        name: $('[data-field="name"]', row).value.trim(),
        symbol: $('[data-field="symbol"]', row).value.trim(),
        value: Number($('[data-field="value"]', row).value) || 0,
        unit: $('[data-field="unit"]', row).value.trim(),
        mode: $('[data-field="mode"]', row).value,
        ...($('[data-field="mode"]', row).value === 'live' ? {
            control: Object.fromEntries($$('[data-control-field]', row)
                .map((input) => [input.dataset.controlField, Number(input.value)]))
        } : {})
    })).filter((parameter) => parameter.name && parameter.symbol);
    if (parameters.some((parameter) => !modelSymbolPattern.test(parameter.symbol)) ||
        new Set(parameters.map((parameter) => parameter.symbol)).size !== parameters.length) {
        $('.parameterRow [data-field="symbol"]')?.focus();
        return;
    }
    const invalidLiveParameter = parameters.find((parameter) => parameter.mode === 'live' && parameterControlError(parameter.value, parameter.control));
    if (invalidLiveParameter) {
        const row = $$('.parameterRow').find((candidate) => $('[data-field="symbol"]', candidate).value.trim() === invalidLiveParameter.symbol);
        $('.parameterControlError', row).textContent = parameterControlError(invalidLiveParameter.value, invalidLiveParameter.control);
        $('[data-control-field="minimum"]', row).focus();
        return;
    }
    const implementationKind = $('#edgeImplementationKind').value;
    const sourceNode = model.nodes.find((node) => node.id === source);
    const targetNode = model.nodes.find((node) => node.id === target);
    const definition = {
        id: allocateModelEntityId(),
        title: $('#newEdgeName').value.trim() || 'Untitled relationship',
        source,
        target,
        sourceStateId: sourceNode?.states[0]?.id ?? null,
        targetStateId: targetNode?.states[0]?.id ?? null,
        directionality: 'directed',
        color: Number.parseInt($('#newEdgeColor').value.replace('#', ''), 16),
        offset: 0,
        enabled: true,
        equation: implementationKind === 'equation' ? $('#edgeEquation').value.trim() : '',
        parameters
    };
    definition.equationModel = normalizeEdgeEquationModel(definition);
    const [outputRole, outputStateId] = $('#edgeEquationOutput').value.split(':');
    if (outputRole && outputStateId) {
        definition.equationModel.output = { role: outputRole, stateId: Number(outputStateId) };
    }
    if (implementationKind === 'equation') {
        if (definition.equation && !definition.equationModel.mathJson) {
            renderBuilderEquationDiagnostics(definition.equationModel.bindings);
            ($('#edgeMathField').hidden ? $('#edgeEquation') : $('#edgeMathField')).focus();
            return;
        }
    } else {
        const fakeParameterIdToReal = Object.fromEntries(parameters.map((parameter, index) => [`builderParameter${index}`, parameter.id]));
        const bindings = $$('#providerBindingRows .providerBindingRow').map((row) => {
            const key = $('[data-field="key"]', row).value.trim();
            const referenceValue = $('[data-field="reference"]', row).value;
            if (referenceValue.startsWith('parameter:')) {
                return { key, kind: 'parameter', parameterId: fakeParameterIdToReal[referenceValue.slice('parameter:'.length)] };
            }
            const [, role, nodeId, stateId] = referenceValue.split(':');
            return { key, kind: 'state', role, nodeId: Number(nodeId), stateId: Number(stateId) };
        });
        definition.implementation = {
            kind: implementationKind,
            providerApiVersion: 1,
            source: $('#edgeProviderSource').value,
            bindings,
            output: { key: $('#providerOutputKey').value.trim(), role: outputRole, stateId: Number(outputStateId) }
        };
    }

    finishEndpointPick();
    model.relationships.push(definition);
    createRelationship(definition);
    updateRelationships();
    updateModelStatus();
    $('#edgeBuilder').classList.add('hidden');
    selectRelationship(definition);
    recordHistory({
        undo: () => setRelationshipVisibility(definition.id, false),
        redo: () => setRelationshipVisibility(definition.id, true)
    });
});

// The builder's own "Create relationship" above always makes a directed edge -- bidirectional is
// only exposed post-creation, in the edge editor. A template that needs it (e.g. Conduction, where
// energy leaving one side must equal energy entering the other) sets pendingBidirectionalTemplate;
// this listener, registered after the one above so it runs after the real creation completes,
// applies it via the same setRelationshipDirectionality the editor itself uses.
$('#createEdge').addEventListener('click', () => {
    if (!pendingBidirectionalTemplate || !$('#edgeBuilder').classList.contains('hidden')) return;
    const template = pendingBidirectionalTemplate;
    pendingBidirectionalTemplate = null;
    const definition = selectedRelationship;
    if (!definition) return;
    setRelationshipDirectionality(definition, 'bidirectional');
    const otherRole = template.output.role === 'source' ? 'target' : 'source';
    const otherNode = model.nodes.find((node) => node.id === definition[otherRole]);
    const otherState = otherNode?.states.find((candidate) => candidate.symbol === template.output.state);
    if (otherState) definition[otherRole === 'source' ? 'sourceStateId' : 'targetStateId'] = otherState.id;
});

function setLabelDetail(detail, expanded) {
    const button = $(`[data-detail="${detail}"]`);
    button.classList.toggle('active', expanded);
    button.ariaPressed = String(expanded);
    canvas.classList.toggle(`show${detail[0].toUpperCase()}${detail.slice(1)}Details`, expanded);
}

$$('[data-detail]').forEach((button) => {
    button.ariaPressed = 'false';
    button.addEventListener('click', () => setLabelDetail(button.dataset.detail, !button.classList.contains('active')));
});

$('#validationSummary').addEventListener('click', () => {
    const panel = $('#validationPanel');
    panel.hidden = !panel.hidden;
    $('#validationSummary').ariaExpanded = String(!panel.hidden);
});
$('#closeValidationPanel').addEventListener('click', () => {
    $('#validationPanel').hidden = true;
    $('#validationSummary').ariaExpanded = 'false';
});

function setTool(tool) {
    if (activeResult && tool !== 'select') return;
    $$('.toolstrip [data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
    canvas.dataset.tool = tool;
    rectangleSelection = null;
    $('#selectionRectangle').hidden = true;
    currentTool = tool;
    dragControls.enabled = !activeResult && tool === 'select';
    transformControls.enabled = !activeResult && tool in transformPropertyForTool;
    orbitControls.enabled = tool !== 'rectangleSelect';

    if (tool in transformPropertyForTool) transformControls.setMode(tool === 'move' ? 'translate' : tool);
    if (!(tool in transformPropertyForTool)) transformControls.detach();
    if (tool in transformPropertyForTool && selectedNode) transformControls.attach(selectedNode);
}

$$('.toolstrip [data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
        setTool(button.dataset.tool);
    });
});

function animateCameraTo(position, up, animated = true) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animated || reduceMotion) {
        camera.position.copy(position);
        camera.up.copy(up);
        camera.lookAt(orbitControls.target);
        orbitControls.update();
        return;
    }
    cameraAnimation = {
        startedAt: performance.now(),
        duration: 650,
        fromPosition: camera.position.clone(),
        toPosition: position.clone(),
        fromUp: camera.up.clone(),
        toUp: up.clone()
    };
    orbitControls.enabled = false;
}

function updateCameraAnimation(time) {
    if (!cameraAnimation) return false;
    const progress = Math.min(1, (time - cameraAnimation.startedAt) / cameraAnimation.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    camera.position.lerpVectors(cameraAnimation.fromPosition, cameraAnimation.toPosition, eased);
    camera.up.lerpVectors(cameraAnimation.fromUp, cameraAnimation.toUp, eased).normalize();
    camera.lookAt(orbitControls.target);
    if (progress === 1) {
        cameraAnimation = null;
        orbitControls.enabled = true;
        orbitControls.update();
    }
    return true;
}

function setCameraView(view, animated = true) {
    currentView = view;
    const position = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    if (view === 'top') {
        up.set(0, 0, -1);
        position.set(0, 24, 0.001);
    } else if (view === 'bottom') {
        up.set(0, 0, 1);
        position.set(0, -24, 0.001);
    } else if (view === 'front') {
        position.set(0, -0.7, 24);
    } else if (view === 'back') {
        position.set(0, -0.7, -24);
    } else if (view === 'right') {
        position.set(24, -0.7, 0.001);
    } else if (view === 'left') {
        position.set(-24, -0.7, 0.001);
    } else {
        position.set(0, 7.5, 19);
    }
    orbitControls.target.set(0, -0.7, 0);
    animateCameraTo(position, up, animated);
    $$('[data-nav-view]').forEach((button) => {
        button.classList.toggle('active', button.dataset.navView === view);
    });
}

$$('[data-nav-view]').forEach((button) => {
    button.addEventListener('click', () => {
        setCameraView(button.dataset.navView);
    });
});

function nearestOrthogonalView() {
    const cameraDirection = camera.position.clone().sub(orbitControls.target).normalize();
    let bestView = 'front';
    let bestDot = -Infinity;
    for (const [view, direction] of Object.entries(faceDirections)) {
        const dot = cameraDirection.dot(direction);
        if (dot > bestDot) {
            bestDot = dot;
            bestView = view;
        }
    }
    return bestView;
}

// Repurposes OrbitControls' own native mouse-button mapping -- the same mechanism already
// behind today's "Shift-drag pans" behavior -- so a plain left-drag pans instead of rotates
// while locked. Corner/isometric views are inherently non-orthogonal, so they're disabled
// rather than left free to silently break the "always looking straight down one axis" promise.
function set2DLock(locked) {
    is2DLocked = locked;
    orbitControls.enableRotate = !locked;
    orbitControls.mouseButtons.LEFT = locked ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    const button = $('#lock2DButton');
    button.classList.toggle('active', locked);
    button.ariaPressed = String(locked);
    button.querySelector('img').src = locked ? '../../assets/lock2D.svg' : '../../assets/lock2DOpen.svg';
    $$('.cubeCorner').forEach((corner) => { corner.disabled = locked; });
    if (locked) setCameraView(nearestOrthogonalView(), true);
}

$('#lock2DButton').addEventListener('click', () => set2DLock(!is2DLocked));

function setCameraCorner(direction) {
    const [x, y, z] = direction.split(',').map(Number);
    currentView = `corner:${direction}`;
    orbitControls.target.set(0, -0.7, 0);
    const position = new THREE.Vector3(x, y, z).normalize().multiplyScalar(24);
    position.add(orbitControls.target);
    animateCameraTo(position, new THREE.Vector3(0, 1, 0));
    $$('.cubeFace').forEach((face) => face.classList.remove('active'));
}

function fitCurrentView() {
    // A camera view reset (e.g. the default view a freshly loaded example resets to) animates
    // over 650ms via cameraAnimation/updateCameraAnimation, which keeps overwriting camera.position
    // on every subsequent render frame until it finishes. Fitting the view while that's still
    // in flight -- e.g. clicking Fit right after a model loads -- would have this function's own
    // direct position write immediately clobbered by the still-running animation, landing on
    // the animation's stale destination instead of the freshly computed fit.
    cameraAnimation = null;
    orbitControls.enabled = true;
    const bounds = new THREE.Box3();
    nodeObjects.forEach((object) => {
        if (object.visible) bounds.expandByObject(object);
    });
    if (bounds.isEmpty()) {
        orbitControls.target.set(0, -0.7, 0);
        camera.position.set(0, 7.5, 19);
        camera.lookAt(orbitControls.target);
        orbitControls.update();
        return;
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const direction = camera.position.clone().sub(orbitControls.target).normalize();
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const limitingFov = Math.min(verticalFov, horizontalFov);
    const distance = Math.max(orbitControls.minDistance, sphere.radius / Math.sin(limitingFov / 2) * 1.15);
    orbitControls.target.copy(center);
    camera.position.copy(direction.multiplyScalar(distance).add(center));
    camera.lookAt(orbitControls.target);
    orbitControls.update();
}

function zoomCamera(direction) {
    if (direction === 'in') orbitControls.dollyIn(0.8);
    else orbitControls.dollyOut(0.8);
}

function panCamera(direction) {
    const step = 36;
    if (direction === 'up') orbitControls.pan(0, step);
    else if (direction === 'down') orbitControls.pan(0, -step);
    else if (direction === 'left') orbitControls.pan(step, 0);
    else orbitControls.pan(-step, 0);
}

$$('[data-nav-corner]').forEach((button) => {
    button.addEventListener('click', () => setCameraCorner(button.dataset.navCorner));
});
$('[data-nav-action="fit"]').addEventListener('click', fitCurrentView);
$('[data-nav-action="zoomIn"]').addEventListener('click', () => zoomCamera('in'));
$('[data-nav-action="zoomOut"]').addEventListener('click', () => zoomCamera('out'));
$$('[data-nav-pan]').forEach((button) => {
    button.addEventListener('click', () => panCamera(button.dataset.navPan));
});

function updateViewCube() {
    $('#viewCube').dataset.cameraDistance = camera.position.distanceTo(orbitControls.target).toFixed(4);
    $('#viewCube').dataset.cameraTarget = orbitControls.target.toArray().map((value) => value.toFixed(4)).join(',');
    const inverseCameraRotation = camera.quaternion.clone().invert();
    const worldRotation = new THREE.Matrix4().makeRotationFromQuaternion(inverseCameraRotation);
    const flipCssY = new THREE.Matrix4().makeScale(1, -1, 1);
    const cssRotation = flipCssY.clone().multiply(worldRotation).multiply(flipCssY);
    $('#viewCubeObject').style.transform = `matrix3d(${cssRotation.elements.join(',')})`;
    const cameraDirection = camera.position.clone().sub(orbitControls.target).normalize();
    $$('.cubeFace').forEach((face) => {
        face.classList.toggle(
            'active',
            cameraDirection.dot(faceDirections[face.dataset.navView]) > 0.985
        );
    });
}

function deleteSelected() {
    if (activeResult) return;
    finishEquationEdit();
    if (selectedNodeIds.size) {
        const nodeIds = new Set(selectedNodeIds);
        const affectedRelationships = [];
        relationshipObjects.forEach((relationship) => {
            const definition = relationship.definition;
            if (nodeIds.has(definition.source) || nodeIds.has(definition.target)) {
                affectedRelationships.push({
                    id: definition.id,
                    visible: !definition.deleted
                });
            }
        });
        const applyDeleted = (deleted) => {
            nodeIds.forEach((id) => setNodeVisibility(id, !deleted));
            affectedRelationships.forEach((relationship) => {
                setRelationshipVisibility(
                    relationship.id,
                    deleted ? false : relationship.visible
                );
            });
        };
        applyDeleted(true);
        recordHistory({ undo: () => applyDeleted(false), redo: () => applyDeleted(true) });
        clearSelection();
    } else if (selectedRelationship) {
        const id = selectedRelationship.id;
        setRelationshipVisibility(id, false);
        recordHistory({
            undo: () => setRelationshipVisibility(id, true),
            redo: () => setRelationshipVisibility(id, false)
        });
        selectedRelationship = null;
    }
}

function copySelectedGraph() {
    if (activeResult || !selectedNodeIds.size) return false;
    const fragment = createGraphFragment(serializeProjectDocument(), selectedNodeIds);
    if (!fragment) return false;
    window.modelClipboard.write(fragment);
    updateSelectionActionControls();
    $('#statusText').textContent = `${fragment.nodes.length} node${fragment.nodes.length === 1 ? '' : 's'} copied`;
    return true;
}

function hydrateFragmentNode(node) {
    const appearance = node.appearance ?? {};
    const importedGeometry = appearance.type === 'mesh' ? geometryFromDocument(appearance.mesh) : null;
    return {
        id: node.id,
        title: node.name || 'Untitled node',
        type: node.type || 'Custom node',
        shape: importedGeometry ? 'imported' : appearance.shape || 'box',
        position: node.position?.length === 3 ? node.position : [0, 0, 0],
        rotation: node.rotation?.length === 3 ? node.rotation : [0, 0, 0],
        scale: node.scale?.length === 3 ? node.scale : [1, 1, 1],
        color: Number.parseInt(String(appearance.color ?? '#34727a').replace('#', ''), 16),
        importedGeometry,
        geometryFileName: appearance.fileName ?? null,
        badgeClass: '',
        subsystemId: activeSubsystemId,
        deleted: false,
        enabled: node.enabled !== false,
        substepsPerGlobalStep: Math.max(1, Math.min(10000, Number(node.numerics?.substepsPerGlobalStep) || 1)),
        sourceTerms: node.sourceTerms ?? [],
        states: (node.states ?? []).map((state) => ({
            id: state.id,
            label: state.name,
            symbol: state.symbol,
            initialValue: state.initialValue,
            unit: state.unit ?? '',
            value: `${state.initialValue}${state.unit ? ` ${state.unit}` : ''}`,
            className: ''
        }))
    };
}

function hydrateFragmentRelationship(edge) {
    return {
        id: edge.id,
        title: edge.name || 'Untitled relationship',
        source: edge.source.nodeId,
        sourceStateId: edge.source.stateId ?? null,
        target: edge.target.nodeId,
        targetStateId: edge.target.stateId ?? null,
        directionality: edge.directionality ?? 'directed',
        equation: edge.equation ?? '',
        equationModel: edge.equationModel,
        parameters: edge.parameters ?? [],
        color: Number.parseInt(String(edge.appearance?.color ?? '#9c83c4').replace('#', ''), 16),
        offset: Number(edge.appearance?.offset) || 0,
        enabled: edge.enabled !== false
    };
}

// The default [1, 0, 1] paste offset shifts a pasted copy along X and Z, leaving Y untouched --
// which only happens to stay in-plane for a Top/Bottom 2D lock. Locked into Front/Back or
// Left/Right instead, that same offset pushes the copy along whatever axis is "depth" for that
// view, out of the plane every other node is visibly sitting in. Zero out that one axis instead
// of leaving it to coincidence.
function pasteOffsetForCurrentView() {
    const offset = [1, 0, 1];
    if (!is2DLocked) return offset;
    const depthAxis = faceDirections[nearestOrthogonalView()].toArray().findIndex((component) => component !== 0);
    offset[depthAxis] = 0;
    return offset;
}

function pasteGraph() {
    if (activeResult) return false;
    const fragment = window.modelClipboard.read();
    if (!validateGraphFragment(fragment)) return false;
    try {
        const remapped = remapGraphFragment(fragment, nextModelEntityId, pasteOffsetForCurrentView());
        nextModelEntityId = remapped.nextId;
        const nodes = remapped.nodes.map(hydrateFragmentNode);
        const relationships = remapped.edges.map(hydrateFragmentRelationship);
        model.nodes.push(...nodes);
        nodes.forEach(createNode);
        model.relationships.push(...relationships);
        relationships.forEach(createRelationship);
        const nodeIds = nodes.map((node) => node.id);
        const relationshipIds = relationships.map((relationship) => relationship.id);
        const applyVisible = (visible) => {
            nodeIds.forEach((id) => setNodeVisibility(id, visible));
            relationshipIds.forEach((id) => setRelationshipVisibility(id, visible));
            updateRelationships();
            updateModelStatus();
        };
        clearSelection();
        nodeIds.forEach((id) => selectNode(nodeObjects.get(id), { additive: selectedNodeIds.size > 0 }));
        if (currentTool in transformPropertyForTool && selectedNode) transformControls.attach(selectedNode);
        recordHistory({ undo: () => applyVisible(false), redo: () => applyVisible(true) });
        updateRelationships();
        updateModelStatus();
        updateValidationStatus();
        $('#statusText').textContent = `${nodes.length} node${nodes.length === 1 ? '' : 's'} pasted`;
        return true;
    } catch (error) {
        console.error('Copied graph could not be pasted.', error);
        $('#statusText').textContent = error.message;
        return false;
    }
}

// Edge groups: one shared relationship definition (docs/edgeGroups.md) expanded into a
// complete mesh -- one directed edge per ordered member pair, both directions independently
// evaluated (docs/edgeDirectionality.md), each an ordinary edge carrying groupId.
// The card at #edgeGroupEditor is a batch/"Save changes" form (like #edgeBuilder), not the
// #edgeEditor's live-per-field-undo pattern -- a group's shared definition has no single concrete
// node pair to bind against while editing, so live diagnostics/candidates are driven off the
// group's first two resolvable members as a representative preview pair.

function memberEdgesForGroup(groupId) {
    return model.relationships.filter((edge) => edge.groupId === groupId && !edge.deleted);
}

function groupPreviewPair(group) {
    const resolvable = group.memberNodeIds
        .map((id) => model.nodes.find((node) => node.id === id))
        .filter((node) => node && !node.deleted);
    return [resolvable[0] ?? null, resolvable[1] ?? null];
}

// Only counts as "the active group" while its editor card is actually visible -- mirrors how
// selectedRelationship/#edgeEditor already interact, so opening any other card implicitly clears
// it without needing a hook into every hideCards() call site.
function currentEdgeGroup() {
    if ($('#edgeGroupEditor').classList.contains('hidden')) return null;
    return model.edgeGroups.find((group) => group.id === activeEdgeGroupId && !group.deleted) ?? null;
}

// Mirrors the single-edge editor's inline .editorParameterRow pattern (renderEdgeEditor): every
// field commits live through changeEdgeGroupModel, matched by the parameter's own stable id
// rather than position -- addGroupParameterRow is only ever called against a parameter that
// already exists in group.definition.parameters (see the "+" button below, which pushes a stub
// parameter through changeEdgeGroupModel first, the same way #editAddEdgeParameter does).
function addGroupParameterRow(container, parameter, group) {
    const control = normalizedParameterControl({ value: Number(parameter.value) || 0, control: parameter.control });
    const row = document.createElement('div');
    row.className = 'builderRow parameterRow';
    row.innerHTML = `
        <label class="parameterField"><span>Name</span><input data-field="name" value="${escapeHtml(parameter.name ?? '')}"></label>
        <label class="parameterField"><span>Symbol</span><input data-field="symbol" value="${escapeHtml(parameter.symbol ?? '')}"></label>
        <label class="parameterField"><span>Initial value</span><input data-field="value" type="number" value="${escapeHtml(parameter.value ?? '')}"></label>
        <label class="parameterField"><span>Unit</span><input data-field="unit" value="${escapeHtml(parameter.unit ?? '')}"></label>
        <label class="parameterField"><span>Mode</span><select data-field="mode"><option value="constant">Constant</option><option value="live">Live</option></select></label>
        <button class="removeBuilderRow" type="button" title="Remove">×</button>
        <div class="parameterControlFields" ${parameter.mode === 'live' ? '' : 'hidden'}>
            <label class="parameterField"><span>Slider minimum</span><input data-control-field="minimum" type="number" value="${control.minimum}"></label>
            <label class="parameterField"><span>Slider maximum</span><input data-control-field="maximum" type="number" value="${control.maximum}"></label>
            <label class="parameterField"><span>Slider step</span><input data-control-field="step" type="number" min="0" value="${control.step}"></label>
            <span class="parameterControlError" role="status"></span>
        </div>
    `;
    $('[data-field="mode"]', row).value = parameter.mode ?? 'constant';
    container.appendChild(row);
    const readControl = () => Object.fromEntries($$('[data-control-field]', row)
        .map((input) => [input.dataset.controlField, Number(input.value)]));
    const showControlError = () => {
        const error = $('[data-field="mode"]', row).value === 'live'
            ? parameterControlError(Number($('[data-field="value"]', row).value), readControl()) : '';
        $('.parameterControlError', row).textContent = error;
        return error;
    };
    $$('[data-control-field], [data-field="value"]', row).forEach((input) => input.addEventListener('input', showControlError));
    $$('[data-field]', row).forEach((input) => input.addEventListener('change', () => {
        if (input.dataset.field === 'mode') $('.parameterControlFields', row).hidden = input.value !== 'live';
        if (showControlError()) return;
        changeEdgeGroupModel(group, (snapshot) => {
            const target = snapshot.definition.parameters.find((candidate) => candidate.id === parameter.id);
            target[input.dataset.field] = input.dataset.field === 'value' ? Number(input.value) || 0 : input.value.trim();
            if (target.mode === 'live') target.control = readControl();
            else delete target.control;
        });
    }));
    $$('[data-control-field]', row).forEach((input) => input.addEventListener('change', () => {
        if (showControlError()) return;
        changeEdgeGroupModel(group, (snapshot) => {
            const target = snapshot.definition.parameters.find((candidate) => candidate.id === parameter.id);
            target.value = Number($('[data-field="value"]', row).value) || 0;
            target.control = readControl();
        });
    }));
    row.querySelector('.removeBuilderRow').addEventListener('click', () => changeEdgeGroupModel(group, (snapshot) => {
        snapshot.definition.parameters = snapshot.definition.parameters.filter((candidate) => candidate.id !== parameter.id);
    }));
}

// Converts one auto-bind candidate (concrete nodeId/stateId, from providerReferenceCandidates)
// into the group's own symbol-keyed provider binding shape -- the inverse of what
// renderGroupProviderBindingRows does to pre-select a row's reference dropdown.
function candidateToGroupBinding(key, candidate, previewSource, previewTarget) {
    if (candidate.kind === 'parameter') return { key, kind: 'parameter', parameterId: candidate.parameterId };
    const node = candidate.role === 'source' ? previewSource : previewTarget;
    return { key, kind: 'state', role: candidate.role, symbol: node?.states.find((state) => state.id === candidate.stateId)?.symbol ?? '' };
}

function renderGroupProviderBindingRows(group, previewSource, previewTarget) {
    const container = $('#groupProviderBindingRows');
    container.replaceChildren();
    const bindings = group.definition.implementation?.bindings ?? [];
    const candidates = providerReferenceCandidates({
        source: previewSource?.id, target: previewTarget?.id, parameters: group.definition.parameters
    });
    if (!bindings.length) container.innerHTML = '<p class="emptyEditorState">No bindings defined</p>';
    bindings.forEach((binding, index) => {
        const row = document.createElement('div');
        row.className = 'builderRow providerBindingRow';
        row.innerHTML = `
            <label class="parameterField"><span>Key</span><input data-field="key" value="${escapeHtml(binding.key ?? '')}"></label>
            <label class="parameterField"><span>Reference</span><select data-field="reference"></select></label>
            <button class="removeBuilderRow" type="button" title="Remove">×</button>
        `;
        const select = $('[data-field="reference"]', row);
        select.replaceChildren(...candidates.map((candidate) => new Option(candidate.label, providerReferenceValue(candidate))));
        if (binding.kind === 'parameter') {
            select.value = `parameter:${binding.parameterId}`;
        } else {
            const node = binding.role === 'source' ? previewSource : previewTarget;
            const state = node?.states.find((candidate) => candidate.symbol === binding.symbol);
            if (state) select.value = `state:${binding.role}:${node.id}:${state.id}`;
        }
        $('[data-field="key"]', row).addEventListener('change', (event) => {
            changeEdgeGroupModel(group, (snapshot) => {
                snapshot.definition.implementation.bindings[index] = { ...snapshot.definition.implementation.bindings[index], key: event.target.value.trim() };
            });
        });
        select.addEventListener('change', (event) => {
            const candidate = candidates.find((option) => providerReferenceValue(option) === event.target.value);
            if (!candidate) return;
            changeEdgeGroupModel(group, (snapshot) => {
                snapshot.definition.implementation.bindings[index] = candidateToGroupBinding($('[data-field="key"]', row).value.trim(), candidate, previewSource, previewTarget);
            });
        });
        row.querySelector('.removeBuilderRow').addEventListener('click', () => changeEdgeGroupModel(group, (snapshot) => {
            snapshot.definition.implementation.bindings = snapshot.definition.implementation.bindings.filter((candidate, i) => i !== index);
        }));
        container.appendChild(row);
    });
}

function renderGroupEquationDiagnostics(group) {
    const [previewSource, previewTarget] = groupPreviewPair(group);
    const bindings = reconcileEquationBindings([], previewSource, previewTarget, group.definition.parameters);
    const latex = ($('#groupMathField').hidden ? $('#groupEquation') : $('#groupMathField')).value;
    const validation = validateEquationLatex(latex, bindings);
    const diagnostics = $('#groupEquationDiagnostics');
    diagnostics.classList.toggle('valid', validation.valid);
    diagnostics.textContent = validation.valid ? 'Valid expression · MathJSON ready' : validation.errors.join(' ');
    return { validation, bindings };
}

function renderEdgeGroupEditor(group) {
    $('#editGroupHeading').textContent = group.name;
    $('#groupName').value = group.name;
    $('#groupColor').value = `#${group.color.toString(16).padStart(6, '0')}`;
    const edges = memberEdgesForGroup(group.id);
    $('#toggleEdgeGroupEnabled').textContent = edges.length && edges.every((edge) => edge.enabled === false) ? 'Enable all' : 'Disable all';

    const membersList = $('#groupMembersList');
    membersList.replaceChildren();
    const members = group.memberNodeIds
        .map((id) => model.nodes.find((node) => node.id === id))
        .filter((node) => node && !node.deleted);
    if (!members.length) membersList.innerHTML = '<p class="emptyEditorState">No members</p>';
    members.forEach((node) => {
        const row = document.createElement('div');
        row.className = 'groupMemberRow';
        row.innerHTML = `<span>${escapeHtml(node.title)}</span><button class="removeBuilderRow" type="button" title="Detach">×</button>`;
        row.querySelector('.removeBuilderRow').addEventListener('click', () => detachNodeFromGroup(group, node.id));
        membersList.appendChild(row);
    });
    const soleSelectedId = selectedNodeIds.size === 1 ? [...selectedNodeIds][0] : null;
    $('#groupAddMember').disabled = Boolean(activeResult) || soleSelectedId === null || group.memberNodeIds.includes(soleSelectedId);

    const [previewSource, previewTarget] = groupPreviewPair(group);
    const implementationKind = group.definition.implementation?.kind ?? 'equation';
    const isEquation = implementationKind === 'equation';
    $('#groupImplementationKind').value = implementationKind;
    $('#groupEquationHeading').hidden = !isEquation;
    $('#groupEquationDiagnostics').hidden = !isEquation;
    $('#groupReferenceHint').hidden = !isEquation;
    $('#groupProviderSection').hidden = isEquation;

    // No source/target role choice here, unlike a hand-authored edge's own "Updates" picker --
    // every generated member edge contributes to its own target by construction (see
    // docs/edgeDirectionality.md), so a group only ever needs to name *which state*, deduplicated
    // across both preview nodes.
    const output = $('#groupEquationOutput');
    output.replaceChildren();
    const outputSymbols = [...new Set([...(previewSource?.states ?? []), ...(previewTarget?.states ?? [])]
        .map((state) => state.symbol))];
    outputSymbols.forEach((symbol) => output.add(new Option(symbol, symbol)));
    output.value = group.definition.output.symbol;

    const parameterContainer = $('#groupParameterRows');
    parameterContainer.replaceChildren();
    if (!group.definition.parameters.length) parameterContainer.innerHTML = '<p class="emptyEditorState">No parameters defined</p>';
    else group.definition.parameters.forEach((parameter) => addGroupParameterRow(parameterContainer, parameter, group));

    const mathField = $('#groupMathField');
    const latexSource = $('#groupEquation');
    if (isEquation) {
        const latexMode = $('[data-group-equation-mode="latex"]').classList.contains('active');
        mathField.hidden = latexMode;
        latexSource.hidden = !latexMode;
        mathField.value = group.definition.equation;
        latexSource.value = group.definition.equation;
        const portList = (role, node) => node?.states.length
            ? node.states.map((state) => `${role}${state.symbol[0].toUpperCase()}${state.symbol.slice(1)}`).join(', ')
            : 'none';
        $('#groupReferenceHint').textContent = previewSource && previewTarget
            ? `Available references (from "${previewSource.title}"/"${previewTarget.title}"): ${portList('source', previewSource)}, ${portList('target', previewTarget)}. Every member must supply the state named in "Updates" below.`
            : 'Add at least two members to see available equation references.';
        renderGroupEquationDiagnostics(group);
    } else {
        mathField.hidden = true;
        latexSource.hidden = true;
        $('#groupProviderSource').value = group.definition.implementation?.source ?? '';
        $('#groupInsertProviderTemplate').hidden = !group.definition.implementation?.source?.trim();
        $('#groupProviderOutputKey').value = group.definition.implementation?.output?.key ?? '';
        renderGroupProviderBindingRows(group, previewSource, previewTarget);
    }
}

function captureEdgeGroupModel(group) {
    return { name: group.name, color: group.color, definition: structuredClone(group.definition) };
}

// Pure apply: mutates the group's own record, re-resolves every *existing* member edge's fields
// (never regenerates one that was individually deleted -- see deleteSelected's edge branch), and
// refreshes visuals. Shared by every live field edit below and by every membership action's
// undo/redo. `rerenderEditor: false` skips the full form re-render -- used only while a field is
// actively being typed into (previewGroupEquation/previewGroupProviderSource), so an in-progress
// keystroke's own field doesn't get clobbered/reset mid-edit the way a full re-render would.
function applyEdgeGroupModel(group, snapshot, { rerenderEditor = true } = {}) {
    group.name = snapshot.name;
    group.color = snapshot.color;
    group.definition = structuredClone(snapshot.definition);
    const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
    memberEdgesForGroup(group.id).forEach((edge) => {
        const sourceNode = nodesById.get(edge.source);
        const targetNode = nodesById.get(edge.target);
        if (!sourceNode || !targetNode) return;
        const resolved = resolveGroupEdgeForPair({ group, sourceNode, targetNode, allocateId: () => edge.id });
        edge.title = resolved.title;
        edge.color = resolved.color;
        edge.equation = resolved.equation;
        edge.equationModel = resolved.equationModel;
        edge.implementation = resolved.implementation ?? null;
        edge.parameters = resolved.parameters;
        edge.sourceStateId = resolved.sourceStateId;
        edge.targetStateId = resolved.targetStateId;
        refreshRelationshipVisual(edge);
    });
    updateRelationships();
    updateValidationStatus();
    if (rerenderEditor && currentEdgeGroup()?.id === group.id) renderEdgeGroupEditor(group);
}

// The group editor's equivalent of changeEdgeModel: capture, mutate a clone, validate, apply, and
// record one undo step -- used by every discrete field commit (name, colour, implementation kind,
// parameter/binding rows). Continuously-typed fields (equation text, provider source) go through
// previewGroupEquation/previewGroupProviderSource instead, which batch keystrokes into one
// undo step via beginEquationEditSession/finishEquationEdit, the same session mechanism the
// single-edge editor's own live equation typing already uses -- reused here unchanged.
function changeEdgeGroupModel(group, mutate) {
    if (activeResult) return false;
    finishEquationEdit();
    const before = captureEdgeGroupModel(group);
    const after = structuredClone(before);
    mutate(after);
    const parameterSymbols = after.definition.parameters.map((parameter) => parameter.symbol);
    if (parameterSymbols.some((symbol) => !modelSymbolPattern.test(symbol)) ||
        new Set(parameterSymbols).size !== parameterSymbols.length) {
        renderEdgeGroupEditor(group);
        return false;
    }
    applyEdgeGroupModel(group, after);
    recordHistory({
        undo: () => applyEdgeGroupModel(group, before),
        redo: () => applyEdgeGroupModel(group, after)
    });
    return true;
}

function previewGroupEquation(latex, origin) {
    const group = currentEdgeGroup();
    if (activeResult || !group) return;
    beginEquationEditSession(`group:${group.id}`, () => captureEdgeGroupModel(group), (snapshot) => applyEdgeGroupModel(group, snapshot));
    group.definition.equation = latex;
    applyEdgeGroupModel(group, captureEdgeGroupModel(group), { rerenderEditor: false });
    if (origin !== 'visual') $('#groupMathField').setValue(latex, { silenceNotifications: true });
    if (origin !== 'latex') $('#groupEquation').value = latex;
    renderGroupEquationDiagnostics(group);
}

function previewGroupProviderSource(source) {
    const group = currentEdgeGroup();
    if (activeResult || !group?.definition.implementation) return;
    beginEquationEditSession(`group:${group.id}`, () => captureEdgeGroupModel(group), (snapshot) => applyEdgeGroupModel(group, snapshot));
    group.definition.implementation = { ...group.definition.implementation, source };
    applyEdgeGroupModel(group, captureEdgeGroupModel(group), { rerenderEditor: false });
    $('#groupInsertProviderTemplate').hidden = !source.trim();
}

// The one field whose commit isn't a plain changeEdgeGroupModel call: picking a different
// "Updates" state can require adding that state to a member node first, and doing so must land in
// the same undo step as the output-symbol change itself -- a lone state-add with no matching
// definition change would leave the model in a shape that was never actually valid at any point
// in history.
function changeGroupOutputSymbol(group) {
    if (activeResult) return;
    finishEquationEdit();
    const outputSymbol = $('#groupEquationOutput').value;
    if (!outputSymbol || outputSymbol === group.definition.output.symbol) return;
    const before = captureEdgeGroupModel(group);
    const after = structuredClone(before);
    after.definition.output = { symbol: outputSymbol };

    const autoAdd = $('#groupAutoAddStates').checked;
    const affectedNodes = autoAdd
        ? group.memberNodeIds
            .map((id) => model.nodes.find((node) => node.id === id))
            .filter((node) => node && !node.deleted && unresolvedGroupSymbols({ group: { definition: after.definition }, node }).length)
        : [];
    const nodeStatesBefore = new Map(affectedNodes.map((node) => [node.id, structuredClone(node.states)]));
    affectedNodes.forEach((node) => {
        node.states.push({ id: allocateModelEntityId(), label: outputSymbol, symbol: outputSymbol, initialValue: 0, unit: '', value: '0', className: '' });
    });
    const nodeStatesAfter = new Map(affectedNodes.map((node) => [node.id, structuredClone(node.states)]));
    const applyNodeStates = (statesById) => statesById.forEach((states, nodeId) => {
        const node = model.nodes.find((candidate) => candidate.id === nodeId);
        if (node) node.states = structuredClone(states);
    });

    applyEdgeGroupModel(group, after);
    recordHistory({
        undo: () => { applyNodeStates(nodeStatesBefore); applyEdgeGroupModel(group, before); },
        redo: () => { applyNodeStates(nodeStatesAfter); applyEdgeGroupModel(group, after); }
    });
}

function openEdgeGroupEditor(groupId) {
    const group = model.edgeGroups.find((item) => item.id === groupId && !item.deleted);
    if (!group) return;
    activeEdgeGroupId = groupId;
    selectedRelationship = null;
    const editor = $('#edgeGroupEditor');
    hideCards(editor);
    renderEdgeGroupEditor(group);
    editor.style.removeProperty('left');
    editor.style.removeProperty('top');
    editor.classList.remove('hidden');
    applyInspectorReadOnly();
    requestAnimationFrame(avoidAssistantInspectorOverlap);
}

// N member nodes expand to N(N-1) edges -- confirm before it grows large, and refuse outright
// past a point with no engine- or validator-side guard against the blowup (docs/edgeGroups.md).
function confirmEdgeGroupSize(nodeCount) {
    // N(N-1), not C(N,2): one directed edge each way per member pair (docs/edgeDirectionality.md).
    const edgeCount = nodeCount * (nodeCount - 1);
    if (nodeCount > 40) {
        window.alert(`An edge group can have at most 40 member nodes (${40 * 39} edges in the mesh).`);
        return false;
    }
    if (nodeCount > 10) {
        return window.confirm(`This will create ${edgeCount} edges between ${nodeCount} nodes. Continue?`);
    }
    return true;
}

function createEdgeGroupFromSelection() {
    if (activeResult || selectedNodeIds.size < 2) return false;
    const nodeIds = [...selectedNodeIds];
    if (!confirmEdgeGroupSize(nodeIds.length)) return false;
    const id = allocateModelEntityId();
    const group = {
        id,
        name: `Edge group ${model.edgeGroups.filter((item) => !item.deleted).length + 1}`,
        memberNodeIds: nodeIds,
        color: 0x2fb8a4,
        deleted: false,
        definition: { parameters: [], output: { symbol: '' }, equation: '', implementation: null }
    };
    model.edgeGroups.push(group);
    const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
    const edges = expandEdgeGroup({ group, nodesById, allocateId: allocateModelEntityId });
    model.relationships.push(...edges);
    edges.forEach(createRelationship);
    updateRelationships();
    updateModelStatus();
    const edgeIds = edges.map((edge) => edge.id);
    const apply = (created) => {
        group.deleted = !created;
        edgeIds.forEach((edgeId) => setRelationshipVisibility(edgeId, created));
    };
    apply(true);
    recordHistory({ undo: () => apply(false), redo: () => apply(true) });
    openEdgeGroupEditor(id);
    return true;
}

function addNodeToGroup(group, nodeId) {
    if (activeResult || group.memberNodeIds.includes(nodeId)) return false;
    const node = model.nodes.find((candidate) => candidate.id === nodeId && !candidate.deleted);
    if (!node) return false;
    if (!confirmEdgeGroupSize(group.memberNodeIds.length + 1)) return false;
    const autoAdd = $('#groupAutoAddStates').checked;
    const symbol = group.definition.output.symbol;
    const needsState = autoAdd && symbol && unresolvedGroupSymbols({ group, node }).length > 0;
    // Allocated once, up front, and reused verbatim by both directions of the undo step below --
    // never re-allocated inside apply(), or redo would mint a second, different state each time.
    const newState = needsState
        ? { id: allocateModelEntityId(), label: symbol, symbol, initialValue: 0, unit: '', value: '0', className: '' }
        : null;
    const previewNode = newState ? { ...node, states: [...node.states, newState] } : node;
    const nodesById = new Map(model.nodes.map((candidate) => [candidate.id, candidate.id === nodeId ? previewNode : candidate]));
    // One edge in each direction against every existing member -- see memberPairs/expandEdgeGroup
    // and docs/edgeDirectionality.md for why a group's mesh uses directed pairs rather than one
    // bidirectional edge per member.
    const newEdges = group.memberNodeIds.flatMap((existingId) => [
        resolveGroupEdgeForPair({ group, sourceNode: nodesById.get(nodeId), targetNode: nodesById.get(existingId), allocateId: allocateModelEntityId }),
        resolveGroupEdgeForPair({ group, sourceNode: nodesById.get(existingId), targetNode: nodesById.get(nodeId), allocateId: allocateModelEntityId })
    ]);
    const apply = (added) => {
        if (added) {
            group.memberNodeIds.push(nodeId);
            if (newState) node.states.push(newState);
            model.relationships.push(...newEdges);
            newEdges.forEach(createRelationship);
        } else {
            group.memberNodeIds = group.memberNodeIds.filter((id) => id !== nodeId);
            if (newState) node.states = node.states.filter((state) => state.id !== newState.id);
            newEdges.forEach((edge) => setRelationshipVisibility(edge.id, false));
        }
        updateRelationships();
        updateModelStatus();
        if (currentEdgeGroup()?.id === group.id) renderEdgeGroupEditor(group);
    };
    apply(true);
    recordHistory({ undo: () => apply(false), redo: () => apply(true) });
    return true;
}

// Leaves the detached node's own edges to the rest of the group behind as ordinary edges, exactly
// as authored -- only clears groupId, per docs/edgeGroups.md. The rest of the mesh is
// untouched.
function detachNodeFromGroup(group, nodeId) {
    if (activeResult || !group.memberNodeIds.includes(nodeId)) return false;
    const touchedEdges = memberEdgesForGroup(group.id).filter((edge) => edge.source === nodeId || edge.target === nodeId);
    const apply = (detached) => {
        group.memberNodeIds = detached
            ? group.memberNodeIds.filter((id) => id !== nodeId)
            : [...group.memberNodeIds, nodeId];
        touchedEdges.forEach((edge) => { edge.groupId = detached ? null : group.id; });
        updateRelationships();
        updateModelStatus();
        if (currentEdgeGroup()?.id === group.id) renderEdgeGroupEditor(group);
    };
    apply(true);
    recordHistory({ undo: () => apply(false), redo: () => apply(true) });
    return true;
}

function deleteEdgeGroupAction(group) {
    if (activeResult) return false;
    const edgeIds = memberEdgesForGroup(group.id).map((edge) => edge.id);
    const apply = (deleted) => {
        group.deleted = deleted;
        edgeIds.forEach((id) => setRelationshipVisibility(id, !deleted));
        updateModelStatus();
    };
    apply(true);
    $('#edgeGroupEditor').classList.add('hidden');
    recordHistory({ undo: () => apply(false), redo: () => apply(true) });
    return true;
}

function toggleEdgeGroupEnabledAction(group) {
    if (activeResult) return false;
    const edges = memberEdgesForGroup(group.id);
    if (!edges.length) return false;
    const nextEnabled = edges.some((edge) => edge.enabled === false);
    const previous = new Map(edges.map((edge) => [edge.id, edge.enabled !== false]));
    const apply = (enabled) => {
        edges.forEach((edge) => setRelationshipEnabled(edge.id, enabled));
        if (currentEdgeGroup()?.id === group.id) renderEdgeGroupEditor(group);
    };
    apply(nextEnabled);
    recordHistory({
        undo: () => edges.forEach((edge) => setRelationshipEnabled(edge.id, previous.get(edge.id))),
        redo: () => apply(nextEnabled)
    });
    return true;
}

function createSubsystemFromSelection(name) {
    if (activeResult || !selectedNodeIds.size) return false;
    const nodeIds = [...selectedNodeIds];
    const id = allocateModelEntityId();
    const center = nodeIds.reduce((sum, nodeId) => sum.add(nodeObjects.get(nodeId).position), new THREE.Vector3())
        .multiplyScalar(1 / nodeIds.length);
    const serialized = serializeProjectDocument();
    const subsystem = {
        id,
        name: name.trim() || `Subsystem ${model.subsystems.filter((item) => !item.deleted).length + 1}`,
        parentSubsystemId: activeSubsystemId,
        position: center.toArray(),
        ports: deriveSubsystemPorts({ subsystemId: id, nodeIds, edges: serialized.edges, allocateId: allocateModelEntityId }),
        deleted: false
    };
    const previousMembership = new Map(nodeIds.map((nodeId) => [nodeId,
        model.nodes.find((node) => node.id === nodeId).subsystemId]));
    model.subsystems.push(subsystem);
    createSubsystemObject(subsystem);
    const apply = (created) => {
        subsystem.deleted = !created;
        nodeIds.forEach((nodeId) => {
            const node = model.nodes.find((item) => item.id === nodeId);
            node.subsystemId = created ? id : previousMembership.get(nodeId);
        });
        refreshSubsystemView();
    };
    apply(true);
    recordHistory({ undo: () => apply(false), redo: () => apply(true) });
    $('#statusText').textContent = `${subsystem.name} created with ${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'} and ${subsystem.ports.length} boundary ${subsystem.ports.length === 1 ? 'port' : 'ports'}`;
    return true;
}

$('#createSubsystem').addEventListener('click', () => {
    if (activeResult || !selectedNodeIds.size) return;
    $('#subsystemName').value = `Subsystem ${model.subsystems.filter((item) => !item.deleted).length + 1}`;
    $('#subsystemDialog').showModal();
    $('#subsystemName').select();
});
$('#subsystemCancel').addEventListener('click', () => $('#subsystemDialog').close());
$('#subsystemDialog form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (createSubsystemFromSelection($('#subsystemName').value)) $('#subsystemDialog').close();
});

$('#createEdgeGroup').addEventListener('click', () => createEdgeGroupFromSelection());
$('#nodeContextCreateEdgeGroup').addEventListener('click', () => {
    hideCards();
    createEdgeGroupFromSelection();
});
$('#nodeContextAddToGroup').addEventListener('click', () => {
    const group = currentEdgeGroup();
    hideCards($('#edgeGroupEditor'));
    if (group && selectedNode) addNodeToGroup(group, selectedNode.userData.id);
});
$('#nodeContextDetachFromGroup').addEventListener('click', () => {
    const group = currentEdgeGroup();
    hideCards($('#edgeGroupEditor'));
    if (group && selectedNode) detachNodeFromGroup(group, selectedNode.userData.id);
});
$('#edgeContextOpenGroup').addEventListener('click', () => {
    const groupId = selectedRelationship?.groupId;
    hideCards();
    if (groupId != null) openEdgeGroupEditor(groupId);
});

$('#groupAddMember').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (group && selectedNodeIds.size === 1) addNodeToGroup(group, [...selectedNodeIds][0]);
});
$('#toggleEdgeGroupEnabled').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (group) toggleEdgeGroupEnabledAction(group);
});
$('[data-delete-edge-group]').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (group) deleteEdgeGroupAction(group);
});
$('#groupName').addEventListener('change', (event) => {
    const group = currentEdgeGroup();
    if (group) changeEdgeGroupModel(group, (snapshot) => { snapshot.name = event.target.value.trim() || 'Untitled edge group'; });
});
$('#groupColor').addEventListener('change', (event) => {
    const group = currentEdgeGroup();
    if (group) changeEdgeGroupModel(group, (snapshot) => { snapshot.color = Number.parseInt(event.target.value.replace('#', ''), 16); });
});
$('#groupAddParameter').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (!group) return;
    changeEdgeGroupModel(group, (snapshot) => {
        snapshot.definition.parameters.push({
            id: allocateModelEntityId(), name: 'Parameter', symbol: `p${snapshot.definition.parameters.length + 1}`,
            value: 0, unit: '', mode: 'constant'
        });
    });
});
$('#groupEquationOutput').addEventListener('change', () => {
    const group = currentEdgeGroup();
    if (group) changeGroupOutputSymbol(group);
});
$('#groupImplementationKind').addEventListener('change', (event) => {
    const group = currentEdgeGroup();
    const isEquation = event.target.value === 'equation';
    $('#groupEquationHeading').hidden = !isEquation;
    $('#groupEquationDiagnostics').hidden = !isEquation;
    $('#groupReferenceHint').hidden = !isEquation;
    $('#groupProviderSection').hidden = isEquation;
    const latexMode = $('[data-group-equation-mode="latex"]').classList.contains('active');
    $('#groupMathField').hidden = !isEquation || latexMode;
    $('#groupEquation').hidden = !isEquation || !latexMode;
    if (!group) return;
    const kind = event.target.value;
    changeEdgeGroupModel(group, (snapshot) => {
        if (kind === 'equation') {
            snapshot.definition.implementation = null;
            return;
        }
        const bindings = snapshot.definition.implementation?.bindings ?? [];
        const output = snapshot.definition.implementation?.output ?? { key: 'output' };
        snapshot.definition.implementation = {
            kind,
            providerApiVersion: 1,
            source: snapshot.definition.implementation?.source || defaultProviderSource(kind, bindings, output.key, snapshot.name),
            bindings,
            output
        };
    });
});
$('#groupInsertProviderTemplate').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (!group?.definition.implementation) return;
    const { kind, bindings, output } = group.definition.implementation;
    if ($('#groupProviderSource').value.trim() &&
        !window.confirm('Replace the current provider source with a freshly generated template?')) return;
    changeEdgeGroupModel(group, (snapshot) => {
        snapshot.definition.implementation.source = defaultProviderSource(kind, bindings, output?.key, snapshot.name);
    });
});
$('#groupProviderSource').addEventListener('input', (event) => {
    previewGroupProviderSource(event.target.value);
});
$('#groupProviderSource').addEventListener('change', () => finishEquationEdit());
$('#groupProviderOutputKey').addEventListener('change', (event) => {
    const group = currentEdgeGroup();
    if (group) changeEdgeGroupModel(group, (snapshot) => {
        if (snapshot.definition.implementation) snapshot.definition.implementation.output = { key: event.target.value.trim() };
    });
});
$('#groupOpenProviderEditor').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (!group) return;
    providerEditTarget = { type: 'group', groupId: group.id };
    window.providerEditor.openWindow({
        source: $('#groupProviderSource').value,
        kind: $('#groupImplementationKind').value,
        title: group.name
    });
});
$('#groupAddProviderBinding').addEventListener('click', () => {
    const group = currentEdgeGroup();
    if (!group) return;
    const [previewSource, previewTarget] = groupPreviewPair(group);
    changeEdgeGroupModel(group, (snapshot) => {
        const candidates = providerReferenceCandidates({
            source: previewSource?.id, target: previewTarget?.id, parameters: snapshot.definition.parameters
        });
        if (!candidates.length) return;
        snapshot.definition.implementation.bindings.push(
            candidateToGroupBinding(`input${snapshot.definition.implementation.bindings.length + 1}`, candidates[0], previewSource, previewTarget));
    });
});
$('#groupMathField').addEventListener('input', (event) => {
    previewGroupEquation(event.target.value, 'visual');
});
$('#groupMathField').addEventListener('change', () => finishEquationEdit());
$('#groupEquation').addEventListener('input', (event) => {
    previewGroupEquation(event.target.value, 'latex');
});
$('#groupEquation').addEventListener('change', () => finishEquationEdit());
$$('[data-group-equation-mode]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-group-equation-mode]').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
    const latexMode = button.dataset.groupEquationMode === 'latex';
    $('#groupMathField').hidden = latexMode;
    $('#groupEquation').hidden = !latexMode;
    (latexMode ? $('#groupEquation') : $('#groupMathField')).focus();
}));

$('#copySelection').addEventListener('click', copySelectedGraph);
$('#pasteSelection').addEventListener('click', pasteGraph);
window.addEventListener('focus', updateSelectionActionControls);

$('#newWindowButton').dataset.tooltip = `New window (${isMac ? '⌘N' : 'Ctrl+N'})`;
$('#loadButton').dataset.tooltip = `Open project (${isMac ? '⌘O' : 'Ctrl+O'})`;
$('#saveButton').dataset.tooltip = `Save project (${isMac ? '⌘S' : 'Ctrl+S'})`;
updateEncryptionControls();
$('#undoButton').dataset.tooltip = `Undo (${isMac ? '⌘Z' : 'Ctrl+Z'})`;
$('#redoButton').dataset.tooltip = `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`;
$('#copySelection').dataset.tooltip = `Copy selected (${isMac ? '⌘C' : 'Ctrl+C'})`;
$('#pasteSelection').dataset.tooltip = `Paste (${isMac ? '⌘V' : 'Ctrl+V'})`;
$('#selectAllShortcutHint').textContent = isMac ? '⌘A' : 'Ctrl+A';
$('#undoButton').addEventListener('click', undo);
$('#redoButton').addEventListener('click', redo);
updateHistoryControls();

const documentTitle = $('.documentTitle');
const documentTitleInput = $('.documentTitleInput');

function beginFilenameEdit() {
    documentTitleInput.value = filenameStem(currentProjectFilename);
    documentTitle.hidden = true;
    documentTitleInput.hidden = false;
    documentTitleInput.focus();
    documentTitleInput.select();
}

async function commitFilenameEdit() {
    if (documentTitleInput.hidden) return;
    const previousFilename = currentProjectFilename;
    const nextFilename = camelCaseFilename(documentTitleInput.value);
    documentTitleInput.hidden = true;
    documentTitle.hidden = false;
    currentProjectFilename = nextFilename;
    updateDocumentTitle();
    if (currentProjectPath && nextFilename !== previousFilename && !await saveProject(true)) {
        currentProjectFilename = previousFilename;
        updateDocumentTitle();
    }
}

function cancelFilenameEdit() {
    documentTitleInput.hidden = true;
    documentTitle.hidden = false;
}

documentTitle.addEventListener('click', beginFilenameEdit);
documentTitleInput.addEventListener('change', commitFilenameEdit);
documentTitleInput.addEventListener('blur', commitFilenameEdit);
documentTitleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        documentTitleInput.blur();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelFilenameEdit();
    }
});

$('[data-action="delete"]').addEventListener('click', deleteSelected);
$('[data-delete-node]').addEventListener('click', () => {
    deleteSelected();
    $('#nodeEditor').classList.add('hidden');
});
$('[data-delete-edge]').addEventListener('click', () => {
    deleteSelected();
    $('#edgeEditor').classList.add('hidden');
});
$('#toggleNodeEnabled').addEventListener('click', toggleSelectedNodeEnabled);
$('#toggleEdgeEnabled').addEventListener('click', toggleSelectedEdgeEnabled);
$('#nodeContextConnect').addEventListener('click', () => {
    hideCards();
    if (!activeResult && selectedNode) connectFromNode(selectedNode);
});
$('#nodeContextToggle').addEventListener('click', () => {
    hideCards();
    toggleSelectedNodeEnabled();
});
$('#nodeContextDisableAll').addEventListener('click', () => {
    hideCards();
    setSelectedNodesEnabled(false);
});
$('#nodeContextEnableAll').addEventListener('click', () => {
    hideCards();
    setSelectedNodesEnabled(true);
});
$('#nodeContextDelete').addEventListener('click', () => {
    hideCards();
    deleteSelected();
});
$('#edgeContextToggle').addEventListener('click', () => {
    hideCards();
    toggleSelectedEdgeEnabled();
});
$('#edgeContextDelete').addEventListener('click', () => {
    hideCards();
    deleteSelected();
});
$('#edgeContextAddWaypoint').addEventListener('click', () => {
    hideCards();
    const staged = pendingWaypoint;
    pendingWaypoint = null;
    if (!staged || selectedRelationship?.id !== staged.relationshipId) return;
    changeEdgeModel(selectedRelationship, (clone) => {
        clone.waypoints.splice(staged.insertionIndex, 0, staged.point);
    });
});
$('#waypointContextRemove').addEventListener('click', () => {
    hideCards();
    const staged = pendingWaypointRemoval;
    pendingWaypointRemoval = null;
    const definition = staged && relationshipObjects.get(staged.relationshipId)?.definition;
    if (!definition) return;
    changeEdgeModel(definition, (clone) => {
        clone.waypoints.splice(staged.index, 1);
    });
});
$('[data-action="select-all"]').addEventListener('click', () => {
    hideCards();
    selectAllNodes();
});
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeEndpointPick) {
        finishEndpointPick();
        return;
    }
    const isEditing = event.target.matches?.('input, textarea, select, math-field') ||
        event.target.isContentEditable ||
        event.composedPath().some((element) => element?.matches?.('input, textarea, select, math-field') || element?.isContentEditable);
    const commandKey = isMac ? event.metaKey : event.ctrlKey;
    if (commandKey && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        $('#zoomInButton').click();
        return;
    }
    if (commandKey && event.key === '-') {
        event.preventDefault();
        $('#zoomOutButton').click();
        return;
    }
    if (commandKey && event.key === '0') {
        event.preventDefault();
        window.uiZoom.reset();
        $('#zoomOutButton').disabled = false;
        $('#zoomInButton').disabled = false;
        $('#zoomOutButton').dataset.tooltip = 'Zoom interface out · 100%';
        $('#zoomInButton').dataset.tooltip = 'Zoom interface in · 100%';
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        window.windowControls.newWindow();
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openProject();
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveProject(event.shiftKey);
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 'c' && selectedNodeIds.size) {
        event.preventDefault();
        copySelectedGraph();
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteGraph();
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllNodes();
        return;
    }
    if (!isEditing && commandKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
    }
    if (!isEditing && !isMac && event.ctrlKey && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
    }
    if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        !isEditing
    ) {
        deleteSelected();
    }
});

function resizeRenderer() {
    const rect = webglContainer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height, false);
    labelRenderer.setSize(rect.width, rect.height);
}

new ResizeObserver(resizeRenderer).observe(webglContainer);
resizeRenderer();
setTool('select');
setCameraView('orbit', false);
updateModelStatus();
initializeAddonToolstripContributions();
checkPendingProjectOpen();

let lastRenderTime = 0;
function render(time) {
    requestAnimationFrame(render);
    if (document.hidden || time - lastRenderTime < 1000 / 30) return;
    lastRenderTime = time;
    if (!updateCameraAnimation(time)) orbitControls.update();
    updateViewCube();

    relationshipObjects.forEach((relationship) => {
        relationship.line.material.opacity = relationship.definition.id === selectedRelationship?.id
            ? 1
            : 0.92;
    });

    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

requestAnimationFrame(render);
