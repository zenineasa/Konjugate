/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The push service as a source for a live twin (docs/proposals/pushService.md, "Reaching a live twin"). The service hands what it
// takes to a PushHub, wherever the service runs (in the app it runs in its own process, and the main process publishes what that
// process sends); each live twin following pushed readings is a follower of the hub, as one following a broker is a client of it.
//
//   new PushHub()                          publish(readings) from the service; readings no follower listens for are counted
//   followPush(hub, { signals, ... })      follows pushed signals, each as one signal with its role and unit, and hands on
//                                          observations as a data log's would be, times counted from when following began
//
// signals: [{ signal, name, role, unit }]: `signal` is the name a script pushes, `name` the name the twin knows it by.

export class PushHub {
    #followers = new Set();
    #unclaimed = 0;

    // Readings as the gate takes them: { signal, value, time (seconds since 1970), quality }.
    publish(readings) {
        let claimed = 0;
        for (const reading of readings) {
            let wanted = false;
            for (const follower of this.#followers) if (follower.wants(reading.signal)) wanted = true;
            if (wanted) claimed += 1;
        }
        this.#unclaimed += readings.length - claimed;
        for (const follower of this.#followers) follower.take(readings);
    }

    // Readings taken while no live twin was listening for their signal: counted for the panel, not kept.
    get unclaimed() { return this.#unclaimed; }

    get followers() { return this.#followers.size; }

    // Every pushed signal a follower listens for.
    get followedSignals() {
        return [...new Set([...this.#followers].flatMap((follower) => follower.signals))];
    }

    follow(follower) {
        this.#followers.add(follower);
        return () => this.#followers.delete(follower);
    }

    // The service stopped or failed: every twin following it is told why, and stops.
    fail(reason) {
        for (const follower of [...this.#followers]) follower.fail(reason);
    }
}

// Follows pushed signals. onHeader(header) is called once, at once; onObservations with each batch of readings (gathered for
// `batchMilliseconds`, so a burst becomes one batch), in time order; onError if the service stops while it is followed.
export function followPush(hub, { signals, onHeader = () => {}, onObservations = () => {}, onError = () => {}, batchMilliseconds = 20, now = () => Date.now() }) {
    // On a whole second, so readings stamped on whole seconds come out as exact times.
    const epoch = Math.floor(now() / 1000) * 1000;
    const bySignal = new Map(signals.map((signal) => [signal.signal, signal]));
    const header = Object.freeze({
        version: 1, source: 'Konjugate push service', epoch,
        signals: Object.freeze(signals.map(({ name, unit = '', role }) => ({ name, unit, role })))
    });
    onHeader(header);
    let pending = [];
    let timer = null;
    const flush = () => {
        timer = null;
        if (!pending.length) return;
        const batch = pending.sort((a, b) => a.time - b.time);
        pending = [];
        onObservations(batch, now());
    };
    const unfollow = hub.follow({
        signals: [...bySignal.keys()],
        wants: (signal) => bySignal.has(signal),
        take(readings) {
            for (const reading of readings) {
                const signal = bySignal.get(reading.signal);
                if (!signal) continue;
                pending.push({ time: reading.time - epoch / 1000, signal: signal.name, value: reading.value, quality: reading.quality, revision: 0 });
            }
            if (pending.length) timer ??= setTimeout(flush, batchMilliseconds);
        },
        fail(reason) {
            if (timer) clearTimeout(timer);
            flush();
            onError(new Error(`The push service stopped: ${reason}`));
        }
    });
    return {
        header,
        ready: Promise.resolve(),
        async stop() {
            unfollow();
            if (timer) clearTimeout(timer);
            flush();
        }
    };
}
