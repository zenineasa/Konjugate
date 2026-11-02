/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What counts as a phone. A phone held upright is narrower than phoneMaxWidth; held on its side it is wider than that (800 or more) but a
// touch screen only phoneMaxHeight high, which no desktop window or tablet is. styles.css repeats phoneMediaQuery in its own media rules
// (CSS cannot import it), and misc.mjs, phoneMenu.mjs and renderer.mjs ask `isPhoneLayout()`, so all of them agree.
export const phoneMaxWidth = 700;
export const phoneMaxHeight = 500;
export const phoneMediaQuery = `(max-width: ${phoneMaxWidth}px), (pointer: coarse) and (max-height: ${phoneMaxHeight}px)`;

export const isPhoneLayout = () => Boolean(globalThis.window?.matchMedia?.(phoneMediaQuery).matches);

// Calls `listener` when the layout changes between a phone's and any other (a phone turned, a window resized).
export function onPhoneLayoutChange(listener) {
    window.matchMedia(phoneMediaQuery).addEventListener('change', (event) => listener(event.matches));
}
