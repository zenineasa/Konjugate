/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Which window reads the controllers when focus is elsewhere (docs/proposals/humanInputBinding.md, "Reading the devices"). A window that
// steers a model (a project window or a twin's) reads its controllers while it has focus; when another of Konjugate's windows has focus
// instead (an add-on's 3D view, a guide), the steering window last used keeps them, so a person can drive while watching that window.
// When another application has focus, none does. No Electron: the main process gives it windows as it has them.

// The steering window that keeps the controllers now: { owner, handedTo }. `focused` is the window with focus (null when another
// application has it), `steering` the windows that steer, and `owner` the steering window last used (kept from the call before).
export function controllerFocus({ focused, steering, owner }) {
    const steers = (window) => Boolean(window) && steering.includes(window);
    const nextOwner = steers(focused) ? focused : (steers(owner) ? owner : null);
    const handedTo = focused && !steers(focused) ? nextOwner : null;
    return { owner: nextOwner, handedTo };
}
