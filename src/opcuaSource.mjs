/* Copyright © 2026 Zenin Easa Panthakkalakath */

// An OPC UA server as a source for a live twin (docs/proposals/digitalTwinConnections.md, "What a small lab needs from OPC UA"):
// Konjugate connects out as a client, as a lab's own HMI would, browses the server's tags, and subscribes to the ones chosen.
//
//   browseOpcUa(url, options)        the server's tags, as a list with their path, value, unit and range (the adapter's `describe`)
//   followOpcUa(url, options)        follows tags as signals and hands on observations, timed by the server's own source timestamps
//
// What a small lab needs, and what this does:
//   - the tags as a tree to choose from instead of typing node identifiers: browse walks the Objects folder;
//   - the unit and range the server already provides: an analog item's EngineeringUnits and EURange are read;
//   - the quality flag on every value: a status code that is Good, Uncertain or Bad becomes the reading's quality;
//   - security of "none", "sign" or "sign and encrypt": a server's certificate is trusted only when the person has said so
//     (`trustServer`), and refused before, with a message saying it is not trusted yet; Konjugate's own certificate is kept in
//     `pkiFolder`, the app's own folder;
//   - subscribing to changes and reconnecting by itself when the PLC restarts: the client's own reconnection.
//
// A subscription reports what the server samples, at the sampling interval it grants (often 50 to 1000 ms), not every change: a tag
// that changes faster than that has changes no client sees. A lab's sensors read once a second or slower are sampled whole. The
// interval each tag was granted is read back (`sampling`), so a person can be told the limit (tests/opcuaSource.test.mjs measures
// it: changes 20 ms apart on a server sampling every 50 ms arrive as 18 of 40, every one from 50 ms apart). Within one notification
// a server groups readings by tag, not by time, so each batch is put back in time order before it is handed on.
//
// Options: { security: 'none' | 'sign' | 'signAndEncrypt', pkiFolder, trustServer }.

import {
    AttributeIds, BrowseDirection, ClientMonitoredItem, ClientSubscription, DataChangeFilter, DataChangeTrigger, DeadbandType, MessageSecurityMode,
    NodeClass, OPCUAClient, SecurityPolicy, TimestampsToReturn
} from 'node-opcua-client';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';

const securityModes = {
    none: { securityMode: MessageSecurityMode.None, securityPolicy: SecurityPolicy.None },
    sign: { securityMode: MessageSecurityMode.Sign, securityPolicy: SecurityPolicy.Basic256Sha256 },
    signAndEncrypt: { securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 }
};

export class OpcUaUntrustedError extends Error {
    constructor(url) {
        super(`The server at ${url} has a certificate this computer does not trust yet. Trust it only if you know this is your lab's server.`);
        this.name = 'OpcUaUntrustedError';
        this.untrusted = true;
    }
}

function makeClient({ security = 'none', pkiFolder = null, trustServer = false, reconnect = true }) {
    const mode = securityModes[security];
    if (!mode) throw new Error('OPC UA security is none, sign, or sign and encrypt.');
    const certificateManager = pkiFolder ? new OPCUACertificateManager({ rootFolder: pkiFolder, automaticallyAcceptUnknownCertificate: trustServer }) : undefined;
    return OPCUAClient.create({
        applicationName: 'Konjugate', endpointMustExist: false, ...mode,
        connectionStrategy: reconnect ? { initialDelay: 250, maxDelay: 5000, maxRetry: Number.MAX_SAFE_INTEGER } : { maxRetry: 0 },
        ...(certificateManager ? { clientCertificateManager: certificateManager } : {}),
        keepSessionAlive: true
    });
}

const untrusted = (error) => /BadCertificateUntrusted|untrusted|not trusted|BadSecurityChecksFailed/i.test(String(error?.message ?? error));

