/* Copyright © 2026 Zenin Easa Panthakkalakath */

import * as THREE from '../../node_modules/three/build/three.module.js';

const $ = (selector, root = document) => root.querySelector(selector);

// A node counts as a renderable body if it has states named exactly these six symbols --
// Konjugate's own canonical vocabulary for pose (see the component library's Free body
// template). Auto-detected by name, the same "match by convention, not explicit wiring"
// principle the component library's auto-bound edges already use -- this visualizer isn't
// tied to Free body specifically, just to the naming convention.
const requiredSymbols = ['x', 'y', 'z', 'roll', 'pitch', 'yaw'];
const bodyPalette = ['#42c9bc', '#e0a458', '#c084d8', '#6fa8dc', '#e07a7a', '#7ad48c', '#d8c05a', '#8f8fe0'];

let context = null;
let bodies = [];
let hiddenBodyIds = new Set();
let nodesById = new Map();
let edgesForBodies = [];
let useEditorShapes = false;
let showConnections = false;
let edgeLines = [];

function formatTime(time) {
    return `${Number(time).toLocaleString(undefined, { maximumSignificantDigits: 6 })} s`;
}

// --- Scene setup -------------------------------------------------------------------------

const canvas = $('#scene');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#081119');
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
camera.position.set(4, 3, 6);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// Three.js's own OrbitControls (examples/jsm) imports the library via the bare specifier
// "three", which only resolves through an import map -- and an inline importmap needs
// 'unsafe-inline' in script-src, which this add-on's CSP deliberately withholds. A small
// hand-rolled orbit-around-target control sidesteps that dependency entirely.
const orbit = { target: new THREE.Vector3(0, 0, 0), radius: camera.position.length(), azimuth: Math.atan2(camera.position.x, camera.position.z), polar: Math.acos(THREE.MathUtils.clamp(camera.position.y / camera.position.length(), -1, 1)) };
function updateCameraFromOrbit() {
    const sinPolar = Math.sin(orbit.polar);
    camera.position.set(
        orbit.target.x + orbit.radius * sinPolar * Math.sin(orbit.azimuth),
        orbit.target.y + orbit.radius * Math.cos(orbit.polar),
        orbit.target.z + orbit.radius * sinPolar * Math.cos(orbit.azimuth)
    );
    camera.lookAt(orbit.target);
}
updateCameraFromOrbit();
let dragging = false;
let lastPointer = { x: 0, y: 0 };
canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointerup', (event) => { dragging = false; canvas.releasePointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    orbit.azimuth -= (event.clientX - lastPointer.x) * 0.008;
    orbit.polar = THREE.MathUtils.clamp(orbit.polar - (event.clientY - lastPointer.y) * 0.008, 0.05, Math.PI - 0.05);
    lastPointer = { x: event.clientX, y: event.clientY };
    updateCameraFromOrbit();
});
canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    orbit.radius = THREE.MathUtils.clamp(orbit.radius * (1 + Math.sign(event.deltaY) * 0.1), 0.5, 200);
    updateCameraFromOrbit();
}, { passive: false });

scene.add(new THREE.HemisphereLight('#cfe8ff', '#0a1018', 1.15));
const keyLight = new THREE.DirectionalLight('#ffffff', 0.85);
keyLight.position.set(5, 8, 6);
scene.add(keyLight);
scene.add(new THREE.GridHelper(20, 20, '#2a3d47', '#182530'));

const edgeLineGroup = new THREE.Group();
scene.add(edgeLineGroup);

function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height, false);
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

function animate() {
    requestAnimationFrame(animate);
    refreshEdgeLabelPositions();
    renderer.render(scene, camera);
}
animate();

