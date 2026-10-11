/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The clocks behind an assistant request. A model that is still producing output is not stuck, so the
// request is not given one fixed deadline: it is stopped when nothing has arrived for the
// configuration's timeout (the "idle" clock, restarted by every sign of life, including each new
// repair attempt), or when it has run for the whole maximum, a safety net for a model that never
// stops talking.

export const maximumRequestSeconds = 20 * 60;

export function createRequestWatchdog({ idleSeconds, maximumSeconds = maximumRequestSeconds, onExpire }) {
    let stopped = false;
    let idleTimer;
    const stop = () => {
        stopped = true;
        clearTimeout(idleTimer);
        clearTimeout(maximumTimer);
    };
    const expire = (reason) => {
        if (stopped) return;
        stop();
        onExpire(reason);
    };
    const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => expire('idle'), idleSeconds * 1000);
    };
    const maximumTimer = setTimeout(() => expire('maximum'), maximumSeconds * 1000);
    arm();
    return { touch() { if (!stopped) arm(); }, stop };
}

// Progress can arrive for every network chunk; the panel only needs the latest picture a few times a
// second. Always sends the newest value, never a stale one, and drops nothing that matters.
export function createLatestThrottle(send, intervalMilliseconds) {
    let latest = null;
    let timer = null;
    const flush = () => {
        timer = null;
        if (latest === null) return;
        const value = latest;
        latest = null;
        send(value);
    };
    return {
        push(value) {
            latest = value;
            if (!timer) timer = setTimeout(flush, intervalMilliseconds);
        },
        stop() {
            clearTimeout(timer);
            timer = null;
            latest = null;
        }
    };
}
