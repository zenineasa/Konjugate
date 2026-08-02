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
import { eligibleEndpointIds, virtualKeyboardInset } from './viewportLayout.mjs';
import { groupRelationshipBundles } from '../relationshipBundles.mjs';
import { nearestSampleIndex, nodeResultSeries, ResultPlot } from './resultPlot.mjs';
import { applyAssistantProposal as buildAssistantProposal } from '../assistantOperations.mjs';
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
const defaultRunConfiguration = () => ({
    id: crypto.randomUUID(), name: 'Default', globalTimeStep: 0.01, outputInterval: 0.1
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
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    document.nodes.forEach((node) => {
        if (!uuidPattern.test(node.id) || ids.has(node.id)) {
            throw new Error('Every node must have a unique UUID id.');
        }
        ids.add(node.id);
        nodeIds.add(node.id);
        const stateIds = new Set();
        const stateSymbols = new Set();
        (node.states ?? []).forEach((state) => {
            if (!uuidPattern.test(state.id) || ids.has(state.id)) {
                throw new Error(`Every state in “${node.name ?? node.id}” must have a unique UUID id.`);
            }
            ids.add(state.id);
            stateIds.add(state.id);
            if (!modelSymbolPattern.test(state.symbol) || stateSymbols.has(state.symbol)) {
                throw new Error(`State symbols in “${node.name ?? node.id}” must be unique lower camel case identifiers.`);
            }
            stateSymbols.add(state.symbol);
        });
        (node.sourceTerms ?? []).forEach((term) => {
            if (!uuidPattern.test(term.id) || ids.has(term.id)) {
                throw new Error(`Every source term in “${node.name ?? node.id}” must have a unique UUID id.`);
            }
            ids.add(term.id);
            if (!stateSymbols.has(term.state)) {
                throw new Error(`A source term in “${node.name ?? node.id}” references a missing state symbol.`);
            }
        });
        stateIdsByNode.set(node.id, stateIds);
    });
    document.edges.forEach((edge) => {
        if (!uuidPattern.test(edge.id) || ids.has(edge.id)) {
            throw new Error('Every edge must have a unique UUID id.');
        }
        ids.add(edge.id);
        if (!nodeIds.has(edge.source?.nodeId) || !nodeIds.has(edge.target?.nodeId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing node.`);
        }
        if (edge.source.stateId && !stateIdsByNode.get(edge.source.nodeId)?.has(edge.source.stateId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing source state.`);
        }
        if (edge.target.stateId && !stateIdsByNode.get(edge.target.nodeId)?.has(edge.target.stateId)) {
            throw new Error(`Edge “${edge.name ?? edge.id}” references a missing target state.`);
        }
        const parameterSymbols = new Set();
        (edge.parameters ?? []).forEach((parameter) => {
            if (!uuidPattern.test(parameter.id) || ids.has(parameter.id)) {
                throw new Error(`Every parameter in “${edge.name ?? edge.id}” must have a unique UUID id.`);
            }
            ids.add(parameter.id);
            if (!modelSymbolPattern.test(parameter.symbol) || parameterSymbols.has(parameter.symbol)) {
                throw new Error(`Parameter symbols in “${edge.name ?? edge.id}” must be unique lower camel case identifiers.`);
            }
            parameterSymbols.add(parameter.symbol);
        });
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
            color: Number.parseInt(String(appearance.color ?? '#34727a').replace('#', ''), 16),
            importedGeometry,
            geometryFileName: appearance.fileName ?? null,
            badgeClass: '',
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
        parameters: edge.parameters ?? [],
        color: Number.parseInt(String(edge.appearance?.color ?? '#9c83c4').replace('#', ''), 16),
        offset: Number(edge.appearance?.offset) || 0
    }));
    const runConfigurations = Array.isArray(document.runConfigurations) && document.runConfigurations.length
        ? document.runConfigurations.map((configuration) => ({
            id: configuration.id ?? crypto.randomUUID(),
            name: configuration.name || 'Untitled',
            globalTimeStep: Number(configuration.globalTimeStep) || 0.01,
            outputInterval: Number(configuration.outputInterval) || 0.1
        }))
        : [defaultRunConfiguration()];
    return {
        metadata: { units: document.metadata?.units || 'SI' },
        runConfigurations,
        activeRunConfigurationId: runConfigurations.some((item) => item.id === document.activeRunConfigurationId)
            ? document.activeRunConfigurationId : runConfigurations[0].id,
        nodes,
        relationships
    };
}

const emptyProjectDocument = {
    format: 'konjugate',
    version: 1,
    copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
    metadata: { units: 'SI' },
    runConfigurations: [],
    nodes: [],
    edges: []
};
const model = hydrateProjectDocument(emptyProjectDocument);
let currentProjectPath = null;
let currentProjectFilename = 'untitled.kjt';
let currentProjectPassword = null;

function filenameStem(fileName) {
    return fileName.replace(/\.kjt$/i, '').replace(/\.konjugate\.json$/i, '').replace(/\.json$/i, '');
}

