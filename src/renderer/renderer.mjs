/* Copyright © 2026 Zenin Easa Panthakkalakath */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragControls } from 'three/addons/controls/DragControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
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

const canvas = $('#canvas');
const webglContainer = $('#webglContainer');
const css2dContainer = $('#css2dContainer');

const model = {
    nodes: [
        {
            id: 'battery',
            title: 'Battery module',
            type: 'Battery',
            shape: 'box',
            position: [-5.2, 0.4, 0],
            color: 0x2f6970,
            states: [
                { label: 'Temperature', symbol: 'T', value: '353.2 K', className: 'temperatureValue' },
                { label: 'State of charge', symbol: 'SOC', value: '84.6%' }
            ]
        },
        {
            id: 'cooling',
            title: 'Coolant reservoir',
            type: 'Fluid volume',
            shape: 'cylinder',
            position: [4.7, 0, -0.8],
            color: 0x2e7591,
            badgeClass: 'coolBadge',
            states: [
                { label: 'Temperature', symbol: 'T', value: '293.2 K', className: 'coolantTemperature' },
                { label: 'Fill level', symbol: 'h', value: '72%' }
            ]
        },
        {
            id: 'heater',
            title: 'Electrical losses',
            type: 'Heat source',
            shape: 'sphere',
            position: [-4.2, -3.6, 0.8],
            color: 0xb66755,
            badgeClass: 'sourceBadge',
            states: [
                { label: 'Heat flow', symbol: 'Q_dot', value: '420 W', className: 'heatValue' }
            ]
        }
    ],
    relationships: [
        {
            id: 'conduction',
            title: 'Thermal conduction',
            source: 'battery',
            target: 'cooling',
            directionality: 'bidirectional',
            color: 0xe6a15b,
            offset: -0.11
        },
        {
            id: 'signal',
            title: 'Temperature signal',
            source: 'battery',
            target: 'cooling',
            directionality: 'directed',
            color: 0xb68bd5,
            offset: 0.16
        },
        {
            id: 'heat-source',
            title: 'Heat source',
            source: 'heater',
            target: 'battery',
            directionality: 'directed',
            color: 0xc88be0,
            offset: 0
        }
    ]
};

const nodeObjects = new Map();
const relationshipObjects = new Map();
const nodePickTargets = [];
const relationshipPickTargets = [];
let selectedNode = null;
let selectedRelationship = null;
let running = false;
let simulationTimer;
let currentTool = 'select';
let currentView = 'orbit';
let activeEndpointPick = null;
let cameraAnimation = null;

function initializeWindowControls() {
    $('#minimizeButton').addEventListener('click', () => window.windowControls.minimize());
    $('#maximizeButton').addEventListener('click', () => window.windowControls.toggleMaximize());
    $('#closeButton').addEventListener('click', () => window.windowControls.close());
    window.windowControls.onMaximizedChange((maximized) => {
        $('#maximizeIcon').textContent = maximized ? '❐' : '□';
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

function geometryFor(shape) {
    if (shape === 'cylinder') return new THREE.CylinderGeometry(1.15, 1.15, 2.9, 32);
    if (shape === 'sphere') return new THREE.SphereGeometry(1.05, 32, 24);
    return new THREE.BoxGeometry(2.8, 1.8, 1.8, 2, 1, 1);
}

function materialFor(definition) {
    if (definition.shape === 'sphere') {
        return new THREE.MeshStandardMaterial({
            color: definition.color,
            emissive: 0x54221e,
            emissiveIntensity: 0.42,
            metalness: 0.08,
            roughness: 0.38
        });
    }

    return new THREE.MeshStandardMaterial({
        color: definition.color,
        metalness: definition.shape === 'cylinder' ? 0.18 : 0.28,
        roughness: 0.42
    });
}

function createNodeLabel(definition) {
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
        if (activeEndpointPick) chooseEndpointNode(definition.id);
    });
    wrapper.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectNode(nodeObjects.get(definition.id));
        openNodeEditor(definition, event.clientX, event.clientY);
    });

    const labelOffsets = {
        box: [1.72, 0.62, 0],
        cylinder: [1.5, 0.7, 0],
        sphere: [1.38, 0.5, 0]
    };
    const label = new CSS2DObject(wrapper);
    label.position.fromArray(labelOffsets[definition.shape] ?? [1.72, 0.62, 0]);
    label.center.set(0, 0.5);
    return label;
}

function createPort(color, position) {
    const port = new THREE.Mesh(
        new THREE.SphereGeometry(0.105, 16, 12),
        new THREE.MeshBasicMaterial({ color })
    );
    port.position.copy(position);
    port.renderOrder = 10;
    return port;
}