// Why a server could not be reached, in words, where the client's own message ("The connection may have been rejected by server,
// Err = ()") says little.
export function unreachableServer(url, error) {
    const message = String(error?.message ?? error);
    if (/ECONNREFUSED|rejected by server|socket has been disconnected|ECONNRESET/i.test(message)) return `No OPC UA server is answering at ${url}. Is the server running, and is this its address and port (often 4840)?`;
    if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return `There is no computer at ${url} on this network. Check the server's address.`;
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) return `The server at ${url} did not answer in time. Is it reachable from this computer?`;
    return `Could not connect to ${url}: ${message}`;
}

async function open(url, options) {
    const client = makeClient({ ...options, reconnect: false });
    try {
        await client.connect(url);
        const session = await client.createSession();
        return { client, session };
    } catch (error) {
        await client.disconnect().catch(() => {});
        if (options.security && options.security !== 'none' && !options.trustServer && untrusted(error)) throw new OpcUaUntrustedError(url);
        throw new Error(unreachableServer(url, error));
    }
}

const quality = (statusCode) => {
    const name = statusCode?.name ?? 'Good';
    return name.startsWith('Good') ? 'good' : name.startsWith('Uncertain') ? 'uncertain' : 'bad';
};

// The server's variables under its Objects folder (the server's own diagnostics left out), as { nodeId, path, value, numeric,
// unit, range, dataType }, up to `maxTags` of them.
export async function browseOpcUa(url, { maxTags = 500, maxDepth = 6, ...options } = {}) {
    const { client, session } = await open(url, options);
    try {
        const tags = [];
        const queue = [{ nodeId: 'ns=0;i=85', path: '', depth: 0 }];
        const seen = new Set();
        while (queue.length && tags.length < maxTags) {
            const { nodeId, path, depth } = queue.shift();
            const result = await session.browse({ nodeId, browseDirection: BrowseDirection.Forward, includeSubtypes: true, nodeClassMask: 0, resultMask: 63, referenceTypeId: 'HierarchicalReferences' });
            for (const reference of result.references ?? []) {
                const id = reference.nodeId.toString();
                const name = reference.browseName.name;
                if (seen.has(id) || (reference.nodeId.namespace === 0 && name === 'Server')) continue;
                seen.add(id);
                const childPath = path ? `${path}/${name}` : name;
                if (reference.nodeClass === NodeClass.Variable) {
                    if (['EngineeringUnits', 'EURange', 'InstrumentRange', 'Definition', 'ValuePrecision'].includes(name)) continue;
                    const value = await session.read({ nodeId: id, attributeId: AttributeIds.Value });
                    const properties = await session.browse({ nodeId: id, browseDirection: BrowseDirection.Forward, referenceTypeId: 'HasProperty', includeSubtypes: true, resultMask: 63 });
                    const property = (wanted) => properties.references?.find((child) => child.browseName.name === wanted)?.nodeId;
                    const units = property('EngineeringUnits') ? (await session.read({ nodeId: property('EngineeringUnits'), attributeId: AttributeIds.Value })).value.value : null;
                    const range = property('EURange') ? (await session.read({ nodeId: property('EURange'), attributeId: AttributeIds.Value })).value.value : null;
                    const raw = value.value?.value;
                    tags.push({
                        nodeId: id, path: childPath, value: typeof raw === 'number' ? raw : raw ?? null, numeric: typeof raw === 'number' || typeof raw === 'boolean',
                        unit: units?.displayName?.text ?? '', range: range ? { low: range.low, high: range.high } : null, quality: quality(value.statusCode)
                    });
                    if (tags.length >= maxTags) break;
                } else if (depth < maxDepth && (reference.nodeClass === NodeClass.Object || reference.nodeClass === NodeClass.Variable)) {
                    queue.push({ nodeId: id, path: childPath, depth: depth + 1 });
                }
            }
        }
        return tags.sort((a, b) => a.path.localeCompare(b.path));
    } finally {
        await session.close().catch(() => {});
        await client.disconnect().catch(() => {});
    }
}