// --- Model-space (Z-up, right-handed) to Three.js-space (Y-up, right-handed) -------------
//
// Every kinematic relationship built for this app's example library (the four-bar linkage,
// the quadrotor kinematics design) treats x/y as a ground plane and z as "up", following
// ordinary robotics/CAD convention. Three.js renders Y-up. Mapping model (x,y,z) to three.js
// (x,z,-y) is the unique axis relabelling that sends model-Z to three.js-Y while keeping both
// systems right-handed (verified: if model X×Y=Z, then three.X×three.Y = model.X×model.Z =
// -model.Y = three.Z, matching three.js's own X×Y=Z convention). Every position and every
// orientation basis vector goes through this exact same mapping, so nothing here is rendered
// mirrored or left-handed.
function toThreeVector(modelXyz) {
    const [x, y, z] = modelXyz;
    return new THREE.Vector3(x, z, -y);
}

// Body-to-world rotation matrix in MODEL space, for the same ZYX (yaw-pitch-roll intrinsic)
// Euler convention already derived and used for this app's own kinematics content: R =
// Rz(yaw)*Ry(pitch)*Rx(roll). Returns the body's own X/Y/Z axes as unit vectors expressed in
// model world space (the columns of R), which toThreeVector then remaps individually -- this
// avoids re-deriving an Euler-order conjugation by hand, and is why it's built as three
// separate basis vectors rather than a single combined transform.
function modelBodyAxes(roll, pitch, yaw) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    return {
        bx: [cy * cp, sy * cp, -sp],
        by: [cy * sp * sr - sy * cr, sy * sp * sr + cy * cr, cp * sr],
        bz: [cy * sp * cr + sy * sr, sy * sp * cr - cy * sr, cp * cr]
    };
}

// --- Body detection and construction --------------------------------------------------

function detectBodies(signalList) {
    const byEntity = Map.groupBy(signalList, (signal) => signal.entityId);
    const detected = [];
    let colorIndex = 0;
    byEntity.forEach((items, entityId) => {
        const bySymbol = Object.fromEntries(items.map((signal) => [signal.symbol, signal]));
        if (!requiredSymbols.every((symbol) => bySymbol[symbol])) return;
        detected.push({
            entityId,
            entityName: items[0].entityName,
            color: bodyPalette[colorIndex++ % bodyPalette.length],
            signalBySymbol: bySymbol,
            series: {},
            object3D: null
        });
    });
    return detected;
}

// Editor-assigned appearance uses whatever units the model/CAD import happened to be authored
// in -- a primitive sized for the main canvas's own layout scale, or an STL/STEP import in
// arbitrary real-world units -- neither of which relates to this add-on's real simulated
// x/y/z motion scale. Every editor shape is normalized to the same on-screen footprint as the
// default box (targetBodyExtent) so bodies stay visually comparable regardless of source.
const targetBodyExtent = 0.4;

function primitiveGeometry(shape) {
    if (shape === 'cylinder') return new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
    if (shape === 'sphere') return new THREE.SphereGeometry(0.5, 24, 18);
    return new THREE.BoxGeometry(1, 1, 1);
}

// Mirrors the main canvas's own geometryFromDocument -- the mesh document (flat position/
// normal/index arrays) is already fully tessellated by the time it reaches here, whether it
// came from the shape library or an imported STL/STEP file, so no CAD or STL parsing is
// needed on this side at all.
function geometryFromMeshDocument(mesh) {
    if (!mesh?.position?.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.position, 3));
    if (mesh.normal?.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normal, 3));
    else geometry.computeVertexNormals();
    if (mesh.index?.length) geometry.setIndex(mesh.index);
    return geometry;
}

function normalizedGeometry(geometry) {
    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const largest = Math.max(size.x, size.y, size.z, 1e-6);
    geometry.scale(targetBodyExtent / largest, targetBodyExtent / largest, targetBodyExtent / largest);
    geometry.center();
    return geometry;
}

function bodyGeometryAndColor(body) {
    const node = useEditorShapes ? nodesById.get(body.entityId) : null;
    if (!node) return { geometry: new THREE.BoxGeometry(0.3, 0.18, 0.42), color: body.color };
    const meshGeometry = node.mesh ? geometryFromMeshDocument(node.mesh) : null;
    const geometry = meshGeometry ? normalizedGeometry(meshGeometry) : primitiveGeometry(node.shape).scale(targetBodyExtent, targetBodyExtent, targetBodyExtent);
    return { geometry, color: node.color };
}

