/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The one place the push service decides what it takes (docs/proposals/pushService.md): every front end (HTTP, the WebSocket and
// gRPC) only turns what arrives into a key and readings, and asks the gate. The gate checks the key (known, not revoked, not from an
// address that has failed too often), the signals it may send and each reading, stamps a reading with no time of its own, and hands
// the readings on. So the three front ends give the same answer to the same readings, whichever way they came.
//
// A reading, as every codec makes it: { signal, value, time, quality }, `time` in seconds since 1970 or null. An answer is
// { status, taken, reason }, `status` the HTTP status the same message gets over HTTP.

const qualities = new Set(['good', 'uncertain', 'bad']);
const futureAllowanceSeconds = 24 * 3600;

// A message refused, with the status and the reason the script is told.
export class PushRefusal extends Error {
    constructor(status, reason, { revoked = false } = {}) {
        super(reason);
        this.status = status;
        this.reason = reason;
        this.revoked = revoked;
    }
}

export const refusalAnswer = (error) => (error instanceof PushRefusal
    ? { status: error.status, taken: 0, reason: error.reason }
    : { status: 500, taken: 0, reason: `The readings could not be taken: ${error?.message ?? error}` });

// The key from an Authorization header's value ("Bearer <key>"), or null.
export const bearerKey = (header) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ''));
    return match ? match[1] : null;
};

export class PushGate {
    #keyStore;
    #deliver;
    #now;
    #failures = new Map();
    #blocked = new Map();
    #failureLimit;
    #failureWindow;
    #blockFor;
    #lastUsed = new Map();
    #takenBySecond = new Map();
    #taken = 0;

    // keyStore: a PushKeyStore. deliver(readings, client): hands taken readings on; may return a promise, and the next message from
    // that client waits for it, which is how a slow consumer slows a sender down. now: milliseconds since 1970.
    constructor({ keyStore, deliver = () => {}, now = () => Date.now(), failureLimit = 10, failureWindowMilliseconds = 60000, blockMilliseconds = 60000 }) {
        this.#keyStore = keyStore;
        this.#deliver = deliver;
        this.#now = now;
        this.#failureLimit = failureLimit;
        this.#failureWindow = failureWindowMilliseconds;
        this.#blockFor = blockMilliseconds;
    }

    // The client a key belongs to: { name, signals, hash, address }; refused with 401 for a missing, unknown or revoked key and 429
    // for an address that has failed too often lately.
    async admit(key, address = 'unknown') {
        const now = this.#now();
        const blockedUntil = this.#blocked.get(address) ?? 0;
        if (blockedUntil > now) throw new PushRefusal(429, 'Too many attempts with a wrong key from this address: try again in a minute.');
        if (!key) return this.#fail(address, now, new PushRefusal(401, 'Send the key as "Authorization: Bearer <key>".'));
        const record = await this.#keyStore.find(key);
        if (!record) return this.#fail(address, now, new PushRefusal(401, 'This key is not one Konjugate knows. Make one in Konjugate, under Settings › Push service.'));
        if (record.revoked) return this.#fail(address, now, new PushRefusal(401, `This key ("${record.name}") was revoked.`, { revoked: true }));
        this.#lastUsed.set(record.name, now);
        return { name: record.name, signals: new Set(record.signals), hash: record.hash, address };
    }

    #fail(address, now, refusal) {
        const recent = (this.#failures.get(address) ?? []).filter((time) => now - time < this.#failureWindow);
        recent.push(now);
        this.#failures.set(address, recent);
        if (recent.length >= this.#failureLimit) {
            this.#blocked.set(address, now + this.#blockFor);
            this.#failures.delete(address);
        }
        throw refusal;
    }

    // Takes a message's readings for a client admitted earlier, answering { status: 202, taken, reason: '' }; anything wrong refuses
    // the whole message, so a script never half-succeeds without knowing. A key revoked since the client was admitted is refused.
    async take(client, readings) {
        const record = await this.#keyStore.findByHash(client.hash);
        if (!record || record.revoked) throw new PushRefusal(401, `This key ("${client.name}") was revoked.`, { revoked: true });
        if (!Array.isArray(readings)) throw new PushRefusal(400, 'A message is { "readings": [ ... ] }.');
        const now = this.#now();
        const arrived = now / 1000;
        const taken = readings.map((reading, index) => {
            const which = readings.length === 1 ? 'The reading' : `Reading ${index + 1}`;
            if (!reading || typeof reading !== 'object') throw new PushRefusal(400, `${which} is not an object with a signal and a value.`);
            const { signal, value, time = null, quality = 'good' } = reading;
            if (typeof signal !== 'string' || !signal) throw new PushRefusal(400, `${which} has no signal.`);
            if (!client.signals.has(signal)) throw new PushRefusal(403, `The key "${client.name}" may not send "${signal}". It may send ${[...client.signals].join(', ')}.`);
            if (value === undefined || value === null) throw new PushRefusal(400, `${which} (${signal}) has no value.`);
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new PushRefusal(400, `${which} (${signal}) has a value that is not a finite number.`);
            if (time !== null && (typeof time !== 'number' || !Number.isFinite(time))) throw new PushRefusal(400, `${which} (${signal}) has a time that is not a time.`);
            if (time !== null && time > arrived + futureAllowanceSeconds) {
                throw new PushRefusal(400, `${which} (${signal}) is timed more than a day from now: a time in seconds since 1970 is expected, not milliseconds.`);
            }
            if (!qualities.has(quality)) throw new PushRefusal(400, `${which} (${signal}) has a quality of "${quality}": it is good, uncertain or bad.`);
            return { signal, value, time: time ?? arrived, quality, stamped: time === null };
        });
        this.#lastUsed.set(client.name, now);
        if (taken.length) {
            await this.#deliver(taken, client);
            this.#count(taken.length, now);
        }
        return { status: 202, taken: taken.length, reason: '' };
    }

    #count(count, now) {
        const second = Math.floor(now / 1000);
        this.#takenBySecond.set(second, (this.#takenBySecond.get(second) ?? 0) + count);
        for (const old of this.#takenBySecond.keys()) if (old < second - 10) this.#takenBySecond.delete(old);
        this.#taken += count;
    }

    // { taken, readingsPerSecond (over the last five whole seconds), lastUsed: { name: milliseconds } }.
    figures() {
        const second = Math.floor(this.#now() / 1000);
        let recent = 0;
        for (let offset = 1; offset <= 5; offset += 1) recent += this.#takenBySecond.get(second - offset) ?? 0;
        return { taken: this.#taken, readingsPerSecond: recent / 5, lastUsed: Object.fromEntries(this.#lastUsed) };
    }
}