function createNode(definition) {
    const mesh = new THREE.Mesh(geometryFor(definition.shape), materialFor(definition));
    mesh.position.fromArray(definition.position);
    mesh.userData = {
        kind: 'node',
        id: definition.id,
        definition
    };

    if (definition.id === 'battery') {
        mesh.add(createPort(0x42d7ca, new THREE.Vector3(1.45, 0.35, 0)));
        mesh.add(createPort(0xc18de1, new THREE.Vector3(1.45, -0.35, 0)));
    } else if (definition.id === 'cooling') {
        mesh.add(createPort(0xe6a15b, new THREE.Vector3(-1.16, 0.35, 0)));
        mesh.add(createPort(0xc18de1, new THREE.Vector3(-1.16, -0.35, 0)));
    } else {
        mesh.add(createPort(0xc18de1, new THREE.Vector3(0.75, 0.68, 0)));
    }

    mesh.add(createNodeLabel(definition));
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
    midpoint.y -= definition.source === 'heater' ? 0.15 : 0.55;

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

model.relationships.forEach(createRelationship);

const bundleAnchor = new THREE.Object3D();
scene.add(bundleAnchor);
const bundleElement = $('#bundleLabel');
const bundleObject = new CSS2DObject(bundleElement);
bundleObject.center.set(0.5, 0.5);
bundleAnchor.add(bundleObject);

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

    const battery = nodeObjects.get('battery').position;
    const cooling = nodeObjects.get('cooling').position;
    bundleAnchor.position.copy(battery).lerp(cooling, 0.5);
    bundleAnchor.position.y -= 1.65;
}

updateRelationships();

const dragControls = new DragControls(
    nodePickTargets,
    camera,
    renderer.domElement
);
dragControls.recursive = false;
dragControls.addEventListener('dragstart', (event) => {
    orbitControls.enabled = false;
    selectNode(event.object);
});
dragControls.addEventListener('drag', () => {
    updateRelationships();
    updateSelectionOutline();
});
dragControls.addEventListener('dragend', () => {
    orbitControls.enabled = true;
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
    updateSelectionOutline();
}

function selectRelationship(relationship) {
    selectedNode = null;
    selectedRelationship = relationship;
    selectionOutline.visible = false;
}

function clearSelection() {
    selectedNode = null;
    selectedRelationship = null;
    selectionOutline.visible = false;
    transformControls.detach();
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

function openNodeEditor(definition, clientX, clientY) {
    const editor = $('#nodeEditor');
    hideCards(editor);
    $('#nodeEditorTitle').textContent = definition.title;
    positionCard(editor, clientX, clientY);
}

function openRelationshipEditor(definition, clientX, clientY) {
    const editor = $('#edgeEditor');
    hideCards(editor);
    $('.edgeEditor > header strong').textContent = definition.title;
    positionCard(editor, clientX, clientY);
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
        <input class="sourceExpression" placeholder="Source expression, e.g. Q_dot / C">
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
    row.querySelector('.removeBuilderRow').addEventListener('click', () => row.remove());
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
    $$('[data-pick-endpoint]').forEach((button) => button.classList.remove('active'));
    dragControls.enabled = currentTool === 'select';
    $('.edgeBuilder > header strong').textContent = 'Connect stateful nodes';
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
    $('.edgeBuilder > header strong').textContent = `Pick ${endpoint} node on canvas`;
}

function refreshStateReferences() {
    const container = $('#stateReferenceChips');
    container.replaceChildren();
    [['source', $('#edgeSource').value], ['target', $('#edgeTarget').value]].forEach(([role, id]) => {
        const node = model.nodes.find((candidate) => candidate.id === id);
        node?.states.forEach((state) => {
            const reference = `${role}.${state.symbol ?? state.label.replaceAll(' ', '_')}`;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = reference;
            button.addEventListener('click', () => {
                const equation = $('#edgeEquation');
                const start = equation.selectionStart;
                equation.setRangeText(reference, start, equation.selectionEnd, 'end');
                equation.focus();
            });
            container.appendChild(button);
        });
    });
}

function updateModelStatus() {
    const status = $$('.modelStatus span');
    status[0].textContent = `${model.nodes.length} nodes`;
    status[1].textContent = `${model.relationships.length} relationships`;
}

function openNodeBuilder(clientX, clientY) {
    const builder = $('#nodeBuilder');
    hideCards(builder);
    $('#newNodeName').value = 'New node';
    $('#newNodeShape').value = 'box';
    $('#stateVariableRows').replaceChildren();
    $('#sourceTermRows').replaceChildren();
    addStateVariableRow({ name: 'Temperature', symbol: 'T', value: '293.15', unit: 'K' });
    addSourceTermRow();
    positionCard(builder, clientX, clientY);
    $('#newNodeName').select();
}

function openEdgeBuilder(clientX, clientY) {
    const builder = $('#edgeBuilder');
    hideCards(builder);
    $('#newEdgeName').value = 'New relationship';
    $('#edgeEquation').value = '';
    $('#edgeParameterRows').replaceChildren();
    finishEndpointPick();
    $('#edgeSource').replaceChildren();
    $('#edgeTarget').replaceChildren();
    refreshEndpointOptions();
    addEdgeParameterRow({ name: 'Coefficient', symbol: 'k', value: '1' });
    positionCard(builder, clientX, clientY);
}

renderer.domElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || transformControls.dragging) return;
    setPointerFromEvent(event);
    const node = rootNodeFromIntersection(firstIntersection(nodePickTargets));

    if (node) {
        selectNode(node);
        if (activeEndpointPick) {
            chooseEndpointNode(node.userData.id);
            return;
        }
        if (currentTool === 'move') transformControls.attach(node);
        return;
    }

    if (activeEndpointPick) return;

    const relationshipHit = firstIntersection(relationshipPickTargets);
    if (relationshipHit) {
        selectRelationship(relationshipHit.object.userData.definition);
        transformControls.detach();
        return;
    }

    clearSelection();
    hideCards();
});