function buildBodyObject(body) {
    const group = new THREE.Group();
    const { geometry, color } = bodyGeometryAndColor(body);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 });
    group.add(new THREE.Mesh(geometry, material));
    group.add(new THREE.AxesHelper(0.4));
    scene.add(group);
    body.material = material;
    return group;
}

function rebuildBodyObjects() {
    bodies.forEach((body) => {
        if (body.object3D) {
            scene.remove(body.object3D);
            body.object3D.traverse((child) => {
                child.geometry?.dispose();
                child.material?.dispose();
            });
        }
        body.object3D = buildBodyObject(body);
        if (body.object3D) body.object3D.visible = !hiddenBodyIds.has(body.entityId);
    });
    applyAllPoses(context?.time ?? 0);
    applySelection(context?.selectedNodeId ?? null);
    buildEdgeLines();
}

$('#useEditorShapes').addEventListener('change', (event) => {
    useEditorShapes = event.target.checked;
    rebuildBodyObjects();
});
$('#showConnections').addEventListener('change', (event) => {
    showConnections = event.target.checked;
    buildEdgeLines();
});

// --- Edges between detected bodies -----------------------------------------------------
//
// An edge only means "one equation reads/writes across these two nodes" -- not necessarily a
// physical joint -- so this deliberately only draws a line when BOTH endpoints are themselves
// detected 6-DOF bodies (never a partial/guessed connection), and always labels the line with
// the edge's own name so it reads as "relationship X between these two", not an unqualified
// claim of physical connection.

function clearEdgeLines() {
    edgeLines.forEach(({ line, label }) => {
        edgeLineGroup.remove(line);
        line.geometry.dispose();
        line.material.dispose();
        label.remove();
    });
    edgeLines = [];
}

function buildEdgeLines() {
    clearEdgeLines();
    if (!showConnections) return;
    const bodyByEntityId = new Map(bodies.map((body) => [body.entityId, body]));
    edgesForBodies.forEach((edge) => {
        const sourceBody = bodyByEntityId.get(edge.sourceNodeId);
        const targetBody = bodyByEntityId.get(edge.targetNodeId);
        if (!sourceBody?.object3D || !targetBody?.object3D) return;
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: '#e0a458' }));
        edgeLineGroup.add(line);
        const label = document.createElement('div');
        label.className = 'edgeLabel';
        label.textContent = edge.title;
        $('#edgeLabels').appendChild(label);
        edgeLines.push({ sourceBody, targetBody, line, label });
    });
    refreshEdgeGeometry();
}

function refreshEdgeGeometry() {
    edgeLines.forEach(({ sourceBody, targetBody, line }) => {
        const visible = isEdgeVisible(sourceBody, targetBody);
        line.visible = visible;
        if (!visible) return;
        const positions = line.geometry.attributes.position;
        positions.setXYZ(0, sourceBody.object3D.position.x, sourceBody.object3D.position.y, sourceBody.object3D.position.z);
        positions.setXYZ(1, targetBody.object3D.position.x, targetBody.object3D.position.y, targetBody.object3D.position.z);
        positions.needsUpdate = true;
    });
}

function isEdgeVisible(sourceBody, targetBody) {
    return sourceBody.object3D.visible && targetBody.object3D.visible;
}

function refreshEdgeLabelPositions() {
    const rect = canvas.getBoundingClientRect();
    edgeLines.forEach(({ sourceBody, targetBody, label }) => {
        if (!isEdgeVisible(sourceBody, targetBody)) { label.style.display = 'none'; return; }
        const midpoint = new THREE.Vector3().addVectors(sourceBody.object3D.position, targetBody.object3D.position).multiplyScalar(0.5);
        const projected = midpoint.project(camera);
        const onScreen = projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
        label.style.display = onScreen ? 'block' : 'none';
        if (!onScreen) return;
        label.style.left = `${((projected.x + 1) / 2) * rect.width}px`;
        label.style.top = `${((1 - projected.y) / 2) * rect.height}px`;
    });
}

