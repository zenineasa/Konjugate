/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A launcher's fetch from the internet in the web edition (docs/proposals/webEditionPackages.md, stage 5): launcherHost.mjs's fetchAllowed
// for a page. The same rules (https, no credentials, only a host the manifest lists, a size limit and a time limit), with the differences a
// browser makes. The page itself may talk only to its own server, so the request is made by `transport`, which the page backs with a sandboxed
// frame (renderer/fetchFrame.html) that has no origin and no cookies. A page can read an answer only from a server that allows pages from other
// sites (CORS), which many data services do not; a browser reports that as a failed request with no reason, so the message names both things
// it may be. A browser cannot stop at a redirect and look where it leads, so the frame follows it and refuses an answer that came from a host
// that is not listed before it reads it. The request carries no cookies and no referrer, so what a server learns is the address asked for.
// No Node, no DOM.

import { checkAddress, fetchTimeoutMilliseconds, maximumFetchBytes } from './launcherImport.mjs';

// checkAddress's refusals for a download, which the stored files' messages word as downloading and not fetching.
export function addressFailure(address, allowed, doing = 'fetch') {
    const past = doing === 'download' ? 'downloaded' : 'fetched';
    if (address.protocol !== 'https:') throw new Error(`Only https addresses can be ${past}.`);
    if (address.username || address.password) throw new Error(`An address with a user name or password cannot be ${past}.`);
    if (!allowed.has(address.hostname.toLowerCase())) throw new Error(`This window may not ${doing === 'download' ? 'download from' : 'connect to'} ${address.hostname}. It may reach: ${[...allowed].join(', ')}.`);
}

// The error a transport's failed answer stands for ({ error: 'address' | 'host' | 'timeout' | 'network' | 'size' | 'stopped' | 'cancelled', host? }), or null.
export function transportFailure(answer, { host, allowed, timeoutMilliseconds }) {
    switch (answer?.error) {
        case undefined: return null;
        case 'address': return new Error('That is not a web address.');
        case 'host': return new Error(`The answer came from ${answer.host || 'an address that could not be read'}, which this window may not connect to. It may reach: ${[...allowed].join(', ')}.`);
        case 'timeout': return new Error(`${host} did not answer within ${timeoutMilliseconds / 1000} seconds.`);
        case 'size': return new Error('The answer is larger than the size limit.');
        case 'stopped': return new Error(`The answer from ${host} stopped part way.`);
        case 'cancelled': return new Error('The download was cancelled.');
        default: return new Error(`Could not read ${host}. Check the connection; the server may also not allow a web page to read it, which the desktop app can.`);
    }
}

// `transport({ url, hosts, maximumBytes, timeoutMilliseconds })` answers { status, bytes } (bytes only for a status that is ok), or
// { error: 'address' | 'host' | 'timeout' | 'network' | 'size' | 'stopped', host? }. Resolves to the bytes, or throws a message a user can act on.
export async function fetchAllowedFromPage({ url, hosts, transport, maximumBytes = maximumFetchBytes, timeoutMilliseconds = fetchTimeoutMilliseconds }) {
    const allowed = new Set(hosts.map((host) => host.toLowerCase()));
    let address;
    try { address = new URL(url); } catch { throw new Error('That is not a web address.'); }
    checkAddress(address, allowed);
    const answer = await transport({ url: address.href, hosts: [...allowed], maximumBytes, timeoutMilliseconds });
    const host = address.hostname;
    const failure = transportFailure(answer, { host, allowed, timeoutMilliseconds });
    if (failure) throw failure;
    if (!(answer.status >= 200 && answer.status < 300)) throw new Error(`${host} answered ${answer.status}${answer.status === 404 ? ' (not found: check the symbol)' : answer.status === 429 ? ' (too many requests: wait a while)' : ''}.`);
    const bytes = new Uint8Array(answer.bytes);
    if (bytes.length > maximumBytes) throw new Error('The answer is larger than the size limit.');
    return bytes;
}
