/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The drawing of a connected controller in Settings › Controllers (docs/proposals/humanInputBinding.md): a gamepad's outline for one the
// browser lays out as its standard gamepad (two sticks, a d-pad, four face buttons, shoulders and triggers, the middle buttons), and a
// stick in its gate for anything else (a joystick), with its other buttons beneath. Each part carries what it shows (`data-pad` with
// `data-button`, `data-stick` or `data-trigger`), and moveControllerOutlines() moves every drawing on a page to what its controller reads.

const svgNamespace = 'http://www.w3.org/2000/svg';

function svgElement(tag, attributes = {}, title) {
    const created = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, String(value));
    if (title) {
        const tooltip = document.createElementNS(svgNamespace, 'title');
        tooltip.textContent = title;
        created.append(tooltip);
    }
    return created;
}

// How far a stick's knob travels from the middle at full tilt, in the drawing's units.
const gamepadStickTravel = 7;
const joystickTravel = 26;

// The standard gamepad's controls (the Gamepad API's standard mapping): buttons by index, with where each is drawn.
const standardShapes = [
    { button: 12, shape: 'rect', at: { x: 56.5, y: 51, width: 11, height: 12, rx: 2 } },
    { button: 13, shape: 'rect', at: { x: 56.5, y: 74, width: 11, height: 12, rx: 2 } },
    { button: 14, shape: 'rect', at: { x: 44.5, y: 63, width: 12, height: 11, rx: 2 } },
    { button: 15, shape: 'rect', at: { x: 67.5, y: 63, width: 12, height: 11, rx: 2 } },
    { button: 3, shape: 'circle', at: { cx: 178, cy: 54, r: 6.5 } },
    { button: 1, shape: 'circle', at: { cx: 192, cy: 68.5, r: 6.5 } },
    { button: 0, shape: 'circle', at: { cx: 178, cy: 83, r: 6.5 } },
    { button: 2, shape: 'circle', at: { cx: 164, cy: 68.5, r: 6.5 } },
    { button: 4, shape: 'rect', at: { x: 42, y: 17, width: 42, height: 8, rx: 4 } },
    { button: 5, shape: 'rect', at: { x: 156, y: 17, width: 42, height: 8, rx: 4 } },
    { button: 8, shape: 'rect', at: { x: 86, y: 44, width: 12, height: 6, rx: 3 } },
    { button: 9, shape: 'rect', at: { x: 142, y: 44, width: 12, height: 6, rx: 3 } },
    { button: 16, shape: 'circle', at: { cx: 120, cy: 78, r: 5 } },
    { button: 17, shape: 'rect', at: { x: 102, y: 34, width: 36, height: 30, rx: 5 } }
];

// The drawing for one connected controller (as humanInput.readings() gives it); `label(control)` names a control, for its tooltip.
export function controllerOutline(pad, label) {
    return pad.mapping === 'standard' ? gamepadOutline(pad, label) : joystickOutline(pad, label);
}

function gamepadOutline(pad, label) {
    const svg = svgElement('svg', { viewBox: '0 0 240 150', class: 'controllerOutline gamepad', role: 'img', 'aria-label': `${pad.name}, drawn as a gamepad` });
    const button = (index) => ({ 'data-pad': pad.id, 'data-button': index, class: 'controllerPart' });
    const name = (control) => label({ type: control.type, index: control.index });
    // Triggers first, behind the shoulders: an outline with a fill that grows with how far each is pulled.
    for (const [index, x] of [[6, 50], [7, 164]]) {
        if (index >= pad.buttons.length) continue;
        const group = svgElement('g', {}, name({ type: 'button', index }));
        group.append(svgElement('rect', { x, y: 3, width: 26, height: 12, rx: 5, class: 'controllerPart' }),
            svgElement('rect', { x, y: 3, width: 0, height: 12, rx: 5, class: 'controllerTriggerFill', 'data-pad': pad.id, 'data-trigger': index, 'data-width': 26 }));
        svg.append(group);
    }
    svg.append(svgElement('path', {
        class: 'controllerBody',
        d: 'M62 28H178C200 28 214 40 220 60L232 106C237 126 226 142 210 142C198 142 190 134 182 124L176 116H64L58 124C50 134 42 142 30 142C14 142 3 126 8 106L20 60C26 40 40 28 62 28Z'
    }));
    for (const { button: index, shape, at } of standardShapes) {
        if (index >= pad.buttons.length) continue;
        svg.append(svgElement(shape, { ...at, ...button(index) }, name({ type: 'button', index })));
    }
    for (const [centre, axes, press] of [[[90, 96], [0, 1], 10], [[150, 96], [2, 3], 11]]) {
        if (axes[1] >= pad.axes.length) continue;
        const [cx, cy] = centre;
        const group = svgElement('g', {}, `${name({ type: 'axis', index: axes[0] })}, ${name({ type: 'axis', index: axes[1] })}`);
        group.append(svgElement('circle', { cx, cy, r: 15, class: 'controllerStickWell' }),
            svgElement('circle', { cx, cy, r: 9, class: 'controllerPart controllerKnob', 'data-pad': pad.id, 'data-stick': axes.join(','), 'data-travel': gamepadStickTravel, ...(press < pad.buttons.length ? { 'data-button': press } : {}) }));
        svg.append(group);
    }
    return svg;
}