function applySelection(selectedNodeId) {
    bodies.forEach((body) => {
        body.material?.emissive.set(body.entityId === selectedNodeId ? '#ffffff' : '#000000');
        if (body.material) body.material.emissiveIntensity = 0.35;
    });
    document.querySelectorAll('.bodyOption').forEach((option) => {
        option.classList.toggle('selectedEntity', Number(option.dataset.entityId) === selectedNodeId);
    });
}

// --- Data loading and playback ------------------------------------------------------

async function loadSeriesFor(body) {
    const signalIds = requiredSymbols.map((symbol) => body.signalBySymbol[symbol].signalId);
    const series = await window.konjugateVisualizer.readSeries(signalIds, { maxPoints: 20000 });
    body.series = Object.fromEntries(requiredSymbols.map((symbol) => {
        const item = series.find((entry) => entry.signalId === body.signalBySymbol[symbol].signalId);
        return [symbol, item?.samples ?? []];
    }));
}

// Binary search for the sample nearest the requested time -- an exact interpolation isn't
// needed here, since the timeline only ever asks for a specific sampled instant, the same way
// the plot viewer's own cursor line just marks a time position rather than resampling.
function nearestValue(samples, time) {
    if (!samples.length) return 0;
    let low = 0;
    let high = samples.length - 1;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (samples[mid].time < time) low = mid + 1; else high = mid;
    }
    if (low > 0 && Math.abs(samples[low - 1].time - time) <= Math.abs(samples[low].time - time)) low -= 1;
    return samples[low].value;
}

function applyPose(body, time) {
    if (!body.object3D) return;
    const pose = Object.fromEntries(requiredSymbols.map((symbol) => [symbol, nearestValue(body.series[symbol], time)]));
    body.object3D.position.copy(toThreeVector([pose.x, pose.y, pose.z]));
    const { bx, by, bz } = modelBodyAxes(pose.roll, pose.pitch, pose.yaw);
    const basis = new THREE.Matrix4().makeBasis(toThreeVector(bx), toThreeVector(by), toThreeVector(bz));
    body.object3D.quaternion.setFromRotationMatrix(basis);
}

function applyAllPoses(time) {
    bodies.forEach((body) => applyPose(body, time));
    refreshEdgeGeometry();
}

// --- Sidebar -------------------------------------------------------------------------

function renderBodyList() {
    const container = $('#bodies');
    container.replaceChildren();
    $('#noBodies').hidden = Boolean(bodies.length);
    $('.sceneWorkspace').classList.toggle('hasBodies', Boolean(bodies.length));
    bodies.forEach((body) => {
        const label = document.createElement('label');
        label.className = 'bodyOption';
        label.style.setProperty('--body-color', body.color);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !hiddenBodyIds.has(body.entityId);
        input.addEventListener('change', () => {
            if (input.checked) hiddenBodyIds.delete(body.entityId);
            else hiddenBodyIds.add(body.entityId);
            if (body.object3D) body.object3D.visible = input.checked;
            refreshEdgeGeometry();
        });
        const identity = document.createElement('span');
        const name = document.createElement('b');
        name.innerHTML = `<i class="bodySwatch" style="background:${body.color}"></i>${body.entityName}`;
        const hint = document.createElement('small');
        hint.textContent = 'x, y, z, roll, pitch, yaw';
        identity.append(name, hint);
        label.append(input, identity);
        label.dataset.entityId = body.entityId;
        container.appendChild(label);
    });
}

// --- Session lifecycle -----------------------------------------------------------------

function disposeBodies() {
    clearEdgeLines();
    bodies.forEach((body) => {
        if (!body.object3D) return;
        scene.remove(body.object3D);
        body.object3D.traverse((child) => {
            child.geometry?.dispose();
            child.material?.dispose();
        });
    });
    bodies = [];
}

