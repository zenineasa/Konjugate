/* Copyright © 2026 Zenin Easa Panthakkalakath */

export function virtualKeyboardInset(viewportHeight, boundingRect, visible = true) {
    if (!visible || !boundingRect || !Number.isFinite(boundingRect.top)) return 0;
    return Math.max(0, Math.round(viewportHeight - boundingRect.top));
}

export function eligibleEndpointIds(nodes, otherEndpointId, isVisible = () => true) {
    return nodes
        .filter((node) => node.id !== otherEndpointId && isVisible(node))
        .map((node) => node.id);
}

// The canvas fades distant shapes into its background, as a cue to depth. With one density for every model, a model
// wide enough to need the camera far back faded away whole: at 100 units, a density of 0.022 leaves under 1% of a
// shape's own colour, and only the labels (drawn over the canvas, not in it) were left. So the fog thins as the camera
// pulls back: up to the distance the canvas opens at it is as it was, and beyond that what the camera looks at keeps the
// colour it has at that distance, while what lies behind it still fades.
export const canvasFog = { density: 0.022, referenceDistance: Math.hypot(7.5, 19) };

export function fogDensityFor(viewDistance, { density = canvasFog.density, referenceDistance = canvasFog.referenceDistance } = {}) {
    if (!Number.isFinite(viewDistance) || viewDistance <= referenceDistance) return density;
    return density * referenceDistance / viewDistance;
}

// And nothing the camera looks at is cut off behind it: the far plane keeps three times the viewing distance, never
// less than the canvas has always had.
export function farPlaneFor(viewDistance, minimum = 300) {
    return Number.isFinite(viewDistance) ? Math.max(minimum, viewDistance * 3) : minimum;
}

// The label a canvas object carries, as its element: found on the object, not in the page. A label enters the page
// only when a frame is drawn, so one looked up in the page straight after its model opened is not there yet, and a
// result shown at once (a scenario's fork) had nowhere to write its values.
export function labelElementOf(object, className) {
    return object?.children?.find((child) => child.element?.classList?.contains(className))?.element ?? null;
}
