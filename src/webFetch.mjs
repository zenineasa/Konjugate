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

// `transport({ url, hosts, maximumBytes, timeoutMilliseconds })` answers { status, bytes } (bytes only for a status that is ok), or
// { error: 'address' | 'host' | 'timeout' | 'network' | 'size' | 'stopped', host? }. Resolves to the bytes, or throws a message a user can act on.
export async function fetchAllowedFromPage({ url, hosts, transport, maximumBytes = maximumFetchBytes, timeoutMilliseconds = fetchTimeoutMilliseconds }) {
    const allowed = new Set(hosts.map((host) => host.toLowerCase()));
    let address;
    try { address = new URL(url); } catch { throw new Error('That is not a web address.'); }
    checkAddress(address, allowed);
    const answer = await transport({ url: address.href, hosts: [...allowed], maximumBytes, timeoutMilliseconds });
    const host = address.hostname;
    switch (answer?.error) {
        case undefined: break;
        case 'address': throw new Error('That is not a web address.');
        case 'host': throw new Error(`The answer came from ${answer.host || 'an address that could not be read'}, which this window may not connect to. It may reach: ${[...allowed].join(', ')}.`);
        case 'timeout': throw new Error(`${host} did not answer within ${timeoutMilliseconds / 1000} seconds.`);
        case 'size': throw new Error('The answer is larger than the size limit.');
        case 'stopped': throw new Error(`The answer from ${host} stopped part way.`);
        default: throw new Error(`Could not read ${host}. Check the connection; the server may also not allow a web page to read it, which the desktop app can.`);
    }
    if (!(answer.status >= 200 && answer.status < 300)) throw new Error(`${host} answered ${answer.status}${answer.status === 404 ? ' (not found: check the symbol)' : answer.status === 429 ? ' (too many requests: wait a while)' : ''}.`);
    const bytes = new Uint8Array(answer.bytes);
    if (bytes.length > maximumBytes) throw new Error('The answer is larger than the size limit.');
    return bytes;
}