function joystickOutline(pad, label) {
    const rows = Math.ceil(pad.buttons.length / 10);
    const height = 120 + rows * 16;
    const svg = svgElement('svg', { viewBox: `0 0 120 ${height}`, class: 'controllerOutline joystick', role: 'img', 'aria-label': `${pad.name}, drawn as a joystick` });
    svg.style.setProperty('--outline-aspect', `120 / ${height}`);
    svg.append(svgElement('rect', { x: 14, y: 6, width: 92, height: 92, rx: 22, class: 'controllerBody' }));
    if (pad.axes.length) {
        svg.append(svgElement('path', { d: 'M60 18V86M26 52H94', class: 'controllerGate' }));
        const axes = pad.axes.length > 1 ? [0, 1] : [0];
        svg.append(svgElement('circle', { cx: 60, cy: 52, r: 12, class: 'controllerPart controllerKnob', 'data-pad': pad.id, 'data-stick': axes.join(','), 'data-travel': joystickTravel },
            axes.map((index) => label({ type: 'axis', index })).join(', ')));
    }
    pad.buttons.forEach((_button, index) => {
        const row = Math.floor(index / 10);
        const inRow = Math.min(10, pad.buttons.length - row * 10);
        const cx = 60 + (index % 10 - (inRow - 1) / 2) * 11;
        svg.append(svgElement('circle', { cx, cy: 116 + row * 16, r: 4, class: 'controllerPart', 'data-pad': pad.id, 'data-button': index }, label({ type: 'button', index })));
    });
    return svg;
}

// The axes and buttons a drawing does not show, which the row shows as bars and dots beside it.
export function controlsNotDrawn(pad) {
    if (pad.mapping === 'standard') {
        return { axes: pad.axes.map((_value, index) => index).filter((index) => index > 3), buttons: pad.buttons.map((_button, index) => index).filter((index) => index > 17) };
    }
    return { axes: pad.axes.map((_value, index) => index).filter((index) => index > 1), buttons: [] };
}

// Moves every drawing under `root` to what its controller reads now (`pads`: a Map from id to humanInput.readings()'s entry).
export function moveControllerOutlines(root, pads) {
    for (const knob of root.querySelectorAll('.controllerKnob[data-stick]')) {
        const pad = pads.get(knob.dataset.pad);
        const [x, y] = knob.dataset.stick.split(',').map(Number);
        const travel = Number(knob.dataset.travel);
        const clamp = (value) => Math.max(-1, Math.min(1, Number(value) || 0));
        const dx = clamp(pad?.axes[x]) * travel;
        const dy = Number.isInteger(y) ? clamp(pad?.axes[y]) * travel : 0;
        knob.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
        knob.classList.toggle('moved', dx !== 0 || dy !== 0);
    }
    for (const fill of root.querySelectorAll('.controllerTriggerFill')) {
        const value = Math.max(0, Math.min(1, pads.get(fill.dataset.pad)?.buttons[Number(fill.dataset.trigger)]?.value ?? 0));
        fill.setAttribute('width', (value * Number(fill.dataset.width)).toFixed(2));
    }
}