async function loadSession() {
    stopPlayback();
    context = await window.konjugateVisualizer.getContext();
    if (!context) return;
    const signals = await window.konjugateVisualizer.listSignals();
    disposeBodies();
    bodies = detectBodies(signals);
    hiddenBodyIds = new Set();
    nodesById = new Map((context.nodes ?? []).map((node) => [node.id, node]));
    edgesForBodies = context.edges ?? [];
    await Promise.all(bodies.map(loadSeriesFor));
    bodies.forEach((body) => { body.object3D = buildBodyObject(body); });
    renderBodyList();
    applyAllPoses(context.time);
    applySelection(context.selectedNodeId);
    buildEdgeLines();

    $('#projectName').textContent = context.projectName;
    $('#runName').textContent = context.run.name;
    $('#timeline').max = String(context.run.targetTime);
    $('#timeline').value = String(context.time);
    $('#currentTime').value = formatTime(context.time);
    $('#targetTime').value = formatTime(context.run.targetTime);
    renderRunStatus(context.run);
}

function renderRunStatus(run) {
    context.run = { ...context.run, ...run };
    $('#runLifecycle').textContent = context.run.lifecycle === 'running'
        ? `Live · ${formatTime(context.run.availableResultTime)}` : 'Completed';
    $('#playPause').disabled = context.run.lifecycle !== 'completed';
    if (context.run.lifecycle !== 'completed') stopPlayback();
}

// Mirrors the main project window's own result playback loop (same 100ms tick, same
// elapsed-wall-time * rate stepping) but drives it purely through seek() -- which already
// round-trips through the main window and back out to every open add-on's onTimelineChange,
// so this add-on doesn't need to track or apply poses locally while playing.
const preferredPlaybackFrameMilliseconds = 100;
let playing = false;
let playbackTimer = null;
let playbackStartedAt = 0;
let playbackStartedFrom = 0;

function stopPlayback() {
    clearTimeout(playbackTimer);
    playbackTimer = null;
    playing = false;
    $('#playPause').textContent = '▶';
    $('#playPause').ariaLabel = 'Play';
}

function schedulePlayback() {
    if (!playing || !context) return;
    const rate = Number($('#playbackRate').value) || 1;
    const finalTime = context.run.availableResultTime;
    playbackTimer = setTimeout(() => {
        const elapsed = (performance.now() - playbackStartedAt) / 1000;
        const targetTime = Math.min(finalTime, playbackStartedFrom + elapsed * rate);
        window.konjugateVisualizer.seek(targetTime);
        if (targetTime >= finalTime) stopPlayback();
        else schedulePlayback();
    }, preferredPlaybackFrameMilliseconds);
}

$('#playPause').addEventListener('click', () => {
    if (!context || context.run.lifecycle !== 'completed') return;
    if (playing) { stopPlayback(); return; }
    playing = true;
    playbackStartedAt = performance.now();
    playbackStartedFrom = context.time >= context.run.availableResultTime ? 0 : context.time;
    $('#playPause').textContent = '❚❚';
    $('#playPause').ariaLabel = 'Pause';
    schedulePlayback();
});

$('#timeline').addEventListener('input', (event) => {
    stopPlayback();
    window.konjugateVisualizer.seek(Number(event.target.value));
});
window.konjugateVisualizer.onTimelineChange((time) => {
    if (!context) return;
    context.time = Number(time);
    $('#timeline').value = String(time);
    $('#currentTime').value = formatTime(time);
    applyAllPoses(context.time);
});
window.konjugateVisualizer.onSamplesAvailable(async ({ availableResultTime }) => {
    if (!context) return;
    context.run.availableResultTime = availableResultTime;
    renderRunStatus(context.run);
    await Promise.all(bodies.map(loadSeriesFor));
    applyAllPoses(context.time);
});
window.konjugateVisualizer.onRunStatusChange((run) => { if (context) renderRunStatus(run); });
window.konjugateVisualizer.onSelectionChange((nodeId) => {
    if (!context) return;
    context.selectedNodeId = nodeId;
    applySelection(nodeId);
});
window.konjugateVisualizer.onSessionChange(loadSession);

loadSession();
