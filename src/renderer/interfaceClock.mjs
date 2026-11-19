/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The clock behind the interface's own gestures that are defined by how long something lasts: pressing and holding a node or a
// relationship, and a steered control coming to rest. It runs on the real clock, unless a test stops it: time then moves only when the test moves it forward, and a
// timer set meanwhile fires exactly when its time comes, never early or late. That is what makes "pressed for 600 ms" the same
// on a fast laptop and on a CI machine that hands the window its input late: the press is seen, the clock is moved on, and the
// release comes after, in that order whatever the machine.

let stopped = null;
let nextManualId = 1;
// Timers set while the clock was stopped and still waiting when it was let go, by their id: the real timer each now is.
const handedOver = new Map();

export function interfaceNow() {
    return stopped ? stopped.now : performance.now();
}

export function setInterfaceTimer(callback, delay) {
    if (!stopped) return { real: setTimeout(callback, delay) };
    const timer = { id: nextManualId++, at: stopped.now + Math.max(0, delay), callback };
    stopped.timers.push(timer);
    return { manual: timer.id };
}

export function clearInterfaceTimer(handle) {
    if (!handle) return;
    if (handle.real !== undefined) clearTimeout(handle.real);
    else if (handedOver.has(handle.manual)) {
        clearTimeout(handedOver.get(handle.manual));
        handedOver.delete(handle.manual);
    } else if (stopped) stopped.timers = stopped.timers.filter((timer) => timer.id !== handle.manual);
}

// Moves a stopped clock on by `milliseconds`, firing each timer due on the way in the order they fall due.
function advance(milliseconds) {
    if (!stopped) throw new Error('The interface clock is not stopped; stop it before moving it on.');
    const until = stopped.now + Math.max(0, milliseconds);
    for (;;) {
        const due = stopped.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        stopped.timers = stopped.timers.filter((timer) => timer !== due);
        stopped.now = due.at;
        due.callback();
    }
    stopped.now = until;
}

// Let go: timers still waiting are handed to the real clock with the time they had left.
function resume() {
    if (!stopped) return;
    const { now, timers } = stopped;
    stopped = null;
    timers.forEach((timer) => handedOver.set(timer.id, setTimeout(() => {
        handedOver.delete(timer.id);
        timer.callback();
    }, timer.at - now)));
}

window.__debugClock = {
    stop: () => { if (!stopped) stopped = { now: performance.now(), timers: [] }; },
    advance,
    resume,
    // How many timers are waiting: a test that has sent a press reads this to know the window has taken it.
    pending: () => stopped?.timers.length ?? 0
};