renderer.domElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    setPointerFromEvent(event);
    const node = rootNodeFromIntersection(firstIntersection(nodePickTargets));

    if (node) {
        selectNode(node);
        openNodeEditor(node.userData.definition, event.clientX, event.clientY);
        return;
    }

    const relationshipHit = firstIntersection(relationshipPickTargets);
    if (relationshipHit) {
        const definition = relationshipHit.object.userData.definition;
        selectRelationship(definition);
        openRelationshipEditor(definition, event.clientX, event.clientY);
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

$('#addButton').addEventListener('click', (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openAddPalette(rect.left, rect.bottom + 3);
});

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
$$('[data-state-suggestion]').forEach((button) => {
    button.addEventListener('click', () => {
        const [name, symbol, value, unit] = button.dataset.stateSuggestion.split('|');
        addStateVariableRow({ name, symbol, value, unit });
    });
});
$('#edgeSource').addEventListener('change', refreshStateReferences);
$('#edgeTarget').addEventListener('change', refreshStateReferences);
$$('[data-pick-endpoint]').forEach((button) => {
    button.addEventListener('click', () => startEndpointPick(button.dataset.pickEndpoint));
});
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

    const id = `node-${Date.now()}`;
    const definition = {
        id,
        title: $('#newNodeName').value.trim() || 'Untitled node',
        type: 'Custom node',
        shape: $('#newNodeShape').value,
        position: [0, -0.7, 0],
        color: 0x34727a,
        states: states.map((state) => ({
            label: state.name,
            symbol: state.symbol,
            initialValue: Number(state.value) || 0,
            unit: state.unit,
            value: `${Number(state.value) || 0}${state.unit ? ` ${state.unit}` : ''}`
        })),
        sourceTerms: $$('.sourceTermRow').map((row) => ({
            state: $('.sourceState', row).value,
            expression: $('.sourceExpression', row).value.trim()
        })).filter((term) => term.state && term.expression)
    };

    hideCards();
    model.nodes.push(definition);
    createNode(definition);
    updateModelStatus();
    selectNode(nodeObjects.get(id));
    if (currentTool === 'move') transformControls.attach(nodeObjects.get(id));
});

$('#createEdge').addEventListener('click', () => {
    const source = $('#edgeSource').value;
    const target = $('#edgeTarget').value;
    if (!source || !target || source === target) {
        $('#edgeTarget').focus();
        return;
    }

    const parameters = $$('.parameterRow').map((row) => ({
        name: $('[data-field="name"]', row).value.trim(),
        symbol: $('[data-field="symbol"]', row).value.trim(),
        value: Number($('[data-field="value"]', row).value) || 0,
        unit: $('[data-field="unit"]', row).value.trim(),
        mode: $('[data-field="mode"]', row).value
    })).filter((parameter) => parameter.name && parameter.symbol);
    const definition = {
        id: `relationship-${Date.now()}`,
        title: $('#newEdgeName').value.trim() || 'Untitled relationship',
        source,
        target,
        directionality: 'directed',
        color: 0x9c83c4,
        offset: 0,
        equation: $('#edgeEquation').value.trim(),
        parameters
    };

    finishEndpointPick();
    model.relationships.push(definition);
    createRelationship(definition);
    updateRelationships();
    updateModelStatus();
    $('#edgeBuilder').classList.add('hidden');
    selectRelationship(definition);
});

bundleElement.addEventListener('pointerdown', (event) => event.stopPropagation());
bundleElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openRelationshipEditor(
        model.relationships[0],
        event.clientX,
        event.clientY
    );
});

$$('.relationshipRow').forEach((row) => {
    row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const definition = model.relationships.find(
            (relationship) => relationship.id === row.dataset.relationship
        );
        openRelationshipEditor(definition, event.clientX, event.clientY);
    });
});

