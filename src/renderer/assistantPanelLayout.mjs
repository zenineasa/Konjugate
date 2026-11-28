/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How the model assistant's panel sits on the screen: floating (dragged by its header, resized from any edge or corner) or
// docked (full height against the right edge, its width dragged from its left edge). By default it docks when the window
// is small, where a floating panel would cover most of the canvas anyway, and floats otherwise; the header's dock button
// pins either choice. Sizes are kept between sessions in `storage`, and are the panel's preferred size: a window smaller
// than that shrinks the panel (its CSS maximums), and a larger one gives it back. On a phone the stylesheet places the
// panel itself and none of this applies. No knowledge of what the panel shows.

const storageKey = 'konjugate.assistantPanelLayout';
const minimumWidth = 300;
const minimumHeight = 260;
const margin = 10;
const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// Small enough that the panel docks by itself (when nothing was chosen): narrower or shorter than this.
export const autoDockBelow = Object.freeze({ width: 1100, height: 600 });

export function preferredMode(preference, { width, height }) {
    if (preference.mode === 'docked' || preference.mode === 'floating') return preference.mode;
    return width < autoDockBelow.width || height < autoDockBelow.height ? 'docked' : 'floating';
}

// A floating panel's new box when `edge` is dragged by (dx, dy) from `start`, kept to the minimum size and inside `area`.
export function resizedBox(start, edge, dx, dy, area) {
    let { left, top, width, height } = start;
    if (edge.includes('e')) width = Math.min(Math.max(start.width + dx, minimumWidth), area.right - left);
    if (edge.includes('s')) height = Math.min(Math.max(start.height + dy, minimumHeight), area.bottom - top);
    if (edge.includes('w')) {
        const right = start.left + start.width;
        left = Math.min(Math.max(start.left + dx, area.left), right - minimumWidth);
        width = right - left;
    }
    if (edge.includes('n')) {
        const bottom = start.top + start.height;
        top = Math.min(Math.max(start.top + dy, area.top), bottom - minimumHeight);
        height = bottom - top;
    }
    return { left, top, width, height };
}

export function createAssistantPanelLayout({ panel, header, dockButton, canvasTop, setPosition, onModeChange = () => {}, storage = globalThis.localStorage, isPhone = () => false }) {
    let preference = { mode: 'auto' };
    try { preference = { mode: 'auto', ...JSON.parse(storage?.getItem(storageKey) ?? '{}') }; } catch { /* the default */ }
    let mode = null;

    const save = () => { try { storage?.setItem(storageKey, JSON.stringify(preference)); } catch { /* not kept */ } };
    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    const area = () => ({ left: margin, top: canvasTop() + margin, right: window.innerWidth - margin, bottom: window.innerHeight - margin });

    function applySize() {
        const set = (name, value) => (value ? panel.style.setProperty(name, `${Math.round(value)}px`) : panel.style.removeProperty(name));
        set('--assistant-width', preference.width);
        set('--assistant-height', preference.height);
        set('--assistant-docked-width', preference.dockedWidth);
    }

    // Sets the mode the window and the preference call for, and tells `onModeChange` when it changed.
    function apply() {
        const next = isPhone() ? 'phone' : preferredMode(preference, viewport());
        applySize();
        panel.classList.toggle('docked', next === 'docked');
        const docked = next === 'docked';
        dockButton.hidden = next === 'phone';
        dockButton.textContent = docked ? '⧉' : '⇥';
        dockButton.ariaLabel = docked ? 'Float the model assistant' : 'Dock the model assistant to the side';
        dockButton.title = docked ? 'Float' : 'Dock to the side';
        if (next !== mode) {
            const previous = mode;
            mode = next;
            onModeChange(mode, previous);
        }
        return mode;
    }

    // The handles at the edges and corners; which ones show is the stylesheet's (a docked panel resizes from its left edge only).
    for (const edge of edges) {
        const handle = document.createElement('div');
        handle.className = 'assistantResize';
        handle.dataset.edge = edge;
        handle.setAttribute('aria-hidden', 'true');
        panel.append(handle);
        let drag = null;
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || panel.classList.contains('collapsed')) return;
            event.preventDefault();
            const rect = panel.getBoundingClientRect();
            drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
            try { handle.setPointerCapture(event.pointerId); } catch { /* a pointer that cannot be captured still drags */ }
            panel.classList.add('resizing');
        });
        handle.addEventListener('pointermove', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            if (mode === 'docked') {
                const width = Math.min(Math.max(window.innerWidth - event.clientX, minimumWidth), Math.round(window.innerWidth * 0.6));
                preference.dockedWidth = width;
            } else {
                const box = resizedBox(drag.start, edge, event.clientX - drag.x, event.clientY - drag.y, area());
                preference.width = box.width;
                preference.height = box.height;
                setPosition(box.left, box.top);
            }
            applySize();
        });
        const finish = (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag = null;
            panel.classList.remove('resizing');
            save();
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
    }

    // Docking pins the choice either way; the automatic choice comes back only by clearing it (resetSize does not).
    dockButton.addEventListener('click', () => {
        preference.mode = mode === 'docked' ? 'floating' : 'docked';
        save();
        apply();
    });
    // A double-click on the header gives back the panel's own size (and, floating, its own place).
    header.addEventListener('dblclick', (event) => {
        if (event.target.closest('button')) return;
        if (mode === 'docked') delete preference.dockedWidth;
        else { delete preference.width; delete preference.height; }
        save();
        applySize();
        onModeChange(mode, mode);
    });
    window.addEventListener('resize', () => apply());

    return Object.freeze({
        apply,
        mode: () => mode,
        preference: () => structuredClone(preference)
    });
}
