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
import { validateModel } from '../modelValidation.mjs';
import { groupRelationshipBundles } from '../relationshipBundles.mjs';
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
    return {
        metadata: { units: document.metadata?.units || 'SI' },
        nodes,
        relationships
    };
}

const emptyProjectDocument = {
    format: 'konjugate',
    version: 1,
    copyright: 'Copyright © 2026 Zenin Easa Panthakkalakath',
    metadata: { units: 'SI' },
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
let currentValidation = { valid: true, issues: [], executableModel: null };
let validationRevision = 0;
let engineValidationTimer = null;
const documentController = new DocumentController();

function updateHistoryControls() {
    $('#undoButton').disabled = !documentController.canUndo;
    $('#redoButton').disabled = !documentController.canRedo;
    $('#saveButton').disabled = !documentController.dirty && currentProjectPath !== null;
    $('.windowTitle i').style.visibility = documentController.dirty ? 'visible' : 'hidden';
}

function recordHistory(action) {
    documentController.record(action);
}

function undo() {
    clearSelection();
    hideCards();
    documentController.undo();
}

function redo() {
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.domElement.className = 'webglSurface';
webglContainer.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'css2dSurface';
css2dContainer.appendChild(labelRenderer.domElement);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.07;
orbitControls.minDistance = 8;
orbitControls.maxDistance = 45;
orbitControls.target.set(0, -0.7, 0);

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
}

function selectRelationship(relationship) {
    selectedNode = null;
    selectedRelationship = relationship;
    selectionOutline.visible = false;
    updateRelationshipSelection();
}

function clearSelection() {
    selectedNode = null;
    selectedRelationship = null;
    selectionOutline.visible = false;
    updateRelationshipSelection();
    transformControls.detach();
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

function openNodeEditor(definition, clientX, clientY) {
    const editor = $('#nodeEditor');
    hideCards(editor);
    const node = nodeObjects.get(definition.id);
    renderNodeEditorModel(node);
    $$('[data-node-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.nodeTab === 'model');
    });
    $$('[data-node-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.nodePanel !== 'model';
    });
    $('#editNodeShape').value = definition.shape === 'imported' ? '' : definition.shape;
    $('#editNodeGeometryFile').value = '';
    $('#editGeometryStatus').textContent = definition.geometryFileName ?? 'Choose a CAD or mesh file';
    $('#editNodeGeometryFile').closest('.geometryImportField').classList.remove('loading', 'error');
    editor.style.removeProperty('left');
    editor.style.removeProperty('top');
    editor.classList.remove('hidden');
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
    dragControls.enabled = currentTool === 'select';
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

function visibleValidationModel() {
    const nodes = model.nodes.filter((node) => nodeObjects.get(node.id)?.visible === true);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const relationships = model.relationships.filter((relationship) => (
        relationshipObjects.get(relationship.id)?.line.visible === true &&
        nodeIds.has(relationship.source) && nodeIds.has(relationship.target)
    ));
    return { nodes, relationships };
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
    currentValidation = validateModel(visibleValidationModel());
    renderValidationStatus();
    scheduleEngineValidation();
}

function scheduleEngineValidation() {
    const revision = ++validationRevision;
    clearTimeout(engineValidationTimer);
    engineValidationTimer = setTimeout(async () => {
        try {
            const result = await window.engine.validate(JSON.stringify(serializeProjectDocument()));
            if (revision !== validationRevision || !result.available) return;
            currentValidation = {
                valid: result.report.valid,
                issues: result.report.issues,
                executableModel: null
            };
            renderValidationStatus();
        } catch (error) {
            console.warn('C++ model validation was unavailable; retaining local validation.', error);
        }
    }, 180);
}

function renderValidationStatus() {
    const errors = currentValidation.issues.filter((item) => item.severity === 'error').length;
    const warnings = currentValidation.issues.filter((item) => item.severity === 'warning').length;
    const summary = $('#validationSummary');
    summary.classList.toggle('error', errors > 0);
    summary.classList.toggle('warning', !errors && warnings > 0);
    $('#statusText').textContent = errors ? `${errors} model ${errors === 1 ? 'error' : 'errors'}`
        : warnings ? `${warnings} model ${warnings === 1 ? 'warning' : 'warnings'}` : 'Model valid';
    $('#runButton').disabled = true;
    $('#runButton').title = errors ? 'Resolve model errors before running' : 'A simulation engine is not configured';

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
        nodes: visibleNodes.map((node) => {
            const object = nodeObjects.get(node.id);
            return {
                id: node.id,
                name: node.title,
                type: node.type,
                position: object.position.toArray(),
                states: node.states.map((state) => ({
                    id: state.id ?? crypto.randomUUID(),
                    name: state.label,
                    symbol: state.symbol,
                    initialValue: (state.initialValue ?? Number.parseFloat(state.value)) || 0,
                    unit: state.unit ?? ''
                })),
                sourceTerms: node.sourceTerms ?? [],
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
    const nextModel = hydrateProjectDocument(document);
    clearRenderedModel();
    model.metadata = nextModel.metadata;
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
        if (currentTool === 'move') transformControls.attach(node);
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

    openAddPalette(event.clientX, event.clientY);
});

$$('[data-close-card]').forEach((button) => {
    button.addEventListener('click', () => {
        if (button.closest('#edgeBuilder')) finishEndpointPick();
        button.closest('.contextCard').classList.add('hidden');
    });
});

$$('[data-node-tab]').forEach((button) => {
    button.addEventListener('click', () => {
        $$('[data-node-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
        $$('[data-node-panel]').forEach((panel) => {
            panel.hidden = panel.dataset.nodePanel !== button.dataset.nodeTab;
        });
    });
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
    if (!selectedRelationship) return;
    const equationModel = normalizeEdgeEquationModel(selectedRelationship, {
        ...selectedRelationship.equationModel,
        latex
    });
    if (origin !== 'visual') $('#editEdgeMathField').setValue(latex, { silenceNotifications: true });
    if (origin !== 'latex') $('#editEdgeEquation').value = latex;
    renderEquationDiagnostics(latex, equationModel.bindings);
}

function commitEdgeEquation(latex) {
    if (!selectedRelationship) return;
    changeEdgeModel(selectedRelationship, (snapshot) => {
        snapshot.equationModel.latex = latex.trim();
        snapshot.equation = snapshot.equationModel.latex;
    });
}

$('#editEdgeMathField').addEventListener('input', (event) => {
    previewEdgeEquation(event.target.value, 'visual');
});
$('#editEdgeMathField').addEventListener('change', (event) => {
    commitEdgeEquation(event.target.value);
});
$('#editEdgeEquation').addEventListener('input', (event) => {
    previewEdgeEquation(event.target.value, 'latex');
});
$('#editEdgeEquation').addEventListener('change', (event) => {
    commitEdgeEquation(event.target.value);
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
    if (!selectedNode) return;
    const sourceId = selectedNode.userData.id;
    const editorRect = $('#nodeEditor').getBoundingClientRect();
    openEdgeBuilder(editorRect.left, editorRect.top);
    $('#edgeSource').value = sourceId;
    refreshStateReferences();
    startEndpointPick('target');
});

$('#createNode').addEventListener('click', () => {
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
        })).filter((term) => term.state && term.expression)
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

$$('[data-detail]').forEach((button) => {
    button.addEventListener('click', () => {
        const detail = button.dataset.detail;
        button.classList.toggle('active');
        canvas.classList.toggle(
            `show${detail[0].toUpperCase()}${detail.slice(1)}Details`,
            button.classList.contains('active')
        );
    });
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
    currentTool = tool;
    dragControls.enabled = tool === 'select';
    transformControls.enabled = tool === 'move';

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
    const direction = camera.position.clone().sub(orbitControls.target).normalize();
    camera.position.copy(direction.multiplyScalar(24).add(orbitControls.target));
    camera.lookAt(orbitControls.target);
    orbitControls.update();
}

$$('[data-nav-corner]').forEach((button) => {
    button.addEventListener('click', () => setCameraCorner(button.dataset.navCorner));
});
$('[data-nav-action="fit"]').addEventListener('click', fitCurrentView);

$('#fitButton').addEventListener('click', () => {
    fitCurrentView();
});

function updateViewCube() {
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
$('#undoButton').title = `Undo (${isMac ? '⌘Z' : 'Ctrl+Z'})`;
$('#redoButton').title = `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`;
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

function render(time) {
    requestAnimationFrame(render);
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