function camelCaseFilename(value) {
    const words = value.trim().replace(/\.konjugate\.json$/i, '').replace(/\.json$/i, '')
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
const nodePickTargets = [];
const relationshipPickTargets = [];
let selectedNode = null;
let selectedRelationship = null;
let currentTool = 'select';
let currentView = 'orbit';
let activeEndpointPick = null;
let endpointPickRestoreCard = null;
let endpointPickMaterialState = new Map();
let cameraAnimation = null;
let pendingImportedGeometry = null;
let pendingGeometryFileName = '';
let currentValidation = { valid: false, issues: [], executableModel: null };
let validationRevision = 0;
let engineValidationTimer = null;
let equationEditSession = null;
let simulationRunning = false;
let activeResult = null;
let activeEngineJobId = null;
let runLaunchSettings = {
    targetTime: 1,
    online: false,
    pacing: { mode: 'fastest', simulationSecondsPerWallSecond: 1 }
};
let pendingRestart = null;
let activeResultSampleIndex = 0;
let resultPlaybackTimer = null;
let resultPlaying = false;
let nodeDetailsBeforeResult = null;
let toolBeforeResult = null;
let addonToolstripContributions = [];
let pendingAssistantProposal = null;
let assistantPreviewRevision = 0;
let assistantGenerationController = null;
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
        if (documentController.dirty && !await window.projectFiles.confirmDiscard()) return;
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
transformControls.addEventListener('objectChange', () => {
    updateRelationships();
    updateSelectionOutline();
});
let transformStartPosition = null;
transformControls.addEventListener('mouseDown', () => {
    transformStartPosition = transformControls.object?.position.clone() ?? null;
});
transformControls.addEventListener('mouseUp', () => {
    const object = transformControls.object;
    if (!object || !transformStartPosition || object.position.equals(transformStartPosition)) {
        transformStartPosition = null;
        return;
    }
    const from = transformStartPosition.clone();
    const to = object.position.clone();
    recordHistory({
        undo: () => {
            object.position.copy(from);
            updateRelationships();
        },
        redo: () => {
            object.position.copy(to);
            updateRelationships();
        }
    });
    transformStartPosition = null;
});

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

function materialFor(definition) {
    return new THREE.MeshStandardMaterial({
        color: definition.color,
        metalness: 0.2,
        roughness: 0.42
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
            </div>
            <dl>${stateRows}</dl>
            <span class="stateCount">${definition.states.length} ${definition.states.length === 1 ? 'state' : 'states'}</span>
        </div>
    `;

    wrapper.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
    });
    wrapper.addEventListener('click', (event) => {
        event.stopPropagation();
        if (activeEndpointPick) {
            chooseEndpointNode(definition.id);
            return;
        }
        selectNode(nodeObjects.get(definition.id));
        openNodeEditor(definition);
    });
    wrapper.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
    });

    const label = new CSS2DObject(wrapper);
    label.position.fromArray(nodeLabelOffset(geometry));
    label.center.set(0, 0.5);
    return label;
}

function createNode(definition) {
    const mesh = new THREE.Mesh(geometryFor(definition), materialFor(definition));
    mesh.position.fromArray(definition.position);
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

model.nodes.forEach(createNode);

const selectionOutline = new THREE.BoxHelper(undefined, 0x62e1d5);
selectionOutline.material.depthTest = false;
selectionOutline.material.transparent = true;
selectionOutline.material.opacity = 0.9;
selectionOutline.renderOrder = 20;
selectionOutline.visible = false;
scene.add(selectionOutline);

function relationshipPoints(definition) {
    const source = nodeObjects.get(definition.source).position;
    const target = nodeObjects.get(definition.target).position;
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

    return { start, midpoint, end };
}

function createDirectionMarker(definition, curve) {
    if (definition.directionality !== 'directed') return null;

    const marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.14, 0.42, 14),
        new THREE.MeshBasicMaterial({
            color: definition.color,
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
        points.midpoint,
        points.end
    ]);
    const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(42));
    const material = new THREE.LineBasicMaterial({
        color: definition.color,
        transparent: true,
        opacity: 0.92
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
    relationship.line.visible = visible;
    if (relationship.marker) relationship.marker.visible = visible;
    updateModelStatus();
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
    node.visible = visible;
    updateModelStatus();
}

function captureNodeAppearance(definition) {
    return {
        shape: definition.shape,
        importedGeometry: definition.importedGeometry?.clone() ?? null,
        geometryFileName: definition.geometryFileName ?? null
    };
}

function applyNodeAppearance(node, appearance) {
    const definition = node.userData.definition;
    definition.importedGeometry?.dispose();
    definition.shape = appearance.shape;
    definition.importedGeometry = appearance.importedGeometry?.clone() ?? null;
    definition.geometryFileName = appearance.geometryFileName ?? null;
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
            points.midpoint,
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
let dragStartPosition = null;
dragControls.addEventListener('dragstart', (event) => {
    orbitControls.enabled = false;
    dragStartPosition = event.object.position.clone();
    selectNode(event.object);
});
dragControls.addEventListener('drag', () => {
    updateRelationships();
    updateSelectionOutline();
});
dragControls.addEventListener('dragend', (event) => {
    orbitControls.enabled = true;
    if (dragStartPosition && !event.object.position.equals(dragStartPosition)) {
        const object = event.object;
        const from = dragStartPosition.clone();
        const to = object.position.clone();
        recordHistory({
            undo: () => {
                object.position.copy(from);
                updateRelationships();
            },
            redo: () => {
                object.position.copy(to);
                updateRelationships();
            }
        });
    }
    dragStartPosition = null;
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
    return raycaster.intersectObjects(targets, true)[0];
}

function rootNodeFromIntersection(intersection) {
    let object = intersection?.object;
    while (object && object.userData.kind !== 'node') object = object.parent;
    return object ?? null;
}

function updateSelectionOutline() {
    if (!selectedNode || !selectedNode.visible) {
        selectionOutline.visible = false;
        return;
    }
    selectionOutline.setFromObject(selectedNode);
    selectionOutline.visible = true;
}

function selectNode(node) {
    selectedNode = node;
    selectedRelationship = null;
    updateRelationshipSelection();
    updateSelectionOutline();
    if (activeResult) window.addons.publishEvent('selection.change', node.userData.id);
}

function selectRelationship(relationship) {
    selectedNode = null;
    selectedRelationship = relationship;
    selectionOutline.visible = false;
    updateRelationshipSelection();
    if (activeResult) window.addons.publishEvent('selection.change', null);
}

function clearSelection() {
    selectedNode = null;
    selectedRelationship = null;
    selectionOutline.visible = false;
    updateRelationshipSelection();
    transformControls.detach();
    if (activeResult) window.addons.publishEvent('selection.change', null);
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
        const row = document.createElement('div');
        row.className = 'editorSourceTermRow';
        row.innerHTML = `
            <select aria-label="Updated state">${definition.states.map((state) => `<option value="${escapeHtml(state.symbol)}" ${state.symbol === term.state ? 'selected' : ''}>${escapeHtml(state.label)}</option>`).join('')}</select>
            <input value="${escapeHtml(term.expression)}" aria-label="Source expression">
            <button type="button" title="Remove source term">×</button>
        `;
        $('select', row).addEventListener('change', (event) => changeNodeModel(node, (snapshot) => {
            snapshot.sourceTerms.find((candidate) => candidate.id === term.id).state = event.target.value;
        }));
        $('input', row).addEventListener('change', (event) => changeNodeModel(node, (snapshot) => {
            snapshot.sourceTerms.find((candidate) => candidate.id === term.id).expression = event.target.value.trim();
        }));
        $('button', row).addEventListener('click', () => changeNodeModel(node, (snapshot) => {
            snapshot.sourceTerms = snapshot.sourceTerms.filter((candidate) => candidate.id !== term.id);
        }));
        sourceTermContainer.appendChild(row);
    });
}

async function renderNodeResults(node) {
    const panel = $('.nodeResultsPanel');
    const series = nodeResultSeries(activeResult, node.userData.definition);
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
    $('#editNodeGeometryFile').value = '';
    $('#editGeometryStatus').textContent = definition.geometryFileName ?? 'Choose a CAD or mesh file';
    $('#editNodeGeometryFile').closest('.geometryImportField').classList.remove('loading', 'error');
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
        parameters: structuredClone(definition.parameters)
    };
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
    setRelationshipDirectionality(definition, snapshot.directionality);
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

function renderEdgeEditor(definition) {
    $('.edgeEditor > header strong').textContent = definition.title;
    $('#editEdgeName').value = definition.title;
    const source = $('#editEdgeSource');
    const target = $('#editEdgeTarget');
    const options = model.nodes.filter((node) => nodeObjects.get(node.id)?.visible === true);
    source.replaceChildren(...options.map((node) => new Option(node.title, node.id)));
    target.replaceChildren(...options.map((node) => new Option(node.title, node.id)));
    source.value = definition.source;
    target.value = definition.target;
    $('#editEdgeDirectionality').value = definition.directionality;
    const parameterContainer = $('#edgeEditorParameters');
    parameterContainer.replaceChildren();
    if (!definition.parameters.length) parameterContainer.innerHTML = '<p class="emptyEditorState">No parameters defined</p>';
    definition.parameters.forEach((parameter) => {
        const row = document.createElement('div');
        row.className = 'editorParameterRow';
        row.innerHTML = `
            <input data-field="name" value="${escapeHtml(parameter.name)}" aria-label="Parameter name">
            <input data-field="symbol" value="${escapeHtml(parameter.symbol)}" aria-label="Parameter symbol">
            <input data-field="value" type="number" value="${escapeHtml(parameter.value)}" aria-label="Value">
            <input data-field="unit" value="${escapeHtml(parameter.unit ?? '')}" aria-label="Unit">
            <select data-field="mode" aria-label="Mode"><option value="constant">Constant</option><option value="live">Live</option></select>
            <button type="button" title="Remove parameter">×</button>
        `;
        $('[data-field="mode"]', row).value = parameter.mode ?? 'constant';
        $$('input, select', row).forEach((input) => input.addEventListener('change', () => {
            changeEdgeModel(definition, (snapshot) => {
                const targetParameter = snapshot.parameters.find((candidate) => candidate.id === parameter.id);
                targetParameter[input.dataset.field] = input.dataset.field === 'value'
                    ? Number(input.value) || 0
                    : input.value.trim();
            });
        }));
        $('button', row).addEventListener('click', () => changeEdgeModel(definition, (snapshot) => {
            snapshot.parameters = snapshot.parameters.filter((candidate) => candidate.id !== parameter.id);
        }));
        parameterContainer.appendChild(row);
    });
    definition.equationModel = normalizeEdgeEquationModel(definition);
    definition.equation = definition.equationModel.latex;
    const mathField = $('#editEdgeMathField');
    const latexSource = $('#editEdgeEquation');
    mathField.value = definition.equationModel.latex;
    latexSource.value = definition.equationModel.latex;
    const output = $('#editEquationOutput');
    output.replaceChildren();
    [['source', definition.source], ['target', definition.target]].forEach(([role, nodeId]) => {
        const node = model.nodes.find((candidate) => candidate.id === nodeId);
        node?.states.forEach((state) => {
            output.add(new Option(`${role}.${state.symbol}`, `${role}:${state.id}`));
        });
    });
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

function openRelationshipEditor(definition, clientX, clientY) {
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

async function importNodeGeometry(file) {
    const extension = file.name.split('.').pop()?.toLowerCase();
    const buffer = await file.arrayBuffer();
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
}

function addSourceTermRow() {
    const row = document.createElement('div');
    row.className = 'builderRow sourceTermRow';
    row.innerHTML = `
        <select class="sourceState" aria-label="Updated state"></select>
        <input class="sourceExpression" placeholder="Source expression, e.g. qDot / heatCapacity">
        <button class="removeBuilderRow" type="button" title="Remove">×</button>
    `;
    $('#sourceTermRows').appendChild(row);
    row.querySelector('.removeBuilderRow').addEventListener('click', () => row.remove());
    refreshSourceStateOptions();
}

function addEdgeParameterRow(values = {}) {
    const row = document.createElement('div');
    row.className = 'builderRow parameterRow';
    row.innerHTML = `
        <input data-field="name" placeholder="Name" value="${values.name ?? ''}">
        <input data-field="symbol" placeholder="Symbol" value="${values.symbol ?? ''}">
        <input data-field="value" type="number" placeholder="Value" value="${values.value ?? ''}">
        <input data-field="unit" placeholder="Unit" value="${values.unit ?? ''}">
        <select data-field="mode" aria-label="Parameter mode"><option value="constant">Constant</option><option value="live">Live</option></select>
        <button class="removeBuilderRow" type="button" title="Remove">×</button>
    `;
    $('[data-field="mode"]', row).value = values.mode ?? 'constant';
    $('#edgeParameterRows').appendChild(row);
    $$('input, select', row).forEach((input) => input.addEventListener('input', refreshStateReferences));
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
    if (model.nodes.some((node) => node.id === previousSource)) source.value = previousSource;
    if (model.nodes.some((node) => node.id === previousTarget)) target.value = previousTarget;
    refreshStateReferences();
}

function finishEndpointPick() {
    activeEndpointPick = null;
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
    const otherEndpoint = activeEndpointPick === 'source' ? $('#edgeTarget').value : $('#edgeSource').value;
    if (nodeId === otherEndpoint) return;
    $(`#edge${activeEndpointPick[0].toUpperCase()}${activeEndpointPick.slice(1)}`).value = nodeId;
    refreshStateReferences();
    finishEndpointPick();
}

function startEndpointPick(endpoint) {
    finishEndpointPick();
    activeEndpointPick = endpoint;
    dragControls.enabled = false;
    canvas.classList.add('pickingEndpoint');
    const button = $(`[data-pick-endpoint="${endpoint}"]`);
    button.classList.add('active');
    const otherEndpoint = endpoint === 'source' ? $('#edgeTarget').value : $('#edgeSource').value;
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
    const sourceNode = model.nodes.find((node) => node.id === $('#edgeSource').value);
    const targetNode = model.nodes.find((node) => node.id === $('#edgeTarget').value);
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
}

function renderBuilderEquationDiagnostics(bindings = null) {
    const availableBindings = bindings ?? (() => {
        const sourceNode = model.nodes.find((node) => node.id === $('#edgeSource').value);
        const targetNode = model.nodes.find((node) => node.id === $('#edgeTarget').value);
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
    const visibleNodes = model.nodes.filter((node) => nodeObjects.get(node.id)?.visible !== false).length;
    const visibleRelationships = model.relationships.filter(
        (relationship) => relationshipObjects.get(relationship.id)?.line.visible !== false
    ).length;
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
        const node = nodeObjects.get(item.location.entityId);
        if (!node) return;
        selectNode(node);
        openNodeEditor(node.userData.definition);
        const field = { name: '#editNodeName', states: '#nodeEditorStates input', sourceTerms: '#nodeEditorSourceTerms input' }[item.location.field];
        if (field) requestAnimationFrame(() => $(field)?.focus());
    } else if (item.location.kind === 'edge') {
        const relationship = model.relationships.find((candidate) => candidate.id === item.location.entityId);
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
            const result = await window.engine.validate(JSON.stringify(projectDocument ?? serializeProjectDocument()));
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
        if (!item.location.entityId) return;
        const previous = severityByEntity.get(item.location.entityId);
        if (!previous || item.severity === 'error') severityByEntity.set(item.location.entityId, item.severity);
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
    const plannedIntervals = Math.max(1, Math.ceil(targetTime / Number(activeResult.outputInterval)));
    const availableIntervals = Math.max(0, activeResult.samples.length - 1);
    $('#resultTimeline').max = String(Math.max(plannedIntervals, availableIntervals));
    $('#resultTimeline').style.setProperty('--available-progress', `${100 * availableIntervals / Math.max(plannedIntervals, availableIntervals)}%`);
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
    const sample = activeResult.samples[activeResultSampleIndex];
    sample.states.forEach((state) => updateDisplayedState(state.stateId, state.value));
    $('#resultTimeline').value = String(activeResultSampleIndex);
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
    if (activeResultSampleIndex >= activeResult.samples.length - 1) {
        stopResultPlayback();
        return;
    }
    const current = activeResult.samples[activeResultSampleIndex];
    const next = activeResult.samples[activeResultSampleIndex + 1];
    const rate = Number($('#resultPlaybackRate').value) || 1;
    resultPlaybackTimer = setTimeout(() => {
        projectResultSample(activeResultSampleIndex + 1);
        scheduleResultPlayback();
    }, Math.max(40, (next.time - current.time) * 1000 / rate));
}

function applyInspectorReadOnly() {
    const locked = Boolean(activeResult);
    $$('[data-result-readonly]').forEach((notice) => { notice.hidden = !locked; });
    $$('#nodeEditor [data-node-panel]:not([data-node-panel="results"]) :is(input, select, textarea, button), #nodeEditor > footer button, #edgeEditor section :is(input, select, textarea, button), #edgeEditor > footer button').forEach((control) => {
        control.disabled = locked;
    });
    $$('#nodeEditor math-field, #edgeEditor math-field').forEach((field) => {
        field.readOnly = locked;
        field.toggleAttribute('read-only', locked);
    });
}

function setResultModeLocked(locked) {
    canvas.classList.toggle('resultModeLocked', locked);
    $('#addButton').disabled = locked;
    $('#assistantButton').disabled = locked;
    $('[data-action="delete"]').disabled = locked;
    $('[data-tool="move"]').disabled = locked;
    $('#runConfigurationButton').disabled = locked;
    $('#runButton').disabled = locked || simulationRunning || !currentValidation.valid;
    transformControls.detach();
    if (locked) {
        discardAssistantProposal();
        hideAssistantPanel();
        $$('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === 'select'));
        setTool('select');
    } else if (toolBeforeResult) {
        const restoredTool = toolBeforeResult;
        toolBeforeResult = null;
        $$('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === restoredTool));
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
    $('#closeResults').lastChild.textContent = 'Close results and edit';
    if (activeResult?.pacing) {
        const { mode, simulationSecondsPerWallSecond: ratio } = activeResult.pacing;
        const value = mode === 'limitedRatio' ? `limitedRatio:${ratio}` : mode;
        if ([...$('#simulationPacing').options].some((option) => option.value === value)) $('#simulationPacing').value = value;
    }
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

async function clearResultPlayback() {
    if (!activeResult) return;
    if (simulationRunning) return;
    stopResultPlayback();
    window.addons.closeContext('resultSession');
    activeResult = null;
    activeEngineJobId = null;
    simulationRunning = false;
    setResultModeLocked(false);
    nodeResultPlot.clear();
    $('.nodeResultsPanel').classList.remove('hasResults');
    $('#resultTransport').hidden = true;
    model.nodes.forEach((node) => node.states.forEach((state) => updateDisplayedState(state.id, state.initialValue)));
    if (nodeDetailsBeforeResult !== null) setLabelDetail('nodes', nodeDetailsBeforeResult);
    nodeDetailsBeforeResult = null;
    renderValidationStatus();
}

$('#resultTimeline').addEventListener('input', (event) => {
    stopResultPlayback();
    projectResultSample(Number(event.target.value));
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
    $('#resultPlayPause').textContent = '❚❚';
    $('#resultPlayPause').ariaLabel = 'Pause results';
    scheduleResultPlayback();
});
$('#resultPlaybackRate').addEventListener('change', () => {
    if (resultPlaying) { clearTimeout(resultPlaybackTimer); scheduleResultPlayback(); }
});
$('#simulationPacing').addEventListener('change', async (event) => {
    if (!activeEngineJobId) return;
    const [mode, ratio] = event.target.value.split(':');
    await window.engine.setPacing(activeEngineJobId, {
        mode,
        simulationSecondsPerWallSecond: mode === 'realTime' ? 1 : Number(ratio || 1)
    });
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
$('#closeResults').addEventListener('click', clearResultPlayback);
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
            nodes: model.nodes.map((node) => ({
                id: node.id,
                title: node.title,
                states: node.states.map(({ id, label, symbol, unit }) => ({ id, label, symbol, unit }))
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
    if (pendingRestart && activeResult) {
        activeResult = { ...activeResult, lifecycle: 'running' };
        updateLiveResultControls();
    }
    $('#runButton').disabled = true;
    $('#runButton').title = 'Simulation is running';
    $('#statusText').textContent = 'Running simulation…';
    try {
        const configuration = model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);
        const execution = await window.engine.start(JSON.stringify(serializeProjectDocument()), {
            ...configuration,
            targetTime: runLaunchSettings.targetTime,
            pacing: runLaunchSettings.pacing,
            ...(pendingRestart ? { startCheckpoint: pendingRestart.checkpoint } : {})
        });
        if (!execution.available) throw new Error('The C++ simulation engine is unavailable.');
        activeEngineJobId = execution.jobId;
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
    updateLiveResultControls();
    $('#statusText').textContent = result.lifecycle === 'stopped' ? 'Simulation stopped · partial results retained' : 'Simulation complete';
});
window.engine.onError(({ jobId, message }) => {
    if (jobId !== activeEngineJobId) return;
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

$('#runConfigurationButton').addEventListener('click', () => {
    if (activeResult) return;
    const configuration = model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId);
    $('#runConfigurationName').value = configuration.name;
    $('#runGlobalTimeStep').value = configuration.globalTimeStep;
    $('#runOutputInterval').value = configuration.outputInterval;
    $('#runConfigurationError').textContent = '';
    $('#runConfigurationDialog').showModal();
});
$('#runConfigurationCancel').addEventListener('click', () => $('#runConfigurationDialog').close());
$('#runConfigurationDialog form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (activeResult) return;
    const before = structuredClone(model.runConfigurations.find((item) => item.id === model.activeRunConfigurationId));
    const after = {
        ...before,
        name: $('#runConfigurationName').value.trim() || 'Untitled',
        globalTimeStep: Number($('#runGlobalTimeStep').value),
        outputInterval: Number($('#runOutputInterval').value)
    };
    const outputRatio = after.outputInterval / after.globalTimeStep;
    if (!(after.globalTimeStep > 0) || !(after.outputInterval > 0) || after.outputInterval < after.globalTimeStep ||
        Math.abs(outputRatio - Math.round(outputRatio)) > 1e-9) {
        $('#runConfigurationError').textContent = 'Use positive values; output interval must be an integer multiple of the global timestep.';
        return;
    }
    applyRunConfiguration(after);
    recordHistory({ undo: () => applyRunConfiguration(before), redo: () => applyRunConfiguration(after) });
    $('#runConfigurationDialog').close();
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
        overlay.anchor.visible = Boolean(sourceObject?.visible && targetObject?.visible);
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
        const row = event.target.closest('.relationshipRow');
        const bundle = activeRelationshipBundles().find((candidate) => candidate.key === key);
        const definition = row
            ? model.relationships.find((relationship) => relationship.id === row.dataset.relationship)
            : bundle?.relationships[0];
        if (definition) openRelationshipEditor(definition);
    });
    element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.target.closest('.relationshipRow');
        const bundle = activeRelationshipBundles().find((candidate) => candidate.key === key);
        const definition = row
            ? model.relationships.find((relationship) => relationship.id === row.dataset.relationship)
            : bundle?.relationships[0];
        if (definition) selectRelationship(definition);
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
        parameter: relationship.parameters?.[0]
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
        row.className = 'relationshipRow';
        row.dataset.relationship = relationship.id;
        row.type = 'button';
        row.innerHTML = `
            <i class="relationColor" style="background:#${relationship.color.toString(16).padStart(6, '0')}"></i>
            <span><b>${relationship.directionality === 'directed' ? '→' : '⇄'}</b> ${escapeHtml(relationship.title)}</span>
            <em>${escapeHtml(summary)}</em>
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
    const visibleNodes = model.nodes.filter((node) => nodeObjects.get(node.id)?.visible === true);
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
                numerics: { substepsPerGlobalStep: node.substepsPerGlobalStep },
                position: object.position.toArray(),
                states: node.states.map((state) => ({
                    id: state.id ?? crypto.randomUUID(),
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
                relationshipObjects.get(edge.id)?.line.visible === true &&
                visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
            ))
            .map((edge) => ({
                id: edge.id,
                name: edge.title,
                source: { nodeId: edge.source, stateId: edge.sourceStateId ?? null },
                target: { nodeId: edge.target, stateId: edge.targetStateId ?? null },
                directionality: edge.directionality,
                equation: edge.equationModel?.latex ?? edge.equation ?? '',
                equationModel: normalizeEdgeEquationModel(edge),
                parameters: edge.parameters ?? [],
                appearance: {
                    color: `#${edge.color.toString(16).padStart(6, '0')}`,
                    offset: edge.offset
                }
            }))
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
    relationshipObjects.clear();
    nodeObjects.clear();
    relationshipPickTargets.length = 0;
    nodePickTargets.length = 0;
}

function loadProjectDocument(document, {
    path = null,
    fileName = 'untitled.kjt',
    saved = true,
    password = null
} = {}) {
    clearResultPlayback();
    discardAssistantProposal();
    hideAssistantPanel();
    const nextModel = hydrateProjectDocument(document);
    clearRenderedModel();
    model.metadata = nextModel.metadata;
    model.runConfigurations = nextModel.runConfigurations;
    model.activeRunConfigurationId = nextModel.activeRunConfigurationId;
    model.nodes.splice(0, model.nodes.length, ...nextModel.nodes);
    model.relationships.splice(0, model.relationships.length, ...nextModel.relationships);
    model.nodes.forEach(createNode);
    model.relationships.forEach(createRelationship);
    invalidateRelationshipBundles();
    updateRelationships();
    updateModelStatus();
    currentProjectPath = path;
    currentProjectFilename = fileName;
    currentProjectPassword = password;
    documentController.reset({ saved });
    updateDocumentTitle();
    updateEncryptionControls();
    setCameraView('orbit');
}

function replaceModelContents(document) {
    const nextModel = hydrateProjectDocument(document);
    clearRenderedModel();
    model.metadata = nextModel.metadata;
    model.runConfigurations = nextModel.runConfigurations;
    model.activeRunConfigurationId = nextModel.activeRunConfigurationId;
    model.nodes.splice(0, model.nodes.length, ...nextModel.nodes);
    model.relationships.splice(0, model.relationships.length, ...nextModel.relationships);
    model.nodes.forEach(createNode);
    model.relationships.forEach(createRelationship);
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
    return [$('#nodeEditor'), $('#edgeEditor')].find((editor) => !editor.classList.contains('hidden')) ?? null;
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
        $('#assistantProposal').hidden = false;
        $('#assistantProposalStatus').className = '';
        $('#assistantProposalStatus').textContent = 'Proposal rejected';
        $('#assistantError').textContent = error.message;
        $('#assistantError').hidden = false;
        $('#applyAssistantProposal').disabled = true;
        return { valid: false, error: error.message };
    }
}

function discardAssistantProposal() {
    assistantPreviewRevision += 1;
    pendingAssistantProposal = null;
    $('#assistantProposal').hidden = true;
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
    replaceModelContents(after);
    recordHistory({
        undo: () => replaceModelContents(before),
        redo: () => replaceModelContents(after)
    });
    discardAssistantProposal();
    hideAssistantPanel();
    return true;
}

function assistantModelSummary() {
    const document = serializeProjectDocument();
    return {
        format: document.format,
        version: document.version,
        units: document.metadata.units,
        nodes: document.nodes.map((node) => ({
            id: node.id, name: node.name, type: node.type,
            states: node.states.map((state) => ({ id: state.id, name: state.name, symbol: state.symbol, initialValue: state.initialValue, unit: state.unit }))
        })),
        edges: document.edges.map((edge) => ({
            id: edge.id, name: edge.name, sourceNodeId: edge.source.nodeId,
            targetNodeId: edge.target.nodeId, directionality: edge.directionality
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
    $('#assistantEmpty').hidden = true;
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
    try {
        const proposal = await window.aiProviders.generateProposal(
            requestUuid, $('#assistantConfiguration').value, request, assistantModelSummary()
        );
        if (controller.signal.aborted) return { valid: false, cancelled: true };
        return await previewAssistantProposal(proposal);
    } catch (error) {
        if (controller.signal.aborted || error.name === 'AbortError') return { valid: false, cancelled: true };
        renderAssistantGenerationError(error.message);
        return { valid: false, error: error.message };
    } finally {
        if (assistantGenerationController === controller) {
            assistantGenerationController = null;
            button.disabled = false;
            button.textContent = pendingAssistantProposal ? 'Revise proposal' : 'Generate proposal';
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
$('#discardAssistantProposal').addEventListener('click', discardAssistantProposal);
$('#applyAssistantProposal').addEventListener('click', commitAssistantProposal);
$('#assistantChanges').addEventListener('click', (event) => {
    const control = event.target.closest('[data-focus-entity]');
    if (control) inspectAssistantEntity(control.dataset.focusEntity);
});
$('#assistantPromptForm').addEventListener('submit', (event) => {
    event.preventDefault();
    requestAssistantProposal();
});
$('#assistantConfiguration').addEventListener('change', async () => {
    activeAssistantConfigurationUuid = $('#assistantConfiguration').value;
    assistantGenerationController?.abort();
    discardAssistantProposal();
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
    discardProposal: discardAssistantProposal
});

function openNodeBuilder(clientX, clientY) {
    const builder = $('#nodeBuilder');
    hideCards(builder);
    $('#newNodeName').value = 'New node';
    $('#newNodeShape').value = 'box';
    $('#nodeGeometryFile').value = '';
    $('#geometryImportField').hidden = true;
    $('#geometryImportField').classList.remove('loading', 'error');
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
    $('#newEdgeName').value = 'New relationship';
    $('#edgeEquation').value = '';
    $('#edgeMathField').setValue('', { silenceNotifications: true });
    $('#edgeMathField').hidden = false;
    $('#edgeEquation').hidden = true;
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

let nodePointerDown = null;

renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || transformControls.dragging) return;
    setPointerFromEvent(event);
    const node = rootNodeFromIntersection(firstIntersection(nodePickTargets));

    if (node) {
        selectNode(node);
        if (activeEndpointPick) {
            nodePointerDown = null;
            chooseEndpointNode(node.userData.id);
            return;
        }
        nodePointerDown = { id: node.userData.id, x: event.clientX, y: event.clientY };
        if (!activeResult && currentTool === 'move') transformControls.attach(node);
        return;
    }

    nodePointerDown = null;

    if (activeEndpointPick) return;

    const relationshipHit = firstIntersection(relationshipPickTargets);
    if (relationshipHit) {
        const definition = relationshipHit.object.userData.definition;
        selectRelationship(definition);
        transformControls.detach();
        openRelationshipEditor(definition);
        return;
    }

    clearSelection();
    hideCards();
});

renderer.domElement.addEventListener('pointerup', (event) => {
    if (event.button !== 0 || !nodePointerDown || activeEndpointPick) {
        nodePointerDown = null;
        return;
    }
    const pointerTravel = Math.hypot(
        event.clientX - nodePointerDown.x,
        event.clientY - nodePointerDown.y
    );
    const node = nodeObjects.get(nodePointerDown.id);
    nodePointerDown = null;
    if (pointerTravel <= 4 && node?.visible) openNodeEditor(node.userData.definition);
});

renderer.domElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    setPointerFromEvent(event);
    const node = rootNodeFromIntersection(firstIntersection(nodePickTargets));

    if (node) {
        selectNode(node);
        return;
    }

    const relationshipHit = firstIntersection(relationshipPickTargets);
    if (relationshipHit) {
        selectRelationship(relationshipHit.object.userData.definition);
        return;
    }

    if (!activeResult) openAddPalette(event.clientX, event.clientY);
});

$$('[data-close-card]').forEach((button) => {
    button.addEventListener('click', () => {
        if (button.closest('#edgeEditor')) finishEquationEdit();
        if (button.closest('#edgeBuilder')) finishEndpointPick();
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
            id: crypto.randomUUID(),
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
            id: crypto.randomUUID(),
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

function previewEdgeEquation(latex, origin) {
    if (activeResult || !selectedRelationship) return;
    const definition = selectedRelationship;
    if (!equationEditSession || equationEditSession.relationshipId !== definition.id) {
        finishEquationEdit();
        equationEditSession = { relationshipId: definition.id, definition, before: captureEdgeModel(definition) };
    }
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

function finishEquationEdit() {
    if (!equationEditSession) return;
    const { definition, before } = equationEditSession;
    equationEditSession = null;
    const after = captureEdgeModel(definition);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    recordHistory({
        undo: () => applyEdgeModel(definition, before),
        redo: () => applyEdgeModel(definition, after)
    });
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
        snapshot.equationModel.output = { role, stateId };
    });
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
            id: crypto.randomUUID(),
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
        shape: event.target.value,
        importedGeometry: null,
        geometryFileName: null
    });
    $('#editGeometryStatus').textContent = 'Choose a CAD or mesh file';
});

$('#editNodeGeometryFile').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file || !selectedNode) return;
    const node = selectedNode;
    const field = event.target.closest('.geometryImportField');
    const status = $('#editGeometryStatus');
    field.classList.remove('error');
    field.classList.add('loading');
    status.textContent = `Loading ${file.name}…`;
    try {
        const geometry = await importNodeGeometry(file);
        changeNodeAppearance(node, {
            shape: 'imported',
            importedGeometry: geometry,
            geometryFileName: file.name
        });
        geometry.dispose();
        $('#editNodeShape').value = '';
        status.textContent = `${file.name} applied`;
    } catch (error) {
        field.classList.add('error');
        status.textContent = error.message;
        $('#editNodeShape').value = node.userData.definition.shape === 'imported'
            ? ''
            : node.userData.definition.shape;
    } finally {
        field.classList.remove('loading');
        event.target.value = '';
    }
});

$('#addButton').addEventListener('click', (event) => {
    if (activeResult) return;
    const rect = event.currentTarget.getBoundingClientRect();
    openAddPalette(rect.left, rect.bottom + 3);
});

async function openProject() {
    try {
        let file = await window.projectFiles.open();
        if (!file) return;
        if (documentController.dirty && !await window.projectFiles.confirmDiscard()) return;
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
        loadProjectDocument(JSON.parse(file.content), {
            path: file.path,
            fileName: file.fileName,
            password: file.encrypted ? password : null
        });
        $('#statusText').textContent = 'Project loaded';
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Load failed · ${error.message}`;
    }
}

async function saveProject(saveAs = false, password = currentProjectPassword) {
    try {
        const content = `${JSON.stringify(serializeProjectDocument(), null, 4)}\n`;
        const result = await window.projectFiles.save(
            saveAs ? null : currentProjectPath,
            content,
            currentProjectFilename,
            password
        );
        if (!result) return false;
        currentProjectPath = result.path;
        currentProjectFilename = result.fileName;
        currentProjectPassword = result.encrypted ? password : null;
        updateDocumentTitle();
        updateEncryptionControls();
        documentController.markSaved();
        $('#statusText').textContent = result.encrypted ? 'Encrypted project saved' : 'Project saved';
        return true;
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Save failed · ${error.message}`;
        return false;
    }
}

async function newProject() {
    if (documentController.dirty && !await window.projectFiles.confirmDiscard()) return;
    loadProjectDocument(emptyProjectDocument);
    $('#statusText').textContent = 'New project';
}

async function loadExample(id) {
    if (!id) return;
    try {
        if (documentController.dirty && !await window.projectFiles.confirmDiscard()) return;
        const example = await window.projectFiles.loadExample(id);
        loadProjectDocument(JSON.parse(example.content), {
            fileName: example.suggestedFilename,
            saved: false
        });
        $('#statusText').textContent = 'Example loaded as an unsaved copy';
    } catch (error) {
        console.error(error);
        $('#statusText').textContent = `Example failed · ${error.message}`;
    } finally {
        closeExampleMenu();
    }
}

function closeExampleMenu() {
    $('#exampleMenu').hidden = true;
    $('#exampleButton').ariaExpanded = 'false';
}

function toggleExampleMenu() {
    const menu = $('#exampleMenu');
    const opening = menu.hidden;
    menu.hidden = !opening;
    $('#exampleButton').ariaExpanded = String(opening);
    if (opening) $('button', menu)?.focus();
}

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

async function populateExamples() {
    try {
        const examples = await window.projectFiles.listExamples();
        const menu = $('#exampleMenu');
        menu.replaceChildren(...examples.map((example) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.role = 'menuitem';
            button.textContent = example.label;
            button.addEventListener('click', () => loadExample(example.id));
            return button;
        }));
    } catch (error) {
        console.error(error);
        $('#exampleButton').disabled = true;
    }
}

$('#newButton').addEventListener('click', newProject);
$('#loadButton').addEventListener('click', openProject);
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
$('#exampleButton').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleExampleMenu();
});
$('#exampleMenu').addEventListener('pointerdown', (event) => event.stopPropagation());
window.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.examplePicker')) closeExampleMenu();
});
populateExamples();

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
$('#newNodeShape').addEventListener('change', (event) => {
    $('#geometryImportField').hidden = event.target.value !== 'imported';
});
$('#nodeGeometryFile').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    const field = $('#geometryImportField');
    const status = $('#geometryImportStatus');
    field.classList.remove('error');
    field.classList.add('loading');
    status.textContent = `Loading ${file.name}…`;
    $('#createNode').disabled = true;
    try {
        const geometry = await importNodeGeometry(file);
        pendingImportedGeometry?.dispose();
        pendingImportedGeometry = geometry;
        pendingGeometryFileName = file.name;
        $('#newNodeShape').value = 'imported';
        field.hidden = false;
        status.textContent = `${file.name} ready`;
    } catch (error) {
        pendingImportedGeometry?.dispose();
        pendingImportedGeometry = null;
        pendingGeometryFileName = '';
        field.classList.add('error');
        status.textContent = error.message;
    } finally {
        field.classList.remove('loading');
        $('#createNode').disabled = false;
    }
});
$$('[data-pick-endpoint]').forEach((button) => {
    button.addEventListener('click', () => startEndpointPick(button.dataset.pickEndpoint));
});
$('#cancelEndpointPick').addEventListener('click', finishEndpointPick);
$('#connectFromNode').addEventListener('click', () => {
    if (activeResult || !selectedNode) return;
    const sourceId = selectedNode.userData.id;
    const editorRect = $('#nodeEditor').getBoundingClientRect();
    openEdgeBuilder(editorRect.left, editorRect.top);
    $('#edgeSource').value = sourceId;
    refreshStateReferences();
    startEndpointPick('target');
});

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

    const id = crypto.randomUUID();
    const definition = {
        id,
        title: $('#newNodeName').value.trim() || 'Untitled node',
        type: 'Custom node',
        shape: $('#newNodeShape').value,
        importedGeometry: pendingImportedGeometry?.clone() ?? null,
        geometryFileName: pendingGeometryFileName || null,
        position: [0, -0.7, 0],
        color: 0x34727a,
        states: states.map((state) => ({
            id: crypto.randomUUID(),
            label: state.name,
            symbol: state.symbol,
            initialValue: Number(state.value) || 0,
            unit: state.unit,
            value: `${Number(state.value) || 0}${state.unit ? ` ${state.unit}` : ''}`
        })),
        sourceTerms: $$('.sourceTermRow').map((row) => ({
            id: crypto.randomUUID(),
            state: $('.sourceState', row).value,
            expression: $('.sourceExpression', row).value.trim()
        })).filter((term) => term.state && term.expression),
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
    if (currentTool === 'move') transformControls.attach(nodeObjects.get(id));
    recordHistory({
        undo: () => setNodeVisibility(id, false),
        redo: () => setNodeVisibility(id, true)
    });
});