$('.collapseBundle').addEventListener('click', (event) => {
    event.stopPropagation();
    bundleElement.classList.toggle('pinned');
    const pinned = bundleElement.classList.contains('pinned');
    $('.collapseBundle').textContent = pinned ? '−' : '＋';
    $('.collapseBundle').title = pinned ? 'Use automatic detail' : 'Keep expanded';
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

function openWorkbench() {
    hideCards();
    $('#equationWorkbench').showModal();
}

$('#equationsButton').addEventListener('click', openWorkbench);
$$('.openEquation, .equationItem').forEach((button) => {
    button.addEventListener('dblclick', openWorkbench);
});
$('#closeWorkbench').addEventListener('click', () => $('#equationWorkbench').close());
$('#cancelWorkbench').addEventListener('click', () => $('#equationWorkbench').close());
$('#saveEquation').addEventListener('click', () => $('#equationWorkbench').close());

const heatSlider = $('#heatSlider');
const heatNumber = $('#heatNumber');
const heaterEnabled = $('#heaterEnabled');
let configuredHeatValue = 420;

function applyHeat(value, remember = true) {
    const bounded = Math.min(1000, Math.max(0, Number(value) || 0));
    if (remember) configuredHeatValue = bounded;
    heatSlider.value = bounded;
    heatNumber.value = bounded;
    $$('.heatValue').forEach((element) => {
        element.textContent = `${bounded} W`;
    });
    heatSlider.style.setProperty('--range-progress', `${bounded / 10}%`);

    const heater = nodeObjects.get('heater');
    heater.material.emissiveIntensity = 0.2 + (bounded / 1000) * 1.15;
}

heatSlider.addEventListener('input', (event) => {
    if (!heaterEnabled.checked) heaterEnabled.checked = true;
    applyHeat(event.target.value);
});
heatNumber.addEventListener('input', (event) => {
    if (!heaterEnabled.checked) heaterEnabled.checked = true;
    applyHeat(event.target.value);
});
heaterEnabled.addEventListener('change', (event) => {
    applyHeat(event.target.checked ? configuredHeatValue : 0, false);
});
$('#closeControl').addEventListener('click', () => {
    $('#controlCard').classList.add('hiddenControl');
});

$('#runButton').addEventListener('click', () => {
    running = !running;
    const button = $('#runButton');
    button.classList.toggle('running', running);
    button.innerHTML = running ? '<span>■</span> Stop' : '<span>▶</span> Run';
    $('#statusText').textContent = running ? 'Simulating · 1.0×' : 'Model ready';
    $('.simulationReadout').classList.toggle('running', running);

    clearInterval(simulationTimer);
    if (running) {
        simulationTimer = setInterval(() => {
            const power = Number(heatNumber.value);
            const temperatureElement = $('.temperatureValue');
            const coolantElement = $('.coolantTemperature');
            const hot = Math.max(
                293.2,
                Number.parseFloat(temperatureElement.textContent) -
                    (2.6 - power / 500) * 0.08
            );
            const cool = Math.min(
                hot,
                Number.parseFloat(coolantElement.textContent) + 0.035
            );
            temperatureElement.textContent = `${hot.toFixed(1)} K`;
            coolantElement.textContent = `${cool.toFixed(1)} K`;
        }, 250);
    }
});

function deleteSelected() {
    if (selectedNode) {
        selectedNode.visible = false;
        relationshipObjects.forEach((relationship) => {
            const definition = relationship.definition;
            if (
                definition.source === selectedNode.userData.id ||
                definition.target === selectedNode.userData.id
            ) {
                relationship.line.visible = false;
                if (relationship.marker) relationship.marker.visible = false;
            }
        });
        clearSelection();
    } else if (selectedRelationship) {
        const relationship = relationshipObjects.get(selectedRelationship.id);
        relationship.line.visible = false;
        if (relationship.marker) relationship.marker.visible = false;
        selectedRelationship = null;
    }
}

$('[data-action="delete"]').addEventListener('click', deleteSelected);
$('[data-delete-node]').addEventListener('click', () => {
    deleteSelected();
    $('#nodeEditor').classList.add('hidden');
});
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeEndpointPick) {
        finishEndpointPick();
        return;
    }
    if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        !event.target.matches('input, textarea')
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
applyHeat(420);

function render(time) {
    requestAnimationFrame(render);
    if (!updateCameraAnimation(time)) orbitControls.update();
    updateViewCube();

    if (running) {
        const pulse = 0.78 + Math.sin(time * 0.008) * 0.2;
        relationshipObjects.forEach((relationship) => {
            relationship.line.material.opacity = pulse;
        });
    } else {
        relationshipObjects.forEach((relationship) => {
            relationship.line.material.opacity = 0.92;
        });
    }

    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

requestAnimationFrame(render);
