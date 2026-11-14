/* Copyright © 2026 Zenin Easa Panthakkalakath */

// "Lay out and dress a model" (docs/proposals/tutorials.md), starting from the Heated Water Tank example: a node moved with the Move tool,
// another given a shape from the shape library and made taller, the camera locked to a flat plane, and the labels' detail changed. None
// of it changes how the model runs; it is how a model is read.

export const layoutModelValues = Object.freeze({
    heater: 'Electric heater',
    tank: 'Water tank',
    shape: { id: 'fluid/tank', name: 'Tank', domain: 'Fluid' },
    scaleY: 1.5
});
const values = layoutModelValues;

const nodeNamed = (document, name) => (document?.nodes ?? []).find((node) => node.name === name);
const moved = (document, start) => JSON.stringify(nodeNamed(document, values.heater)?.position) !== JSON.stringify(nodeNamed(start, values.heater)?.position);
const shaped = (document, start) => JSON.stringify(nodeNamed(document, values.tank)?.appearance) !== JSON.stringify(nodeNamed(start, values.tank)?.appearance);
const taller = (document) => Number(nodeNamed(document, values.tank)?.scale?.[1]) === values.scaleY;

const steps = Object.freeze([
    {
        id: 'welcome',
        title: 'Lay out and dress a model',
        text: 'Where things sit and what they look like do not change how a model runs, but they change how fast someone else understands it. You will move a part, give another a shape that says what it is, flatten the view, and choose how much the labels say.',
        advance: 'next', nextLabel: 'Start', done: () => true
    },
    {
        id: 'move',
        title: 'Move a part',
        text: `Choose the Move tool in the toolbar (the four arrows), click the ${values.heater}, and drag one of the arrows that appear on it to put it beside the tank. The Select tool drags freely; Move keeps to one direction at a time.`,
        target: (ui) => (ui.tool === 'move' ? ui.labelOf(values.heater) : '[data-tool="move"]'), skip: 'moveNode', node: values.heater, offset: [2.5, 0, 0],
        done: ({ document, start }) => moved(document, start)
    },
    {
        id: 'shape',
        title: 'Give the tank its shape',
        text: `Click the ${values.tank}, open its Appearance tab and press "Shape library". Choose ${values.shape.domain}, then "${values.shape.name}", and press Apply shape.`,
        target: (ui) => (ui.shapeLibraryOpen ? '#shapeLibraryApply' : ui.nodeEditorFor === values.tank ? (ui.appearanceTabShown ? '#editBrowseShapeLibrary' : '#nodeEditor [data-node-tab="appearance"]') : ui.labelOf(values.tank)),
        skip: 'applyShape', node: values.tank, shapeId: values.shape.id,
        done: ({ document, start }) => shaped(document, start)
    },
    {
        id: 'scale',
        title: 'Make it taller',
        text: `In the same Appearance tab, set Scale Y to ${values.scaleY} and press Enter. The rotation fields beside it turn a part precisely; the Rotate and Scale tools in the toolbar do it by dragging.`,
        target: (ui) => (ui.nodeEditorFor === values.tank && ui.appearanceTabShown ? '#editNodeScaleY' : ui.labelOf(values.tank)),
        skip: 'setNodeScale', node: values.tank, axis: 'Y', value: values.scaleY,
        done: ({ document }) => taller(document)
    },
    {
        id: 'flatten',
        title: 'Flatten the view',
        text: 'Press the lock above the view cube at the bottom left. The camera keeps to a flat plane, like a drawing, and can no longer tip; press it again to look around in 3D.',
        target: '#lock2DButton', skip: 'lock2D',
        done: ({ ui }) => ui.lockedTo2D
    },
    {
        id: 'labels',
        title: 'Choose how much labels say',
        text: 'At the top right, press Nodes beside Details: it goes from compact labels to full ones, showing every state\'s value, and then to none. Edges does the same for the relationships\' labels. A large model starts with fewer.',
        target: '#nodeLabelsButton', skip: 'cycleNodeLabels',
        done: ({ ui }) => ui.labelDetailChanged
    },
    {
        id: 'finish',
        title: 'You have laid out a model',
        text: 'Fit visible model, beside the camera\'s zoom buttons, brings everything into view. A node\'s Appearance can also use a 3D file of your own (STL, OBJ or glTF), and be built from several parts. Save the project to keep the layout.',
        advance: 'next', nextLabel: 'Finish', done: () => false
    }
]);

export const layoutModel = Object.freeze({
    id: 'layoutModel',
    title: 'Lay out and dress a model',
    summary: 'Move a part, give another a shape from the library, flatten the view, and choose how much labels say.',
    minutes: 3,
    area: 'modelling',
    tags: ['layout', 'move', 'rotate', 'scale', 'transform', 'appearance', 'shape library', 'shape', '3D model', '2D', 'lock', 'labels', 'detail', 'view', 'camera'],
    start: { from: 'example', example: 'heatedWaterTank.kjt' },
    editions: ['desktop', 'web'],
    steps
});