$('#createEdge').addEventListener('click', () => {
    if (activeResult) return;
    const source = $('#edgeSource').value;
    const target = $('#edgeTarget').value;
    if (!source || !target || source === target) {
        $('#edgeTarget').focus();
        return;
    }

    const parameters = $$('.parameterRow').map((row) => ({
        id: crypto.randomUUID(),
        name: $('[data-field="name"]', row).value.trim(),
        symbol: $('[data-field="symbol"]', row).value.trim(),
        value: Number($('[data-field="value"]', row).value) || 0,
        unit: $('[data-field="unit"]', row).value.trim(),
        mode: $('[data-field="mode"]', row).value
    })).filter((parameter) => parameter.name && parameter.symbol);
    if (parameters.some((parameter) => !modelSymbolPattern.test(parameter.symbol)) ||
        new Set(parameters.map((parameter) => parameter.symbol)).size !== parameters.length) {
        $('.parameterRow [data-field="symbol"]')?.focus();
        return;
    }
    const definition = {
        id: crypto.randomUUID(),
        title: $('#newEdgeName').value.trim() || 'Untitled relationship',
        source,
        target,
        sourceStateId: null,
        targetStateId: null,
        directionality: 'directed',
        color: 0x9c83c4,
        offset: 0,
        equation: $('#edgeEquation').value.trim(),
        parameters
    };
    definition.equationModel = normalizeEdgeEquationModel(definition);
    const [outputRole, outputStateId] = $('#edgeEquationOutput').value.split(':');
    if (outputRole && outputStateId) {
        definition.equationModel.output = { role: outputRole, stateId: outputStateId };
    }
    if (definition.equation && !definition.equationModel.mathJson) {
        renderBuilderEquationDiagnostics(definition.equationModel.bindings);
        ($('#edgeMathField').hidden ? $('#edgeEquation') : $('#edgeMathField')).focus();
        return;
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
    currentTool = tool;
    dragControls.enabled = !activeResult && tool === 'select';
    transformControls.enabled = !activeResult && tool === 'move';

    if (tool !== 'move') transformControls.detach();
    if (tool === 'move' && selectedNode) transformControls.attach(selectedNode);
}

$$('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
        $$('[data-tool]').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
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
    const faceDirections = {
        front: new THREE.Vector3(0, 0, 1),
        back: new THREE.Vector3(0, 0, -1),
        right: new THREE.Vector3(1, 0, 0),
        left: new THREE.Vector3(-1, 0, 0),
        top: new THREE.Vector3(0, 1, 0),
        bottom: new THREE.Vector3(0, -1, 0)
    };
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
    if (selectedNode) {
        const node = selectedNode;
        const affectedRelationships = [];
        relationshipObjects.forEach((relationship) => {
            const definition = relationship.definition;
            if (
                definition.source === node.userData.id ||
                definition.target === node.userData.id
            ) {
                affectedRelationships.push({
                    id: definition.id,
                    visible: relationship.line.visible
                });
            }
        });
        const applyDeleted = (deleted) => {
            setNodeVisibility(node.userData.id, !deleted);
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

$('#newButton').dataset.tooltip = `New project (${isMac ? '⌘N' : 'Ctrl+N'})`;
$('#loadButton').dataset.tooltip = `Open project (${isMac ? '⌘O' : 'Ctrl+O'})`;
$('#saveButton').dataset.tooltip = `Save project (${isMac ? '⌘S' : 'Ctrl+S'})`;
updateEncryptionControls();
$('#undoButton').dataset.tooltip = `Undo (${isMac ? '⌘Z' : 'Ctrl+Z'})`;
$('#redoButton').dataset.tooltip = `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`;
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
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#exampleMenu').hidden) {
        closeExampleMenu();
        $('#exampleButton').focus();
        return;
    }
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
        newProject();
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