// Follows tags as signals: [{ nodeId, name, role, unit, scale = 1, offset = 0 }]. A reading is timed by the server's source timestamp
// (when the value was measured), else its server timestamp, else when it arrived; times are counted from when following began. A
// true or false tag reads as 1 or 0. onHeader is called at once; onObservations with each batch; onError if it cannot connect. The
// follower's `sampling` resolves, once the server has answered for every tag, to { signal name: the sampling interval in ms it granted }.
export function followOpcUa(url, { signals, samplingInterval = 0, batchMilliseconds = 20, now = () => Date.now(), onHeader = () => {}, onObservations = () => {}, onError = () => {}, ...options }) {
    // On a whole second, so readings stamped on whole seconds come out as exact times, not 60.0000000000018.
    const epoch = Math.floor(now() / 1000) * 1000;
    const byNode = new Map(signals.map((signal) => [signal.nodeId, signal]));
    const header = Object.freeze({ version: 1, source: url, epoch, signals: Object.freeze(signals.map(({ name, unit = '', role }) => ({ name, unit, role }))) });
    onHeader(header);
    let pending = [];
    let timer = null;
    let client = null;
    let session = null;
    let subscription = null;
    let granted;
    const sampling = new Promise((resolve) => { granted = resolve; });
    const flush = () => {
        timer = null;
        if (!pending.length) return;
        // Put in time order: a source can deliver several signals' readings together, grouped by signal rather than by time (an
        // OPC UA server's notifications are), and what follows (a move, a recording) needs them in the order they were measured.
        const batch = pending.sort((a, b) => a.time - b.time);
        pending = [];
        onObservations(batch, now());
    };
    const connected = (async () => {
        client = makeClient(options);
        try {
            await client.connect(url);
            session = await client.createSession();
        } catch (error) {
            if (options.security && options.security !== 'none' && !options.trustServer && untrusted(error)) throw new OpcUaUntrustedError(url);
            throw error;
        }
        const intervals = {};
        const answered = (signal, item) => {
            intervals[signal.name] = item.monitoringParameters?.samplingInterval ?? null;
            if (Object.keys(intervals).length === signals.length) granted(intervals);
        };
        subscription = ClientSubscription.create(session, { requestedPublishingInterval: 50, requestedLifetimeCount: 600, requestedMaxKeepAliveCount: 20, maxNotificationsPerPublish: 0, publishingEnabled: true, priority: 10 });
        for (const signal of signals) {
            // A reading that repeats the last value is still a reading: by default a server reports only a changed value or status,
            // so the filter asks for a new timestamp too.
            const filter = new DataChangeFilter({ trigger: DataChangeTrigger.StatusValueTimestamp, deadbandType: DeadbandType.None, deadbandValue: 0 });
            const item = ClientMonitoredItem.create(subscription, { nodeId: signal.nodeId, attributeId: AttributeIds.Value },
                { samplingInterval, queueSize: 10000, discardOldest: false, filter }, TimestampsToReturn.Both);
            item.once('initialized', () => answered(signal, item));
            item.once('err', () => answered(signal, item));
            item.on('changed', (dataValue) => {
                const raw = dataValue.value?.value;
                // Only a number or a true/false is a reading: text is not, even text that looks like a number ("" would be 0).
                const number = typeof raw === 'boolean' ? (raw ? 1 : 0) : typeof raw === 'number' ? raw : NaN;
                if (!Number.isFinite(number)) return;
                const stamp = dataValue.sourceTimestamp ?? dataValue.serverTimestamp ?? new Date(now());
                pending.push({
                    time: (stamp.getTime() - epoch) / 1000, signal: signal.name, value: number * (signal.scale ?? 1) + (signal.offset ?? 0),
                    quality: quality(dataValue.statusCode), revision: 0
                });
                timer ??= setTimeout(flush, batchMilliseconds);
            });
            byNode.set(signal.nodeId, { ...signal, item });
        }
    })().catch((error) => { onError(error); });
    return {
        header,
        ready: connected,
        sampling,
        async stop() {
            await connected;
            if (timer) clearTimeout(timer);
            flush();
            await subscription?.terminate().catch(() => {});
            await session?.close().catch(() => {});
            await client?.disconnect().catch(() => {});
        }
    };
}
