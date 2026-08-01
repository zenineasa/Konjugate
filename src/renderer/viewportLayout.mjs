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
