/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Some Linux machines, virtual machines above all, give Chromium a GPU it cannot use: the GPU process crashes over
// and over and WebGL never starts, which leaves the 3D view dead. Recent Chromium does not fall back to software
// WebGL on its own, so the app does: after repeated GPU crashes it restarts once with ANGLE's SwiftShader, and
// remembers that for this machine. A machine whose GPU works never gets here and keeps hardware rendering.

export const softwareRenderingArgument = '--konjugate-software-rendering';

export const softwareRenderingSwitches = [['use-gl', 'angle'], ['use-angle', 'swiftshader'], ['enable-unsafe-swiftshader']];

// Chromium restarts a crashed GPU process a few times before it gives up and blocks WebGL, so two crashes close
// together are already the pattern of a GPU that will not come up.
export function createGpuCrashWatch({ limit = 2, windowMs = 30000 } = {}) {
    const times = [];
    return {
        // Records a crash at `time` (milliseconds); true once `limit` of them fall within `windowMs`.
        record(time) {
            times.push(time);
            while (times.length && time - times[0] > windowMs) times.shift();
            return times.length >= limit;
        }
    };
}

// What to pass to app.relaunch. An AppImage's own files are unmounted when its first process exits, so it is run
// again through the AppImage itself and not through the executable inside it.
export function softwareRenderingRelaunch({ argv, appImagePath }) {
    const args = [...argv.slice(1), softwareRenderingArgument];
    return appImagePath ? { execPath: appImagePath, args } : { args };
}
